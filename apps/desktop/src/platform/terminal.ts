import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { decodeBase64ToBytes } from './base64'
import { isTauriRuntime } from './environment'

export interface TerminalSpawnOptions {
  terminalId: string
  /** 绑定工作区（Rust 侧 canonical 路径）：启动时显式绑定，撤销时按此作用域回收。 */
  workspacePath: string
  cwd?: string
  cols: number
  rows: number
}

interface TerminalEventPayload {
  terminalId: string
  /** PTY 输出字节（Rust 侧 base64 编码，镜像 terminal.rs TerminalEvent.data）。 */
  data?: string
  done: boolean
  exitCode?: number
  error?: string
}

export const openTerminal = async (
  options: TerminalSpawnOptions,
  onData: (data: string) => void,
  onExit: (exitCode: number | null) => void,
  signal: AbortSignal,
  /**
   * spawn 确认回调：`spawn_terminal` 成功返回后触发一次（失败与已 abort 不触发）。
   * 本函数的 Promise 只在会话结束时 resolve，调用方靠它区分「已启动」与「尚未启动」
   * （终端状态从 spawning 推进到 running 的时机）。
   */
  onSpawned?: () => void,
): Promise<void> => {
  if (!isTauriRuntime()) throw new Error('终端仅在 Axiom 桌面应用中可用')
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

  const decoder = new TextDecoder()
  let unlisten: UnlistenFn | undefined
  let finished = false
  let resolveExit: (() => void) | undefined
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve
  })

  const flushDecoder = (): void => {
    const remainder = decoder.decode()
    if (remainder) onData(remainder)
  }

  const finish = (exitCode: number | null): void => {
    if (finished) return
    finished = true
    flushDecoder()
    try {
      onExit(exitCode)
    } finally {
      resolveExit?.()
    }
  }

  const abort = (): void => {
    if (finished) return
    void invoke('kill_terminal', { terminalId: options.terminalId }).catch(() => false)
    finish(null)
  }

  try {
    unlisten = await listen<TerminalEventPayload>('axiom:terminal-event', (event) => {
      if (event.payload.terminalId !== options.terminalId) return
      if (event.payload.data) {
        const data = decoder.decode(decodeBase64ToBytes(event.payload.data), { stream: true })
        if (data) onData(data)
      }
      if (event.payload.error) {
        onData(`\r\n终端错误：${event.payload.error}\r\n`)
        finish(null)
        return
      }
      if (event.payload.done) {
        finish(event.payload.exitCode ?? null)
      }
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      await exit
      return
    }
    try {
      await invoke<string>('spawn_terminal', { request: options })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onData(`\r\n无法启动终端：${message}\r\n`)
      finish(null)
      throw error
    }
    if (signal.aborted) {
      await invoke('kill_terminal', { terminalId: options.terminalId }).catch(() => false)
    } else {
      // 只有真正启动成功（且期间未被 abort）才通知调用方推进状态。
      onSpawned?.()
    }
    await exit
  } finally {
    signal.removeEventListener('abort', abort)
    unlisten?.()
    if (!finished) {
      finish(null)
      await invoke('kill_terminal', { terminalId: options.terminalId }).catch(() => false)
    }
  }
}

export const writeTerminalStdin = async (terminalId: string, data: string): Promise<void> => {
  if (!isTauriRuntime()) return
  await invoke('write_terminal_stdin', { terminalId, data })
}

/**
 * 报告终端面板的键盘焦点状态给 Rust 手势门（terminal.rs set_terminal_focus）。
 * 焦点报告仅作纵深防御：手势门仍要求真实原生 keyDown 授予单次消费令牌。
 */
export const setTerminalFocus = async (focused: boolean): Promise<void> => {
  if (!isTauriRuntime()) return
  await invoke('set_terminal_focus', { focused })
}

export const resizeTerminal = async (terminalId: string, cols: number, rows: number): Promise<void> => {
  if (!isTauriRuntime()) return
  await invoke('resize_terminal', { terminalId, cols, rows })
}

export const killTerminal = async (terminalId: string): Promise<void> => {
  if (!isTauriRuntime()) return
  await invoke('kill_terminal', { terminalId })
}

/**
 * 终端配色主题。与 UI 组件解耦，便于在 SSR 快照测试中独立断言。
 * 其中 background/selection/red/brightBlack 原先是旧调色板令牌值的拷贝，
 * 随 .pen/axiom.pen 重建同步（background=bg-canvas、selection=border-subtle、
 * red=diff-red、brightBlack=text-tertiary）；其余为独立 ANSI 色，保持不动。
 */
export const TERMINAL_THEME = {
  background: '#0A0A09',
  foreground: '#F2F1EC',
  cursor: '#F2F1EC',
  cursorAccent: '#0A0A09',
  selectionBackground: '#3A3934',
  black: '#0A0A09',
  red: '#F4716B',
  green: '#3FB27F',
  yellow: '#FEBC2E',
  blue: '#5B8DEF',
  magenta: '#C678DD',
  cyan: '#56B6C2',
  white: '#F2F1EC',
  brightBlack: '#9B998F',
  brightRed: '#F4716B',
  brightGreen: '#3FB27F',
  brightYellow: '#FEBC2E',
  brightBlue: '#5B8DEF',
  brightMagenta: '#C678DD',
  brightCyan: '#56B6C2',
  brightWhite: '#F2F1EC',
} as const

/**
 * 生成终端会话 ID：`term-` 前缀 + 8 字符 base36 随机串。
 * 随机性保证同一页面多个终端实例不冲突。
 */
export const generateTerminalId = (): string => {
  const random = Math.random().toString(36).slice(2, 10)
  return `term-${random}`
}
