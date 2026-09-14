import { create } from 'zustand'
import type { ImageContentBlock } from '@/agent/core/types'
import { setIdleSleepPrevention } from '@/platform/power'
import { setWorkspaceApprovalMode } from '@/platform/workspaceApproval'
import { syncNativeWindowTheme } from '@/platform/windowTheme'
import { detectSystemLanguage, resolveLanguage } from '@/i18n/locale'

export type AppView = 'new-task' | 'session' | 'ssh' | 'settings'
export type SettingsSection = 'general' | 'browser' | 'computer' | 'models' | 'sessions' | 'usage' | 'archived' | 'skills' | 'subagents' | 'about'
/** 右侧运行时面板的视图枚举：浏览器 / 电脑控制。SSH 自设计稿起迁出 rail，
 * 改由侧栏导航进入独立全窗口视图（SshView）。会话内有效，不持久化。 */
export type RuntimeRailTab = 'browser' | 'computer'
/** rail 面板模式：picker = 卡片选择页；其余为具体功能面板。 */
export type RuntimeRailPane = 'picker' | RuntimeRailTab
export type AccessMode = 'standard' | 'no-approval'
export type UiLanguage = 'system' | 'zh-CN' | 'en'
export type UiTheme = 'system' | 'dark' | 'light'
/** 等宽字体偏好（代码块/内联代码/终端共用）；默认 JetBrains Mono（与 --font-mono 一致）。 */
export type MonoFontFamily = 'jetbrains' | 'menlo' | 'sf-mono' | 'monaco'
export type SummaryRequest =
  | { mode: 'compaction' }
  | { mode: 'branch'; messageId: string }
/** 待编辑的已发送用户消息：操作行点击「编辑」后回填 Composer，提交时分支重发。
 *  带上会话 id——切走会话后残留的请求不得回填到别的会话的输入框。
 *  images 是原消息的图片块：编辑重发从分支边界重建消息，不带会把图丢掉。 */
export interface MessageEditRequest {
  sessionId: string
  messageId: string
  content: string
  images?: ImageContentBlock[]
}
/** 会话输出窗口截图的灯箱：点击缩略图查看原图，Esc/点击遮罩关闭。 */
export interface ImageLightboxState {
  src: string
  alt: string
}
/** 反馈弹窗请求：帮助菜单「需求/问题」打开同一弹窗，按入口预选类型。 */
export type FeedbackKind = 'feature' | 'bug'
export interface FeedbackRequest {
  kind: FeedbackKind
}
/** 自更新流程阶段：downloading 的字节进度在 updateProgress，错误文案在 updateMessage。 */
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'uptodate' | 'disabled' | 'error'
export interface AvailableAppUpdate {
  version: string
  notes: string | null
  pubDate: string | null
}
export interface UpdateProgressState {
  downloadedBytes: number
  totalBytes: number | null
}

const ACCESS_MODE_STORAGE_KEY = 'axiom.access.mode.v1'
const UI_LANGUAGE_STORAGE_KEY = 'axiom.ui.language.v1'
const UI_THEME_STORAGE_KEY = 'axiom.ui.theme.v1'
const UI_FONT_SIZE_STORAGE_KEY = 'axiom.ui.fontSizePx.v1'
const MONO_FONT_FAMILY_STORAGE_KEY = 'axiom.ui.monoFontFamily.v1'
const GIT_BRANCH_PREFIX_STORAGE_KEY = 'axiom.git.branch.prefix.v1'
const PREVENT_IDLE_SLEEP_STORAGE_KEY = 'axiom.power.preventIdleSleep.v1'
const PROJECT_SKILLS_ENABLED_STORAGE_KEY = 'axiom.skills.project.v1'
const RECENT_WORKSPACE_STORAGE_KEY = 'axiom.workspace.recent.v1'
const TERMINAL_PANEL_HEIGHT_STORAGE_KEY = 'axiom.terminal.panelHeight.v1'
const SFTP_PANEL_HEIGHT_STORAGE_KEY = 'axiom.sftp.panelHeight.v1'
const RUNTIME_RAIL_WIDTH_STORAGE_KEY = 'axiom.runtime.railWidth.v1'
const MAX_RECENT_WORKSPACES = 20

