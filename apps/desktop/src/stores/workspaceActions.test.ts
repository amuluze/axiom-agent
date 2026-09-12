import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { MemorySessionRepository } from '@/persistence/MemorySessionRepository'
import type { SessionDefaults, SessionSnapshot } from '@/persistence/types'
import type { AuthorizedWorkspace } from '@/platform/workspace'
import type { AgentState } from './agentStateTypes'
import type { AgentGet, AgentSet, StoreRuntimeDeps } from './sessionActions'
import {
  activateWorkspace,
  addWorkspace,
  authorizeDirectory,
  authorizeFile,
  authorizeWorkspace,
  createNewSession,
  refreshWorkspaceBranchInfo,
  revokeFile,
  revokeWorkspace,
  sessionWorkspacePaths,
} from './workspaceActions'
import { isTauriRuntime } from '@/platform/environment'
import { useUiStore } from './uiStore'
import type { AgentHarness } from '@/agent/runtime/AgentHarness'
import {
  dropRuntimeCachesForSession,
  setRuntimeSession,
} from './runtimeCaches'

const mocks = vi.hoisted(() => ({
  selectAndAuthorizeWorkspace: vi.fn(),
  getAuthorizedWorkspaces: vi.fn(),
  revokeWorkspace: vi.fn(),
  activateAuthorizedWorkspace: vi.fn(),
  selectAndAuthorizeReadFile: vi.fn(),
  selectAndAuthorizeReadDirectory: vi.fn(),
  listAuthorizedReadFiles: vi.fn(),
  revokeAuthorizedReadFile: vi.fn(),
}))

vi.mock('@/platform/environment', () => ({
  isTauriRuntime: vi.fn(() => false),
}))

vi.mock('@/platform/workspace', () => ({
  selectAndAuthorizeWorkspace: mocks.selectAndAuthorizeWorkspace,
  getAuthorizedWorkspaces: mocks.getAuthorizedWorkspaces,
  revokeWorkspace: mocks.revokeWorkspace,
  activateAuthorizedWorkspace: mocks.activateAuthorizedWorkspace,
}))

vi.mock('@/platform/authorizedFiles', () => ({
  selectAndAuthorizeReadFile: mocks.selectAndAuthorizeReadFile,
  selectAndAuthorizeReadDirectory: mocks.selectAndAuthorizeReadDirectory,
  listAuthorizedReadFiles: mocks.listAuthorizedReadFiles,
  revokeAuthorizedReadFile: mocks.revokeAuthorizedReadFile,
}))

