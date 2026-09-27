//! WKWebView 原生视口截图（`capture_webview_viewport`）——设计稿「渲染回读/扫描
//! 验证」的光栅化源（docs/ax-format.md §4.6、docs/design-canvas.md §7）。
//!
//! 为什么需要原生路径：既有管线走「DOM → SVG foreignObject → canvas」，而 WebKit
//! 自 changeset 195614 起，绘制**任何**含 `<foreignObject>` 的 SVG 都会污染画布
//! （blob:/data: 一律，且明确不采纳 Chromium 的 blob 豁免）——`getImageData` /
//! `toDataURL` 必抛 SecurityError。该管线只在 Chromium（浏览器 dev 模式）可用，
//! macOS 应用本体（WKWebView）里所有页面都会「光栅化失败」。原生
//! `takeSnapshotWithConfiguration:` 用 WebKit 自己的渲染器出图（含字体），保真度
//! 是构造性的；JS 侧拿到 PNG 后再画到 canvas 做像素统计（普通 PNG data: 不污染，
//! 可读回）。
//!
//! 实现注记：WKWebView 指针经 `with_webview` 在主线程取得；WebKit 类（WKWebView /
//! WKSnapshotConfiguration）与 AppKit 类（NSBitmapImageRep）均无 objc2 feature
//! 绑定——按仓库惯例走 `objc2::msg_send!` 动态消息 + 手工内存平衡（alloc/init
//! 持有的对象显式 release；便利方法返回的自动释放对象只在本块内消费）。
//!
//! 安全边界：只截取**调用方窗口**（`window: WebviewWindow` 由 Tauri 注入调用侧，
//! 不接受任意窗口句柄）；快照只落内存 → base64 回传，无新增持久化面；非 macOS
//! fail-closed（无等价可信的原生截图通道，浏览器 dev 模式回退 foreignObject 管线）。

/// 非 macOS 的 fail-closed 文案（浏览器 dev 模式由前端回退 foreignObject 管线，
/// 不走本命令；本消息只出现在非 macOS 桌面端）。
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn webview_capture_unsupported_message() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        "渲染回读仅支持 macOS：Linux 上无 WKWebView 原生截图通道，SVG foreignObject 管线又会被 WebKit 系引擎污染画布（SecurityError）"
    }
    #[cfg(target_os = "windows")]
    {
        "渲染回读仅支持 macOS：Windows 上暂无 WebView2 原生截图通道的等价实现（CapturePreview 方案待评估）"
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        "渲染回读仅支持 macOS"
    }
}

/// 原生截图载荷：PNG base64 + 像素尺寸（Retina 下为 rect × backingScale）。
/// 字段名经 camelCase 与 TS 镜像（platform/webviewCapture.ts）逐字对齐——漏了
/// rename_all 会序列化出 image_base64，TS 读 imageBase64 得 undefined，误报
/// 「返回空数据」而实际截图成功。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebViewCapture {
    pub image_base64: String,
    pub width: u32,
    pub height: u32,
}

/// 截取调用方窗口 WebView 的当前视口（可选 rect 限页面矩形，视口坐标为 CSS px）。
/// `probe=true` 只做平台支持性探测（macOS 返回空载荷、其它平台返回错误），不真正
/// 截图——前端据此选择原生路径还是 foreignObject 回退，避免一次多余的画面闪动。
#[tauri::command]
pub(crate) async fn capture_webview_viewport(
    window: tauri::WebviewWindow,
    rect: Option<[f64; 4]>,
    probe: Option<bool>,
) -> Result<WebViewCapture, String> {
    #[cfg(target_os = "macos")]
    {
        return capture_impl(&window, rect, probe.unwrap_or(false)).await;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, rect);
        if probe.unwrap_or(false) {
            return Err(webview_capture_unsupported_message().to_string());
        }
        Err(webview_capture_unsupported_message().to_string())
    }
}

#[cfg(target_os = "macos")]
async fn capture_impl(
    window: &tauri::WebviewWindow,
    rect: Option<[f64; 4]>,
    probe: bool,
) -> Result<WebViewCapture, String> {
    use std::sync::mpsc;

    if probe {
        // 支持性探测不进 with_webview（不必碰主线程）：本平台恒可用。
        return Ok(WebViewCapture { image_base64: String::new(), width: 0, height: 0 });
    }

    let (tx, rx) = mpsc::channel::<Result<WebViewCapture, String>>();
    // 快照完成回调在主线程异步到达：通道 + 有界等待（渲染挂起的兜底）。
    window
        .with_webview(move |platform| {
            let result = unsafe { dispatch_snapshot(platform.inner(), rect, tx.clone()) };
            if let Err(message) = result {
                let _ = tx.send(Err(message));
            }
        })
        .map_err(|error| format!("无法访问 WebView 主线程：{error}"))?;

    // spawn_blocking 等待通道（recv 可阻塞 14s，不占 worker）；外层 15s 兜底超时。
    let joined = tokio::task::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(14)));
    let payload = match tokio::time::timeout(std::time::Duration::from_secs(15), joined).await {
        Ok(Ok(received)) => received
            .map_err(|error| format!("WebView 截图失败：{error}"))?,
        Ok(Err(error)) => return Err(format!("截图任务失败：{error}")),
        Err(_) => return Err("WebView 截图超时（15s）".to_string()),
    };
    payload
}

