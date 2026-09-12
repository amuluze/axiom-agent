// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalStore } from '@/stores/terminalStore'
import { useUiStore } from '@/stores/uiStore'

/** xterm 在模块顶层引用浏览器全局（self），且 canvas 无法在 jsdom 中真实渲染：
 *  用记录型假实现替代，断言的是本模块的生命周期契约，而不是 xterm 本身。 */
const mocks = vi.hoisted(() => ({
  openTerminal: vi.fn(async () => {}),
  killTerminal: vi.fn(async () => {}),
  resizeTerminal: vi.fn(async () => {}),
  setTerminalFocus: vi.fn(async () => {}),
  writeTerminalStdin: vi.fn(async () => {}),
  seq: 0,
  instances: [] as Array<{
    opened: boolean
    disposed: boolean
    cols: number
    rows: number
    options: { fontSize?: number; fontFamily?: string }
    textarea: HTMLTextAreaElement | null
  }>,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: { fontSize?: number; fontFamily?: string } = {}
    textarea: HTMLTextAreaElement | null = null
    opened = false
    disposed = false
    private dataHandler: ((data: string) => void) | undefined

    constructor() {
      mocks.instances.push(this)
    }

    loadAddon(): void {}

    open(container: HTMLElement): void {
      this.opened = true
      const textarea = document.createElement('textarea')
      container.appendChild(textarea)
      this.textarea = textarea
    }

    onData(handler: (data: string) => void) {
      this.dataHandler = handler
      return { dispose: (): void => {} }
    }

    /** 本模块只把 resize 回调透传给 PTY，测试不注入尺寸事件，故不保留句柄。 */
    onResize(): { dispose: () => void } {
      return { dispose: (): void => {} }
    }

    write(): void {}

    dispose(): void {
      this.disposed = true
    }

    emitData(data: string): void {
      this.dataHandler?.(data)
    }
  },
}))

// fit 模拟真实布局效果：把列行数改掉，以便断言后续 resizeTerminal 的载荷。
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {
      const target = mocks.instances[mocks.instances.length - 1]
      if (target) {
        target.cols = 100
        target.rows = 30
      }
    }
  },
}))

vi.mock('@/platform/terminal', () => ({
  TERMINAL_THEME: {},
  generateTerminalId: () => `term-${(mocks.seq += 1)}`,
  openTerminal: mocks.openTerminal,
  killTerminal: mocks.killTerminal,
  resizeTerminal: mocks.resizeTerminal,
  setTerminalFocus: mocks.setTerminalFocus,
  writeTerminalStdin: mocks.writeTerminalStdin,
}))

const runtime = await import('./terminalRuntime')

const WS = '/ws/a'

const lastResize = (): unknown[] => mocks.resizeTerminal.mock.calls.at(-1) ?? []

beforeEach(() => {
  useTerminalStore.setState({ entries: {} })
  runtime.disposeAllTerminals()
  mocks.openTerminal.mockClear()
  mocks.killTerminal.mockClear()
  mocks.resizeTerminal.mockClear()
  mocks.setTerminalFocus.mockClear()
  mocks.instances.length = 0
  mocks.seq = 0
})

