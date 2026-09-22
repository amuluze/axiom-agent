import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemorySessionRepository } from '@/persistence/MemorySessionRepository'
import type { SessionDefaults, SessionSnapshot } from '@/persistence/types'
import type { AgentHarness } from '@/agent/runtime/AgentHarness'
import type { AgentMessage } from '@/agent/core/types'
import type { AuthorizedWorkspace } from '@/platform/workspace'
import { setRuntimeSession } from './runtimeCaches'
import type { AgentState } from './agentStateTypes'
import type { AgentGet, AgentSet, StoreRuntimeDeps } from './sessionActions'
import { editUserMessage } from './sessionActions'
import {
  archiveSession,
  branchFromMessage,
  cancelBranchSummary,
  deleteSession,
  renameSession,
  restoreSession,
  selectSession,
} from './sessionManagementActions'
import { isTauriRuntime } from '@/platform/environment'

const mocks = vi.hoisted(() => ({
  activateAuthorizedWorkspace: vi.fn(),
  createProviderTransport: vi.fn(),
}))

const sessionMetadataState = vi.hoisted(() => ({} as Record<string, {
  workspace: AuthorizedWorkspace | null
  archivedAt: number | null
}>))

vi.mock('@/platform/environment', () => ({
  isTauriRuntime: vi.fn(() => false),
}))

vi.mock('@/platform/workspace', () => ({
  activateAuthorizedWorkspace: mocks.activateAuthorizedWorkspace,
}))

// 部分 mock：editUserMessage 从 sessionActions 取值导入，会连带加载 settingsPersistence，
// 后者需要 provider 模块的其余导出（如 initialProviderFallback）。
vi.mock('@/agent/transport/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agent/transport/provider')>()),
  createProviderTransport: mocks.createProviderTransport,
}))

vi.mock('./services/sessionMetadata', () => ({
  hydrateSessionMetadata: (session: SessionSnapshot['session']) => session,
  updateSessionMetadata: vi.fn(),
  removeSessionMetadata: vi.fn(),
  sessionMetadataById: sessionMetadataState,
}))

const workspace = (path: string, name = path): AuthorizedWorkspace => ({
  path,
  name,
  gitBranch: null,
})

const SESSION_DEFAULTS: SessionDefaults = {
  systemPrompt: 'system prompt',
  modelProvider: 'demo',
  modelId: 'demo-model',
}

let repository: MemorySessionRepository
let state: AgentState
let set: AgentSet
let get: AgentGet
let deps: StoreRuntimeDeps
let harness: {
  runStructuralOperation: ReturnType<typeof vi.fn>
  summarizeBranch: ReturnType<typeof vi.fn>
  requestAbort: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
  takeQueuedMessages: ReturnType<typeof vi.fn>
}

const baseState = (): AgentState => ({
  activeSessionId: null,
  sessions: [],
  messages: [],
  running: false,
  sessionBusy: false,
  branchSummaryRunning: false,
  providerReady: false,
  providerSetupRequired: false,
  authorizedWorkspace: null,
  authorizedWorkspaces: [],
  settingsError: null,
  error: null,
  provider: {} as AgentState['provider'],
  providerHasKey: false,
  providerMessage: null,
  storageStats: null,
  initializationError: null,
  selectSession: vi.fn(async () => true),
} as unknown as AgentState)

