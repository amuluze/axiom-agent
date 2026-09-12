import {
  addBrowserAgentActivityListener,
  browserCommand,
  subscribeBrowserEvents,
  type UnlistenFn,
} from '@/platform/browserSession'
import { getBrowserSettings } from '@/config/browserSettings'
import { isTauriRuntime } from '@/platform/environment'
import { useBrowserStore } from '@/stores/browserStore'
import { useUiStore } from '@/stores/uiStore'

/**
 * 浏览器面板服务：订阅 Rust 事件总线写 browserStore，并管理 screencast 的
 * 可见性门控——只有「右栏打开且停在 browser tab + liveView 开启 + 浏览器在跑」
 * 时才对 active tab 推流，切走即停（面板不可见时白流 JPEG 帧纯浪费 IPC）。
 *
 * Agent 联动（对齐 zcode「tabs.new() 自动打开内嵌面板」）：Agent 经环境通道
 * 成功 newTab 时自动打开右栏、切到 browser tab 并开启实时画面。
 */

let serviceStarted = false
let unlistenEvents: UnlistenFn | undefined
let removeAgentActivityListener: (() => void) | undefined
let unsubscribeUi: (() => void) | undefined
let unsubscribeBrowser: (() => void) | undefined
/** 当前正在推流的 tab（null = 未推流）；仅在 syncScreencast 内变更。 */
let screencastTabId: string | null = null
/** 启动推流时的帧尺寸基准：容器明显变化后重启，让帧分辨率跟随面板（更锐）。 */
let screencastBounds: { width: number; height: number } | null = null
/** 容器尺寸变化重启推流的阈值（≥ 该差值才重启，防连续 resize 抖动）。 */
const SCREENCAST_RESIZE_RESTART_THRESHOLD = 48

const isRunning = (): boolean => useBrowserStore.getState().status?.running === true

/** 计算应推流的目标 tab；null = 应停止。 */
const desiredScreencastTab = (): string | null => {
  const ui = useUiStore.getState()
  const browser = useBrowserStore.getState()
  if (!ui.runtimeRailOpen || ui.runtimeRailPane !== 'browser') return null
  if (!browser.liveView || !browser.screencastAvailable) return null
  if (!isRunning()) return null
  return browser.tabs.find((tab) => tab.active)?.tabId ?? null
}

/** 容器尺寸变化 → 重启推流让帧分辨率跟随面板。首次拿到尺寸（此前启动时
 * ResizeObserver 未就绪，基准为 null）也会重启一次，保证首帧即匹配面板。 */
const boundsChangedEnough = (next: { width: number; height: number } | null): boolean => {
  if (!next) return false
  if (!screencastBounds) return true
  return (
    Math.abs(next.width - screencastBounds.width) >= SCREENCAST_RESIZE_RESTART_THRESHOLD
    || Math.abs(next.height - screencastBounds.height) >= SCREENCAST_RESIZE_RESTART_THRESHOLD
  )
}

const startScreencastFor = async (target: string): Promise<void> => {
  const { liveViewBounds } = useBrowserStore.getState()
  const request = {
    action: 'startScreencast' as const,
    tabId: target,
    ...(liveViewBounds ? { maxWidth: liveViewBounds.width } : {}),
    ...(liveViewBounds ? { maxHeight: liveViewBounds.height } : {}),
  }
  try {
    await browserCommand(request)
    screencastBounds = liveViewBounds
  } catch {
    // 引擎不支持 screencast（极旧 Chromium）：面板回退截图轮询。
    screencastTabId = null
    screencastBounds = null
    useBrowserStore.getState().markScreencastUnavailable()
  }
}

/** 对齐推流目标：切 tab / 开关直播 / rail 可见性变化时增量启停；
 * 目标不变但容器尺寸明显变化时重启（帧分辨率跟随面板尺寸）。 */
const syncScreencast = async (): Promise<void> => {
  const target = desiredScreencastTab()
  if (target !== null && target === screencastTabId) {
    if (boundsChangedEnough(useBrowserStore.getState().liveViewBounds)) {
      await browserCommand({ action: 'stopScreencast', tabId: target }).catch(() => undefined)
      screencastBounds = null
      await startScreencastFor(target)
    }
    return
  }
  const previous = screencastTabId
  screencastTabId = target
  screencastBounds = null
  if (previous) {
    // 停流失败静默：连接将关时 stop 无意义。
    await browserCommand({ action: 'stopScreencast', tabId: previous }).catch(() => undefined)
  }
  if (!target) return
  await startScreencastFor(target)
}

