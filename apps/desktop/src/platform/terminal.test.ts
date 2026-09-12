import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_THEME,
  generateTerminalId,
  killTerminal,
  openTerminal,
  resizeTerminal,
  writeTerminalStdin,
} from './terminal'

interface TerminalPayload {
  terminalId: string
  /** PTY 输出字节的 base64 编码（与 Rust TerminalEvent.data 镜像）。 */
  data?: string
  done: boolean
  exitCode?: number
  error?: string
}

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  handler: undefined as ((event: { payload: TerminalPayload }) => void) | undefined,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('./environment', () => ({ isTauriRuntime: () => true }))

const options = { terminalId: 'term-1', workspacePath: '/ws', cols: 80, rows: 24 }

describe('terminal IPC lifecycle', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.listen.mockReset()
    mocks.unlisten.mockReset()
    mocks.handler = undefined
    mocks.listen.mockImplementation(async (_eventName, handler) => {
      mocks.handler = handler
      return mocks.unlisten
    })
    mocks.invoke.mockResolvedValue('term-1')
  })

  it('stays open after spawn returns and only cleans up after done', async () => {
    const onData = vi.fn()
    const onExit = vi.fn()
    let settled = false
    const run = openTerminal(options, onData, onExit, new AbortController().signal)
      .finally(() => { settled = true })

    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('spawn_terminal', { request: options })
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(mocks.unlisten).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()

    mocks.handler?.({ payload: { terminalId: 'term-1', done: true, exitCode: 0 } })
    await run

    expect(onExit).toHaveBeenCalledWith(0)
    expect(mocks.unlisten).toHaveBeenCalledOnce()
    expect(mocks.invoke).not.toHaveBeenCalledWith('kill_terminal', expect.anything())
  })

  it('notifies onSpawned only after spawn_terminal resolves', async () => {
    let releaseSpawn: ((value: string) => void) | undefined
    mocks.invoke.mockImplementation((command) => {
      if (command === 'spawn_terminal') return new Promise((resolve) => { releaseSpawn = resolve })
      return Promise.resolve(false)
    })
    const onSpawned = vi.fn()
    const run = openTerminal(options, vi.fn(), vi.fn(), new AbortController().signal, onSpawned)

    await vi.waitFor(() => expect(releaseSpawn).toBeTypeOf('function'))
    expect(onSpawned).not.toHaveBeenCalled()

    releaseSpawn?.('term-1')
    await vi.waitFor(() => expect(onSpawned).toHaveBeenCalledTimes(1))

    mocks.handler?.({ payload: { terminalId: 'term-1', done: true, exitCode: 0 } })
    await run
  })

  it('does not notify onSpawned when the spawn request fails', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('pty unavailable'))
    const onSpawned = vi.fn()

    await expect(openTerminal(options, vi.fn(), vi.fn(), new AbortController().signal, onSpawned))
      .rejects.toThrow('pty unavailable')

    expect(onSpawned).not.toHaveBeenCalled()
  })

  it('does not spawn when abort wins while listen is being installed', async () => {
    let releaseListen: ((value: typeof mocks.unlisten) => void) | undefined
    mocks.listen.mockImplementation(() => new Promise((resolve) => {
      releaseListen = resolve
    }))
    const controller = new AbortController()
    const onExit = vi.fn()
    const run = openTerminal(options, vi.fn(), onExit, controller.signal)
    controller.abort()
    releaseListen?.(mocks.unlisten)

    await run

    expect(mocks.invoke).not.toHaveBeenCalledWith('spawn_terminal', expect.anything())
    expect(onExit).toHaveBeenCalledWith(null)
    expect(mocks.unlisten).toHaveBeenCalledOnce()
  })

  it('kills again after spawn when abort happened during the spawn race', async () => {
    let releaseSpawn: ((value: string) => void) | undefined
    mocks.invoke.mockImplementation((command) => {
      if (command === 'spawn_terminal') {
        return new Promise((resolve) => { releaseSpawn = resolve })
      }
      return Promise.resolve(false)
    })
    const controller = new AbortController()
    const run = openTerminal(options, vi.fn(), vi.fn(), controller.signal)
    await vi.waitFor(() => expect(releaseSpawn).toBeTypeOf('function'))

    controller.abort()
    releaseSpawn?.('term-1')
    await run

    const killCalls = mocks.invoke.mock.calls.filter(([command]) => command === 'kill_terminal')
    expect(killCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('writes spawn failures into the terminal before rejecting', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('pty unavailable'))
    const onData = vi.fn()
    const onExit = vi.fn()

    await expect(openTerminal(options, onData, onExit, new AbortController().signal))
      .rejects.toThrow('pty unavailable')

    expect(onData).toHaveBeenCalledWith(expect.stringContaining('无法启动终端：pty unavailable'))
    expect(onExit).toHaveBeenCalledWith(null)
    expect(mocks.unlisten).toHaveBeenCalledOnce()
  })

  it('decodes streamed base64 output via onData and flushes on done', async () => {
    const onData = vi.fn()
    const onExit = vi.fn()
    const run = openTerminal(options, onData, onExit, new AbortController().signal)
    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('spawn_terminal', { request: options })
    })
    // 模拟一段 UTF-8 字节流：'hi' 分两片（base64 编码），finish 时 flush 残余
    mocks.handler?.({ payload: { terminalId: 'term-1', data: btoa('h'), done: false } })
    mocks.handler?.({ payload: { terminalId: 'term-1', data: btoa('i'), done: true, exitCode: 0 } })
    await run

    expect(onData).toHaveBeenCalledWith('h')
    expect(onData).toHaveBeenCalledWith('i')
    expect(onExit).toHaveBeenCalledWith(0)
  })

  it('writes error payload into the terminal and finishes with null exit', async () => {
    const onData = vi.fn()
    const onExit = vi.fn()
    const run = openTerminal(options, onData, onExit, new AbortController().signal)
    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('spawn_terminal', { request: options })
    })
    mocks.handler?.({ payload: { terminalId: 'term-1', error: 'pty EOF', done: true } })
    await run

    expect(onData).toHaveBeenCalledWith(expect.stringContaining('终端错误：pty EOF'))
    expect(onExit).toHaveBeenCalledWith(null)
  })

  it('ignores events targeted at a different terminalId', async () => {
    const onData = vi.fn()
    const onExit = vi.fn()
    const run = openTerminal(options, onData, onExit, new AbortController().signal)
    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('spawn_terminal', { request: options })
    })
    mocks.handler?.({ payload: { terminalId: 'term-other', data: btoa('x'), done: true } })
    mocks.handler?.({ payload: { terminalId: 'term-1', done: true, exitCode: 7 } })
    await run

    expect(onData).not.toHaveBeenCalled()
    expect(onExit).toHaveBeenCalledWith(7)
  })
})