beforeEach(() => {
  vi.clearAllMocks()
  Object.keys(sessionMetadataState).forEach((key) => { delete sessionMetadataState[key] })
  mocks.activateAuthorizedWorkspace.mockImplementation(async (path: string) => workspace(path))
  mocks.createProviderTransport.mockReturnValue({ model: {}, transport: {} })
  vi.mocked(isTauriRuntime).mockReturnValue(false)
  repository = new MemorySessionRepository()
  state = baseState()
  set = (partial) => {
    state = {
      ...state,
      ...(typeof partial === 'function' ? partial(state) : partial),
    }
  }
  get = () => state
  harness = {
    runStructuralOperation: vi.fn(async (_op: string, fn: (signal: AbortSignal) => Promise<boolean>) =>
      fn(new AbortController().signal)),
    summarizeBranch: vi.fn(async () => 'branch summary'),
    requestAbort: vi.fn(),
    prompt: vi.fn(async () => ({ reason: 'completed', newMessages: [] })),
    takeQueuedMessages: vi.fn(async () => undefined),
  }
  deps = {
    beginStructural: vi.fn(() => Symbol('lease')),
    endStructural: vi.fn(),
    getRepository: () => repository,
    getSession: () => harness as unknown as AgentHarness,
    activateSessionSnapshot: vi.fn(async () => undefined),
    activateCommittedSessionSnapshot: vi.fn(async () => ({ status: 'activated' })),
    activateCachedRuntimeSession: vi.fn(async () => undefined),
    activateCommittedCachedRuntimeSession: vi.fn(async () => ({ status: 'activated' })),
    projectedSessions: (snapshot: { session: unknown }) => [snapshot.session],
    sessionDefaults: () => SESSION_DEFAULTS,
    updateAuthorizedReadFiles: vi.fn(),
  } as unknown as StoreRuntimeDeps
})

describe('renameSession', () => {
  it('成功时更新本地会话标题并按 updatedAt 排序', async () => {
    const s1 = (await repository.createSession(SESSION_DEFAULTS)).session
    await new Promise((resolve) => setTimeout(resolve, 2))
    const s2 = (await repository.createSession(SESSION_DEFAULTS)).session
    state = { ...state, sessions: [s1, s2] }
    expect(await renameSession(set, get, deps, s2.id, '新标题')).toBe(true)
    expect(state.sessions.find((stored) => stored.id === s2.id)?.title).toBe('新标题')
    expect(state.sessions[0].id).toBe(s2.id)
  })

  it('structural lease 不可用时返回 false', async () => {
    deps.beginStructural = vi.fn(() => undefined)
    expect(await renameSession(set, get, deps, 'x', 't')).toBe(false)
  })

  it('异常时写 settingsError', async () => {
    repository.renameSession = vi.fn(async () => { throw new Error('rename boom') })
    expect(await renameSession(set, get, deps, 'x', 't')).toBe(false)
    expect(state.settingsError).toContain('rename boom')
  })
})

describe('cancelBranchSummary', () => {
  it('请求中止当前会话 harness', () => {
    cancelBranchSummary(set, get, deps)
    expect(harness.requestAbort).toHaveBeenCalledTimes(1)
  })
})

describe('restoreSession', () => {
  it('会话不存在时返回 false', async () => {
    expect(await restoreSession(set, get, deps, 'nope')).toBe(false)
  })

  it('成功时清除 archivedAt 并提示', async () => {
    const created = await repository.createSession(SESSION_DEFAULTS)
    const archived = { ...created.session, archivedAt: 123 }
    state = { ...state, sessions: [archived], activeSessionId: 'other' }
    expect(await restoreSession(set, get, deps, created.session.id)).toBe(true)
    expect(state.sessions[0].archivedAt).toBeNull()
    expect(state.providerMessage).toContain('已从归档恢复')
  })

  it('恢复后更新 updatedAt 并自动激活会话', async () => {
    const created = await repository.createSession(SESSION_DEFAULTS)
    const archived = { ...created.session, archivedAt: 123 }
    state = { ...state, sessions: [archived], activeSessionId: 'other' }
    expect(await restoreSession(set, get, deps, created.session.id)).toBe(true)
    expect(state.sessions[0].updatedAt).toBeGreaterThanOrEqual(archived.updatedAt)
    // 自动激活：selectSession（模块函数）经 activateSessionSnapshot 激活恢复的会话。
    expect(deps.activateSessionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({ session: expect.objectContaining({ id: created.session.id }) }),
    }))
  })

  it('恢复当前已激活会话时不再重复激活', async () => {
    const created = await repository.createSession(SESSION_DEFAULTS)
    const archived = { ...created.session, archivedAt: 123 }
    state = { ...state, sessions: [archived], activeSessionId: created.session.id }
    expect(await restoreSession(set, get, deps, created.session.id)).toBe(true)
    expect(deps.activateSessionSnapshot).not.toHaveBeenCalled()
  })

  it('恢复抛错时写 settingsError', async () => {
    const created = await repository.createSession(SESSION_DEFAULTS)
    state = { ...state, sessions: [created.session] }
    repository.restoreSession = vi.fn(async () => { throw new Error('restore boom') })
    expect(await restoreSession(set, get, deps, created.session.id)).toBe(false)
    expect(state.settingsError).toContain('restore boom')
  })
})

