//! 设计稿 PNG 导出通道（设计画布 v0.3，docs/design-canvas.md §7）。
//!
//! 写盘目标只来自系统原生保存对话框——**不经 WebView 传路径**（与
//! `pick_and_authorize_workspace` 同款信任模型：渲染进程无法伪造落点，
//! 用户手势即授权）。这也是本模块存在的前提：仓库既有约定是「UI 无免审写
//! 通道」，导出到工作区外的文件必须由用户在选择器里明确指定。
//!
//! 载荷有界：仅接受 PNG 魔数、64MiB 上限；扩展名统一为 .png。
//! 建议文件名做基础名清洗（去路径分隔符/控制字符），避免对话框预填穿越。

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

/// 单张导出上限：与 artifact 8MiB 不同，PNG 是光栅化产物，留足 4K 画布余量。
const MAX_DESIGN_EXPORT_BYTES: usize = 64 * 1024 * 1024;
const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// 清洗对话框建议文件名：只取基础名（丢路径分量），滤掉控制字符，限长。
fn sanitize_suggested_name(raw: &str) -> String {
    let base = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("design")
        .chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>();
    let trimmed = base.trim();
    if trimmed.is_empty() {
        return "design.png".into();
    }
    trimmed.chars().take(80).collect()
}

/// 导出 base64 PNG 到用户选定路径；取消返回 Ok(None)，否则返回落盘绝对路径。
#[tauri::command]
pub(crate) async fn export_design_png(
    app: tauri::AppHandle,
    suggested_file_name: String,
    content_base64: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let bytes = BASE64
        .decode(content_base64.as_bytes())
        .map_err(|_| "导出内容不是合法的 base64".to_string())?;
    if bytes.len() > MAX_DESIGN_EXPORT_BYTES {
        return Err(format!(
            "导出内容超过 {} MiB 上限",
            MAX_DESIGN_EXPORT_BYTES / (1024 * 1024)
        ));
    }
    if !bytes.starts_with(&PNG_MAGIC) {
        return Err("导出内容不是 PNG 图像".into());
    }
    let file_name = sanitize_suggested_name(&suggested_file_name);

    // 非阻塞 save_file + oneshot：blocking_* 在 macOS 会阻塞 Tauri 主线程上下文。
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("导出设计稿为 PNG")
        .set_file_name(file_name)
        .add_filter("PNG", &["png"])
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let picked = receiver
        .await
        .map_err(|_| "保存对话框意外关闭".to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let mut path = picked
        .into_path()
        .map_err(|error| format!("无法解析所选保存路径：{error}"))?;
    let has_png_ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("png"));
    if !has_png_ext {
        path.set_extension("png");
    }

    // 落盘走 blocking 线程池：文件 I/O 不占 tokio worker（与写命令同款形态）。
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&target, &bytes))
        .await
        .map_err(|error| format!("导出任务中断：{error}"))?
        .map_err(|error| format!("写入导出文件失败：{error}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggested_name_strips_paths_and_controls() {
        assert_eq!(sanitize_suggested_name("axiom.png"), "axiom.png");
        assert_eq!(sanitize_suggested_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_suggested_name("dir\\nested\\登录页.png"), "登录页.png");
        assert_eq!(sanitize_suggested_name("bad\u{0}name\u{7f}.png"), "badname.png");
    }

    #[test]
    fn suggested_name_falls_back_when_empty_or_blank() {
        assert_eq!(sanitize_suggested_name(""), "design.png");
        assert_eq!(sanitize_suggested_name("   "), "design.png");
        assert_eq!(sanitize_suggested_name("///"), "design.png");
    }

    #[test]
    fn suggested_name_is_length_capped() {
        let long = "a".repeat(500);
        assert_eq!(sanitize_suggested_name(&long).chars().count(), 80);
    }
}
