import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sshAgentCommand: vi.fn(),
  grantListeners: [] as Array<(event: { sessionId: string; host: string }) => void>,
}))

vi.mock('@/platform/environment', () => ({ isTauriRuntime: () => true }))
vi.mock('@/platform/sshAgent', () => ({
  onSshAgentGrantEvent: vi.fn((handler: (event: { sessionId: string; host: string }) => void) => {
    mocks.grantListeners.push(handler)
    return Promise.resolve(() => {})
  }),
  sshAgentCommand: mocks.sshAgentCommand,
}))

const deliverGrant = (event: { sessionId: string; host: string }): void => {
  for (const handler of mocks.grantListeners) handler(event)
}

describe('sshApprovalGrants（免卡片镜像）', () => {
  beforeEach(() => {
    mocks.sshAgentCommand.mockReset().mockResolvedValue({ type: 'ack' })
    mocks.grantListeners.length = 0
    vi.resetModules()
  })

  it('授权事件更新镜像，会话间隔离', async () => {
    const { ensureSshApprovalGrantMirror, sshHostGrantedForSession } = await import('./sshApprovalGrants')
    ensureSshApprovalGrantMirror()
    await vi.waitFor(() => expect(mocks.grantListeners.length).toBe(1))
    deliverGrant({ sessionId: 's1', host: 'prod' })
    deliverGrant({ sessionId: 's1', host: 'build' })
    deliverGrant({ sessionId: 's2', host: 'prod' })
    expect(sshHostGrantedForSession('s1', 'prod')).toBe(true)
    expect(sshHostGrantedForSession('s1', 'build')).toBe(true)
    expect(sshHostGrantedForSession('s2', 'prod')).toBe(true)
    expect(sshHostGrantedForSession('s1', 'ghost')).toBe(false)
    expect(sshHostGrantedForSession('s3', 'prod')).toBe(false)
  })

  it('forget 清本地镜像并通知 Rust 回收权威表（best-effort）', async () => {
    const { ensureSshApprovalGrantMirror, sshHostGrantedForSession, forgetSshApprovalGrants } =
      await import('./sshApprovalGrants')
    ensureSshApprovalGrantMirror()
    await vi.waitFor(() => expect(mocks.grantListeners.length).toBe(1))
    deliverGrant({ sessionId: 's1', host: 'prod' })
    expect(sshHostGrantedForSession('s1', 'prod')).toBe(true)

    forgetSshApprovalGrants('s1')
    expect(sshHostGrantedForSession('s1', 'prod')).toBe(false)
    expect(mocks.sshAgentCommand).toHaveBeenCalledWith({
      action: 'revokeSessionGrants',
      sessionId: 's1',
    })
  })

  it('revoke 调用失败不抛错（不阻断会话删除）', async () => {
    mocks.sshAgentCommand.mockRejectedValue(new Error('通道不可用'))
    const { forgetSshApprovalGrants } = await import('./sshApprovalGrants')
    expect(() => forgetSshApprovalGrants('s1')).not.toThrow()
  })
})