export const DEFAULT_TERMINAL_PANEL_HEIGHT = 240
export const MIN_TERMINAL_PANEL_HEIGHT = 120
// 终端面板之外至少为会话主体（header + 输入区）保留的高度，防止面板拖满整窗。
export const TERMINAL_PANEL_BODY_RESERVED_HEIGHT = 180
export const DEFAULT_SFTP_PANEL_HEIGHT = 320
export const MIN_SFTP_PANEL_HEIGHT = 160
// SFTP 面板之外至少为终端区（hostbar + 状态栏 + 数行可见终端）保留的高度，
// 防止面板拖满整个终端栏。
export const SFTP_PANEL_BODY_RESERVED_HEIGHT = 180
export const DEFAULT_RUNTIME_RAIL_WIDTH = 288
// 下限按浏览器工具栏的刚性宽度定：5 个 24px 按钮 + 间距 + 地址栏可读最小值
// （约 90px），220 会让 + 按钮与页脚「关闭浏览器」溢出裁切。
export const MIN_RUNTIME_RAIL_WIDTH = 280
// 上限保证会话主体（消息列 + composer）在常见窗口宽度下仍有可用空间。
export const MAX_RUNTIME_RAIL_WIDTH = 520
// rail 之外至少为会话主体保留的宽度：过窄窗口下 rail 让位，不把消息列挤没。
const RUNTIME_RAIL_BODY_RESERVED_WIDTH = 420
// innerHeight 不可用（SSR / 测试 stub window）时的兜底视口高度。
const FALLBACK_VIEWPORT_HEIGHT = 1024
// innerWidth 不可用时的兜底视口宽度。
const FALLBACK_VIEWPORT_WIDTH = 1280

/** 界面字号偏好（px 基准值）：选项见 UI_FONT_SIZE_OPTIONS，默认 13 与历史一致。 */
export const DEFAULT_UI_FONT_SIZE_PX = 13
/** 字号上限 16：UI 按 13px 设计，px 布局与行高不缩放，放大过多会挤占固定高度控件。 */
export const MIN_UI_FONT_SIZE_PX = 12
export const MAX_UI_FONT_SIZE_PX = 16
export const UI_FONT_SIZE_OPTIONS: ReadonlyArray<number> = [12, 13, 14, 15, 16]
/** 等宽字体选项（设置页展示序）。 */
export const MONO_FONT_FAMILY_OPTIONS: ReadonlyArray<MonoFontFamily> = [
  'jetbrains',
  'menlo',
  'sf-mono',
  'monaco',
]

/**
 * 各等宽偏好的完整 CSS 栈（首项为所选字体，尾部兜底与 tokens.css 的
 * --font-mono 默认一致——JetBrains Mono 之外的选项经 documentElement
 * 内联变量覆盖生效；CJK 成员保证代码/终端里的中文走 PingFang 显式回退）。
 */
export const MONO_FONT_STACKS: Record<MonoFontFamily, string> = {
  jetbrains: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'PingFang SC', 'Noto Sans CJK SC', monospace",
  menlo: "'Menlo', ui-monospace, SFMono-Regular, 'PingFang SC', monospace",
  'sf-mono': "ui-monospace, SFMono-Regular, 'PingFang SC', monospace",
  monaco: "'Monaco', ui-monospace, 'PingFang SC', monospace",
}

/** xterm 等 canvas 终端不吃 CSS rem，字号需按界面基准等比换算为设备 px。 */
export const scaledTerminalFontSize = (basePx: number, fontSizePx: number): number =>
  Math.min(24, Math.max(9, Math.round((basePx * fontSizePx) / DEFAULT_UI_FONT_SIZE_PX)))

const DEFAULT_GIT_BRANCH_PREFIX = 'feat-'

const loadUiLanguage = (): UiLanguage => {
  if (typeof window === 'undefined') return 'system'
  const stored = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)
  return stored === 'zh-CN' || stored === 'en' ? stored : 'system'
}

