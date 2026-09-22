import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  Globe,
  Lock,
  Plus,
  RefreshCw,
  RotateCw,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import {
  browserCommand,
  browserStatus as fetchBrowserStatus,
  ensureBrowserRunning,
  shutdownBrowser,
  type BrowserCommandRequest,
  type ConsoleEntry,
  type JsDialogInfo,
} from '@/platform/browserSession'
import { getBrowserSettings } from '@/config/browserSettings'
import { openExternalUrl } from '@/platform/webAccess'
import { useBrowserStore } from '@/stores/browserStore'
import { useUiStore } from '@/stores/uiStore'
import { useT, type TFunction } from '@/i18n'

/**
 * 浏览器面板：导航工具栏 + 实时画面 + tab 列表 + console 抽屉，形态对齐
 * zcode / codex 桌面版的共享浏览器视图。
 *
 * - 状态源是 browserStore（Rust 事件总线镜像）：tab 列表 / 地址 / 对话框 /
 *   进程状态随 Agent 或用户操作实时同步，无需手动刷新；本组件只保留编辑中
 *   的草稿（地址栏、对话框回应、console 展开态之外的瞬态）
 * - 实时画面走 CDP screencast 事件流（增量 JPEG）；引擎不支持时自动回退
 *   1.5s 截图轮询；推流由 browserPanelService 按面板可见性门控启停
 * - 实时画面可交互：点击/滚动/键盘经坐标换算转发为 CDP Input 注入（用户
 *   亲手操作通道，不走 Agent 工具的 ref 锚点路径）
 * - console 抽屉展示 per-tab 的 console 输出与运行时错误（error 计数徽标）
 * - 浏览器未启用 → 引导到 设置 → 浏览器（隐藏工具栏）
 * - 所有 IPC 错误降级展示并允许继续操作；不抛出破坏面板
 */
/**
 * Tauri invoke 的 Promise 拒绝值是 Rust 侧的原始字符串（非 Error 实例），
 * 必须先按字符串取用，否则真实错误（如引擎未找到）会被笼统文案吞掉。
 */
const toErrorMessage = (cause: unknown, fallback: string): string => {
  if (typeof cause === 'string') return cause
  if (cause instanceof Error) return cause.message
  return fallback
}

const dialogKindLabel = (kind: string, t: TFunction): string => {
  const known = ['alert', 'confirm', 'prompt'] as const
  if ((known as readonly string[]).includes(kind)) {
    return t(`app.browserPanel.dialog.kind.${kind}`)
  }
  return t('app.browserPanel.dialog.kind.unknown')
}

/** screencast 不可用时的回退轮询间隔。 */
const LIVE_VIEW_POLL_MS = 1500
/** 用户滚轮转发节流：滚动突发下合并增量，避免每 tick 一次 CDP 往返。 */
const WHEEL_FLUSH_MS = 80
/** 导航加载指示的兜底超时：事件流未刷新 URL 时的保守清除。 */
const NAVIGATE_INDICATOR_TIMEOUT_MS = 5000

/** DOM KeyboardEvent.key → Rust `press` 的键名词表（不支持的原样丢弃）。 */
const DOM_KEY_TO_BROWSER: Record<string, string> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ' ': 'Space',
}

const consoleLevelLabel = (level: string, t: TFunction): string => {
  const known = ['error', 'warning'] as const
  if ((known as readonly string[]).includes(level)) {
    return t(`app.browserPanel.console.level.${level}`)
  }
  return t('app.browserPanel.console.level.unknown', { level })
}

