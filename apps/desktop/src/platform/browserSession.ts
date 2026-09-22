import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getBrowserSettings, type BrowserSettings } from '@/config/browserSettings'

/**
 * browser 工具的平台封装：命令名以字面量出现在 `invoke` 调用中，供
 * `tauri-capability-audit` 做 handler ↔ capability ↔ 前端三向漂移审计。
 * 安全边界（可执行文件 allowlist、隔离 profile、回环 CDP、URL/输出上限）
 * 全部由 Rust `browser_session.rs` 权威执行，本层只做类型化转发与启用门控。
 *
 * 请求/响应/事件类型与 Rust 侧 `BrowserCommandRequest`/`BrowserCommandResponse`
 * 及 `axiom:browser-*` 事件载荷逐字镜像（serde tag=action/type + camelCase 字段），
 * 改任一侧必须同步另一侧。
 */

export type { BrowserSettings } from '@/config/browserSettings'
export type { UnlistenFn } from '@tauri-apps/api/event'

export interface BrowserSpawnConfig {
  enabled: boolean
  executablePath: string
  headless: boolean
  ignoreCertificateErrors: boolean
}

export type BrowserCommandRequest =
  | { action: 'detect' }
  | { action: 'validateExecutable'; path: string }
  | { action: 'status' }
  | { action: 'ensureRunning'; config: BrowserSpawnConfig }
  | { action: 'shutdown' }
  | { action: 'clearProfileData'; mode: 'cache' | 'all' }
  | { action: 'tabs' }
  | { action: 'newTab'; url?: string }
  | { action: 'closeTab'; tabId: string }
  | { action: 'dblClick'; tabId: string; ref: number }
  | { action: 'setViewport'; tabId: string; width?: number; height?: number }
  | { action: 'downloads'; limit?: number }
  | { action: 'readDownload'; name: string }
  | { action: 'activateTab'; tabId: string }
  | { action: 'navigate'; tabId: string; url: string }
  | { action: 'snapshot'; tabId: string }
  | { action: 'click'; tabId: string; ref: number }
  | { action: 'fill'; tabId: string; ref: number; text: string }
  | { action: 'selectOption'; tabId: string; ref: number; text: string }
  | { action: 'uploadFile'; tabId: string; ref: number; path: string }
  | { action: 'typeText'; tabId: string; ref?: number; text: string }
  | { action: 'press'; tabId: string; key: string; ref?: number }
  | { action: 'scroll'; tabId: string; ref?: number; deltaX?: number; deltaY?: number }
  | { action: 'screenshot'; tabId: string; ref?: number }
  | { action: 'hover'; tabId: string; ref: number }
  | { action: 'wait'; tabId: string; text?: string; durationMs?: number }
  | { action: 'find'; tabId: string; text: string; limit?: number }
  | { action: 'back'; tabId: string }
  | { action: 'forward'; tabId: string }
  | { action: 'navigationHistory'; tabId: string }
  | { action: 'reload'; tabId: string }
  | { action: 'dialog'; tabId: string }
  | { action: 'respondDialog'; tabId: string; accept: boolean; promptText?: string }
  | { action: 'startScreencast'; tabId: string; maxWidth?: number; maxHeight?: number }
  | { action: 'stopScreencast'; tabId: string }
  | { action: 'console'; tabId: string; limit?: number }
  | { action: 'clickAt'; tabId: string; x: number; y: number }
  | { action: 'scrollAt'; tabId: string; x: number; y: number; deltaX?: number; deltaY?: number }

export interface BrowserEngineInfo {
  engine: string
  path: string
  available: boolean
}

export interface BrowserTabInfo {
  tabId: string
  url: string
  title: string
  active: boolean
  hasDialog: boolean
}

export interface JsDialogInfo {
  kind: string
  message: string
}