/// 在主线程派发快照：构造（可选 rect 的）配置 + 完成回调块，立即返回；
/// 结果经 `tx` 异步回传。
///
/// # Safety
/// `webview_ptr` 必须是 `with_webview` 回调给出的 WKWebView 指针（主线程有效）。
#[cfg(target_os = "macos")]
unsafe fn dispatch_snapshot(
    webview_ptr: *mut std::ffi::c_void,
    rect: Option<[f64; 4]>,
    tx: std::sync::mpsc::Sender<Result<WebViewCapture, String>>,
) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    if webview_ptr.is_null() {
        return Err("WebView 指针无效".to_string());
    }
    let webview = Retained::<AnyObject>::retain(webview_ptr.cast())
        .ok_or_else(|| "WebView 对象无效".to_string())?;

    // rect 给定时只截取页面所在矩形（视口坐标/pt）；省缺配置 = 整个视口。
    let config: *mut AnyObject = rect
        .map(|[x, y, width, height]| -> *mut AnyObject {
            let config = unsafe { objc2::msg_send![objc2::class!(WKSnapshotConfiguration), new] };
            let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
            let _: () = unsafe { objc2::msg_send![config, setRect: frame] };
            config
        })
        .unwrap_or(std::ptr::null_mut());

    // 完成回调：image/error 任一非空；结果统一编码为 PNG 后回传。
    // RcBlock 供 takeSnapshot copy 持有；块内 tx.send 后自动释放（Rc 归零）。
    let block: block2::RcBlock<dyn Fn(*mut AnyObject, *mut AnyObject)> =
        block2::RcBlock::new(move |image: *mut AnyObject, _error: *mut AnyObject| {
            let result = if image.is_null() {
                Err("WebView 快照为空".to_string())
            } else {
                encode_snapshot_to_png(image)
            };
            let _ = tx.send(result);
        });

    if config.is_null() {
        let _: () = unsafe {
            objc2::msg_send![&webview, takeSnapshotWithConfiguration: std::ptr::null_mut::<AnyObject>(), completionHandler: &*block]
        };
    } else {
        let _: () = unsafe {
            objc2::msg_send![&webview, takeSnapshotWithConfiguration: config, completionHandler: &*block]
        };
        let _: () = unsafe { objc2::msg_send![config, release] };
    }
    Ok(())
}

/// NSImage（快照）→ CGImage → NSBitmapImageRep → PNG NSData → base64。
/// 手工内存平衡：alloc/init 产物显式 release；便利方法的自动释放对象只在本函数内
/// 消费（bytes 立即拷出）。
#[cfg(target_os = "macos")]
fn encode_snapshot_to_png(image: *mut objc2::runtime::AnyObject) -> Result<WebViewCapture, String> {
    use base64::Engine as _;
    use objc2::runtime::AnyObject;

    // NSImage → CGImage（proposedRect/context/hints 均可空）。
    let cg_image: *mut AnyObject = unsafe {
        objc2::msg_send![
            image,
            CGImageForProposedRect: std::ptr::null_mut::<objc2_foundation::NSRect>(),
            context: std::ptr::null_mut::<AnyObject>(),
            hints: std::ptr::null_mut::<AnyObject>()
        ]
    };
    if cg_image.is_null() {
        return Err("快照解码失败：无位图表示".to_string());
    }

    // CGImage → NSBitmapImageRep（alloc/init 两步，持有 +1，末尾 release）。
    let rep_alloc: *mut AnyObject =
        unsafe { objc2::msg_send![objc2::class!(NSBitmapImageRep), alloc] };
    let rep: *mut AnyObject = unsafe { objc2::msg_send![rep_alloc, initWithCGImage: cg_image] };
    if rep.is_null() {
        return Err("快照位图创建失败".to_string());
    }

    let result = (|| {
        // NSBitmapImageFileTypePNG = 4；properties 传 nil。
        let png_data: *mut AnyObject = unsafe {
            objc2::msg_send![rep, representationUsingType: 4usize, properties: std::ptr::null_mut::<AnyObject>()]
        };
        if png_data.is_null() {
            return Err("PNG 编码失败：数据为空".to_string());
        }
        let length: usize = unsafe { objc2::msg_send![png_data, length] };
        let bytes: *const u8 = unsafe { objc2::msg_send![png_data, bytes] };
        if bytes.is_null() || length == 0 {
            return Err("PNG 编码失败：数据不可读".to_string());
        }
        let png = unsafe { std::slice::from_raw_parts(bytes, length) }.to_vec();
        let width: isize = unsafe { objc2::msg_send![rep, pixelsWide] };
        let height: isize = unsafe { objc2::msg_send![rep, pixelsHigh] };
        if width <= 0 || height <= 0 {
            return Err("快照尺寸无效".to_string());
        }
        // 与 computer/browser 截图同一体积守卫（4 MiB 内降采样重编码）。
        let (png, width, height, _) =
            crate::browser_session::ensure_screenshot_within_cap(png)?;
        Ok(WebViewCapture {
            image_base64: base64::engine::general_purpose::STANDARD.encode(png),
            width,
            height,
        })
    })();

    let _: () = unsafe { objc2::msg_send![rep, release] };
    result
}

#[cfg(test)]
mod tests {
    use super::WebViewCapture;

    #[test]
    fn serializes_camel_case_for_ts_mirror() {
        // TS 镜像（platform/webviewCapture.ts）逐字读 imageBase64：漏了
        // rename_all 会序列化出蛇形 image_base64，TS 侧读 undefined、误报空数据。
        let payload = WebViewCapture { image_base64: "abc".into(), width: 2, height: 1 };
        let json = serde_json::to_value(&payload).expect("serialize");
        assert!(json.get("imageBase64").is_some(), "字段必须是 camelCase");
        assert!(json.get("image_base64").is_none(), "不得出现蛇形字段");
    }
}
