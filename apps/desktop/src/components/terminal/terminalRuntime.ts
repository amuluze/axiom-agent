import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import {
  TERMINAL_THEME,
  generateTerminalId,
  killTerminal,
  openTerminal,
  resizeTerminal,
  setTerminalFocus,
  writeTerminalStdin,
} from '@/platform/terminal'
import { MONO_FONT_STACKS, scaledTerminalFontSize, useUiStore } from '@/stores/uiStore'
import { useTerminalStore } from '@/stores/terminalStore'

/** xterm 用 canvas 绘制、不吃 CSS rem：与面板同一基准字号（本地终端 13px）。 */
const BASE_FONT_SIZE_PX = 13

/**
 * 单个工作区的终端运行时。
 *
 * xterm 实例与承载 DOM 都活在本模块（模块级 Map），不在 React 树里：面板卸载、切换
 * 视图或切到其他工作区时只解绑 DOM，实例与 PTY 继续存活并继续累积输出——这是
 * 「终端生命周期与视图解耦」（`.specs/domain/terminal-user-channel.md` 不变量 9）的落点。
 * 每个工作区至多一个条目，`terminalId` 作为回调守卫键（迟到事件不得写回已替换条目）。
 */
export interface TerminalRuntimeEntry {
  terminalId: string
  term: Terminal
  fitAddon: FitAddon
  container: HTMLDivElement
  abort: AbortController
  /** term.open 只能做一次，且必须在容器已挂入文档后（否则测不出尺寸）。 */
  opened: boolean
}

const entries = new Map<string, TerminalRuntimeEntry>()

const setStatus = (workspacePath: string, terminalId: string, status: 'spawning' | 'running' | 'exited'): void => {
  useTerminalStore.getState().setEntryStatus(workspacePath, terminalId, status)
}

export const getTerminalRuntime = (workspacePath: string): TerminalRuntimeEntry | null =>
  entries.get(workspacePath) ?? null

/** 幂等：已有该工作区条目时直接返回，不重复启动（重复激活同一工作区不重启）。 */
export const ensureTerminal = (workspacePath: string): TerminalRuntimeEntry => {
  const existing = entries.get(workspacePath)
  if (existing) return existing

  const { fontSizePx, monoFontFamily } = useUiStore.getState()
  const fitAddon = new FitAddon()
  const term = new Terminal({
    fontFamily: MONO_FONT_STACKS[monoFontFamily],
    fontSize: scaledTerminalFontSize(BASE_FONT_SIZE_PX, fontSizePx),
    lineHeight: 1.3,
    cursorBlink: true,
    theme: TERMINAL_THEME,
  })
  term.loadAddon(fitAddon)
  const container = document.createElement('div')
  container.className = 'terminal-panel__surface'

  const entry: TerminalRuntimeEntry = {
    terminalId: generateTerminalId(),
    term,
    fitAddon,
    container,
    abort: new AbortController(),
    opened: false,
  }
  entries.set(workspacePath, entry)

  const { terminalId } = entry
  useTerminalStore.getState().upsertEntry(workspacePath, { terminalId, status: 'spawning' })
  term.onData((data) => {
    void writeTerminalStdin(terminalId, data)
  })
  term.onResize(({ cols, rows }) => {
    // 静默收口：dispose 后迟到的 resize 会得到 "session is not active"，不能让它变成
    // 未处理的 Promise rejection（异步 rejection 捕不到 try/catch）。
    void resizeTerminal(terminalId, cols, rows).catch(() => {})
  })
  // 焦点监听不在此处注册：term.textarea 在 term.open() 之后才存在，在这里取会得到
  // undefined 并被可选链静默吞掉，导致焦点上报永久失效（Rust 手势门因此不给 stdin
  // 配额，终端变成不可输入）。注册点在 attachTerminal 首次 open 之后。

  void openTerminal(
    { terminalId, workspacePath, cols: term.cols, rows: term.rows },
    (data) => term.write(data),
    () => setStatus(workspacePath, terminalId, 'exited'),
    entry.abort.signal,
    // 只有 spawn 确认后才置 running：此前维持 spawning，面板既不显示「结束终端」也不
    // 显示「重新启动」，失败的 spawn 因此不会被误呈为运行中会话。
    () => setStatus(workspacePath, terminalId, 'running'),
  ).catch(() => setStatus(workspacePath, terminalId, 'exited'))
  return entry
}