const applyUiLanguage = (language: UiLanguage): void => {
  if (typeof document === 'undefined') return
  // system 模式按系统语言解析后写 <html lang>，避免无障碍/字体回退与界面语言脱节。
  document.documentElement.lang = resolveLanguage(language, detectSystemLanguage())
}

const loadUiTheme = (): UiTheme => {
  if (typeof window === 'undefined') return 'system'
  const stored = window.localStorage.getItem(UI_THEME_STORAGE_KEY)
  return stored === 'dark' || stored === 'light' ? stored : 'system'
}

const applyUiTheme = (theme: UiTheme): void => {
  if (typeof document === 'undefined') return
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.dataset.theme = theme
  // data-theme 只管页面内配色；原生控件（select 下拉等）跟随 NSApp 外观，
  // 需同步到原生窗口，否则主题与系统外观不一致时原生弹层配色错位。
  void syncNativeWindowTheme(theme)
}

const clampUiFontSizePx = (value: number): number =>
  Math.min(MAX_UI_FONT_SIZE_PX, Math.max(MIN_UI_FONT_SIZE_PX, Math.round(value)))

const loadUiFontSizePx = (): number => {
  if (typeof window === 'undefined') return DEFAULT_UI_FONT_SIZE_PX
  const raw = window.localStorage.getItem(UI_FONT_SIZE_STORAGE_KEY)
  // 注意 Number(null) === 0：缺失键必须显式回默认，不能走数值解析。
  if (raw === null) return DEFAULT_UI_FONT_SIZE_PX
  const stored = Number(raw)
  if (!Number.isFinite(stored)) return DEFAULT_UI_FONT_SIZE_PX
  return clampUiFontSizePx(stored)
}

/** 界面字号经根元素内联 --ui-font-size 生效：全部 rem 字号（base.css）随动缩放。 */
const applyUiFontSizePx = (fontSizePx: number): void => {
  if (typeof document === 'undefined') return
  document.documentElement.style?.setProperty('--ui-font-size', `${fontSizePx}px`)
}

const loadMonoFontFamily = (): MonoFontFamily => {
  if (typeof window === 'undefined') return 'jetbrains'
  const stored = window.localStorage.getItem(MONO_FONT_FAMILY_STORAGE_KEY)
  return stored === 'menlo' || stored === 'sf-mono' || stored === 'monaco' ? stored : 'jetbrains'
}

/** 等宽字体经根元素内联 --font-mono 覆盖：CSS 消费方与 xterm 同栈。 */
const applyMonoFontFamily = (family: MonoFontFamily): void => {
  if (typeof document === 'undefined') return
  document.documentElement.style?.setProperty('--font-mono', MONO_FONT_STACKS[family])
}

const loadAccessMode = (): AccessMode => {
  if (typeof window === 'undefined') return 'standard'
  const stored = window.localStorage.getItem(ACCESS_MODE_STORAGE_KEY)
  // 旧版 'high-risk' 已下线：收窄后自动映射为 standard（意图确认语义，fail-closed）。
  if (stored === 'standard' || stored === 'no-approval') return stored
  return 'standard'
}

const loadRecentWorkspacePaths = (): string[] => {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(RECENT_WORKSPACE_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((path): path is string => typeof path === 'string' && path.length > 0)
      .slice(0, MAX_RECENT_WORKSPACES)
  } catch {
    return []
  }
}

const persistRecentWorkspacePaths = (paths: string[]): void => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(RECENT_WORKSPACE_STORAGE_KEY, JSON.stringify(paths))
}

const persistAccessMode = (mode: AccessMode): void => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(ACCESS_MODE_STORAGE_KEY, mode)
}

const loadGitBranchPrefix = (): string => {
  if (typeof window === 'undefined') return DEFAULT_GIT_BRANCH_PREFIX
  return window.localStorage.getItem(GIT_BRANCH_PREFIX_STORAGE_KEY) ?? DEFAULT_GIT_BRANCH_PREFIX
}