describe('archiveSession', () => {
  it('会话不存在时返回 false', async () => {
    expect(await archiveSession(set, get, deps, 'nope')).toBe(false)
  })

  it('运行中的会话拒绝归档', async () => {
    const created = await repository.createSession(SESSION_DEFAULTS)
    state = { ...state, sessions: [{ ...created.session, status: 'running' }] }
    expect(await archiveSession(set, get, deps, created.session.id)).toBe(false)
    expect(state.settingsError).toContain('不能归档')
  })

  it('归档活动会话但无后继会话时拒绝', async () => {
    const created = await repository.createSession(SESSION_DEFAULTS)
    state = { ...state, sessions: [created.session], activeSessionId: created.session.id }
    expect(await archiveSession(set, get, deps, created.session.id)).toBe(false)
    expect(state.settingsError).toContain('请先新建或选择')
  })

  it('归档活动会话时先切换到后继会话', async () => {
    const active = (await repository.createSession(SESSION_DEFAULTS)).session
    const successor = (await repository.createSession(SESSION_DEFAULTS)).session
    state = { ...state, sessions: [active, successor], activeSessionId: active.id }
    const selectSession = vi.fn(async () => true)
    state.selectSession = selectSession
    expect(await archiveSession(set, get, deps, active.id)).toBe(true)
    expect(selectSession).toHaveBeenCalledWith(successor.id)
    expect(state.sessions.find((stored) => stored.id === active.id)?.archivedAt).not.toBeNull()
  })

  it('非活动会话归档成功', async () => {
    const created = await repository.createSession(SESSION_DEFAULTS)
    state = { ...state, sessions: [created.session] }
    expect(await archiveSession(set, get, deps, created.session.id)).toBe(true)
    expect(state.sessions[0].archivedAt).not.toBeNull()
  })

  it('归档抛错时写 settingsError', async () => {
    const created = await repository.createSession(SESSION_DEFAULTS)
    state = { ...state, sessions: [created.session] }
    repository.archiveSession = vi.fn(async () => { throw new Error('archive boom') })
    expect(await archiveSession(set, get, deps, created.session.id)).toBe(false)
    expect(state.settingsError).toContain('archive boom')
  })
})

describe('selectSession', () => {
  it('选中当前会话时返回 false', async () => {
    state = { ...state, activeSessionId: 'same' }
    expect(await selectSession(set, get, deps, 'same')).toBe(false)
  })

  it('存在未销毁的缓存运行时走 activateCachedRuntimeSession', async () => {
    const created = await repository.createSession(SESSION_DEFAULTS)
    state = { ...state, sessions: [created.session] }
    setRuntimeSession(created.session.id, { isDisposed: false } as unknown as AgentHarness)
    expect(await selectSession(set, get, deps, created.session.id)).toBe(true)
    expect(deps.activateCachedRuntimeSession).toHaveBeenCalledTimes(1)
  })

  it('无缓存运行时经投影激活并恢复已授权工作区', async () => {
    const ws = workspace('/ws/sel')
    const created = await repository.createSession({ ...SESSION_DEFAULTS, workspace: ws })
    state = { ...state, sessions: [created.session], authorizedWorkspaces: [ws] }
    expect(await selectSession(set, get, deps, created.session.id)).toBe(true)
    expect(deps.activateSessionSnapshot).toHaveBeenCalledTimes(1)
    expect(deps.activateSessionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({ authorizedWorkspace: ws }),
    }))
  })

  it('会话工作区未授权时 authorizedWorkspace 为 null', async () => {
    const created = await repository.createSession(SESSION_DEFAULTS)
    state = { ...state, sessions: [created.session], authorizedWorkspaces: [] }
    expect(await selectSession(set, get, deps, created.session.id)).toBe(true)
    expect(deps.activateSessionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({ authorizedWorkspace: null }),
    }))
  })

  it('加载抛错时写 settingsError', async () => {
    repository.loadSession = vi.fn(async () => { throw new Error('load boom') })
    expect(await selectSession(set, get, deps, 'x')).toBe(false)
    expect(state.settingsError).toContain('load boom')
  })
})