const handleAgentActivity = (request: { action: string }): void => {
  if (request.action !== 'newTab') return
  const ui = useUiStore.getState()
  // 展开会重置 pane 为 picker；先 open 再设 pane，保证最终停在浏览器面板。
  ui.setRuntimeRailOpen(true)
  ui.setRuntimeRailPane('browser')
  // Agent 正在开页面：联动开直播，让用户直接看到 Agent 在浏览器里做什么。
  useBrowserStore.getState().setLiveView(true)
}

const toErrorMessage = (cause: unknown, fallback: string): string => {
  if (typeof cause === 'string') return cause
  if (cause instanceof Error) return cause.message
  return fallback
}

/**
 * 消息链接「在面板打开」：展开右栏并停在浏览器面板，随后新建 tab 打开链接
 * （newTab 走 SPAWN 门控，未运行会自动启动浏览器）。
 * - 浏览器未启用（能力开关关闭）：不调用 SDK（会 throw 打断调用方），只展开
 *   面板——面板自身渲染「未启用 → 打开设置」引导。
 * - 启动/导航失败：把错误注入 browserStore.panelError，由面板错误条展示。
 */
export const openUrlInBuiltinBrowser = async (url: string): Promise<{ ok: boolean; error?: string }> => {
  const ui = useUiStore.getState()
  ui.setRuntimeRailOpen(true)
  ui.setRuntimeRailPane('browser')
  if (!getBrowserSettings().enabled) return { ok: false }
  try {
    await browserCommand({ action: 'newTab', url })
    useBrowserStore.getState().setPanelError(null)
    return { ok: true }
  } catch (cause) {
    const error = toErrorMessage(cause, '在面板打开链接失败')
    useBrowserStore.getState().setPanelError(error)
    return { ok: false, error }
  }
}

export const initBrowserPanelService = (): void => {
  if (serviceStarted || !isTauriRuntime()) return
  serviceStarted = true
  void subscribeBrowserEvents({
    onFrame: (frame) => useBrowserStore.getState().applyFrame(frame),
    onTabs: (event) => {
      useBrowserStore.getState().applyTabs(event.tabs)
      void syncScreencast()
    },
    onStatus: (event) => {
      useBrowserStore.getState().applyStatusEvent(event)
      void syncScreencast()
    },
    onDialog: (event) => useBrowserStore.getState().applyDialogEvent(event),
    onNavigated: (event) => useBrowserStore.getState().applyNavigatedEvent(event),
    onConsole: (event) => useBrowserStore.getState().appendConsoleEvent(event),
  }).then((unlisten) => {
    unlistenEvents = unlisten
  }).catch(() => undefined)
  removeAgentActivityListener = addBrowserAgentActivityListener((request) => {
    handleAgentActivity(request)
  })
  // rail 可见性 / liveView / active tab 变化都会改变推流目标；zustand 原生
  // subscribe 每次任一 set 都回调，syncScreencast 内部自行短路。
  unsubscribeUi = useUiStore.subscribe(() => {
    void syncScreencast()
  })
  unsubscribeBrowser = useBrowserStore.subscribe(() => {
    void syncScreencast()
  })
}

/** 测试专用：重置模块级状态并解除全部订阅。 */
export const resetBrowserPanelServiceForTests = (): void => {
  serviceStarted = false
  unlistenEvents?.()
  unlistenEvents = undefined
  removeAgentActivityListener?.()
  removeAgentActivityListener = undefined
  unsubscribeUi?.()
  unsubscribeUi = undefined
  unsubscribeBrowser?.()
  unsubscribeBrowser = undefined
  screencastTabId = null
  screencastBounds = null
}

/** 测试与诊断出口：当前推流目标。 */
export const browserPanelServiceInternals = {
  get screencastTabId(): string | null {
    return screencastTabId
  },
  syncScreencast,
  handleAgentActivity,
}
