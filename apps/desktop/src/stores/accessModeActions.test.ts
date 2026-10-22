import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setWorkspaceApprovalMode } from '@/platform/workspaceApproval'
import type { StoredAgentSession } from '@/persistence/types'
import type { AgentState } from './agentStateTypes'
import type { StoreRuntimeDeps } from './sessionActions'
import { resetSessionAccessMode, setSessionAccessMode } from './accessModeActions'

vi.mock('@/platform/workspaceApproval', () => ({
  setWorkspaceApprovalMode: vi.fn(),
}))

const mockedSetWorkspaceApprovalMode = vi.mocked(setWorkspaceApprovalMode)

const session = (accessMode: StoredAgentSession['accessMode']): StoredAgentSession => ({
  id: 'session-1',
  title: 'Session',
  createdAt: 1,
  updatedAt: 1,
  parentSessionId: null,
  status: 'idle',
  accessMode,
} as StoredAgentSession)

const setup = (updateSessionAccessMode = vi.fn().mockResolvedValue(undefined)) => {
  let state = {
    sessions: [session('standard')],
    activeSessionId: 'session-1',
    accessMode: 'standard',
    accessModeChanging: false,
    settingsError: null,
  } as AgentState
  const set = (partial: Partial<AgentState> | ((current: AgentState) => Partial<AgentState>)) => {
    state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) }
  }
  const get = () => state
  const cancelPendingApprovals = vi.fn().mockReturnValue(0)
  const deps = {
    getRepository: () => ({ updateSessionAccessMode }),
    cancelPendingApprovals,
  } as unknown as StoreRuntimeDeps
  return { cancelPendingApprovals, deps, get, set, updateSessionAccessMode }
}

