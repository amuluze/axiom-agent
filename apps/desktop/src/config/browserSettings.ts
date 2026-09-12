/**
 * 浏览器工具的本地配置（设置页「浏览器」区读写）。
 *
 * 刻意做成无任何 import 的叶子模块：platform/browserSession（spawn 前读取
 * enabled/executablePath/headless）与设置页 UI 共用同一份持久化，而不引入
 * stores ↔ platform 的反向依赖。localStorage key 沿用 `axiom.<域>.<名>.v1`
 * 约定；字段逐项校验，损坏载荷 fail-safe 回退默认值。
 */

export interface BrowserSettings {
  /** 浏览器能力总开关：关闭时 Rust 侧 spawn 类动作 fail-closed 拒绝。 */
  enabled: boolean
  /** Chromium 系可执行文件路径；空串 = 自动探测（按固定候选序）。 */
  executablePath: string
  /** 无头模式（默认）；有头模式浏览器窗口对用户可见。 */
  headless: boolean
}

const BROWSER_SETTINGS_STORAGE_KEY = 'axiom.browser.config.v1'

const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  enabled: false,
  executablePath: '',
  headless: true,
}

export const loadBrowserSettings = (): BrowserSettings => {
  if (typeof window === 'undefined') return { ...DEFAULT_BROWSER_SETTINGS }
  try {
    const raw = window.localStorage.getItem(BROWSER_SETTINGS_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_BROWSER_SETTINGS }
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') {
      return { ...DEFAULT_BROWSER_SETTINGS }
    }
    const record = parsed as Record<string, unknown>
    return {
      enabled: typeof record.enabled === 'boolean' ? record.enabled : false,
      executablePath:
        typeof record.executablePath === 'string' ? record.executablePath : '',
      headless: typeof record.headless === 'boolean' ? record.headless : true,
    }
  } catch {
    return { ...DEFAULT_BROWSER_SETTINGS }
  }
}

/** 持久化并同步模块级 live binding（非 React 消费方即时读到新值）。 */
export const saveBrowserSettings = (settings: BrowserSettings): void => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(BROWSER_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  activeBrowserSettings = { ...settings }
}

let activeBrowserSettings: BrowserSettings = loadBrowserSettings()

export const getBrowserSettings = (): BrowserSettings => activeBrowserSettings
