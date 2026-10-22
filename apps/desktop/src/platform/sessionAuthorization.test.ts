import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSessionAuthorization, retireSessionAuthority, revokeSessionAuthorization } from './sessionAuthorization'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

describe('sessionAuthorization', () => {
  beforeEach(() => { mocks.invoke.mockReset().mockResolvedValue({}) })

  it('查询按会话发送，只使用固定命令', async () => {
    await getSessionAuthorization('s1')
    expect(mocks.invoke).toHaveBeenCalledWith('session_authorization_command', {
      request: { action: 'snapshot', sessionId: 's1' },
    })
  })

  it('撤销只递增会话代际，不携带资源与全局范围', async () => {
    await revokeSessionAuthorization('s1')
    expect(mocks.invoke).toHaveBeenCalledWith('session_authorization_command', {
      request: { action: 'revoke', sessionId: 's1' },
    })
  })

  it('撤销不传其它会话或全局范围', async () => {
    await revokeSessionAuthorization('s2')
    expect(mocks.invoke).toHaveBeenCalledWith('session_authorization_command', {
      request: { action: 'revoke', sessionId: 's2' },
    })
  })

  // 停止会话的权限收口走单条命令：held Automatic 模式与会话撤销代际在 Rust
  // 侧同一次调用内落定，降级失败不会把更高权限留在原处。
  it('权限收口单次调用完成，不拆成两段 IPC', async () => {
    await retireSessionAuthority('s3')
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    expect(mocks.invoke).toHaveBeenCalledWith('retire_session_authority_command', {
      sessionId: 's3',
    })
  })
})