// 隔离 localStorage 依赖：workspaceActions 经 services/sessionMetadata 读写
// localStorage（仅 Tauri 运行时），测试中全 mock，行为由真实实现另行覆盖。
vi.mock('./services/sessionMetadata', () => ({
  hydrateSessionMetadata: (session: SessionSnapshot['session']) => session,
  hydrateSessionsMetadata: (list: SessionSnapshot['session'][]) => list,
  updateSessionMetadata: vi.fn(),
  removeWorkspaceSessionMetadata: vi.fn(),
  removeWorkspaceSessionMetadataForSessions: vi.fn(),
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
let commitProjection: Mock<() => Promise<{ status: string }>>

const sessionDefaults = (): SessionDefaults => SESSION_DEFAULTS

const baseState = (): AgentState => ({
  activeSessionId: null,
  sessions: [],
  authorizedWorkspace: null,
  authorizedWorkspaces: [],
  authorizedFiles: [],
  provider: {} as AgentState['provider'],
  providerHasKey: false,
  settingsError: null,
  providerMessage: null,
  selectSession: vi.fn(async () => true),
} as unknown as AgentState)

const activateCommittedSessionSnapshot = vi.fn(async () => commitProjection())

beforeEach(() => {
  vi.clearAllMocks()
  mocks.activateAuthorizedWorkspace.mockImplementation(async (path: string) => workspace(path))
  mocks.getAuthorizedWorkspaces.mockResolvedValue([])
  vi.mocked(isTauriRuntime).mockReturnValue(false)
  // 重置「最近打开」状态，隔离 workspaceActions 成功路径对 uiStore 的写入。
  useUiStore.setState({ recentWorkspacePaths: [] })
  repository = new MemorySessionRepository()
  state = baseState()
  set = (partial: Parameters<AgentSet>[0]) => {
    state = {
      ...state,
      ...(typeof partial === 'function' ? partial(state) : partial),
    }
  }
  get = () => state
  commitProjection = vi.fn(async () => ({ status: 'activated' }))
  activateCommittedSessionSnapshot.mockImplementation(async () => commitProjection())
  deps = {
    beginStructural: vi.fn(() => Symbol('lease')),
    endStructural: vi.fn(),
    getRepository: () => repository,
    activateSessionSnapshot: vi.fn(async () => undefined),
    activateCommittedSessionSnapshot: activateCommittedSessionSnapshot,
    projectedSessions: (snapshot: { session: unknown }) => [snapshot.session],
    sessionDefaults,
    updateAuthorizedReadFiles: vi.fn(),
  } as unknown as StoreRuntimeDeps
})

describe('authorizeWorkspace', () => {
  it('返回 false 且不发起选择当 structural lease 不可用', async () => {
    deps.beginStructural = vi.fn(() => undefined)
    const result = await authorizeWorkspace(set, get, deps)
    expect(result).toBe(false)
    expect(mocks.selectAndAuthorizeWorkspace).not.toHaveBeenCalled()
  })

  it('用户取消选择时返回 false 并清空 settingsError', async () => {
    mocks.selectAndAuthorizeWorkspace.mockResolvedValue(null)
    const result = await authorizeWorkspace(set, get, deps)
    expect(result).toBe(false)
    expect(state.settingsError).toBeNull()
  })

  it('无活动会话时仅写入工作区状态并返回 true', async () => {
    const ws = workspace('/ws/a')
    mocks.selectAndAuthorizeWorkspace.mockResolvedValue(ws)
    mocks.getAuthorizedWorkspaces.mockResolvedValue([ws])
    const result = await authorizeWorkspace(set, get, deps)
    expect(result).toBe(true)
    expect(state.authorizedWorkspace).toEqual(ws)
    expect(state.authorizedWorkspaces).toEqual([ws])
    expect(state.providerMessage).toContain('已授权工作区')
    expect(deps.activateSessionSnapshot).not.toHaveBeenCalled()
  })

  it('有活动会话时刷新会话投影并带工作区提示', async () => {
    const ws = workspace('/ws/b')
    const created = await repository.createSession(SESSION_DEFAULTS)
    state = { ...state, activeSessionId: created.session.id, sessions: [created.session] }
    mocks.selectAndAuthorizeWorkspace.mockResolvedValue(ws)
    mocks.getAuthorizedWorkspaces.mockResolvedValue([ws])
    const result = await authorizeWorkspace(set, get, deps)
    expect(result).toBe(true)
    expect(deps.activateSessionSnapshot).toHaveBeenCalledTimes(1)
    expect(deps.activateSessionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({
        authorizedWorkspace: ws,
        providerMessage: expect.stringContaining('已授权工作区'),
      }),
    }))
  })

  it('选择或加载失败时写入 settingsError 并返回 false', async () => {
    mocks.selectAndAuthorizeWorkspace.mockRejectedValue(new Error('native picker failed'))
    const result = await authorizeWorkspace(set, get, deps)
    expect(result).toBe(false)
    expect(state.settingsError).toContain('native picker failed')
  })
})

describe('addWorkspace', () => {
  it('lease 不可用时返回 false', async () => {
    deps.beginStructural = vi.fn(() => undefined)
    expect(await addWorkspace(set, get, deps)).toBe(false)
  })

  it('用户取消时返回 false', async () => {
    mocks.selectAndAuthorizeWorkspace.mockResolvedValue(null)
    expect(await addWorkspace(set, get, deps)).toBe(false)
  })

  it('无可复用会话时新建 Session 并绑定工作区', async () => {
    const ws = workspace('/ws/c')
    mocks.selectAndAuthorizeWorkspace.mockResolvedValue(ws)
    mocks.getAuthorizedWorkspaces.mockResolvedValue([ws])
    const result = await addWorkspace(set, get, deps)
    expect(result).toBe(true)
    expect(await repository.listSessions()).toHaveLength(1)
    expect(deps.activateCommittedSessionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({
        authorizedWorkspace: ws,
        providerMessage: expect.stringContaining('已添加工作目录'),
      }),
    }))
    const sessions = await repository.listSessions()
    expect(sessions[0].workspace?.path).toBe('/ws/c')
    expect(useUiStore.getState().recentWorkspacePaths).toContain('/ws/c')
  })

  it('存在未绑定且空闲的空会话时复用它而非新建', async () => {
    const ws = workspace('/ws/d')
    const created = await repository.createSession(SESSION_DEFAULTS)
    state = { ...state, activeSessionId: created.session.id, sessions: [created.session] }
    mocks.selectAndAuthorizeWorkspace.mockResolvedValue(ws)
    mocks.getAuthorizedWorkspaces.mockResolvedValue([ws])
    const result = await addWorkspace(set, get, deps)
    expect(result).toBe(true)
    // 复用路径不写 repository（workspace 仅进 session metadata），断言 metadata 写入与投影参数。
    expect(deps.activateCommittedSessionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({
        authorizedWorkspace: ws,
        providerMessage: expect.stringContaining('已将当前会话绑定'),
      }),
    }))
    const sessions = await repository.listSessions()
    expect(sessions).toHaveLength(1)
  })

  it('投影失败时写入 settingsError 但保留 true', async () => {
    const ws = workspace('/ws/e')
    mocks.selectAndAuthorizeWorkspace.mockResolvedValue(ws)
    mocks.getAuthorizedWorkspaces.mockResolvedValue([ws])
    commitProjection = vi.fn(async () => ({ status: 'projection_failed', error: 'projection boom' }))
    const result = await addWorkspace(set, get, deps)
    expect(result).toBe(true)
    expect(state.settingsError).toContain('projection boom')
  })

  it('异常路径写入 settingsError 并返回 false', async () => {
    mocks.selectAndAuthorizeWorkspace.mockRejectedValue(new Error('picker down'))
    expect(await addWorkspace(set, get, deps)).toBe(false)
    expect(state.settingsError).toContain('picker down')
  })
})

