//! Image detection and resizing for the read tool.
//!
//! Detection uses magic bytes (mirroring pi's `mime.ts`) so that a file is
//! recognized by its actual content, not just its extension. Resizing uses the
//! `image` crate with a Lanczos3 filter, capping the longest edge at 2000 px and
//! the base64 payload at ~4.5 MiB (below common provider limits).

use base64::Engine;
use image::ImageReader;
use std::io::Cursor;

/// Maximum dimension (width or height) after resizing.
const MAX_IMAGE_DIMENSION: u32 = 2_000;
/// Upper bound for the base64 payload, mirroring pi's `DEFAULT_MAX_BYTES`.
const MAX_BASE64_BYTES: usize = 4_500_000;
/// 解码前的单轴尺寸硬上限。超出即拒绝，避免恶意文件在头部声明超大
/// 尺寸触发 decode 分配 GB 级像素缓冲（OOM/DoS）。覆盖真实照片（≤ 8K），
/// 但阻止 40000×40000 这类病态声明。
const MAX_DECODE_IMAGE_DIMENSION: u32 = 8_192;

fn check_decode_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width > MAX_DECODE_IMAGE_DIMENSION || height > MAX_DECODE_IMAGE_DIMENSION {
        return Err(format!(
            "image dimensions {width}x{height} exceed the safe decode limit of {MAX_DECODE_IMAGE_DIMENSION}px"
        ));
    }
    Ok(())
}

/// Image extensions accepted by the read tool's image branch.
pub(crate) const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

#[derive(Debug)]
pub(crate) struct ResizedImage {
    pub mime_type: &'static str,
    pub data_base64: String,
    pub original_width: Option<u32>,
    pub original_height: Option<u32>,
    pub resized: bool,
}

/// Detect the image MIME type from the leading magic bytes.
/// Returns `None` for unsupported or non-image data.
pub(crate) fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        // JPEG-XR (0xFF D8 FF F7) is not supported by the image crate.
        if bytes.get(3) == Some(&0xF7) {
            return None;
        }
        return Some("image/jpeg");
    }
    const PNG_SIG: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.len() >= 8 && bytes[..8] == PNG_SIG {
        return Some("image/png");
    }
    if bytes.len() >= 3 && &bytes[..3] == b"GIF" {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 2 && &bytes[..2] == b"BM" {
        return Some("image/bmp");
    }
    None
}

/// Whether a path's extension looks like a supported image.
pub(crate) fn is_supported_image_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            IMAGE_EXTENSIONS
                .iter()
                .any(|accepted| accepted.eq_ignore_ascii_case(ext))
        })
}

/// Load, optionally resize, and base64-encode an image.
///
/// If the image already fits within `MAX_IMAGE_DIMENSION` on both axes and the
/// original base64 is under the byte budget, it is returned verbatim
/// (`resized == false`). Otherwise it is scaled down with Lanczos3 and, if
/// still too large, progressively shrunk until it fits the budget.
pub(crate) fn resize_image(bytes: &[u8]) -> Result<ResizedImage, String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("failed to read image: {error}"))?;
    let format = reader
        .format()
        .ok_or_else(|| "could not determine image format".to_string())?;
    let mime_type = image_format_to_mime(format);
    // 解码前先读取头部声明的尺寸并做硬上限检查：decode 会分配 w*h*4 的像素缓冲，
    // 恶意文件可声明 40000x40000 的 IHDR 触发 GB 级分配，即使被 image crate 的
    // 512 MiB 上限拦截也构成 DoS。这里只读头部、不分配，超限直接拒绝。
    let (orig_w, orig_h) = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("failed to read image: {error}"))?
        .into_dimensions()
        .map_err(|error| format!("failed to read image dimensions: {error}"))?;
    check_decode_dimensions(orig_w, orig_h)?;
    let original = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("failed to read image: {error}"))?
        .decode()
        .map_err(|error| format!("failed to decode image: {error}"))?;
    debug_assert_eq!((original.width(), original.height()), (orig_w, orig_h));

    // Fast path: original is small enough.
    let original_base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    if orig_w <= MAX_IMAGE_DIMENSION
        && orig_h <= MAX_IMAGE_DIMENSION
        && original_base64.len() <= MAX_BASE64_BYTES
    {
        return Ok(ResizedImage {
            mime_type,
            data_base64: original_base64,
            original_width: Some(orig_w),
            original_height: Some(orig_h),
            resized: false,
        });
    }

    // Scale down to fit MAX_IMAGE_DIMENSION, preserving aspect ratio.
    let scale = MAX_IMAGE_DIMENSION as f64 / orig_w.max(orig_h) as f64;
    let target_w = ((orig_w as f64) * scale).round().max(1.0) as u32;
    let target_h = ((orig_h as f64) * scale).round().max(1.0) as u32;
    let mut current_w = target_w;
    let mut current_h = target_h;

    loop {
        let resized = original.resize_exact(current_w, current_h, image::imageops::FilterType::Lanczos3);
        let mut out: Vec<u8> = Vec::new();
        resized
            .write_to(&mut Cursor::new(&mut out), format)
            .map_err(|error| format!("failed to encode image: {error}"))?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&out);
        if encoded.len() <= MAX_BASE64_BYTES || (current_w == 1 && current_h == 1) {
            return Ok(ResizedImage {
                mime_type,
                data_base64: encoded,
                original_width: Some(orig_w),
                original_height: Some(orig_h),
                resized: true,
            });
        }
        // Shrink further (mirror pi's 0.75 factor), flooring at 1.
        current_w = ((current_w as f64) * 0.75).max(1.0) as u32;
        current_h = ((current_h as f64) * 0.75).max(1.0) as u32;
    }
}