describe('setSessionAccessMode', () => {
  beforeEach(() => {
    mockedSetWorkspaceApprovalMode.mockReset()
    mockedSetWorkspaceApprovalMode.mockResolvedValue(undefined)
  })

  it('commits the native mode before the session record and projection', async () => {
    const calls: string[] = []
    mockedSetWorkspaceApprovalMode.mockImplementation(async (_sessionId, mode) => {
      calls.push(`native:${mode}`)
    })
    const updateSessionAccessMode = vi.fn(async (_sessionId, mode) => {
      calls.push(`repository:${mode}`)
    })
    const context = setup(updateSessionAccessMode)

    await setSessionAccessMode(context.set, context.get, context.deps, 'session-1', 'no-approval')

    expect(calls).toEqual(['native:automatic', 'repository:no-approval'])
    expect(context.get().sessions[0]?.accessMode).toBe('no-approval')
    expect(context.get().accessMode).toBe('no-approval')
    expect(context.get().accessModeChanging).toBe(false)
  })

  it('rolls the native mode back when persistence fails', async () => {
    const updateSessionAccessMode = vi.fn().mockRejectedValue(new Error('database unavailable'))
    const context = setup(updateSessionAccessMode)

    await setSessionAccessMode(context.set, context.get, context.deps, 'session-1', 'no-approval')

    expect(mockedSetWorkspaceApprovalMode.mock.calls).toEqual([
      ['session-1', 'automatic'],
      ['session-1', 'interactive'],
    ])
    expect(context.get().sessions[0]?.accessMode).toBe('standard')
    expect(context.get().accessMode).toBe('standard')
    expect(context.get().settingsError).toContain('database unavailable')
  })

  it('keeps full access visible when enabling succeeds but persistence and rollback both fail', async () => {
    const updateSessionAccessMode = vi.fn().mockRejectedValue(new Error('database unavailable'))
    mockedSetWorkspaceApprovalMode
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('native rollback unavailable'))
    const context = setup(updateSessionAccessMode)

    await setSessionAccessMode(context.set, context.get, context.deps, 'session-1', 'no-approval')

    expect(context.get().sessions[0]?.accessMode).toBe('no-approval')
    expect(context.get().accessMode).toBe('no-approval')
    expect(context.get().settingsError).toContain('原生访问模式回滚失败')
  })

  it('serializes rapid updates for the same session', async () => {
    let releaseFirst: (() => void) | undefined
    const firstNative = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    mockedSetWorkspaceApprovalMode
      .mockImplementationOnce(() => firstNative)
      .mockResolvedValue(undefined)
    const context = setup()

    const enable = setSessionAccessMode(
      context.set,
      context.get,
      context.deps,
      'session-1',
      'no-approval',
    )
    const disable = setSessionAccessMode(
      context.set,
      context.get,
      context.deps,
      'session-1',
      'standard',
    )
    await vi.waitFor(() => {
      expect(mockedSetWorkspaceApprovalMode).toHaveBeenCalledTimes(1)
    })

    releaseFirst?.()
    await Promise.all([enable, disable])

    expect(mockedSetWorkspaceApprovalMode.mock.calls).toEqual([
      ['session-1', 'automatic'],
      ['session-1', 'interactive'],
    ])
    expect(context.updateSessionAccessMode.mock.calls).toEqual([
      ['session-1', 'no-approval'],
      ['session-1', 'standard'],
    ])
    expect(context.get().accessMode).toBe('standard')
  })

  it('keeps the native mode fail-closed when a reset cannot be persisted', async () => {
    const updateSessionAccessMode = vi.fn().mockRejectedValue(new Error('database unavailable'))
    const context = setup(updateSessionAccessMode)
    context.set((state) => ({
      sessions: state.sessions.map((candidate) => ({
        ...candidate,
        accessMode: 'no-approval',
      })),
      accessMode: 'no-approval',
    }))

    await expect(resetSessionAccessMode(
      context.set,
      context.get,
      context.deps,
      'session-1',
    )).resolves.toBe(true)

    expect(mockedSetWorkspaceApprovalMode.mock.calls).toEqual([
      ['session-1', 'interactive'],
    ])
    expect(context.get().sessions[0]?.accessMode).toBe('standard')
    expect(context.get().accessMode).toBe('standard')
    expect(context.get().settingsError).toContain('原生访问模式已重置')
  })

  // 降级必须撤回该会话已入队的审批卡片：卡片按降级前的权限状态排队，用户点
  // 「允许一次」走 interactive 签发路径——撤销工作区后仍能拿到 Unrestricted
  // 租约即由此而来。
  it('withdraws queued approvals for the session when downgrading', async () => {
    const context = setup()
    context.set((state) => ({
      sessions: state.sessions.map((candidate) => ({ ...candidate, accessMode: 'no-approval' })),
      accessMode: 'no-approval',
    }))

    await resetSessionAccessMode(context.set, context.get, context.deps, 'session-1')

    expect(context.cancelPendingApprovals).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('访问模式已变更'),
    )
  })

  it('withdraws queued approvals when the user switches back to standard', async () => {
    const context = setup()
    context.set((state) => ({
      sessions: state.sessions.map((candidate) => ({ ...candidate, accessMode: 'no-approval' })),
      accessMode: 'no-approval',
    }))

    await setSessionAccessMode(context.set, context.get, context.deps, 'session-1', 'standard')

    expect(context.cancelPendingApprovals).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('访问模式已变更'),
    )
  })

  // 升级到完全访问不撤回：卡片本就等价于标准模式下的逐次审批，且撤回会让
  // run 以「被拒绝」收口而非自动放行。
  it('keeps queued approvals when upgrading to full access', async () => {
    const context = setup()

    await setSessionAccessMode(context.set, context.get, context.deps, 'session-1', 'no-approval')

    expect(context.cancelPendingApprovals).not.toHaveBeenCalled()
  })

  // native 复位失败时降级根本没发生，卡片必须保留。
  it('keeps queued approvals when the downgrade itself fails', async () => {
    mockedSetWorkspaceApprovalMode.mockRejectedValue(new Error('native channel down'))
    const context = setup()
    context.set((state) => ({
      sessions: state.sessions.map((candidate) => ({ ...candidate, accessMode: 'no-approval' })),
      accessMode: 'no-approval',
    }))

    await expect(resetSessionAccessMode(
      context.set,
      context.get,
      context.deps,
      'session-1',
    )).resolves.toBe(false)

    expect(context.cancelPendingApprovals).not.toHaveBeenCalled()
  })
})