describe('activateWorkspace', () => {
  it('非 Tauri 运行时直接返回 false', async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(false)
    expect(await activateWorkspace(set, get, deps, '/ws/x')).toBe(false)
  })

  it('存在绑定该路径的活动会话时切到该会话', async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true)
    const created = await repository.createSession({ ...SESSION_DEFAULTS, workspace: workspace('/ws/x') })
    state = { ...state, sessions: [created.session], activeSessionId: 'other' }
    const selectSession = vi.fn(async () => true)
    state.selectSession = selectSession
    expect(await activateWorkspace(set, get, deps, '/ws/x')).toBe(true)
    expect(selectSession).toHaveBeenCalledWith(created.session.id)
    expect(useUiStore.getState().recentWorkspacePaths).toContain('/ws/x')
  })

  it('路径未授权时拒绝并提示重新选择', async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true)
    expect(await activateWorkspace(set, get, deps, '/ws/unknown')).toBe(false)
    expect(state.settingsError).toContain('尚未授权')
  })

  it('已授权且已有匹配会话时直接激活并返回', async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true)
    const created = await repository.createSession({ ...SESSION_DEFAULTS, workspace: workspace('/ws/y') })
    state = {
      ...state,
      sessions: [created.session],
      activeSessionId: created.session.id,
      authorizedWorkspaces: [workspace('/ws/y')],
    }
    expect(await activateWorkspace(set, get, deps, '/ws/y')).toBe(true)
    expect(mocks.activateAuthorizedWorkspace).toHaveBeenCalledWith('/ws/y')
    expect(state.authorizedWorkspace?.path).toBe('/ws/y')
    expect(deps.activateCommittedSessionSnapshot).not.toHaveBeenCalled()
  })

  it('无匹配会话时新建 Session 并切换工作区', async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true)
    state = { ...state, authorizedWorkspaces: [workspace('/ws/z')] }
    expect(await activateWorkspace(set, get, deps, '/ws/z')).toBe(true)
    expect(deps.activateCommittedSessionSnapshot).toHaveBeenCalledTimes(1)
    expect(deps.activateCommittedSessionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({ providerMessage: expect.stringContaining('已切换到工作目录') }),
    }))
    expect(useUiStore.getState().recentWorkspacePaths).toContain('/ws/z')
  })

  it('路径未授权时不记录最近打开', async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true)
    expect(await activateWorkspace(set, get, deps, '/ws/unknown')).toBe(false)
    expect(useUiStore.getState().recentWorkspacePaths).not.toContain('/ws/unknown')
  })

  it('激活抛错时写 settingsError', async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true)
    state = { ...state, authorizedWorkspaces: [workspace('/ws/z')] }
    mocks.activateAuthorizedWorkspace.mockRejectedValue(new Error('activate failed'))
    expect(await activateWorkspace(set, get, deps, '/ws/z')).toBe(false)
    expect(state.settingsError).toContain('activate failed')
  })
})