describe('terminalRuntime 工作区终端生命周期', () => {
  it('ensureTerminal 幂等：重复激活同一工作区不重复启动', () => {
    const first = runtime.ensureTerminal(WS)
    const second = runtime.ensureTerminal(WS)

    expect(second.terminalId).toBe(first.terminalId)
    expect(mocks.openTerminal).toHaveBeenCalledTimes(1)
    expect(useTerminalStore.getState().entries[WS]?.terminalId).toBe(first.terminalId)
  })

  it('attachTerminal 首次挂载才 open 并同步 PTY 尺寸；重复 attach 不重复 open', () => {
    const host = document.createElement('div')
    const entry = runtime.attachTerminal(WS, host)

    expect(host.contains(entry.container)).toBe(true)
    expect(mocks.instances[0]?.opened).toBe(true)
    // fit 只对已挂载容器生效：先把 host 真正挂入文档再断言尺寸同步。
    document.body.appendChild(host)
    runtime.fitTerminal(WS)
    expect(lastResize()).toEqual([entry.terminalId, 100, 30])

    runtime.attachTerminal(WS, host)
    expect(host.querySelectorAll('.terminal-panel__surface').length).toBe(1)
    expect(mocks.openTerminal).toHaveBeenCalledTimes(1)
  })

  it('焦点上报在 open 之后注册（防止 textarea 尚不存在导致手势门永久失效）', () => {
    const host = document.createElement('div')
    const entry = runtime.attachTerminal(WS, host)

    entry.term.textarea?.dispatchEvent(new Event('focus'))
    expect(mocks.setTerminalFocus).toHaveBeenCalledWith(true)
    entry.term.textarea?.dispatchEvent(new Event('blur'))
    expect(mocks.setTerminalFocus).toHaveBeenCalledWith(false)
  })

  it('后台（已解绑）终端不参与尺寸自适应：不发 resize', () => {
    const host = document.createElement('div')
    runtime.attachTerminal(WS, host)
    runtime.detachTerminal(WS)
    expect(host.contains(runtime.getTerminalRuntime(WS)?.container ?? host)).toBe(false)

    mocks.resizeTerminal.mockClear()
    runtime.fitTerminal(WS)
    expect(mocks.resizeTerminal).not.toHaveBeenCalled()
  })

  it('detachTerminal 只解绑 DOM：不 kill、条目保留（终端在后台继续运行）', () => {
    const host = document.createElement('div')
    runtime.attachTerminal(WS, host)
    runtime.detachTerminal(WS)

    expect(mocks.killTerminal).not.toHaveBeenCalled()
    expect(useTerminalStore.getState().entries[WS]).toBeDefined()
  })

  it('disposeTerminal 结束会话：kill 并移除条目与实例', () => {
    const host = document.createElement('div')
    const entry = runtime.attachTerminal(WS, host)
    runtime.disposeTerminal(WS)

    expect(mocks.killTerminal).toHaveBeenCalledWith(entry.terminalId)
    expect(useTerminalStore.getState().entries[WS]).toBeUndefined()
    expect(runtime.getTerminalRuntime(WS)).toBeNull()
  })

  it('restartTerminal 换新会话，且新条目必须重新挂载才能 open（面板以 terminalId 变化重跑）', () => {
    const host = document.body.appendChild(document.createElement('div'))
    const before = runtime.attachTerminal(WS, host)
    const after = runtime.restartTerminal(WS)

    expect(after.terminalId).not.toBe(before.terminalId)
    expect(mocks.openTerminal).toHaveBeenCalledTimes(2)
    expect(mocks.killTerminal).toHaveBeenCalledWith(before.terminalId)
    // 重启后的新实例尚未 open：不重新挂载就是一个永不 open、不可输入的悬挂会话
    // （面板侧靠 effect 依赖 terminalId 变化重新 attach，此断言锁住该契约）。
    expect(mocks.instances.at(-1)?.opened).toBe(false)

    runtime.attachTerminal(WS, host)
    expect(mocks.instances.at(-1)?.opened).toBe(true)
    expect(host.contains(after.container)).toBe(true)
    expect(host.contains(before.container)).toBe(false)
  })

  it('syncTerminalFont 把字号/字体偏好热更新到条目', () => {
    const host = document.createElement('div')
    const entry = runtime.attachTerminal(WS, host)
    const before = entry.term.options.fontFamily
    useUiStore.setState({ monoFontFamily: 'menlo' })
    runtime.syncTerminalFont()

    expect(entry.term.options.fontFamily).not.toBe(before)
    expect(typeof entry.term.options.fontSize).toBe('number')
  })

  it('running 只在 spawn 确认后出现（spawning 期间不呈现为运行中）', () => {
    // 默认 mock 不调用 spawn 确认回调：状态应停在 spawning（面板此时不显示「结束终端」，
    // 也不会把尚未启动或已失败的会话误呈为运行中）。
    runtime.ensureTerminal(WS)
    expect(useTerminalStore.getState().entries[WS]?.status).toBe('spawning')

    let confirmSpawn: (() => void) | undefined
    mocks.openTerminal.mockImplementationOnce((async (...args: unknown[]) => {
      confirmSpawn = args[4] as () => void
    }) as unknown as typeof mocks.openTerminal)
    runtime.restartTerminal(WS)
    expect(useTerminalStore.getState().entries[WS]?.status).toBe('spawning')

    confirmSpawn?.()
    expect(useTerminalStore.getState().entries[WS]?.status).toBe('running')
  })
})