const loadProjectSkillsEnabled = (): boolean => {
  if (typeof window === 'undefined') return true
  return window.localStorage.getItem(PROJECT_SKILLS_ENABLED_STORAGE_KEY) !== 'false'
}

const loadPreventIdleSleep = (): boolean => {
  if (typeof window === 'undefined') return false
  // 默认关闭（fail-safe）：阻止系统休眠是显式偏好，不做无依据默认开启。
  return window.localStorage.getItem(PREVENT_IDLE_SLEEP_STORAGE_KEY) === 'true'
}

/** 终端面板高度统一在此 clamp：下限保证 header + 可读行数，上限保证会话主体可用。 */
export const clampTerminalPanelHeight = (height: number, maxHeight: number): number =>
  Math.min(
    Math.max(height, MIN_TERMINAL_PANEL_HEIGHT),
    Math.max(MIN_TERMINAL_PANEL_HEIGHT, maxHeight),
  )

/** rail 宽度统一在此 clamp：下限保证 tab 与浏览器工具栏可用，上限取「绝对上限」与「视口减会话主体保留宽度」的较小者。 */
export const clampRuntimeRailWidth = (width: number, maxWidth: number): number =>
  Math.min(
    Math.max(width, MIN_RUNTIME_RAIL_WIDTH),
    Math.max(MIN_RUNTIME_RAIL_WIDTH, maxWidth),
  )

/** 当前视口下 rail 宽度上限：与 terminalPanelMaxHeight 同思路，窄窗口自动让位。 */
export const runtimeRailMaxWidth = (): number => {
  if (typeof window === 'undefined') return MAX_RUNTIME_RAIL_WIDTH
  const viewport = typeof window.innerWidth === 'number' && window.innerWidth > 0
    ? window.innerWidth
    : FALLBACK_VIEWPORT_WIDTH
  return Math.max(
    MIN_RUNTIME_RAIL_WIDTH,
    Math.min(MAX_RUNTIME_RAIL_WIDTH, viewport - RUNTIME_RAIL_BODY_RESERVED_WIDTH),
  )
}

const terminalPanelMaxHeight = (): number => {
  if (typeof window === 'undefined') return FALLBACK_VIEWPORT_HEIGHT - TERMINAL_PANEL_BODY_RESERVED_HEIGHT
  const viewport = typeof window.innerHeight === 'number' && window.innerHeight > 0
    ? window.innerHeight
    : FALLBACK_VIEWPORT_HEIGHT
  return viewport - TERMINAL_PANEL_BODY_RESERVED_HEIGHT
}

const loadTerminalPanelHeight = (): number => {
  if (typeof window === 'undefined') return DEFAULT_TERMINAL_PANEL_HEIGHT
  const stored = Number(window.localStorage.getItem(TERMINAL_PANEL_HEIGHT_STORAGE_KEY))
  if (!Number.isFinite(stored)) return DEFAULT_TERMINAL_PANEL_HEIGHT
  return clampTerminalPanelHeight(stored, terminalPanelMaxHeight())
}

/** SFTP 面板高度统一在此 clamp：下限保证头部行 + 数行列表可读，上限保证终端区仍可用。 */
export const clampSftpPanelHeight = (height: number, maxHeight: number): number =>
  Math.min(
    Math.max(height, MIN_SFTP_PANEL_HEIGHT),
    Math.max(MIN_SFTP_PANEL_HEIGHT, maxHeight),
  )

const sftpPanelMaxHeight = (): number => {
  if (typeof window === 'undefined') return FALLBACK_VIEWPORT_HEIGHT - SFTP_PANEL_BODY_RESERVED_HEIGHT
  const viewport = typeof window.innerHeight === 'number' && window.innerHeight > 0
    ? window.innerHeight
    : FALLBACK_VIEWPORT_HEIGHT
  return viewport - SFTP_PANEL_BODY_RESERVED_HEIGHT
}