export type BrowserCommandResponse =
  | { type: 'detected'; engines: BrowserEngineInfo[] }
  | { type: 'executableValid'; path: string; engine: string }
  | {
      type: 'status'
      running: boolean
      port?: number
      engine?: string
      headless?: boolean
      version?: string
      tabs?: number
    }
  | { type: 'tabs'; tabs: BrowserTabInfo[] }
  | { type: 'tabOpened'; tab: BrowserTabInfo }
  | { type: 'navigated'; url: string; title: string }
  | {
      type: 'snapshot'
      url: string
      title: string
      text: string
      truncated: boolean
      dialog?: JsDialogInfo
    }
  | {
      type: 'screenshot'
      imageBase64: string
      mimeType: string
      width: number
      height: number
      resized: boolean
    }
  | { type: 'dialogState'; dialog?: JsDialogInfo }
  | { type: 'navigationState'; canGoBack: boolean; canGoForward: boolean }
  | { type: 'waited'; textMatched: boolean; waitedMs: number }
  | {
      type: 'found'
      url: string
      title: string
      matches: string[]
      total: number
      truncated: boolean
    }
  | { type: 'screencastStarted' }
  | { type: 'consoleLog'; entries: ConsoleEntry[] }
  | { type: 'viewportApplied'; width?: number; height?: number }
  | { type: 'downloadList'; directory: string; entries: DownloadEntry[] }
  | { type: 'downloadContent'; name: string; path: string; sizeBytes: number; truncated: boolean; content: string }
  | { type: 'done' }

/** 下载目录条目（recent-first，未完成的 .crdownload 不出现）。 */
export interface DownloadEntry {
  name: string
  path: string
  sizeBytes: number
  /** Unix 毫秒时间戳 */
  modifiedAt: number
}

/** console/运行时错误条目（Rust 环形缓冲的镜像，最近条目优先语义）。 */
export interface ConsoleEntry {
  /** error / warning / info / log / debug */
  level: string
  text: string
  /** console（console.* 调用）/ exception（未捕获异常）/ network 等 */
  source: string
  /** Unix 毫秒时间戳 */
  timestamp: number
}

/** 需要浏览器进程在跑的动作：转发前先过启用门控 + ensureRunning。 */
const SPAWN_REQUIRED_ACTIONS = new Set<BrowserCommandRequest['action']>([
  'tabs',
  'newTab',
  'closeTab',
  'activateTab',
  'dblClick',
  'setViewport',
  'navigate',
  'snapshot',
  'click',
  'fill',
  'selectOption',
  'uploadFile',
  'typeText',
  'press',
  'scroll',
  'screenshot',
  'hover',
  'wait',
  'find',
  'back',
  'forward',
  'reload',
  'navigationHistory',
  'dialog',
  'respondDialog',
  'console',
])

const spawnConfigFromSettings = (settings: BrowserSettings): BrowserSpawnConfig => ({
  enabled: settings.enabled,
  executablePath: settings.executablePath,
  headless: settings.headless,
  ignoreCertificateErrors: settings.ignoreCertificateErrors,
})

export const browserCommand = async (
  request: BrowserCommandRequest,
): Promise<BrowserCommandResponse> => {
  if (SPAWN_REQUIRED_ACTIONS.has(request.action)) {
    const settings = getBrowserSettings()
    if (!settings.enabled) {
      throw new Error('浏览器能力未启用：请在 设置 → 浏览器 打开开关并保存')
    }
    // ensureRunning 幂等且已在跑时立即返回；显式前置而不是塞进每个动作，
    // 保持 Rust 请求枚举与动作一一对应。
    await invoke<BrowserCommandResponse>('browser_command', {
      request: { action: 'ensureRunning', config: spawnConfigFromSettings(settings) },
    })
  }
  return invoke<BrowserCommandResponse>('browser_command', { request })
}

// ---------------------------------------------------------------------------
// 设置页消费的薄封装
// ---------------------------------------------------------------------------

export const detectBrowserEngines = (): Promise<BrowserCommandResponse> =>
  browserCommand({ action: 'detect' })

export const validateBrowserExecutable = (path: string): Promise<BrowserCommandResponse> =>
  browserCommand({ action: 'validateExecutable', path })

export const browserStatus = (): Promise<BrowserCommandResponse> =>
  browserCommand({ action: 'status' })

export const ensureBrowserRunning = (
  config: BrowserSpawnConfig,
): Promise<BrowserCommandResponse> =>
  invoke<BrowserCommandResponse>('browser_command', {
    request: { action: 'ensureRunning', config },
  })

export const shutdownBrowser = (): Promise<BrowserCommandResponse> =>
  browserCommand({ action: 'shutdown' })

/** 清理隔离 profile 数据：cache 保留登录态，all 整库重建（不可撤销）。 */
export const clearBrowserProfileData = (mode: 'cache' | 'all'): Promise<BrowserCommandResponse> =>
  browserCommand({ action: 'clearProfileData', mode })

// ---------------------------------------------------------------------------
// Agent 通道活动监听：browserPanelService 注册，用于「Agent 用浏览器时自动
// 展示面板」（对齐 zcode 的 tabs.new() 自动打开内嵌浏览器面板）。
// 只在 desktopAgentEnvironment 的 browser.command 成功返回后触发——面板自身
// 的操作不走环境接口，不会误触发。
// ---------------------------------------------------------------------------