describe('deleteSession', () => {
  it('运行中的会话拒绝删除', async () => {
    const created = await repository.createSession(SESSION_DEFAULTS)
    state = { ...state, sessions: [{ ...created.session, status: 'running' }] }
    expect(await deleteSession(set, get, deps, created.session.id)).toBe(false)
    expect(state.settingsError).toContain('不能删除')
  })

  it('删除非活动会话并从列表移除', async () => {
    const created = await repository.createSession(SESSION_DEFAULTS)
    state = { ...state, sessions: [created.session], activeSessionId: 'other' }
    expect(await deleteSession(set, get, deps, created.session.id)).toBe(true)
    expect(state.sessions).toHaveLength(0)
    expect(await repository.listSessions()).toHaveLength(0)
  })

  it('删除活动会话且有后继时激活后继', async () => {
    const active = (await repository.createSession(SESSION_DEFAULTS)).session
    const successor = (await repository.createSession(SESSION_DEFAULTS)).session
    state = { ...state, sessions: [active, successor], activeSessionId: active.id }
    expect(await deleteSession(set, get, deps, active.id)).toBe(true)
    expect(deps.activateCommittedSessionSnapshot).toHaveBeenCalledTimes(1)
    expect(deps.activateCommittedSessionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({ session: expect.objectContaining({ id: successor.id }) }),
    }))
  })

  it('删除活动会话且无后继时新建空会话', async () => {
    const active = (await repository.createSession(SESSION_DEFAULTS)).session
    state = { ...state, sessions: [active], activeSessionId: active.id }
    const deleteWithSuccessor = vi.spyOn(repository, 'deleteSessionWithSuccessor')
    expect(await deleteSession(set, get, deps, active.id)).toBe(true)
    expect(deleteWithSuccessor).toHaveBeenCalledTimes(1)
    // state.sessions 由投影（mock）更新，这里断言投影收到的后继 snapshot 是新会话。
    expect(deps.activateCommittedSessionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({
        session: expect.objectContaining({ id: expect.not.stringMatching(active.id) }),
      }),
    }))
  })

  it('删除抛错时写 settingsError', async () => {
    const created = await repository.createSession(SESSION_DEFAULTS)
    state = { ...state, sessions: [created.session], activeSessionId: 'other' }
    repository.deleteSession = vi.fn(async () => { throw new Error('delete boom') })
    expect(await deleteSession(set, get, deps, created.session.id)).toBe(false)
    expect(state.settingsError).toContain('delete boom')
  })
})