const loadSftpPanelHeight = (): number => {
  if (typeof window === 'undefined') return DEFAULT_SFTP_PANEL_HEIGHT
  const stored = Number(window.localStorage.getItem(SFTP_PANEL_HEIGHT_STORAGE_KEY))
  if (!Number.isFinite(stored)) return DEFAULT_SFTP_PANEL_HEIGHT
  return clampSftpPanelHeight(stored, sftpPanelMaxHeight())
}

const loadRuntimeRailWidth = (): number => {
  if (typeof window === 'undefined') return DEFAULT_RUNTIME_RAIL_WIDTH
  const stored = Number(window.localStorage.getItem(RUNTIME_RAIL_WIDTH_STORAGE_KEY))
  if (!Number.isFinite(stored)) return DEFAULT_RUNTIME_RAIL_WIDTH
  return clampRuntimeRailWidth(stored, runtimeRailMaxWidth())
}

/**
 * 以下 getter 供 agent 层（非 React 上下文）同步读取当前 UI 偏好。
 * 定义为模块内函数（闭包引用模块内 useUiStore），即使测试 vi.mock 覆盖了
 * 导出的 useUiStore，经 importOriginal + spread 保留的原始 getter 仍通过
 * 闭包引用真实的 zustand store（有 getState），不依赖 mock 提供的形态。
 */
export const getGitBranchPrefix = (): string => useUiStore.getState().gitBranchPrefix
export const getProjectSkillsEnabled = (): boolean => useUiStore.getState().projectSkillsEnabled

interface UiState {
  view: AppView
  settingsSection: SettingsSection
  sidebarCollapsed: boolean
  sidebarUserOverride: boolean
  sidebarCompact: boolean
  sidebarOverlayOpen: boolean
  runtimeRailOpen: boolean
  runtimeRailPane: RuntimeRailPane
  runtimeRailWidth: number
  terminalPanelOpen: boolean
  terminalPanelHeight: number
  sftpPanelHeight: number
  connectPanelOpen: boolean
  accessMode: AccessMode
  language: UiLanguage
  theme: UiTheme
  fontSizePx: number
  monoFontFamily: MonoFontFamily
  gitBranchPrefix: string
  projectSkillsEnabled: boolean
  preventIdleSleep: boolean
  summaryRequest: SummaryRequest | null
  messageEditRequest: MessageEditRequest | null
  imageLightbox: ImageLightboxState | null
  feedbackRequest: FeedbackRequest | null
  recentWorkspacePaths: string[]
  updatePhase: UpdatePhase
  availableUpdate: AvailableAppUpdate | null
  updateProgress: UpdateProgressState | null
  updateMessage: string | null
  recordRecentWorkspace: (path: string) => void
  patchUpdater: (
    patch: Partial<Pick<UiState, 'updatePhase' | 'availableUpdate' | 'updateProgress' | 'updateMessage'>>,
  ) => void
  setView: (view: AppView) => void
  setSettingsSection: (section: SettingsSection) => void
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setSidebarCompact: (compact: boolean) => void
  closeSidebarOverlay: () => void
  toggleRuntimeRail: () => void
  setRuntimeRailOpen: (open: boolean) => void
  setRuntimeRailPane: (pane: RuntimeRailPane) => void
  setRuntimeRailWidth: (width: number) => void
  toggleTerminalPanel: () => void
  setTerminalPanelOpen: (open: boolean) => void
  toggleConnectPanel: () => void
  setConnectPanelOpen: (open: boolean) => void
  setTerminalPanelHeight: (height: number) => void
  setSftpPanelHeight: (height: number, maxHeight?: number) => void
  setAccessMode: (mode: AccessMode) => void
  setLanguage: (language: UiLanguage) => void
  setTheme: (theme: UiTheme) => void
  setFontSizePx: (fontSizePx: number) => void
  setMonoFontFamily: (family: MonoFontFamily) => void
  setGitBranchPrefix: (prefix: string) => void
  setProjectSkillsEnabled: (enabled: boolean) => void
  setPreventIdleSleep: (enabled: boolean) => void
  setSummaryRequest: (request: SummaryRequest | null) => void
  setMessageEditRequest: (request: MessageEditRequest | null) => void
  openImageLightbox: (src: string, alt: string) => void
  closeImageLightbox: () => void
  openFeedback: (kind: FeedbackKind) => void
  closeFeedback: () => void
}

