import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauriRuntime } from './environment'

/**
 * 把应用内主题偏好同步为原生窗口外观。WKWebView 的原生控件（<select> 下拉、
 * 右键菜单等）跟随 NSView 的 NSAppearance 渲染，而不是页面 CSS color-scheme——
 * 应用内主题与 macOS 系统外观不一致时，这些原生弹层会以错误配色浮在暗色界面上。
 * 'system' 传 null 清除覆盖、交还系统决定；浏览器开发模式（非 Tauri 环境）与
 * 权限缺失时静默跳过，主题本就只是视觉偏好。
 */
export const syncNativeWindowTheme = (theme: 'dark' | 'light' | 'system'): Promise<void> => {
  if (!isTauriRuntime()) return Promise.resolve()
  // getCurrentWindow() 在 __TAURI_INTERNALS__ 不完整时（测试桩/异常宿主）会同步抛错，
  // 外观同步只是视觉偏好，任何失败都不能打断主题切换。
  try {
    return getCurrentWindow()
      .setTheme(theme === 'system' ? null : theme)
      .catch(() => undefined)
  } catch {
    return Promise.resolve()
  }
}