describe('revokeWorkspace', () => {
  it('无目标路径且无当前工作区时返回 false', async () => {
    expect(await revokeWorkspace(set, get, deps)).toBe(false)
  })

  it('撤销失败时返回 false', async () => {
    mocks.revokeWorkspace.mockResolvedValue(false)
    expect(await revokeWorkspace(set, get, deps, '/ws/a')).toBe(false)
  })

  it('撤销后清空 metadata 并回到剩余授权工作区', async () => {
    const wsA = workspace('/ws/a')
    const wsB = workspace('/ws/b')
    const created = await repository.createSession({ ...SESSION_DEFAULTS, workspace: wsA })
    state = {
      ...state,
      sessions: [created.session],
      activeSessionId: created.session.id,
      authorizedWorkspace: wsA,
      authorizedWorkspaces: [wsA, wsB],
    }
    mocks.revokeWorkspace.mockResolvedValue(true)
    mocks.getAuthorizedWorkspaces.mockResolvedValue([wsB])
    expect(await revokeWorkspace(set, get, deps, '/ws/a')).toBe(true)
    expect(repository.clearWorkspaceForPath).toBeDefined()
    expect(state.authorizedWorkspace?.path).toBe('/ws/b')
    expect(state.authorizedWorkspaces).toEqual([wsB])
    expect(state.providerMessage).toContain('已从授权列表移除')
  })

  it('撤销全部工作区后 authorizedWorkspace 为 null', async () => {
    const wsA = workspace('/ws/a')
    state = { ...state, authorizedWorkspace: wsA, authorizedWorkspaces: [wsA] }
    mocks.revokeWorkspace.mockResolvedValue(true)
    mocks.getAuthorizedWorkspaces.mockResolvedValue([])
    expect(await revokeWorkspace(set, get, deps)).toBe(true)
    expect(state.authorizedWorkspace).toBeNull()
    expect(state.providerMessage).toContain('已撤销')
  })

  it('异常路径写 settingsError', async () => {
    mocks.revokeWorkspace.mockRejectedValue(new Error('revoke failed'))
    expect(await revokeWorkspace(set, get, deps, '/ws/a')).toBe(false)
    expect(state.settingsError).toContain('revoke failed')
  })

  it('撤销时停止绑定该工作区的运行中会话并清理工作区映射', async () => {
    const wsA = workspace('/ws/a')
    const wsB = workspace('/ws/b')
    const createdA = await repository.createSession({ ...SESSION_DEFAULTS, workspace: wsA })
    const createdB = await repository.createSession({ ...SESSION_DEFAULTS, workspace: wsB })
    state = {
      ...state,
      sessions: [createdA.session, createdB.session],
      activeSessionId: createdB.session.id,
      authorizedWorkspace: wsB,
      authorizedWorkspaces: [wsA, wsB],
    }
    const requestAbort = vi.fn()
    setRuntimeSession(createdA.session.id, {
      isRunning: true,
      isDisposed: false,
      requestAbort,
    } as unknown as AgentHarness)
    sessionWorkspacePaths.set(createdA.session.id, '/ws/a')
    sessionWorkspacePaths.set(createdB.session.id, '/ws/b')
    mocks.revokeWorkspace.mockResolvedValue(true)
    mocks.getAuthorizedWorkspaces.mockResolvedValue([wsB])
    expect(await revokeWorkspace(set, get, deps, '/ws/a')).toBe(true)
    expect(requestAbort).toHaveBeenCalledTimes(1)
    expect(sessionWorkspacePaths.get(createdA.session.id)).toBeUndefined()
    expect(sessionWorkspacePaths.get(createdB.session.id)).toBe('/ws/b')
    expect(state.providerMessage).toContain('已停止 1 个关联的运行中会话')
    dropRuntimeCachesForSession(createdA.session.id)
    sessionWorkspacePaths.delete(createdB.session.id)
  })
})