const initialLanguage = loadUiLanguage()
const initialTheme = loadUiTheme()
const initialFontSizePx = loadUiFontSizePx()
const initialMonoFontFamily = loadMonoFontFamily()
applyUiLanguage(initialLanguage)
applyUiTheme(initialTheme)
// 启动即恢复字号与等宽字体偏好：字号经根变量缩放全部 rem 文本，终端面板
// 挂载时读同一 store，canvas 字号随动。
applyUiFontSizePx(initialFontSizePx)
applyMonoFontFamily(initialMonoFontFamily)
// 启动即按持久化偏好恢复 idle-sleep 阻止（全局生效；浏览器开发模式静默降级）。
// 断言随 Axiom 进程退出自动释放，无需关机路径。
void setIdleSleepPrevention(loadPreventIdleSleep()).catch(() => undefined)

export const useUiStore = create<UiState>((set, get) => ({
  view: 'new-task',
  settingsSection: 'general',
  sidebarCollapsed: false,
  sidebarUserOverride: false,
  sidebarCompact: false,
  sidebarOverlayOpen: false,
  runtimeRailOpen: false,
  runtimeRailPane: 'picker',
  runtimeRailWidth: loadRuntimeRailWidth(),
  terminalPanelOpen: false,
  terminalPanelHeight: loadTerminalPanelHeight(),
  sftpPanelHeight: loadSftpPanelHeight(),
  connectPanelOpen: false,
  accessMode: loadAccessMode(),
  language: initialLanguage,
  theme: initialTheme,
  fontSizePx: initialFontSizePx,
  monoFontFamily: initialMonoFontFamily,
  gitBranchPrefix: loadGitBranchPrefix(),
  projectSkillsEnabled: loadProjectSkillsEnabled(),
  preventIdleSleep: loadPreventIdleSleep(),
  summaryRequest: null,
  messageEditRequest: null,
  imageLightbox: null,
  feedbackRequest: null,
  recentWorkspacePaths: loadRecentWorkspacePaths(),
  updatePhase: 'idle',
  availableUpdate: null,
  updateProgress: null,
  updateMessage: null,
  recordRecentWorkspace: (path) => {
    if (!path) return
    const next = [path, ...get().recentWorkspacePaths.filter((candidate) => candidate !== path)]
      .slice(0, MAX_RECENT_WORKSPACES)
    persistRecentWorkspacePaths(next)
    set({ recentWorkspacePaths: next })
  },
  setView: (view) => set({ view }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  toggleSidebar: () => set((state) => state.sidebarCompact
    ? { sidebarOverlayOpen: !state.sidebarOverlayOpen }
    : {
        sidebarCollapsed: !state.sidebarCollapsed,
        sidebarUserOverride: true,
      }),
  setSidebarCollapsed: (sidebarCollapsed) => {
    if (get().sidebarUserOverride) return
    set({ sidebarCollapsed })
  },
  setSidebarCompact: (sidebarCompact) => set({
    sidebarCompact,
    sidebarOverlayOpen: false,
  }),
  closeSidebarOverlay: () => set({ sidebarOverlayOpen: false }),
  toggleRuntimeRail: () => set((state) => (state.runtimeRailOpen
    ? { runtimeRailOpen: false }
    // 展开即回卡片选择页（对齐「展开时展示标签页卡片」形态）。
    : { runtimeRailOpen: true, runtimeRailPane: 'picker' })),
  setRuntimeRailOpen: (runtimeRailOpen) => set(runtimeRailOpen
    ? { runtimeRailOpen: true, runtimeRailPane: 'picker' }
    : { runtimeRailOpen: false }),
  setRuntimeRailPane: (runtimeRailPane) => set({ runtimeRailPane }),
  // 宽度是显式布局偏好：clamp 后持久化，拖拽/键盘共用此入口。
  setRuntimeRailWidth: (runtimeRailWidth) => {
    if (!Number.isFinite(runtimeRailWidth)) return
    const next = clampRuntimeRailWidth(runtimeRailWidth, runtimeRailMaxWidth())
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(RUNTIME_RAIL_WIDTH_STORAGE_KEY, String(next))
    }
    set({ runtimeRailWidth: next })
  },
  toggleTerminalPanel: () => set((state) => ({ terminalPanelOpen: !state.terminalPanelOpen })),
  setTerminalPanelOpen: (terminalPanelOpen) => set({ terminalPanelOpen }),
  // 连接面板是瞬态浮层（默认收起），不持久化：重启后回到收起态即可。
  toggleConnectPanel: () => set((state) => ({ connectPanelOpen: !state.connectPanelOpen })),
  setConnectPanelOpen: (connectPanelOpen) => set({ connectPanelOpen }),
  // 拖拽/键盘调整均走此入口：clamp 后持久化，旧偏好换小屏也不会把面板撑出视口。
  setTerminalPanelHeight: (height) => {
    if (!Number.isFinite(height)) return
    const next = clampTerminalPanelHeight(height, terminalPanelMaxHeight())
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(TERMINAL_PANEL_HEIGHT_STORAGE_KEY, String(next))
    }
    set({ terminalPanelHeight: next })
  },
  // SFTP 面板是 SSH 终端栏内的浮层，真实上限取决于该栏的实测高度（调用方在
  // 拖拽/键盘时传入），视口值只兜底加载期与缺省调用。
  setSftpPanelHeight: (height, maxHeight) => {
    if (!Number.isFinite(height)) return
    const next = clampSftpPanelHeight(height, maxHeight ?? sftpPanelMaxHeight())
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SFTP_PANEL_HEIGHT_STORAGE_KEY, String(next))
    }
    set({ sftpPanelHeight: next })
  },
  setAccessMode: (mode) => {
    persistAccessMode(mode)
    void setWorkspaceApprovalMode(
      mode === 'standard' ? 'interactive' : 'automatic',
    ).catch(() => undefined)
    set({ accessMode: mode })
  },
  setLanguage: (language) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language)
    applyUiLanguage(language)
    set({ language })
  },
  setTheme: (theme) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(UI_THEME_STORAGE_KEY, theme)
    applyUiTheme(theme)
    set({ theme })
  },
  setFontSizePx: (fontSizePx) => {
    if (!Number.isFinite(fontSizePx)) return
    const next = clampUiFontSizePx(fontSizePx)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(UI_FONT_SIZE_STORAGE_KEY, String(next))
    }
    applyUiFontSizePx(next)
    set({ fontSizePx: next })
  },
  setMonoFontFamily: (family) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MONO_FONT_FAMILY_STORAGE_KEY, family)
    }
    applyMonoFontFamily(family)
    set({ monoFontFamily: family })
  },
  setGitBranchPrefix: (prefix) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(GIT_BRANCH_PREFIX_STORAGE_KEY, prefix)
    set({ gitBranchPrefix: prefix })
  },
  setProjectSkillsEnabled: (enabled) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(PROJECT_SKILLS_ENABLED_STORAGE_KEY, enabled ? 'true' : 'false')
    set({ projectSkillsEnabled: enabled })
  },
  setPreventIdleSleep: (enabled) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PREVENT_IDLE_SLEEP_STORAGE_KEY, enabled ? 'true' : 'false')
    }
    void setIdleSleepPrevention(enabled).catch(() => undefined)
    set({ preventIdleSleep: enabled })
  },
  setSummaryRequest: (summaryRequest) => set({ summaryRequest }),
  setMessageEditRequest: (messageEditRequest) => set({ messageEditRequest }),
  openImageLightbox: (src, alt) => set({ imageLightbox: { src, alt } }),
  closeImageLightbox: () => set({ imageLightbox: null }),
  openFeedback: (kind) => set({ feedbackRequest: { kind } }),
  closeFeedback: () => set({ feedbackRequest: null }),
  patchUpdater: (patch) => set(patch),
}))