export const BrowserPanel = () => {
  const setSettingsSection = useUiStore((state) => state.setSettingsSection)
  const setView = useUiStore((state) => state.setView)
  const status = useBrowserStore((state) => state.status)
  const tabs = useBrowserStore((state) => state.tabs)
  const liveView = useBrowserStore((state) => state.liveView)
  const liveFrame = useBrowserStore((state) => state.liveFrame)
  const screencastAvailable = useBrowserStore((state) => state.screencastAvailable)
  const consoleOpen = useBrowserStore((state) => state.consoleOpen)
  const consoleEntries = useBrowserStore((state) => state.consoleEntries)
  const pageTextOpen = useBrowserStore((state) => state.pageTextOpen)
  const pageSnapshot = useBrowserStore((state) => state.pageSnapshot)
  const panelError = useBrowserStore((state) => state.panelError)
  const setLiveView = useBrowserStore((state) => state.setLiveView)
  const setConsoleOpen = useBrowserStore((state) => state.setConsoleOpen)
  const setPageTextOpen = useBrowserStore((state) => state.setPageTextOpen)
  const setPageSnapshot = useBrowserStore((state) => state.setPageSnapshot)
  const setPanelError = useBrowserStore((state) => state.setPanelError)
  const setLiveViewBounds = useBrowserStore((state) => state.setLiveViewBounds)
  const setStoreStatus = useBrowserStore((state) => state.setStoreStatus)
  const applyTabs = useBrowserStore((state) => state.applyTabs)
  const clearConsole = useBrowserStore((state) => state.clearConsole)
  const resetTransient = useBrowserStore((state) => state.resetTransient)
  const { t } = useT()

  const [enabled, setEnabled] = useState<boolean>(() => getBrowserSettings().enabled)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [draftUrl, setDraftUrl] = useState<string>('')
  const [editingUrl, setEditingUrl] = useState<boolean>(false)
  const [dialogTabId, setDialogTabId] = useState<string | null>(null)
  const [dialogDetail, setDialogDetail] = useState<JsDialogInfo | null>(null)
  const [promptDraft, setPromptDraft] = useState<string>('')
  const [navState, setNavState] = useState<{ canGoBack: boolean; canGoForward: boolean } | null>(null)
  const [preview, setPreview] = useState<{ src: string; label: string } | null>(null)
  /** 页面文本抽屉读取状态（快照本体在 store，加载/错误是面板瞬态）。 */
  const [pageTextLoading, setPageTextLoading] = useState<boolean>(false)
  const [pageTextError, setPageTextError] = useState<string | null>(null)
  const [pageTextCopyState, setPageTextCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  /** stage 实测高度：figure 像素定高，避免依赖 flex 百分比解析链。 */
  const [stageHeightPx, setStageHeightPx] = useState<number | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  /** 导航进行中（地址栏 spinner）：URL 刷新或 5s 超时清除。 */
  const [navigating, setNavigating] = useState<boolean>(false)
  const liveInFlightRef = useRef(false)
  const liveBoxRef = useRef<HTMLDivElement | null>(null)
  const urlInputRef = useRef<HTMLInputElement | null>(null)
  const consoleListRef = useRef<HTMLDivElement | null>(null)
  const wheelPendingRef = useRef<{ x: number; y: number; timer: number | undefined }>({ x: 0, y: 0, timer: undefined })

  const isRunning = status?.running === true
  const activeTab = tabs.find((tab) => tab.active) ?? null
  const activeTabId = activeTab?.tabId ?? null
  const engine = status?.engine
  /** 直播帧只渲染 active tab 的（screencast 本就只对 active tab 推流）。 */
  const activeFrame = liveFrame && liveFrame.tabId === activeTabId ? liveFrame : null
  const renderLive = liveView && isRunning && screencastAvailable && activeFrame !== null
  const dialogTab = dialogTabId ? (tabs.find((tab) => tab.tabId === dialogTabId) ?? null) : null
  /** 暂停实时画面后仍显示最后一帧（浏览器的「冻结画面」语义）。 */
  const pausedFrame = !liveView && liveFrame && liveFrame.tabId === activeTabId ? liveFrame : null
  const activeConsoleEntries = activeTabId ? (consoleEntries[activeTabId] ?? []) : []
  /** 页面文本抽屉只展示 active tab 的快照（导航/切换后旧快照不串台）。 */
  const activePageSnapshot = pageSnapshot && pageSnapshot.tabId === activeTabId ? pageSnapshot : null
  // 徽标统计全部 tab 的错误数（抽屉内容仍只展示 active tab）。
  const consoleErrorCount = Object.values(consoleEntries)
    .flat()
    .filter((entry) => entry.level === 'error').length

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    setPreview(null)
    try {
      setEnabled(getBrowserSettings().enabled)
      // 先查 status，仅运行中才拉 tabs：tabs 动作带 spawn 门控，直接调会在
      // 面板挂载时静默拉起浏览器进程（启动失败还整页报错）。
      const statusResponse = await fetchBrowserStatus()
      if (statusResponse.type === 'status') {
        setStoreStatus({
          running: statusResponse.running,
          port: statusResponse.port,
          engine: statusResponse.engine,
          headless: statusResponse.headless,
          version: statusResponse.version,
          tabs: statusResponse.tabs,
        })
        if (statusResponse.running) {
          const tabsResponse = await browserCommand({ action: 'tabs' })
          if (tabsResponse.type === 'tabs') applyTabs(tabsResponse.tabs)
        } else {
          applyTabs([])
        }
      }
      // 面板健康即清除外部注入的错误（如「在面板打开链接」失败）。
      setPanelError(null)
    } catch (cause) {
      setError(toErrorMessage(cause, t('app.browserPanel.error.statusFailed')))
      setStoreStatus(null)
      applyTabs([])
    } finally {
      setLoading(false)
    }
  }, [applyTabs, setStoreStatus, setPanelError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 地址栏跟随 active tab 回显（事件总线实时更新）；用户正在编辑时不回写。
  useEffect(() => {
    if (editingUrl) return
    setDraftUrl(activeTab?.url ?? '')
  }, [activeTab?.url, editingUrl])

  // stage 高度实测：figure 定高无歧义（含 ResizeObserver 跟随拖拽调宽/面板开合）。
  useEffect(() => {
    const el = stageRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = (): void => {
      const height = Math.max(0, el.clientHeight)
      setStageHeightPx((current) => (current === height ? current : height))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // 打开浏览器面板（或浏览器启动完成）即自动开启实时画面：对齐 zcode
  // 「进入浏览器即可见页面」。Eye 按钮成为手动暂停/恢复；依赖不含 liveView，
  // 用户暂停后不会立刻被拉回，但切走面板再回来（重新 mount）会再次开启。
  useEffect(() => {
    if (!isRunning || liveView || !screencastAvailable) return
    setLiveView(true)
  }, [isRunning, screencastAvailable, setLiveView])

  // 导航指示清除：URL 刷新（frameNavigated 事件流）即判定完成；5s 兜底超时
  // 应付 reload 后 URL 不变、事件流迟到等场景。
  useEffect(() => {
    if (!activeTab?.url) return
    setNavigating(false)
  }, [activeTab?.url])
  useEffect(() => {
    if (!navigating) return
    const timeout = window.setTimeout(() => setNavigating(false), NAVIGATE_INDICATOR_TIMEOUT_MS)
    return () => window.clearTimeout(timeout)
  }, [navigating])

  // active tab 或其地址变化（激活/新建/导航——含 Agent 驱动）后同步导航历史
  // 边界，用于禁用后退/前进。
  useEffect(() => {
    if (!activeTabId) {
      setNavState(null)
      return
    }
    let cancelled = false
    browserCommand({ action: 'navigationHistory', tabId: activeTabId })
      .then((response) => {
        if (cancelled) return
        setNavState(
          response.type === 'navigationState'
            ? { canGoBack: response.canGoBack, canGoForward: response.canGoForward }
            : null,
        )
      })
      .catch(() => {
        if (!cancelled) setNavState(null)
      })
    return () => {
      cancelled = true
    }
  }, [activeTabId, activeTab?.url])

  /** 同 tab 内的后退/前进/刷新/导航不换 tabId，effect 不会触发，需显式同步。 */
  const syncNavState = async (tabId: string): Promise<void> => {
    try {
      const response = await browserCommand({ action: 'navigationHistory', tabId })
      setNavState(
        response.type === 'navigationState'
          ? { canGoBack: response.canGoBack, canGoForward: response.canGoForward }
          : null,
      )
    } catch {
      setNavState(null)
    }
  }

  // 直播容器尺寸上报：screencast 按面板显示尺寸捕获（控制帧体积）。直播
  // 容器随 renderLive 挂载/卸载，观察器必须跟着重建。
  useEffect(() => {
    const container = liveBoxRef.current
    if (!renderLive || !container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect || rect.width < 8 || rect.height < 8) return
      // ×dpr 上限 2：高分屏预览不糊，普通屏不过度捕获。
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      setLiveViewBounds({
        width: Math.round(rect.width * dpr),
        height: Math.round(rect.height * dpr),
      })
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [renderLive, setLiveViewBounds])

  // screencast 不可用（极旧引擎）时的回退：保留截图轮询路径。
  useEffect(() => {
    if (!liveView || screencastAvailable || !isRunning || !activeTabId) return
    let cancelled = false
    let timer: number | undefined
    const tick = async (): Promise<void> => {
      if (liveInFlightRef.current) return
      liveInFlightRef.current = true
      try {
        const response = await browserCommand({ action: 'screenshot', tabId: activeTabId })
        if (!cancelled && response.type === 'screenshot') {
          setPreview({
            src: `data:${response.mimeType};base64,${response.imageBase64}`,
            label: t('app.browserPanel.liveView.previewLabel', { width: response.width, height: response.height }),
          })
        }
      } catch {
        // 轮询失败（tab 关闭/浏览器退出）停表保留最后画面，不打断面板。
        if (!cancelled) setLiveView(false)
      } finally {
        liveInFlightRef.current = false
      }
    }
    const schedule = (): void => {
      timer = window.setTimeout(() => { void tick().then(schedule) }, LIVE_VIEW_POLL_MS)
    }
    void tick().then(schedule)
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [liveView, screencastAvailable, isRunning, activeTabId, setLiveView])

  const runBrowserAction = async (request: BrowserCommandRequest): Promise<boolean> => {
    setError(null)
    setPreview(null)
    try {
      const response = await browserCommand(request)
      if (response.type === 'tabs') applyTabs(response.tabs)
      // 面板自身动作成功即清除外部注入的错误（面板已恢复可操作）。
      setPanelError(null)
      return true
    } catch (cause) {
      setError(toErrorMessage(cause, t('app.browserPanel.error.actionFailed')))
      return false
    }
  }

  // ------------------------------------------------------------------
  // 「页面文本」抽屉：读 active tab 的 accessibility snapshot 文本，
  // 实时画面是像素，文本视图才是可读「页面内容」的通道。
  // ------------------------------------------------------------------

  const fetchPageSnapshot = useCallback(async (tabId: string): Promise<void> => {
    setPageTextLoading(true)
    setPageTextError(null)
    try {
      const response = await browserCommand({ action: 'snapshot', tabId })
      if (response.type === 'snapshot') {
        setPageSnapshot({
          tabId,
          url: response.url,
          title: response.title,
          text: response.text,
          truncated: response.truncated,
          at: Date.now(),
        })
        setPageTextCopyState('idle')
      }
    } catch (cause) {
      // 失败保留旧快照；旧数据不存在时抽屉内显示错误 + 重试。
      setPageTextError(toErrorMessage(cause, t('app.browserPanel.error.readPageTextFailed')))
    } finally {
      setPageTextLoading(false)
    }
  }, [setPageSnapshot])

  const copyPageText = async (): Promise<void> => {
    if (!activePageSnapshot) return
    try {
      await navigator.clipboard.writeText(activePageSnapshot.text)
      setPageTextCopyState('copied')
    } catch {
      setPageTextCopyState('failed')
    }
  }

  // 打开抽屉 / 切 active tab / 导航（同 tab 内导航不改 tabId，用 url 触发）
  // 时重读快照；开关状态在 store，切回面板（重新挂载）也会补拉。
  useEffect(() => {
    if (!pageTextOpen || !isRunning || !activeTabId) return
    void fetchPageSnapshot(activeTabId)
  }, [pageTextOpen, isRunning, activeTabId, activeTab?.url, fetchPageSnapshot])

  /** 有副作用的动作成功后重拉 tabs，保证列表与真实浏览器状态一致（事件
   * 总线 2s 内会覆盖为权威值，这里只是让用户动作立即反映）。 */
  const runBrowserActionAndResync = async (request: BrowserCommandRequest): Promise<void> => {
    if (await runBrowserAction(request)) await refresh()
  }

  /** 作用于 active 页面的动作：同 tab 内历史边界会变，resync 后需显式同步。 */
  const runActivePageAction = async (
    action: 'back' | 'forward' | 'reload',
    tabId: string,
  ): Promise<void> => {
    if (await runBrowserAction({ action, tabId })) {
      setNavigating(true)
      await refresh()
      await syncNavState(tabId)
    }
  }

  const startBrowser = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const settings = getBrowserSettings()
      setEnabled(settings.enabled)
      const response = await ensureBrowserRunning({
        enabled: settings.enabled,
        executablePath: settings.executablePath,
        headless: settings.headless,
        ignoreCertificateErrors: settings.ignoreCertificateErrors,
      })
      if (response.type === 'status') {
        setStoreStatus({
          running: response.running,
          port: response.port,
          engine: response.engine,
          headless: response.headless,
          version: response.version,
          tabs: response.tabs,
        })
      }
      await refresh()
    } catch (cause) {
      setError(toErrorMessage(cause, t('app.browserPanel.error.startFailed')))
    } finally {
      setLoading(false)
    }
  }

  const shutdown = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      await shutdownBrowser()
      setStoreStatus({ running: false })
      resetTransient()
      setDialogTabId(null)
      setPreview(null)
    } catch (cause) {
      setError(toErrorMessage(cause, t('app.browserPanel.error.shutdownFailed')))
    } finally {
      setLoading(false)
    }
  }

  const submitDraftUrl = async (): Promise<void> => {
    const url = normalizeUrlInput(draftUrl)
    if (!url) return
    // 与 active tab 当前地址一致时跳过，避免回车重复导航打断页面。
    if (activeTab && url === activeTab.url) {
      setEditingUrl(false)
      return
    }
    setLoading(true)
    const request: BrowserCommandRequest = activeTab
      ? { action: 'navigate', tabId: activeTab.tabId, url }
      : { action: 'newTab', url }
    if (await runBrowserAction(request)) {
      setDraftUrl('')
      setEditingUrl(false)
      if (activeTab) {
        setNavigating(true)
        await syncNavState(activeTab.tabId)
      } else {
        // 新建 tab 后聚焦地址栏：直接进入输入态（约带 about:blank 的新 tab）。
        urlInputRef.current?.focus()
        setEditingUrl(true)
      }
      await refresh()
    } else {
      setLoading(false)
    }
  }

  const onUrlFormSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void submitDraftUrl()
  }

  const onUrlKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    setDraftUrl(activeTab?.url ?? '')
    setEditingUrl(false)
    event.currentTarget.blur()
  }

  /** 聚焦即全选当前 URL：重导航常用操作，省掉手动选中。 */
  const onUrlFocus = (event: React.FocusEvent<HTMLInputElement>): void => {
    setEditingUrl(true)
    event.currentTarget.select()
  }

  // ------------------------------------------------------------------
  // 实时画面交互：显示坐标 → 页面坐标按比例换算后经 CDP Input 注入。
  // ------------------------------------------------------------------

  const pagePointFromEvent = (
    event: { clientX: number; clientY: number },
    element: HTMLElement,
  ): { x: number; y: number } | null => {
    if (!activeFrame) return null
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: ((event.clientX - rect.left) / rect.width) * activeFrame.width,
      y: ((event.clientY - rect.top) / rect.height) * activeFrame.height,
    }
  }

  const onLiveClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!activeTabId || event.defaultPrevented) return
    const point = pagePointFromEvent(event, event.currentTarget)
    if (!point) return
    void runBrowserAction({ action: 'clickAt', tabId: activeTabId, x: point.x, y: point.y })
  }

  /** 滚轮转发（非受控 wheel 必须手动挂 non-passive 监听才能 preventDefault）。 */
  useEffect(() => {
    const container = liveBoxRef.current
    if (!renderLive || !container || !activeFrame || !activeTabId) return
    const flush = (): void => {
      const pending = wheelPendingRef.current
      pending.timer = undefined
      const { x, y } = pending
      pending.x = 0
      pending.y = 0
      if (!activeTabId || (x === 0 && y === 0)) return
      // 滚动锚点取画面中心：滚轮事件不带指针位置，Rust 侧还会 clamp 进视口。
      void browserCommand({
        action: 'scrollAt',
        tabId: activeTabId,
        x: activeFrame.width / 2,
        y: activeFrame.height / 2,
        deltaX: x,
        deltaY: y,
      }).catch(() => undefined)
    }
    const onWheel = (event: WheelEvent): void => {
      if (!activeTabId) return
      event.preventDefault()
      const pending = wheelPendingRef.current
      pending.x = clampDelta(pending.x + event.deltaX)
      pending.y = clampDelta(pending.y + event.deltaY)
      if (pending.timer === undefined) {
        pending.timer = window.setTimeout(flush, WHEEL_FLUSH_MS)
      }
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      container.removeEventListener('wheel', onWheel)
      const pending = wheelPendingRef.current
      if (pending.timer !== undefined) {
        window.clearTimeout(pending.timer)
        pending.timer = undefined
      }
      pending.x = 0
      pending.y = 0
    }
  }, [renderLive, activeFrame, activeTabId])

  const onLiveKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!activeTabId) return
    // 带功能修饰键的组合留给系统/应用快捷键，不注入页面。
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const mapped = DOM_KEY_TO_BROWSER[event.key]
    const key = mapped ?? (event.key.length === 1 ? event.key : null)
    if (!key) return
    event.preventDefault()
    void runBrowserAction({ action: 'press', tabId: activeTabId, key })
  }

  // console 抽屉自动滚到最新条目。
  useEffect(() => {
    const list = consoleListRef.current
    if (list && consoleOpen) list.scrollTop = list.scrollHeight
  }, [activeConsoleEntries.length, consoleOpen])

  const respondDialog = (tabId: string, accept: boolean): void => {
    setDialogTabId(null)
    setDialogDetail(null)
    // prompt() 对话框接受时携带用户输入的回应文本；其余对话框无此参数。
    const trimmed = promptDraft.trim()
    const promptText = dialogDetail?.kind === 'prompt' && trimmed ? trimmed : undefined
    setPromptDraft('')
    void runBrowserActionAndResync({
      action: 'respondDialog',
      tabId,
      accept,
      ...(promptText ? { promptText } : {}),
    })
  }

  const expandDialog = (tabId: string): void => {
    setDialogTabId(tabId)
    setDialogDetail(null)
    setPromptDraft('')
    void browserCommand({ action: 'dialog', tabId })
      .then((response) => {
        if (response.type === 'dialogState') setDialogDetail(response.dialog ?? null)
      })
      .catch(() => setDialogDetail(null))
  }

  const collapseDialog = (): void => {
    setDialogTabId(null)
    setDialogDetail(null)
    setPromptDraft('')
  }

  const goToSettings = (): void => {
    setSettingsSection('browser')
    setView('settings')
  }

  const navDisabled = !isRunning || !activeTab
  // 历史边界未知（navState 为 null）时保持可点，由 Rust 侧边界拒绝兜底。
  const backDisabled = navDisabled || (navState !== null && !navState.canGoBack)
  const forwardDisabled = navDisabled || (navState !== null && !navState.canGoForward)

  const liveActive = liveView && isRunning && activeTabId !== null
  /** 动作级失败（组件 error）与面板外注入的 panelError 合并为同一条横幅。 */
  const displayError = error ?? panelError

  return (
    <section className="rail__panel rail__browser-panel" aria-label={t('app.browserPanel.aria')}>
      {isRunning && tabs.length > 0 && (
        <div className="rail__browser-tabs" role="tablist" aria-label={t('app.browserPanel.tabList')}>
          {tabs.map((tab) => {
            const rowName = tab.title || tab.url
            const dialogOpen = dialogTabId === tab.tabId
            return (
              <div
                key={tab.tabId}
                className={`rail__browser-tab ${tab.active ? 'rail__browser-tab--active' : ''}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.active}
                  className="rail__browser-tab-main"
                  title={tab.active ? t('app.browserPanel.tab.titleActive', { name: rowName }) : t('app.browserPanel.tab.titleInactive', { name: rowName })}
                  onClick={() => {
                    if (!tab.active) {
                      void runBrowserActionAndResync({ action: 'activateTab', tabId: tab.tabId })
                    }
                  }}
                >
                  <span className="rail__browser-tab-favicon" aria-hidden>
                    {(tab.title || tab.url || '?').trim().charAt(0).toUpperCase()}
                  </span>
                  <span className="rail__browser-tab-title">{tab.title || t('app.browserPanel.tabs.untitled')}</span>
                </button>
                {tab.hasDialog && (
                  <button
                    type="button"
                    className="rail__browser-tab-warn"
                    aria-label={t('app.browserPanel.tab.handleDialogAria', { name: rowName })}
                    aria-expanded={dialogOpen}
                    title={dialogOpen ? t('app.browserPanel.tab.handleDialogTitle.collapse') : t('app.browserPanel.tab.handleDialogTitle.expand')}
                    onClick={() => { if (dialogOpen) collapseDialog(); else expandDialog(tab.tabId) }}
                  >
                    <AlertTriangle size={11} />
                  </button>
                )}
                <button
                  type="button"
                  className="rail__browser-tab-close"
                  aria-label={t('app.browserPanel.tab.closeAria', { name: rowName })}
                  title={t('app.browserPanel.tab.closeTitle')}
                  onClick={() => { void runBrowserActionAndResync({ action: 'closeTab', tabId: tab.tabId }) }}
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}
          <button
            type="button"
            className="rail__browser-tab-new"
            aria-label={t('app.browserPanel.tab.newAria')}
            title={t('app.browserPanel.tab.newTitle')}
            onClick={() => { void runBrowserActionAndResync({ action: 'newTab', url: 'about:blank' }) }}
          >
            <Plus size={13} />
          </button>
        </div>
      )}
      {enabled && (
        <div className="rail__browser-toolbar">
          <button
            type="button"
            className="rail__browser-navbtn"
            aria-label={t('app.browserPanel.nav.backAria')}
            title={t('app.browserPanel.nav.backTitle')}
            disabled={backDisabled}
            onClick={() => { if (activeTab) void runActivePageAction('back', activeTab.tabId) }}
          >
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            className="rail__browser-navbtn"
            aria-label={t('app.browserPanel.nav.forwardAria')}
            title={t('app.browserPanel.nav.forwardTitle')}
            disabled={forwardDisabled}
            onClick={() => { if (activeTab) void runActivePageAction('forward', activeTab.tabId) }}
          >
            <ChevronRight size={15} />
          </button>
          <button
            type="button"
            className="rail__browser-navbtn"
            aria-label={t('app.browserPanel.nav.reloadAria')}
            title={t('app.browserPanel.nav.reloadTitle')}
            disabled={navDisabled}
            onClick={() => { if (activeTab) void runActivePageAction('reload', activeTab.tabId) }}
          >
            <RotateCw size={13} />
          </button>
          <form className="rail__browser-urlform" onSubmit={onUrlFormSubmit}>
            <span className="rail__browser-url-lock" aria-hidden>
              {activeTab?.url?.startsWith('https://') ? <Lock size={10} /> : <Globe size={10} />}
            </span>
            <input
              ref={urlInputRef}
              className="rail__browser-url"
              aria-label={t('app.browserPanel.address.aria')}
              placeholder={t('app.browserPanel.address.placeholder')}
              value={draftUrl}
              onChange={(event) => { setDraftUrl(event.target.value) }}
              onFocus={onUrlFocus}
              onBlur={() => { setEditingUrl(false) }}
              onKeyDown={onUrlKeyDown}
              spellCheck={false}
              autoComplete="off"
            />
            {navigating && !editingUrl && (
              <span className="rail__browser-url-spinner" aria-label={t('app.browserPanel.address.loadingAria')}>
                <RotateCw size={11} />
              </span>
            )}
          </form>
          <button
            type="button"
            className="rail__browser-navbtn"
            aria-label={t('app.browserPanel.external.openAria')}
            title={t('app.browserPanel.external.openTitle')}
            disabled={navDisabled || !activeTab?.url || activeTab.url === 'about:blank'}
            onClick={() => { if (activeTab?.url) { void openExternalUrl(activeTab.url).catch(() => undefined) } }}
          >
            <ExternalLink size={13} />
          </button>
          <button
            type="button"
            className={`rail__browser-navbtn ${liveView ? 'rail__browser-navbtn--live' : ''}`}
            aria-label={t('app.browserPanel.liveView.aria')}
            aria-pressed={liveView}
            title={liveView ? t('app.browserPanel.liveView.titleOn') : t('app.browserPanel.liveView.titleOff')}
            disabled={navDisabled}
            onClick={() => { setLiveView(!liveView) }}
          >
            <Eye size={13} />
          </button>
          <button
            type="button"
            className={`rail__browser-navbtn ${consoleOpen ? 'rail__browser-navbtn--console-open' : ''}`}
            aria-label={t('app.browserPanel.console.toggleAria')}
            aria-pressed={consoleOpen}
            title={consoleOpen ? t('app.browserPanel.console.toggleTitleOn') : t('app.browserPanel.console.toggleTitleOff')}
            disabled={navDisabled}
            onClick={() => {
              const next = !consoleOpen
              setConsoleOpen(next)
              // 抽屉互斥：一次只看一类信息，避免舞台被双层抽屉压扁。
              if (next) setPageTextOpen(false)
            }}
          >
            <Terminal size={13} />
            {consoleErrorCount > 0 && (
              <span className="rail__browser-console-badge" title={t('app.browserPanel.console.badgeTitle', { count: consoleErrorCount })}>
                {consoleErrorCount > 99 ? '99+' : consoleErrorCount}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`rail__browser-navbtn ${pageTextOpen ? 'rail__browser-navbtn--text-open' : ''}`}
            aria-label={t('app.browserPanel.pageText.toggleAria')}
            aria-pressed={pageTextOpen}
            title={pageTextOpen ? t('app.browserPanel.pageText.toggleTitleOn') : t('app.browserPanel.pageText.toggleTitleOff')}
            disabled={navDisabled}
            onClick={() => {
              const next = !pageTextOpen
              setPageTextOpen(next)
              if (next) setConsoleOpen(false)
            }}
          >
            <FileText size={13} />
          </button>
        </div>
      )}
      {dialogTab && (
        <div className="rail__browser-dialog-bar">
          {dialogDetail && (
            <span className="rail__browser-dialog-message">
              <span className="rail__browser-dialog-kind">{dialogKindLabel(dialogDetail.kind, t)}</span>
              {dialogDetail.message}
            </span>
          )}
          {dialogDetail?.kind === 'prompt' && (
            <input
              className="rail__browser-dialog-input"
              aria-label={t('app.browserPanel.dialog.respondAria', { tab: dialogTab.title || dialogTab.url })}
              placeholder={t('app.browserPanel.dialog.respondPlaceholder')}
              value={promptDraft}
              onChange={(event) => { setPromptDraft(event.target.value) }}
              spellCheck={false}
            />
          )}
          <span className="rail__browser-row-dialog-actions">
            <button type="button" onClick={() => { respondDialog(dialogTab.tabId, true) }}>
              {t('app.browserPanel.dialog.accept')}
            </button>
            <button type="button" onClick={() => { respondDialog(dialogTab.tabId, false) }}>
              {t('app.browserPanel.dialog.reject')}
            </button>
          </span>
        </div>
      )}
      <div className="rail__browser-stage" ref={stageRef}>
        {renderLive && activeFrame && (
          <figure
            className="rail__browser-preview rail__browser-preview--live"
            aria-label={t('app.browserPanel.liveView.aria')}
            style={stageHeightPx !== null ? { height: `${stageHeightPx}px` } : undefined}
          >
            <div
              ref={liveBoxRef}
              className="rail__browser-livebox"
              role="button"
              tabIndex={0}
              aria-label={t('app.browserPanel.liveView.liveboxAria')}
              title={t('app.browserPanel.liveView.liveboxTitle')}
              style={{ aspectRatio: `${activeFrame.width} / ${activeFrame.height}` }}
              onClick={onLiveClick}
              onKeyDown={onLiveKeyDown}
            >
              <img src={activeFrame.src} alt={t('app.browserPanel.liveView.altActive')} draggable={false} />
            </div>
            <figcaption>
              <span className="rail__browser-preview-live">{t('app.browserPanel.liveView.label')}</span>
              {activeFrame.width}×{activeFrame.height}
            </figcaption>
          </figure>
        )}
        {pausedFrame && (
          <figure className="rail__browser-preview rail__browser-preview--live" aria-label={t('app.browserPanel.liveView.labelPaused')}>
            <div
              className="rail__browser-livebox"
              style={{ aspectRatio: `${pausedFrame.width} / ${pausedFrame.height}` }}
            >
              <img src={pausedFrame.src} alt={t('app.browserPanel.liveView.altPaused')} draggable={false} />
            </div>
            <figcaption>
              <span className="rail__browser-preview-paused">{t('app.browserPanel.liveView.labelPaused')}</span>
              {pausedFrame.width}×{pausedFrame.height}
            </figcaption>
          </figure>
        )}
        {liveActive && !renderLive && !preview && !pausedFrame && (
          <div className="rail__browser-live-pending" aria-live="polite">
            {t('app.browserPanel.liveView.opening')}
          </div>
        )}
        {preview && !renderLive && (
          <figure className="rail__browser-preview">
            <img src={preview.src} alt={t('app.browserPanel.liveView.altSnapshot')} />
            <figcaption>
              {liveView && <span className="rail__browser-preview-live">{t('app.browserPanel.liveView.label')}</span>}
              {preview.label}
            </figcaption>
            {!liveView && (
              <button
                type="button"
                className="rail__browser-preview-close"
                aria-label={t('app.browserPanel.liveView.closeSnapshotAria')}
                title={t('app.browserPanel.liveView.closeSnapshotTitle')}
                onClick={() => { setPreview(null) }}
              >
                <X size={12} />
              </button>
            )}
          </figure>
        )}
        {(() => {
          if (!enabled) {
            return (
              <BrowserEmpty
                icon={<Globe size={34} strokeWidth={1.5} />}
                title={t('app.browserPanel.empty.disabled.title')}
                hint={t('app.browserPanel.empty.disabled.hint')}
                action={
                  <button type="button" className="rail__browser-action" onClick={goToSettings}>
                    {t('app.browserPanel.empty.disabled.action')}
                  </button>
                }
              />
            )
          }
          // 拉取彻底失败（没有任何 status 数据）才整页报错；动作级错误走行内横幅。
          if (error && !status) {
            return (
              <BrowserEmpty
                icon={<Globe size={34} strokeWidth={1.5} />}
                title={t('app.browserPanel.empty.fetchFailed.title')}
                hint={error}
                action={
                  <button
                    type="button"
                    className="rail__browser-action"
                    onClick={() => { void refresh() }}
                  >
                    {t('app.browserPanel.empty.fetchFailed.retry')}
                  </button>
                }
              />
            )
          }
          return (
            <>
              {/* 面板动作失败（组件本地 error）与面板外注入的 panelError 合并展示。 */}
          {displayError && <div className="rail__browser-error" role="alert">{displayError}</div>}
              {!isRunning ? (
                <BrowserEmpty
                  icon={<Globe size={34} strokeWidth={1.5} />}
                  title={t('app.browserPanel.empty.notStarted.title')}
                  hint={t('app.browserPanel.empty.notStarted.hint')}
                  action={
                    <button
                      type="button"
                      className="rail__browser-action rail__browser-action--primary"
                      onClick={() => { void startBrowser() }}
                      disabled={loading}
                    >
                      {loading ? t('app.browserPanel.empty.notStarted.starting') : t('app.browserPanel.empty.notStarted.start')}
                    </button>
                  }
                />
              ) : tabs.length === 0 ? (
                <BrowserEmpty
                  icon={<Globe size={34} strokeWidth={1.5} />}
                  title={t('app.browserPanel.empty.idle.title')}
                  hint={t('app.browserPanel.empty.idle.hint')}
                />
              ) : (
                // 有 tab 时主区由实时画面/暂停帧/预览占据，空态不得同框。
                null
              )}
            </>
          )
        })()}
      </div>
      {enabled && isRunning && consoleOpen && activeTabId && (
        <div className="rail__browser-console">
          <div className="rail__browser-console-header">
            <span className="rail__browser-console-title">
              {activeConsoleEntries.length > 0
                ? t('app.browserPanel.console.titleWithCount', { count: activeConsoleEntries.length })
                : t('app.browserPanel.console.title')}
            </span>
            <button
              type="button"
              className="rail__browser-console-clear"
              aria-label={t('app.browserPanel.console.clearAria')}
              title={t('app.browserPanel.console.clearTitle')}
              disabled={activeConsoleEntries.length === 0}
              onClick={() => { clearConsole(activeTabId) }}
            >
              <Trash2 size={12} />
            </button>
          </div>
          <div className="rail__browser-console-list" ref={consoleListRef}>
            {activeConsoleEntries.length === 0
              ? (
                <div className="rail__browser-console-empty">{t('app.browserPanel.console.empty')}</div>
              )
              : activeConsoleEntries.map((entry, index) => (
                <ConsoleLine key={`${entry.timestamp}-${index}`} entry={entry} />
              ))}
          </div>
        </div>
      )}
      {enabled && isRunning && pageTextOpen && activeTabId && (
        <div className="rail__browser-text">
          <div className="rail__browser-text-header">
            <span className="rail__browser-text-title">
              {activePageSnapshot
                ? t('app.browserPanel.pageText.titleWithTab', { title: activePageSnapshot.title || activePageSnapshot.url })
                : t('app.browserPanel.pageText.title')}
            </span>
            <button
              type="button"
              className="rail__browser-text-action"
              aria-label={t('app.browserPanel.pageText.retryAria')}
              title={t('app.browserPanel.pageText.retryTitle')}
              disabled={pageTextLoading}
              onClick={() => { void fetchPageSnapshot(activeTabId) }}
            >
              <RefreshCw size={12} />
            </button>
            <button
              type="button"
              className="rail__browser-text-action"
              aria-label={t('app.browserPanel.pageText.copyAria')}
              title={pageTextCopyState === 'copied'
                ? t('app.browserPanel.pageText.copyTitleCopied')
                : t('app.browserPanel.pageText.copyTitleDefault')}
              disabled={!activePageSnapshot}
              onClick={() => { void copyPageText() }}
            >
              {pageTextCopyState === 'copied' ? <Check size={12} /> : <Copy size={12} />}
            </button>
            <button
              type="button"
              className="rail__browser-text-action"
              aria-label={t('app.browserPanel.pageText.collapseAria')}
              title={t('app.browserPanel.pageText.collapseTitle')}
              onClick={() => { setPageTextOpen(false) }}
            >
              <X size={12} />
            </button>
          </div>
          <div className="rail__browser-text-body">
            {pageTextLoading && !activePageSnapshot ? (
              <div className="rail__browser-text-empty">{t('app.browserPanel.pageText.loading')}</div>
            ) : pageTextError && !activePageSnapshot ? (
              <div className="rail__browser-text-fail">
                <span className="rail__browser-text-error">{pageTextError}</span>
                <button
                  type="button"
                  className="rail__browser-action"
                  onClick={() => { void fetchPageSnapshot(activeTabId) }}
                >
                  {t('app.browserPanel.pageText.retry')}
                </button>
              </div>
            ) : activePageSnapshot ? (
              <>
                <pre className="rail__browser-text-pre">
                  {activePageSnapshot.text || t('app.browserPanel.pageText.emptyText')}
                </pre>
                {activePageSnapshot.truncated && (
                  <div className="rail__browser-text-truncated">
                    {t('app.browserPanel.pageText.truncated')}
                  </div>
                )}
                <div className="rail__browser-text-age">
                  {t('app.browserPanel.pageText.readAt', { time: new Date(activePageSnapshot.at).toLocaleTimeString() })}
                </div>
              </>
            ) : (
              <div className="rail__browser-text-empty">{t('app.browserPanel.pageText.clickToFetch')}</div>
            )}
          </div>
        </div>
      )}
      {enabled && (
        <div className="rail__browser-footer">
          <span className="rail__browser-status">
            <span className={`rail__browser-dot ${isRunning ? 'rail__browser-dot--running' : ''}`} aria-hidden />
            <span className="rail__browser-status-text">
              {isRunning
                ? engine
                  ? t('app.browserPanel.footer.status.runningWithEngine', { count: tabs.length, engine })
                  : t('app.browserPanel.footer.status.runningSimple', { count: tabs.length })
                : t('app.browserPanel.footer.status.idle')}
            </span>
          </span>
          <button
            type="button"
            className="rail__browser-navbtn"
            aria-label={t('app.browserPanel.footer.refreshAria')}
            title={t('app.browserPanel.footer.refreshTitle')}
            disabled={loading}
            onClick={() => { void refresh() }}
          >
            <RefreshCw size={12} />
          </button>
          <button
            type="button"
            className="rail__browser-shutdown"
            onClick={() => { void shutdown() }}
            disabled={loading || !isRunning}
          >
            {t('app.browserPanel.footer.shutdown')}
          </button>
        </div>
      )}
    </section>
  )
}

const clampDelta = (value: number): number =>
  Math.max(-4000, Math.min(4000, value))

const ConsoleLine = ({ entry }: { entry: ConsoleEntry }) => {
  const { t } = useT()
  return (
    <div className={`rail__browser-console-line rail__browser-console-line--${entry.level}`}>
      <span className="rail__browser-console-level">{consoleLevelLabel(entry.level, t)}</span>
      <span className="rail__browser-console-text" title={`${entry.source} · ${entry.text}`}>
        {entry.text}
      </span>
    </div>
  )
}

/**
 * 补全 URL scheme：本机地址先判断（`localhost:5174` 的 `localhost:` 会被
 * 通用 scheme 正则误认为协议，必须前置），显式 http(s) 原样透传，
 * 其它 scheme 原样透传交由 Rust 侧校验拒绝，其余补 https://。
 */
const normalizeUrlInput = (raw: string): string | null => {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(trimmed)) {
    return `http://${trimmed}`
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

interface BrowserEmptyProps {
  icon: ReactNode
  title: string
  hint: string
  action?: ReactNode
}

const BrowserEmpty = ({ icon, title, hint, action }: BrowserEmptyProps) => (
  <div className="rail__browser-empty-block">
    <div className="rail__browser-empty-icon">{icon}</div>
    <div className="rail__browser-empty-title">{title}</div>
    <div className="rail__browser-empty-hint">{hint}</div>
    {action && <div className="rail__browser-empty-action">{action}</div>}
  </div>
)