/** 把该工作区的容器挂入面板视口（先从旧父节点摘除），首次挂载时才 term.open。 */
export const attachTerminal = (workspacePath: string, host: HTMLElement): TerminalRuntimeEntry => {
  const entry = ensureTerminal(workspacePath)
  if (entry.container.parentElement !== host) {
    entry.container.parentElement?.removeChild(entry.container)
    host.appendChild(entry.container)
  }
  if (!entry.opened) {
    entry.term.open(entry.container)
    entry.opened = true
    // 焦点上报 Rust 手势门：仅当终端聚焦时，原生 keyDown 才授予 stdin 配额；失焦清空
    // 未消费配额。textarea 只在 open 之后存在，故注册点必须在首次 open 处。
    const focusTextarea = entry.term.textarea
    focusTextarea?.addEventListener('focus', () => {
      void setTerminalFocus(true)
    })
    focusTextarea?.addEventListener('blur', () => {
      void setTerminalFocus(false)
    })
  }
  fitTerminal(workspacePath)
  return entry
}

/** 只作用于已挂载的容器：detached（后台工作区）时不发 resize，避免改写其 PTY 尺寸。 */
export const fitTerminal = (workspacePath: string): void => {
  const entry = entries.get(workspacePath)
  if (!entry || !entry.opened || !entry.container.isConnected) return
  try {
    entry.fitAddon.fit()
    // 静默收口：dispose 后迟到的 resize 会被 Rust 拒绝（session is not active）。
    void resizeTerminal(entry.terminalId, entry.term.cols, entry.term.rows).catch(() => {})
  } catch {
    // 尚未布局（面板刚打开）：由既有 ResizeObserver 兜底。
  }
}

/** 离开视图只解绑 DOM：不 dispose、不 kill，终端在后台继续运行。 */
export const detachTerminal = (workspacePath: string): void => {
  entries.get(workspacePath)?.container.remove()
}

/** 字号/等宽字体偏好热更新所有条目；可见条目由调用方随后 fit。 */
export const syncTerminalFont = (): void => {
  const { fontSizePx, monoFontFamily } = useUiStore.getState()
  const fontSize = scaledTerminalFontSize(BASE_FONT_SIZE_PX, fontSizePx)
  const fontFamily = MONO_FONT_STACKS[monoFontFamily]
  for (const entry of entries.values()) {
    if (entry.term.options.fontSize !== fontSize) entry.term.options.fontSize = fontSize
    if (entry.term.options.fontFamily !== fontFamily) entry.term.options.fontFamily = fontFamily
  }
}

/** 结束某工作区的终端并从投影中各去除其条目（撤销授权与用户显式结束共用）。 */
export const disposeTerminal = (workspacePath: string): void => {
  const entry = entries.get(workspacePath)
  if (!entry) return
  entries.delete(workspacePath)
  useTerminalStore.getState().removeEntry(workspacePath, entry.terminalId)
  // abort 会经 openTerminal 的收尾路径 kill_terminal；直接 kill 是幂等的双保险。
  entry.abort.abort()
  void killTerminal(entry.terminalId)
  entry.container.remove()
  entry.term.dispose()
}

/** 重启：先结束旧条目再启动新的（用户点「重新启动」时使用）。 */
export const restartTerminal = (workspacePath: string): TerminalRuntimeEntry => {
  disposeTerminal(workspacePath)
  return ensureTerminal(workspacePath)
}

/**
 * 结束全部工作区终端。生产路径当前无调用方（应用退出由进程回收各 PTY），保留为统一
 * 回收入口供测试与后续退出钩子使用——不是死代码，勿按未使用导出清理。
 */
export const disposeAllTerminals = (): void => {
  for (const workspacePath of [...entries.keys()]) disposeTerminal(workspacePath)
}