describe('branchFromMessage', () => {
  const ws = workspace('/ws/branch')

  const seedBranchState = async (): Promise<void> => {
    const created = await repository.createSession(SESSION_DEFAULTS)
    const sourceMessages = [
      { id: 'm1', role: 'user', content: 'hi' },
      { id: 'm2', role: 'assistant', content: 'yo' },
    ] as unknown as AgentMessage[]
    // A3：branchFromMessage 现在从 repository 重读权威消息计算分支边界，
    // 因此 mock loadSession 返回带消息的快照（此前依赖 store messages 快照）。
    repository.loadSession = vi.fn(async () => ({
      session: created.session,
      messages: sourceMessages,
      checkpoint: null,
      journalEntries: [],
    }))
    // branchSession 由本测试 mock：分支创建自身的消息复制/校验逻辑由
    // MemorySessionRepository 测试覆盖，这里专注 action 编排路径。
    repository.branchSession = vi.fn(async (request) => ({
      ...(await repository.loadSession(request.sourceSessionId)),
      session: { ...created.session, id: 'branch-1', parentSessionId: created.session.id },
    }))
    state = {
      ...state,
      activeSessionId: created.session.id,
      sessions: [created.session],
      messages: sourceMessages,
      providerReady: true,
      providerSetupRequired: false,
      authorizedWorkspaces: [ws],
    }
    sessionMetadataState[created.session.id] = { workspace: ws, archivedAt: null }
  }

  it('运行中或忙时返回 false 并提示错误', async () => {
    state = { ...state, running: true }
    expect(await branchFromMessage(set, get, deps, 'm1')).toBe(false)
    expect(state.error).toContain('正在运行')
  })

  it('当前会话没有可用工作目录时拒绝', async () => {
    const created = await repository.createSession(SESSION_DEFAULTS)
    state = { ...state, activeSessionId: created.session.id, sessions: [created.session] }
    sessionMetadataState[created.session.id] = { workspace: null, archivedAt: null }
    expect(await branchFromMessage(set, get, deps, 'm1')).toBe(false)
    expect(state.error).toContain('没有可用的工作目录')
  })

  it('summary 模式要求真实 Provider 配置', async () => {
    await seedBranchState()
    state = { ...state, providerReady: false, providerSetupRequired: true }
    expect(await branchFromMessage(set, get, deps, 'm1', true)).toBe(false)
    expect(state.error).toContain('Provider 配置')
  })

  it('分支边界消息不存在时失败', async () => {
    await seedBranchState()
    expect(await branchFromMessage(set, get, deps, 'missing')).toBe(false)
    expect(state.error).toContain('分支边界消息不存在')
  })

  it('成功创建分支并提示', async () => {
    await seedBranchState()
    expect(await branchFromMessage(set, get, deps, 'm1')).toBe(true)
    expect(deps.activateCommittedSessionSnapshot).toHaveBeenCalledTimes(1)
    expect(state.branchSummaryRunning).toBe(false)
    expect(state.error).toBeNull()
  })

  it('summary 模式生成 Branch Summary 并提示', async () => {
    await seedBranchState()
    expect(await branchFromMessage(set, get, deps, 'm1', true)).toBe(true)
    expect(mocks.createProviderTransport).toHaveBeenCalledTimes(1)
    expect(harness.summarizeBranch).toHaveBeenCalledTimes(1)
    expect(state.branchSummaryRunning).toBe(false)
  })

  it('repository 消息比 store 快照新时按权威快照计算分支边界', async () => {
    await seedBranchState()
    // store 快照缺最新消息 m3，但 repository 权威快照包含它。
    repository.loadSession = vi.fn(async () => {
      const session = (await new MemorySessionRepository().createSession(SESSION_DEFAULTS)).session
      return {
        session,
        messages: [
          { id: 'm1', role: 'user', content: 'hi' },
          { id: 'm2', role: 'assistant', content: 'yo' },
          { id: 'm3', role: 'assistant', content: 'extra' },
        ] as unknown as AgentMessage[],
        checkpoint: null,
        journalEntries: [],
      }
    })
    state = {
      ...state,
      messages: [
        { id: 'm1', role: 'user', content: 'hi' },
        { id: 'm2', role: 'assistant', content: 'yo' },
      ] as unknown as AgentMessage[],
    }
    expect(await branchFromMessage(set, get, deps, 'm1', true)).toBe(true)
    expect(harness.summarizeBranch).toHaveBeenCalledTimes(1)
    const abandoned = harness.summarizeBranch.mock.calls[0][0].messages as AgentMessage[]
    expect(abandoned.map((message) => message.id)).toEqual(['m2', 'm3'])
  })

  it('投影失败时提示在侧栏重新选择分支', async () => {
    await seedBranchState()
    deps.activateCommittedSessionSnapshot = vi.fn(async () => ({
      status: 'projection_failed' as const,
      error: 'projection boom',
    }))
    expect(await branchFromMessage(set, get, deps, 'm1')).toBe(true)
    expect(state.error).toContain('请在侧栏重新选择该分支')
  })
})