fn image_format_to_mime(format: image::ImageFormat) -> &'static str {
    match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::Gif => "image/gif",
        image::ImageFormat::WebP => "image/webp",
        image::ImageFormat::Bmp => "image/bmp",
        _ => "image/png",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_supported_formats_by_magic_bytes() {
        // Minimal valid PNG header.
        let png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        assert_eq!(detect_image_mime(&png), Some("image/png"));

        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0];
        assert_eq!(detect_image_mime(&jpeg), Some("image/jpeg"));

        let gif = b"GIF89a";
        assert_eq!(detect_image_mime(gif), Some("image/gif"));

        let webp = [b'R', b'I', b'F', b'F', 0, 0, 0, 0, b'W', b'E', b'B', b'P'];
        assert_eq!(detect_image_mime(&webp), Some("image/webp"));
    }

    #[test]
    fn rejects_jpeg_xr_variant() {
        let jpeg_xr = [0xFF, 0xD8, 0xFF, 0xF7];
        assert_eq!(detect_image_mime(&jpeg_xr), None);
    }

    #[test]
    fn returns_none_for_non_image_bytes() {
        assert_eq!(detect_image_mime(b"hello world"), None);
        assert_eq!(detect_image_mime(b""), None);
    }

    #[test]
    fn detects_image_extensions_case_insensitively() {
        assert!(is_supported_image_path(std::path::Path::new("photo.PNG")));
        assert!(is_supported_image_path(std::path::Path::new("photo.jpg")));
        assert!(!is_supported_image_path(std::path::Path::new("photo.txt")));
        assert!(!is_supported_image_path(std::path::Path::new("photo")));
    }

    fn png_crc32(data: &[u8]) -> u32 {
        let mut crc: u32 = 0xFFFF_FFFF;
        for &byte in data {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }

    /// 用真实小 PNG 修补 IHDR 尺寸为给定值并重算 CRC，模拟恶意文件在头部声明超大尺寸。
    fn patch_png_dimensions(mut bytes: Vec<u8>, width: u32, height: u32) -> Vec<u8> {
        // PNG 布局：signature(8) + length(4) + "IHDR"(4) + data(13) + CRC(4)。
        // width/height 在偏移 16..24，CRC 覆盖 12..29、存放于 29..33。
        bytes[16..20].copy_from_slice(&width.to_be_bytes());
        bytes[20..24].copy_from_slice(&height.to_be_bytes());
        let crc = png_crc32(&bytes[12..29]);
        bytes[29..33].copy_from_slice(&crc.to_be_bytes());
        bytes
    }

    fn tiny_png() -> Vec<u8> {
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::new(2, 2));
        let mut bytes: Vec<u8> = Vec::new();
        img.write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        bytes
    }

    #[test]
    fn check_decode_dimensions_enforces_the_hard_cap() {
        assert!(check_decode_dimensions(40_000, 40_000).is_err());
        assert!(check_decode_dimensions(8_193, 8_192).is_err());
        assert!(check_decode_dimensions(8_192, 8_192).is_ok());
        assert!(check_decode_dimensions(1_920, 1_080).is_ok());
    }

    #[test]
    fn rejects_images_whose_header_declares_huge_dimensions() {
        // 字节级小文件声明 40000x40000：必须在分配像素缓冲前被拒绝
        let png = patch_png_dimensions(tiny_png(), 40_000, 40_000);
        let error = resize_image(&png).unwrap_err();
        assert!(
            error.contains("exceed the safe decode limit"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn resizes_a_large_synthetic_image() {
        // Generate a 3000x3000 PNG that exceeds the dimension cap.
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::new(3000, 3000));
        let mut buf: Vec<u8> = Vec::new();
        img.write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        let result = resize_image(&buf).unwrap();
        assert_eq!(result.mime_type, "image/png");
        assert!(result.resized);
        assert_eq!(result.original_width, Some(3000));
        assert!(result.data_base64.len() <= MAX_BASE64_BYTES);
    }

    #[test]
    fn keeps_small_image_unchanged() {
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::new(10, 10));
        let mut original: Vec<u8> = Vec::new();
        img.write_to(&mut Cursor::new(&mut original), image::ImageFormat::Png)
            .unwrap();
        let result = resize_image(&original).unwrap();
        assert!(!result.resized);
        // Small identical image -> base64 equals the original encoding.
        assert_eq!(
            result.data_base64,
            base64::engine::general_purpose::STANDARD.encode(&original)
        );
    }
}
