import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentState } from './agentStateTypes'
import { continueConversation, type AgentSet, type StoreRuntimeDeps } from './sessionActions'
import { bindSessionWorkspace, forgetSessionWorkspace } from './services/sessionWorkspaceRegistry'

describe('预算暂停后的专用恢复', () => {
  afterEach(() => forgetSessionWorkspace('budget-resume'))

  const fixture = () => {
    const resume = vi.fn(async () => ({ reason: 'completed', newMessages: [] }))
    const prompt = vi.fn()
    const runtime = {
      id: 'budget-resume', continue: resume, prompt,
      takeQueuedMessages: vi.fn(async () => []), queuedMessages: [], recoveredMessages: [],
    }
    let state = {
      activeSessionId: runtime.id, runtimeLifecycle: 'ready', running: false, sessionBusy: false,
      providerReady: true, providerSetupRequired: false, provider: { providerId: 'demo' },
      messages: [{ role: 'user', content: '完成任务' }], endReason: 'turn_limit',
      sessions: [{ id: runtime.id, workspace: { path: '/repo/budget' } }],
      authorizedWorkspaces: [{ path: '/repo/budget' }],
    } as unknown as AgentState
    const set: AgentSet = (update) => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } }
    const deps = {
      getSession: () => runtime, getRepository: () => ({}),
    } as unknown as StoreRuntimeDeps
    bindSessionWorkspace(runtime.id, '/repo/budget')
    return { resume, prompt, deps, set, get: () => state }
  }

  it('沿用原会话继续，不发送新的用户消息', async () => {
    const f = fixture()
    await continueConversation(f.set, f.get, f.deps)
    expect(f.resume).toHaveBeenCalledOnce()
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.get().messages).toHaveLength(1)
    expect(f.get().running).toBe(false)
  })

  it('授权撤销后不恢复', async () => {
    const f = fixture()
    f.set({ authorizedWorkspaces: [] })
    await continueConversation(f.set, f.get, f.deps)
    expect(f.resume).not.toHaveBeenCalled()
    expect(f.get().error).toContain('已授权')
  })

  it('运行时绑定丢失后不恢复', async () => {
    const f = fixture()
    forgetSessionWorkspace('budget-resume')
    await continueConversation(f.set, f.get, f.deps)
    expect(f.resume).not.toHaveBeenCalled()
    expect(f.get().error).toContain('绑定已失效')
  })

  it('运行中不重复启动', async () => {
    const f = fixture()
    f.set({ running: true })
    await continueConversation(f.set, f.get, f.deps)
    expect(f.resume).not.toHaveBeenCalled()
  })

  it('Provider 尚未配置时不恢复', async () => {
    const f = fixture()
    f.set({ providerSetupRequired: true })
    await continueConversation(f.set, f.get, f.deps)
    expect(f.resume).not.toHaveBeenCalled()
    expect(f.get().error).toContain('Provider')
  })

  it('宿主未就绪时不恢复', async () => {
    const f = fixture()
    f.set({ runtimeLifecycle: 'initializing' } as unknown as Partial<AgentState>)
    await continueConversation(f.set, f.get, f.deps)
    expect(f.resume).not.toHaveBeenCalled()
  })
})
