import { invoke } from '@tauri-apps/api/core'

/**
 * WKWebView 原生视口截图（Rust `webview_capture.rs`）——设计稿渲染回读/扫描验证
 * 与画布 PNG 导出的光栅化源。
 *
 * 为什么绕开 JS 侧的「SVG foreignObject → canvas」管线：WebKit 对绘制含
 * `<foreignObject>` 的 SVG 一律污染画布（blob:/data: 同样，见 docs/ax-format.md
 * §4.6），`getImageData`/`toDataURL` 必抛 SecurityError——该管线只在 Chromium
 * （浏览器 dev 模式）可用。原生截图用 WebKit 自己的渲染器出图（含字体），保真度
 * 是构造性的；返回的普通 PNG 画到 canvas 可正常读回像素统计。
 *
 * 安全边界：只截取调用方窗口的当前视口；rect 为页面所在矩形（视口坐标/CSS px），
 * 由前端传入——Rust 不做任何窗口枚举或定位。
 */

export interface WebViewCaptureResult {
  imageBase64: string
  /** 快照像素尺寸（Retina 下为 rect × backingScale）。 */
  width: number
  height: number
}

/** 截取调用方窗口 WebView 的当前视口；rect 省缺 = 整个视口。 */
export const captureWebViewViewport = (
  rect?: [number, number, number, number],
): Promise<WebViewCaptureResult> =>
  invoke<WebViewCaptureResult>('capture_webview_viewport', { rect: rect ?? null, probe: false })

/** 平台支持性探测（Rust 侧不真正截图，无画面闪动）；浏览器 dev 环境恒为 false。 */
export const probeWebViewCapture = (): Promise<boolean> =>
  invoke<WebViewCaptureResult>('capture_webview_viewport', { rect: null, probe: true })
    .then(() => true)
    .catch(() => false)