describe('editUserMessage', () => {
  const ws = workspace('/ws/edit')

  const seedEditState = async (): Promise<string> => {
    const created = await repository.createSession(SESSION_DEFAULTS)
    const sourceMessages = [
      { id: 'm1', role: 'user', content: 'hi', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'yo', toolCalls: [], stopReason: 'stop', createdAt: 2 },
      { id: 'm3', role: 'user', content: 'again', createdAt: 3 },
    ] as unknown as AgentMessage[]
    repository.loadSession = vi.fn(async () => ({
      session: created.session,
      messages: sourceMessages,
      checkpoint: null,
      journalEntries: [],
    }))
    repository.branchSession = vi.fn(async (request) => ({
      ...(await repository.loadSession(request.sourceSessionId)),
      session: { ...created.session, id: 'edit-1', parentSessionId: created.session.id },
    }))
    state = {
      ...state,
      activeSessionId: created.session.id,
      sessions: [created.session],
      messages: sourceMessages,
      providerReady: true,
      providerSetupRequired: false,
      authorizedWorkspaces: [ws],
    }
    sessionMetadataState[created.session.id] = { workspace: ws, archivedAt: null }
    return created.session.id
  }

  it('空内容直接拒绝', async () => {
    await seedEditState()
    expect(await editUserMessage(set, get, deps, 'm3', '   ')).toBe(false)
    expect(state.error).toContain('不能为空')
  })

  it('运行中或忙时返回 false 并提示错误', async () => {
    await seedEditState()
    state = { ...state, running: true }
    expect(await editUserMessage(set, get, deps, 'm3', 'edited')).toBe(false)
    expect(state.error).toContain('正在运行')
  })

  it('当前会话没有可用工作目录时拒绝', async () => {
    const sessionId = await seedEditState()
    sessionMetadataState[sessionId] = { workspace: null, archivedAt: null }
    expect(await editUserMessage(set, get, deps, 'm3', 'edited')).toBe(false)
    expect(state.error).toContain('没有可用的工作目录')
  })

  it('Provider 未就绪时拒绝', async () => {
    await seedEditState()
    state = { ...state, providerReady: false, providerSetupRequired: true }
    expect(await editUserMessage(set, get, deps, 'm3', 'edited')).toBe(false)
    expect(state.error).toContain('Provider 配置')
  })

  it('消息之前没有安全分支边界时拒绝（首条用户消息）', async () => {
    await seedEditState()
    expect(await editUserMessage(set, get, deps, 'm1', 'edited')).toBe(false)
    expect(state.error).toContain('没有安全的分支边界')
    expect(repository.branchSession).not.toHaveBeenCalled()
  })

  it('从该消息之前的边界创建分支并把编辑后的内容发给新分支', async () => {
    await seedEditState()
    expect(await editUserMessage(set, get, deps, 'm3', '  编辑后的内容  ')).toBe(true)

    expect(repository.branchSession).toHaveBeenCalledWith(expect.objectContaining({
      throughMessageId: 'm2',
      kind: 'branch',
    }))
    expect(deps.activateCommittedSessionSnapshot).toHaveBeenCalledTimes(1)
    expect(harness.prompt).toHaveBeenCalledWith('编辑后的内容', undefined)
    expect(state.error).toBeNull()
    expect(deps.endStructural).toHaveBeenCalledTimes(1)
  })

  it('重发已发起即返回 true，不等待整个 run 完成（Composer 立即清空输入的依据）', async () => {
    await seedEditState()
    harness.prompt = vi.fn(() => new Promise(() => {}))
    expect(await editUserMessage(set, get, deps, 'm3', 'edited')).toBe(true)
    expect(harness.prompt).toHaveBeenCalledWith('edited', undefined)
  })

  it('编辑重发时原消息的图片块随 prompt 透传', async () => {
    await seedEditState()
    const images = [{
      type: 'image' as const,
      source: { type: 'base64' as const, mediaType: 'image/png', data: 'cG5n' },
    }]
    expect(await editUserMessage(set, get, deps, 'm3', '编辑后的内容', images)).toBe(true)
    expect(harness.prompt).toHaveBeenCalledWith('编辑后的内容', images)
  })

  it('文本被清空但带图片时允许编辑重发', async () => {
    await seedEditState()
    const images = [{
      type: 'image' as const,
      source: { type: 'base64' as const, mediaType: 'image/png', data: 'cG5n' },
    }]
    expect(await editUserMessage(set, get, deps, 'm3', '   ', images)).toBe(true)
    expect(harness.prompt).toHaveBeenCalledWith('', images)
  })

  it('投影失败时不发送编辑后的内容', async () => {
    await seedEditState()
    deps.activateCommittedSessionSnapshot = vi.fn(async () => ({
      status: 'projection_failed' as const,
      error: 'projection boom',
    }))

    expect(await editUserMessage(set, get, deps, 'm3', 'edited')).toBe(false)
    expect(harness.prompt).not.toHaveBeenCalled()
    expect(state.error).toContain('编辑分支已创建，但运行时投影失败')
  })
})