export type BrowserAgentActivityListener = (
  request: BrowserCommandRequest,
  response: BrowserCommandResponse,
) => void

const agentActivityListeners = new Set<BrowserAgentActivityListener>()

export const addBrowserAgentActivityListener = (
  listener: BrowserAgentActivityListener,
): (() => void) => {
  agentActivityListeners.add(listener)
  return () => {
    agentActivityListeners.delete(listener)
  }
}

export const notifyBrowserAgentActivity = (
  request: BrowserCommandRequest,
  response: BrowserCommandResponse,
): void => {
  for (const listener of agentActivityListeners) {
    listener(request, response)
  }
}

// ---------------------------------------------------------------------------
// 面板实时同步事件（Rust browser_session.rs 事件总线镜像）
// ---------------------------------------------------------------------------

export const BROWSER_FRAME_EVENT = 'axiom:browser-frame'
export const BROWSER_TABS_EVENT = 'axiom:browser-tabs'
export const BROWSER_STATUS_EVENT = 'axiom:browser-status'
export const BROWSER_DIALOG_EVENT = 'axiom:browser-dialog'
export const BROWSER_NAVIGATED_EVENT = 'axiom:browser-navigated'
export const BROWSER_CONSOLE_EVENT = 'axiom:browser-console'

/** screencast 增量帧（JPEG base64）。width/height 是捕获尺寸（含 DPR 缩放）。 */
export interface BrowserFrameEvent {
  tabId: string
  imageBase64: string
  mimeType: string
  width: number
  height: number
}

export interface BrowserTabsEvent {
  tabs: BrowserTabInfo[]
}

/** running=false 附带 reason（意外退出非空，显式关闭缺省）。 */
export interface BrowserStatusEvent {
  running: boolean
  reason?: string
}

export interface BrowserDialogEvent {
  tabId: string
  dialog?: JsDialogInfo
}

/** 主 frame 导航：地址栏即时同步（标题由 tabs 事件补齐）。 */
export interface BrowserNavigatedEvent {
  tabId: string
  url: string
}

export interface BrowserConsoleEvent {
  tabId: string
  entry: ConsoleEntry
}

export interface BrowserEventHandlers {
  onFrame?: (event: BrowserFrameEvent) => void
  onTabs?: (event: BrowserTabsEvent) => void
  onStatus?: (event: BrowserStatusEvent) => void
  onDialog?: (event: BrowserDialogEvent) => void
  onNavigated?: (event: BrowserNavigatedEvent) => void
  onConsole?: (event: BrowserConsoleEvent) => void
}

/**
 * 订阅浏览器面板事件总线，返回统一 unlisten。只注册声明了的 handler——
 * 帧事件高频，未消费的面板不应挂空监听。
 *
 * 注意：clickAt/scrollAt/startScreencast/stopScreencast 刻意不在
 * SPAWN_REQUIRED_ACTIONS 里——它们是面板用户手势/直播控制通道，只在浏览器
 * 已运行时可达，省掉 ensureRunning 前置 IPC（每次点击多一跳会让交互发粘）；
 * 未运行时的失败由 Rust 报「浏览器未运行」，面板按行内错误展示。
 */
export const subscribeBrowserEvents = async (
  handlers: BrowserEventHandlers,
): Promise<UnlistenFn> => {
  const unlisteners: UnlistenFn[] = []
  const register = async <T>(
    event: string,
    handler: ((payload: T) => void) | undefined,
  ): Promise<void> => {
    if (!handler) return
    unlisteners.push(await listen<T>(event, (e) => handler(e.payload)))
  }
  await Promise.all([
    register<BrowserFrameEvent>(BROWSER_FRAME_EVENT, handlers.onFrame),
    register<BrowserTabsEvent>(BROWSER_TABS_EVENT, handlers.onTabs),
    register<BrowserStatusEvent>(BROWSER_STATUS_EVENT, handlers.onStatus),
    register<BrowserDialogEvent>(BROWSER_DIALOG_EVENT, handlers.onDialog),
    register<BrowserNavigatedEvent>(BROWSER_NAVIGATED_EVENT, handlers.onNavigated),
    register<BrowserConsoleEvent>(BROWSER_CONSOLE_EVENT, handlers.onConsole),
  ])
  return () => {
    for (const unlisten of unlisteners) unlisten()
  }
}