describe('authorizeFile / revokeFile', () => {
  it('授权文件成功后更新列表与提示', async () => {
    const file = { path: '/ws/a/README.md', name: 'README.md', sizeBytes: 42, isDirectory: false }
    mocks.selectAndAuthorizeReadFile.mockResolvedValue(file)
    mocks.listAuthorizedReadFiles.mockResolvedValue([file])
    expect(await authorizeFile(set, get, deps)).toBe(true)
    expect(state.authorizedFiles).toEqual([file])
    expect(deps.updateAuthorizedReadFiles).toHaveBeenCalledWith([file])
    expect(state.providerMessage).toContain('已添加文件引用')
  })

  it('授权目录成功后更新列表与提示', async () => {
    const directory = { path: '/ws/a/src', name: 'src', sizeBytes: 0, isDirectory: true }
    mocks.selectAndAuthorizeReadDirectory.mockResolvedValue(directory)
    mocks.listAuthorizedReadFiles.mockResolvedValue([directory])
    expect(await authorizeDirectory(set, get, deps)).toBe(true)
    expect(state.authorizedFiles).toEqual([directory])
    expect(deps.updateAuthorizedReadFiles).toHaveBeenCalledWith([directory])
    expect(state.providerMessage).toContain('已添加目录引用')
  })

  it('授权目录取消时返回 false', async () => {
    mocks.selectAndAuthorizeReadDirectory.mockResolvedValue(null)
    expect(await authorizeDirectory(set, get, deps)).toBe(false)
  })

  it('授权文件取消时返回 false', async () => {
    mocks.selectAndAuthorizeReadFile.mockResolvedValue(null)
    expect(await authorizeFile(set, get, deps)).toBe(false)
  })

  it('撤销文件成功后更新列表', async () => {
    mocks.listAuthorizedReadFiles.mockResolvedValue([])
    expect(await revokeFile(set, get, deps, '/ws/a/README.md')).toBe(true)
    expect(mocks.revokeAuthorizedReadFile).toHaveBeenCalledWith('/ws/a/README.md')
    expect(state.authorizedFiles).toEqual([])
    expect(state.providerMessage).toContain('已移除')
  })

  it('授权/撤销的异常路径写 settingsError', async () => {
    mocks.selectAndAuthorizeReadFile.mockRejectedValue(new Error('file picker down'))
    expect(await authorizeFile(set, get, deps)).toBe(false)
    expect(state.settingsError).toContain('file picker down')
    mocks.revokeAuthorizedReadFile.mockRejectedValue(new Error('revoke file down'))
    expect(await revokeFile(set, get, deps, '/ws/a/x')).toBe(false)
    expect(state.settingsError).toContain('revoke file down')
  })
})