describe('terminal small IPC wrappers', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue(undefined)
  })

  it('writeTerminalStdin forwards terminalId and data to the Rust command', async () => {
    await writeTerminalStdin('term-1', 'ls -la\n')
    expect(mocks.invoke).toHaveBeenCalledWith('write_terminal_stdin', {
      terminalId: 'term-1',
      data: 'ls -la\n',
    })
  })

  it('resizeTerminal forwards terminalId, cols and rows', async () => {
    await resizeTerminal('term-1', 120, 40)
    expect(mocks.invoke).toHaveBeenCalledWith('resize_terminal', {
      terminalId: 'term-1',
      cols: 120,
      rows: 40,
    })
  })

  it('killTerminal forwards only terminalId', async () => {
    await killTerminal('term-1')
    expect(mocks.invoke).toHaveBeenCalledWith('kill_terminal', { terminalId: 'term-1' })
  })
})

describe('terminal pure helpers', () => {
  it('generateTerminalId produces term- prefix followed by 8 base36 chars', () => {
    for (let i = 0; i < 50; i += 1) {
      const id = generateTerminalId()
      expect(id).toMatch(/^term-[a-z0-9]{8}$/)
    }
  })

  it('generateTerminalId yields unique values across a reasonable sample', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 200; i += 1) ids.add(generateTerminalId())
    expect(ids.size).toBe(200)
  })

  it('TERMINAL_THEME is a non-empty color map', () => {
    expect(Object.keys(TERMINAL_THEME).length).toBeGreaterThan(0)
    expect(TERMINAL_THEME.background).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })
})
