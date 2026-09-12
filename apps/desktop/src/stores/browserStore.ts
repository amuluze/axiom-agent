import { create } from 'zustand'
import type {
  BrowserFrameEvent,
  BrowserStatusEvent,
  BrowserDialogEvent,
  BrowserNavigatedEvent,
  BrowserConsoleEvent,
  BrowserTabInfo,
  ConsoleEntry,
} from '@/platform/browserSession'

/**
 * 浏览器面板 store：Rust 事件总线（axiom:browser-*）与面板动作在渲染层的
 * 单一状态镜像。状态从 BrowserPanel 组件内迁出——右栏切走（组件卸载）不再
 * 丢失实时画面/对话框/console 状态；Agent 用浏览器时面板服务也能在 store 上
 * 联动（自动展示 + 开直播）。
 *
 * 权威数据在 Rust（/json/list 轮询 + CDP 会话）；本 store 只做镜像，面板
 * 动作后的即时回写允许短暂领先事件总线（事件到达时覆盖为权威值）。
 */

export type BrowserStatusInfo = {
  running: boolean
  port?: number
  engine?: string
  headless?: boolean
  version?: string
  tabs?: number
  /** 进程退出原因（意外退出时非空，来自 status 事件）。 */
  exitReason?: string
}

export interface BrowserLiveFrame {
  tabId: string
  src: string
  width: number
  height: number
  /** 收帧时间戳（ms），面板用来展示帧龄。 */
  at: number
}

/** 「页面文本」抽屉读取的快照结果（镜像 Rust snapshot 响应）。 */
export interface BrowserPageSnapshot {
  tabId: string
  url: string
  title: string
  text: string
  truncated: boolean
  /** 读取时间戳（ms），面板用来展示快照生成时刻。 */
  at: number
}

/** store 侧 console 每 tab 保留条数（与 Rust 环形缓冲同容量）。 */
const MAX_STORE_CONSOLE_ENTRIES = 200

export interface BrowserPanelState {
  status: BrowserStatusInfo | null
  tabs: BrowserTabInfo[]
  /** 实时画面开关（用户切换或 Agent 联动开启）。 */
  liveView: boolean
  /** 直播容器像素尺寸（面板 ResizeObserver 上报），控制 screencast 帧体积。 */
  liveViewBounds: { width: number; height: number } | null
  liveFrame: BrowserLiveFrame | null
  /** screencast 是否可用（引擎不支持时置 false，面板回退截图轮询）。 */
  screencastAvailable: boolean
  /** console 抽屉开合（跨 rail 切换保持）。 */
  consoleOpen: boolean
  consoleEntries: Record<string, ConsoleEntry[]>
  /** 「页面文本」抽屉开合（跨 rail 切换保持）。 */
  pageTextOpen: boolean
  /** active tab 的页面文本快照（打开抽屉/导航后刷新）。 */
  pageSnapshot: BrowserPageSnapshot | null
  /** 面板级错误通知：由面板外动作（如消息链接「在面板打开」失败）注入，
   * 面板动作成功后清除；与面板组件内动作级 error 分开，组件卸载不丢。 */
  panelError: string | null

  setLiveView: (liveView: boolean) => void
  setLiveViewBounds: (bounds: { width: number; height: number } | null) => void
  setConsoleOpen: (consoleOpen: boolean) => void
  setPageTextOpen: (pageTextOpen: boolean) => void
  setPageSnapshot: (snapshot: BrowserPageSnapshot | null) => void
  setPanelError: (error: string | null) => void
  setStoreStatus: (status: BrowserStatusInfo | null) => void
  applyTabs: (tabs: BrowserTabInfo[]) => void
  applyFrame: (frame: BrowserFrameEvent) => void
  applyStatusEvent: (event: BrowserStatusEvent) => void
  applyDialogEvent: (event: BrowserDialogEvent) => void
  applyNavigatedEvent: (event: BrowserNavigatedEvent) => void
  appendConsoleEvent: (event: BrowserConsoleEvent) => void
  clearConsole: (tabId: string) => void
  markScreencastUnavailable: () => void
  /** 浏览器停止/重启时清瞬态（帧/console），保留用户开关偏好。 */
  resetTransient: () => void
}

export const useBrowserStore = create<BrowserPanelState>((set) => ({
  status: null,
  tabs: [],
  liveView: false,
  liveViewBounds: null,
  liveFrame: null,
  screencastAvailable: true,
  consoleOpen: false,
  consoleEntries: {},
  pageTextOpen: false,
  pageSnapshot: null,
  panelError: null,

  setLiveView: (liveView) => set({ liveView }),
  setLiveViewBounds: (liveViewBounds) => set({ liveViewBounds }),
  setConsoleOpen: (consoleOpen) => set({ consoleOpen }),
  setPageTextOpen: (pageTextOpen) => set({ pageTextOpen }),
  setPageSnapshot: (pageSnapshot) => set({ pageSnapshot }),
  setPanelError: (panelError) => set({ panelError }),
  setStoreStatus: (status) => set({ status }),
  applyTabs: (tabs) => set({ tabs }),
  applyFrame: (frame) =>
    set({
      liveFrame: {
        tabId: frame.tabId,
        src: `data:${frame.mimeType};base64,${frame.imageBase64}`,
        width: frame.width,
        height: frame.height,
        at: Date.now(),
      },
    }),
  applyStatusEvent: (event) =>
    set(
      event.running
        ? { status: { running: true } }
        : {
            status: { running: false, exitReason: event.reason },
            tabs: [],
            liveFrame: null,
          },
    ),
  applyDialogEvent: (event) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.tabId === event.tabId ? { ...tab, hasDialog: event.dialog !== undefined } : tab,
      ),
    })),
  applyNavigatedEvent: (event) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.tabId === event.tabId ? { ...tab, url: event.url } : tab,
      ),
    })),
  appendConsoleEvent: (event) =>
    set((state) => {
      const existing = state.consoleEntries[event.tabId] ?? []
      const next = [...existing, event.entry]
      if (next.length > MAX_STORE_CONSOLE_ENTRIES) {
        next.splice(0, next.length - MAX_STORE_CONSOLE_ENTRIES)
      }
      return { consoleEntries: { ...state.consoleEntries, [event.tabId]: next } }
    }),
  clearConsole: (tabId) =>
    set((state) => ({ consoleEntries: { ...state.consoleEntries, [tabId]: [] } })),
  markScreencastUnavailable: () => set({ screencastAvailable: false }),
  resetTransient: () =>
    set({
      liveFrame: null,
      tabs: [],
      consoleEntries: {},
      pageSnapshot: null,
      // screencastAvailable 不重置：引擎能力不随会话变化。
    }),
}))

/** 测试辅助：复位到初始态。 */
export const resetBrowserStoreForTests = (): void => {
  useBrowserStore.setState({
    status: null,
    tabs: [],
    liveView: false,
    liveViewBounds: null,
    liveFrame: null,
    screencastAvailable: true,
    consoleOpen: false,
    consoleEntries: {},
    pageTextOpen: false,
    pageSnapshot: null,
    panelError: null,
  })
}
