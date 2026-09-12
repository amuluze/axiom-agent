// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalStore } from '@/stores/terminalStore'

/**
 * 面板侧契约：呈现 effect 必须同时依赖「激活工作区路径」与「条目身份（terminalId）」。
 * 只依赖前者时，重启（条目被替换）不会重跑 effect，新 xterm 永不 open——面板空白、
 * 焦点监听未注册而不可输入。现有 SSR 快照测试不执行 effect，无法锁住这条契约。
 */
const agent = vi.hoisted(() => ({
  state: {
    authorizedWorkspace: null as { path: string } | null,
    authorizedWorkspaces: [] as Array<{ path: string }>,
  },
  listeners: new Set<() => void>(),
  subscribe: (listener: () => void): (() => void) => {
    agent.listeners.add(listener)
    return () => agent.listeners.delete(listener)
  },
  set: (patch: Partial<typeof agent.state>): void => {
    Object.assign(agent.state, patch)
    for (const listener of agent.listeners) listener()
  },
}))

vi.mock('@/stores/agentStore', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useAgentStore: <T,>(selector: (state: typeof agent.state) => T): T =>
      useSyncExternalStore(agent.subscribe, () => selector(agent.state)),
  }
})

const runtime = vi.hoisted(() => ({
  attachTerminal: vi.fn(() => ({ terminalId: 'term-1' })),
  detachTerminal: vi.fn(),
  fitTerminal: vi.fn(),
  disposeTerminal: vi.fn(),
  restartTerminal: vi.fn(),
  syncTerminalFont: vi.fn(),
}))

vi.mock('./terminalRuntime', () => runtime)
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@/platform/terminal', () => ({ setTerminalFocus: vi.fn(async () => {}) }))

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
)

const { WorkspaceTerminalPanel } = await import('./WorkspaceTerminalPanel')

const WS = '/ws/a'

beforeEach(() => {
  runtime.attachTerminal.mockClear()
  runtime.detachTerminal.mockClear()
  agent.set({ authorizedWorkspace: { path: WS }, authorizedWorkspaces: [{ path: WS }] })
  useTerminalStore.setState({ entries: { [WS]: { terminalId: 'term-1', status: 'running' } } })
})

describe('WorkspaceTerminalPanel 呈现契约', () => {
  it('激活工作区变化时重新挂载容器', () => {
    const { rerender } = render(<WorkspaceTerminalPanel />)
    expect(runtime.attachTerminal).toHaveBeenCalledTimes(1)

    act(() => agent.set({
      authorizedWorkspace: { path: '/ws/b' },
      authorizedWorkspaces: [{ path: WS }, { path: '/ws/b' }],
    }))
    rerender(<WorkspaceTerminalPanel />)

    expect(runtime.attachTerminal).toHaveBeenCalledTimes(2)
    expect(runtime.detachTerminal).toHaveBeenCalledWith(WS)
  })

  it('条目被替换（terminalId 变化，即重启）时也必须重新挂载', () => {
    render(<WorkspaceTerminalPanel />)
    expect(runtime.attachTerminal).toHaveBeenCalledTimes(1)

    act(() => {
      useTerminalStore.setState({ entries: { [WS]: { terminalId: 'term-2', status: 'running' } } })
    })

    expect(runtime.attachTerminal).toHaveBeenCalledTimes(2)
  })

  it('工作区被撤销授权后不再呈现终端（空态、不发起启动）', () => {
    render(<WorkspaceTerminalPanel />)
    expect(runtime.attachTerminal).toHaveBeenCalledTimes(1)

    act(() => agent.set({ authorizedWorkspaces: [] }))

    expect(runtime.detachTerminal).toHaveBeenCalledWith(WS)
  })
})