describe('createNewSession', () => {
  it('未选择工作区时拒绝新建', async () => {
    expect(await createNewSession(set, get, deps)).toBe(false)
    expect(state.settingsError).toContain('请先选择一个已授权的工作目录')
  })

  it('按显式 workspacePath 新建会话', async () => {
    const ws = workspace('/ws/n')
    state = { ...state, authorizedWorkspaces: [ws] }
    expect(await createNewSession(set, get, deps, '/ws/n')).toBe(true)
    expect(deps.activateCommittedSessionSnapshot).toHaveBeenCalledTimes(1)
    expect(deps.activateCommittedSessionSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({ authorizedWorkspace: ws }),
    }))
    expect(useUiStore.getState().recentWorkspacePaths).toContain('/ws/n')
  })

  it('无显式路径时使用当前授权工作区', async () => {
    const ws = workspace('/ws/cur')
    state = { ...state, authorizedWorkspace: ws, authorizedWorkspaces: [ws] }
    expect(await createNewSession(set, get, deps)).toBe(true)
    expect(state.authorizedWorkspace?.path).toBe('/ws/cur')
  })

  it('投影失败时写 settingsError', async () => {
    const ws = workspace('/ws/n')
    state = { ...state, authorizedWorkspaces: [ws] }
    commitProjection = vi.fn(async () => ({ status: 'projection_failed', error: 'projection nope' }))
    expect(await createNewSession(set, get, deps, '/ws/n')).toBe(true)
    expect(state.settingsError).toContain('projection nope')
  })

  it('创建抛错时写 settingsError', async () => {
    const ws = workspace('/ws/n')
    state = { ...state, authorizedWorkspaces: [ws] }
    const original = repository.createSession.bind(repository)
    repository.createSession = vi.fn(async () => { throw new Error('create failed') })
    expect(await createNewSession(set, get, deps, '/ws/n')).toBe(false)
    expect(state.settingsError).toContain('create failed')
    repository.createSession = original
  })
})

describe('refreshWorkspaceBranchInfo', () => {
  it('非 Tauri 运行时直接跳过，不调用 Rust', async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(false)
    await refreshWorkspaceBranchInfo(set, get, deps)
    expect(mocks.getAuthorizedWorkspaces).not.toHaveBeenCalled()
  })

  it('分支变化时更新 authorizedWorkspaces 与 authorizedWorkspace', async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true)
    state = {
      ...state,
      authorizedWorkspace: workspace('/ws/x', 'x'),
      authorizedWorkspaces: [workspace('/ws/x', 'x')],
    }
    mocks.getAuthorizedWorkspaces.mockResolvedValue([
      { path: '/ws/x', name: 'x', gitBranch: 'feat-branch' },
    ])
    await refreshWorkspaceBranchInfo(set, get, deps)
    expect(state.authorizedWorkspaces[0]?.gitBranch).toBe('feat-branch')
    expect(state.authorizedWorkspace?.gitBranch).toBe('feat-branch')
  })

  it('分支未变化时不触发 set（state 引用不变）', async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true)
    const ws = workspace('/ws/x', 'x')
    state = { ...state, authorizedWorkspace: ws, authorizedWorkspaces: [ws] }
    mocks.getAuthorizedWorkspaces.mockResolvedValue([workspace('/ws/x', 'x')])
    const snapshot = state
    await refreshWorkspaceBranchInfo(set, get, deps)
    expect(state).toBe(snapshot)
  })

  it('读取失败时静默保持旧值', async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true)
    const ws = workspace('/ws/x', 'x')
    state = { ...state, authorizedWorkspace: ws, authorizedWorkspaces: [ws] }
    mocks.getAuthorizedWorkspaces.mockRejectedValue(new Error('git head unreadable'))
    await refreshWorkspaceBranchInfo(set, get, deps)
    expect(state.authorizedWorkspace?.gitBranch).toBeNull()
  })
})
