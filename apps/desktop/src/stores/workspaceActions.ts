import { isTauriRuntime } from '@/platform/environment'
import {
  activateAuthorizedWorkspace,
  getAuthorizedWorkspaces,
  revokeWorkspace as revokeAuthorizedWorkspace,
  selectAndAuthorizeWorkspace,
} from '@/platform/workspace'
import {
  listAuthorizedReadFiles,
  revokeAuthorizedReadFile,
  selectAndAuthorizeReadDirectory,
  selectAndAuthorizeReadFile,
  type AuthorizedReadFile,
} from '@/platform/authorizedFiles'
import {
  hydrateSessionMetadata,
  hydrateSessionsMetadata,
  removeWorkspaceSessionMetadata,
  removeWorkspaceSessionMetadataForSessions,
  updateSessionMetadata,
} from './services/sessionMetadata'
import type { StoredAgentSession } from '@/persistence/types'
import type { AgentGet, AgentSet, StoreRuntimeDeps } from './sessionActions'
import type { AgentState } from './agentStateTypes'
import { useUiStore } from './uiStore'
import { getRuntimeSession } from './runtimeCaches'
import { storeT } from '@/i18n/storeTranslate'
import { resetSessionAccessMode } from './accessModeActions'
import {
  bindSessionWorkspace,
  forgetSessionWorkspace,
  forgetSessionsForWorkspace,
  sessionWorkspaceBindings,
  sessionWorkspacePath,
  sessionsForWorkspace,
} from './services/sessionWorkspaceRegistry'

/**
 * 工作区路径 → 会话绑定的模块级镜像：createRuntimeSession（store 初始化阶段）
 * 与 workspace action（新增/撤销）都会读写它，因此独立成模块共享。
 *
 * 语义与三处同步约束见 {@link ./services/sessionWorkspaceRegistry} 的模块注释——
 * 裸 Map 会让「忘记同步」变成静默的 stale path，故只暴露具名方法。
 */
export const sessionWorkspacePaths = {
  bind: bindSessionWorkspace,
  forget: forgetSessionWorkspace,
  pathOf: sessionWorkspacePath,
  forgetSessionsForWorkspace,
  sessionsForWorkspace,
  bindings: sessionWorkspaceBindings,
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 工作区成功激活/选中后，把 path 记录为「最近打开」（置顶持久化）。 */
const recordRecent = (path: string): void => {
  useUiStore.getState().recordRecentWorkspace(path)
}

const reusableUnboundActiveSession = (
  state: Pick<AgentState, 'activeSessionId' | 'sessions'>,
): StoredAgentSession | undefined => state.sessions.find((stored) => (
  stored.id === state.activeSessionId
  && !stored.workspace
  && !stored.archivedAt
  && stored.status === 'idle'
  && stored.messageCount === 0
))

const resetActiveFullAccessForWorkspaceSwitch = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  path: string,
): Promise<boolean> => {
  const activeSessionId = get().activeSessionId
  const activeSession = get().sessions.find((session) => session.id === activeSessionId)
  if (
    !activeSessionId
    || activeSession?.workspace?.path === path
    || activeSession?.accessMode !== 'no-approval'
  ) return true
  const ok = await resetSessionAccessMode(set, get, deps, activeSessionId)
  // 切换工作区同样改变提示词里的访问模式段，需重建（run 进行中时内部跳过）。
  if (ok) await deps.refreshSystemPromptForAccessMode()
  return ok
}

export const authorizeWorkspace = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
): Promise<boolean> => {
  const structuralLease = deps.beginStructural()
  if (!structuralLease) return false
  set({ settingsError: null })
  try {
    const workspace = await selectAndAuthorizeWorkspace()
    if (!workspace) return false
    if (!await resetActiveFullAccessForWorkspaceSwitch(set, get, deps, workspace.path)) return false
    recordRecent(workspace.path)
    const activeSessionId = get().activeSessionId
    if (activeSessionId) updateSessionMetadata(activeSessionId, { workspace })
    const authorizedWorkspaces = await getAuthorizedWorkspaces()
    if (activeSessionId) {
      const snapshot = await deps.getRepository().loadSession(activeSessionId)
      await deps.activateSessionSnapshot({
        repository: deps.getRepository(),
        snapshot: { ...snapshot, session: hydrateSessionMetadata(snapshot.session) },
        config: get().provider,
        configuredKey: get().providerHasKey,
        fallbackSessions: get().sessions.map((stored) => stored.id === activeSessionId
          ? hydrateSessionMetadata(stored)
          : stored),
        state: {
          authorizedWorkspace: workspace,
          authorizedWorkspaces,
          providerMessage: storeT('status.workspace.authorized', { name: workspace.name }),
        },
      })
    } else {
      set({
        authorizedWorkspace: workspace,
        authorizedWorkspaces,
        providerMessage: storeT('status.workspace.authorized', { name: workspace.name }),
      })
    }
    return true
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return false
  } finally {
    deps.endStructural(structuralLease)
  }
}

export const addWorkspace = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
): Promise<boolean> => {
  const structuralLease = deps.beginStructural(true)
  if (!structuralLease) return false
  set({ settingsError: null })
  try {
    const workspace = await selectAndAuthorizeWorkspace()
    if (!workspace) return false
    if (!await resetActiveFullAccessForWorkspaceSwitch(set, get, deps, workspace.path)) return false
    recordRecent(workspace.path)
    const reusable = reusableUnboundActiveSession(get())
    const created = reusable
      ? await deps.getRepository().loadSession(reusable.id)
      : await deps.getRepository().createSession({
          ...deps.sessionDefaults(get().provider),
          workspace,
        })
    updateSessionMetadata(created.session.id, { workspace })
    const snapshot = { ...created, session: hydrateSessionMetadata(created.session) }
    const authorizedWorkspaces = await getAuthorizedWorkspaces()
    const projection = await deps.activateCommittedSessionSnapshot({
      repository: deps.getRepository(),
      snapshot,
      config: get().provider,
      configuredKey: get().providerHasKey,
      fallbackSessions: deps.projectedSessions(snapshot),
      state: {
        running: false,
        authorizedWorkspace: workspace,
        authorizedWorkspaces,
        providerMessage: reusable
          ? storeT('status.workspace.bound', { name: workspace.name })
          : storeT('status.workspace.added', { name: workspace.name }),
      },
    })
    if (projection.status === 'projection_failed') {
      set({ settingsError: storeT('status.workspace.createProjectionFailed', { detail: projection.error }) })
    }
    return true
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return false
  } finally {
    deps.endStructural(structuralLease)
  }
}

export const activateWorkspace = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  path: string,
): Promise<boolean> => {
  if (!isTauriRuntime()) return false
  if (!await resetActiveFullAccessForWorkspaceSwitch(set, get, deps, path)) return false
  const matchingSession = get().sessions.find((stored) => (
    stored.workspace?.path === path && !stored.archivedAt
  ))
  if (matchingSession && matchingSession.id !== get().activeSessionId) {
    recordRecent(path)
    return get().selectSession(matchingSession.id)
  }
  const knownWorkspace = get().authorizedWorkspaces.find((workspace) => workspace.path === path)
  if (!knownWorkspace) {
    set({ settingsError: storeT('status.workspace.reselectRequired') })
    return false
  }
  if (matchingSession) {
    try {
      const workspace = await activateAuthorizedWorkspace(path)
      recordRecent(path)
      set({ authorizedWorkspace: workspace, settingsError: null })
      return true
    } catch (error) {
      set({ settingsError: storeT('status.workspace.switchFailed', { detail: errorMessage(error) }) })
      return false
    }
  }
  const structuralLease = deps.beginStructural(true)
  if (!structuralLease) return false
  try {
    const workspace = await activateAuthorizedWorkspace(path)
    recordRecent(path)
    const reusable = reusableUnboundActiveSession(get())
    const created = reusable
      ? await deps.getRepository().loadSession(reusable.id)
      : await deps.getRepository().createSession({
          ...deps.sessionDefaults(get().provider),
          workspace,
        })
    updateSessionMetadata(created.session.id, { workspace })
    const snapshot = { ...created, session: hydrateSessionMetadata(created.session) }
    const projection = await deps.activateCommittedSessionSnapshot({
      repository: deps.getRepository(),
      snapshot,
      config: get().provider,
      configuredKey: get().providerHasKey,
      fallbackSessions: deps.projectedSessions(snapshot),
      state: {
        running: false,
        authorizedWorkspace: workspace,
        providerMessage: storeT('status.workspace.switched', { name: workspace.name }),
      },
    })
    if (projection.status === 'projection_failed') {
      set({ settingsError: storeT('status.workspace.sessionProjectionFailed', { detail: projection.error }) })
    }
    return true
  } catch (error) {
    set({ settingsError: storeT('status.workspace.switchFailed', { detail: errorMessage(error) }) })
    return false
  } finally {
    deps.endStructural(structuralLease)
  }
}

export const revokeWorkspace = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  path?: string,
): Promise<boolean> => {
  const target = path ?? get().authorizedWorkspace?.path
  if (!target) return false
  const structuralLease = deps.beginStructural()
  if (!structuralLease) return false
  set({ settingsError: null })
  try {
    const revoked = await revokeAuthorizedWorkspace(target)
    if (!revoked) return false
    // 先清 SQLite（跨层调用、可能失败）再清 localStorage（本地同步、几乎不会失败）：
    // 若顺序相反，DB 清理失败会在 localStorage 已清空的状态下留下 DB 残留，重启时
    // hydrateSessionMetadata 的 DB→localStorage 反向同步把 workspace 写回，经
    // persistedWorkspacePaths → restoreAuthorizedWorkspaces 重新授权已撤销目录。
    // 顺序调换后，DB 清理失败时 localStorage 保持残留（与 DB 一致），且 Rust 侧
    // 注册表已在 revokeAuthorizedWorkspace 中先行移除——重启恢复被注册表
    // fail-closed 拒绝，撤销跨重启依然有效。
    await deps.getRepository().clearWorkspaceForPath(target)
    // 用 store 当前持有的 state.sessions 找到引用该 path 的 session id 列表，
    // 按 id 精确清空 localStorage 对应 metadata.workspace。绕开 path 字符串比对，
    // 避免 localStorage 残留 workspace 字段导致重启后被 hydrateSessionMetadata
    // 的 DB→localStorage 同步路径或 fallback 重新挂回 session.workspace。
    const affectedSessionIds = get().sessions
      .filter((stored) => stored.workspace?.path === target)
      .map((stored) => stored.id)
    removeWorkspaceSessionMetadataForSessions(affectedSessionIds)
    // 保留旧 path 比对调用作为兜底（覆盖某些 state.sessions 为空的边角场景）。
    removeWorkspaceSessionMetadata(target)
    // 停止绑定被撤销工作区的运行中会话（含后台），并解绑其工作区绑定。
    //
    // 路径**不保留**：`clearWorkspaceForPath` 已把 DB 的 session.workspace 清空，
    // 本表随之解绑——两者同源，一并失效。该会话在重新绑定工作区前不可运行，由
    // 工作区门而非审批挡住：激活时全局 `authorizedWorkspace` 由会话自己的工作区
    // 推导（已为 null）→ Composer 的 workspaceReady 为假；后台 `sendToSession`
    // 要求会话工作区非空且在授权集内。重新绑定（新建会话 / 切换工作区）时经
    // createRuntimeSession / activateCachedRuntimeSession 按新快照重建绑定。
    //
    // 先取快照再解绑（forgetSessionsForWorkspace 内部已完成），不在遍历中改 Map。
    const boundSessionIds = sessionWorkspacePaths.sessionsForWorkspace(target)
    let abortedRunningCount = 0
    for (const sessionId of boundSessionIds) {
      const harness = getRuntimeSession(sessionId)
      if (harness && !harness.isDisposed && harness.isRunning) {
        harness.requestAbort()
        abortedRunningCount += 1
      }
    }
    sessionWorkspacePaths.forgetSessionsForWorkspace(target)
    // 撤销工作区同时降级其全部会话的访问模式。撤销期间工具调用已被
    // authorized_root_for fail-closed 挡住，真正的洞在「日后重新授权同一路径」：
    // 会话在 DB 的 no-approval 与 Rust held Automatic 都原样保留，而重新绑定回
    // 同一路径时 resetActiveFullAccessForWorkspaceSwitch 因路径相同而跳过，
    // 完全访问于是无原生警告地静默恢复。此处对每个受影响会话无条件走一次
    // resetSessionAccessMode（它内部没有「已是标准就早退」的短路——DB 显示标准
    // 而 native 侧可能仍是 Automatic 的残留态必须借此自愈），重授权需重新确认。
    //
    // 名单取 state.sessions 与运行时绑定的并集：前者来自 DB 投影（可能因
    // listSessions 故障走了内存副本而缺项），后者（boundSessionIds，解绑前快照）
    // 覆盖仍挂载该路径的运行中会话。漏掉任何一个都会让它在重授权时静默恢复完全访问。
    const downgradeSessionIds = new Set([...affectedSessionIds, ...boundSessionIds])
    let downgradeFailed = 0
    for (const sessionId of downgradeSessionIds) {
      // 不丢弃返回值：降级失败必须留下可见痕迹，否则「已撤销」与「已降级」会
      // 在 UI 上无法区分，用户重授权时才会发现完全访问又回来了。
      if (!await resetSessionAccessMode(set, get, deps, sessionId)) {
        downgradeFailed += 1
      }
    }
    if (downgradeFailed > 0) {
      set({
        settingsError: `${downgradeFailed} 个关联会话的访问模式未能降级；重新授权该工作区前请先在会话内切回标准模式`,
      })
    }
    // 模式已变 → 提示词的访问模式段需重建，否则模型仍按完全访问行事。
    await deps.refreshSystemPromptForAccessMode()
    const authorizedWorkspaces = await getAuthorizedWorkspaces()
    // 必须从 DB 重新加载 session 列表后再 hydrate；若直接使用内存中仍带有旧
    // workspace 的 get().sessions，hydrateSessionMetadata 会把旧 workspace 又
    // 写回 localStorage，导致重启后 persistedWorkspacePaths 重新恢复该目录。
    const refreshedSessions = await deps.getRepository().listSessions()
    const activeSessionWorkspace = refreshedSessions.find((stored) => (
      stored.id === get().activeSessionId
    ))?.workspace
    const remainingPath = activeSessionWorkspace
      && authorizedWorkspaces.some((workspace) => workspace.path === activeSessionWorkspace.path)
      ? activeSessionWorkspace.path
      : authorizedWorkspaces[0]?.path ?? null
    const authorizedWorkspace = remainingPath
      ? await activateAuthorizedWorkspace(remainingPath)
      : null
    set({
      authorizedWorkspace,
      authorizedWorkspaces,
      sessions: hydrateSessionsMetadata(refreshedSessions),
      providerMessage: (path
        ? storeT('status.workspace.removed')
        : storeT('status.workspace.revoked'))
        + (abortedRunningCount > 0
          ? storeT('status.workspace.abortedSuffix', { count: abortedRunningCount })
          : ''),
    })
    return true
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return false
  } finally {
    deps.endStructural(structuralLease)
  }
}

export const authorizeFile = async (
  set: AgentSet,
  _get: AgentGet,
  deps: StoreRuntimeDeps,
): Promise<AuthorizedReadFile | null> => {
  const structuralLease = deps.beginStructural()
  if (!structuralLease) return null
  set({ settingsError: null })
  try {
    const file = await selectAndAuthorizeReadFile()
    if (!file) return null
    const authorizedFiles = await listAuthorizedReadFiles()
    deps.updateAuthorizedReadFiles(authorizedFiles)
    set({ authorizedFiles, providerMessage: storeT('status.fileReference.added', { name: file.name }) })
    // 返回所选条目：Composer 的 + 附件按钮依赖它把引用 token 插入输入框。
    return file
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return null
  } finally {
    deps.endStructural(structuralLease)
  }
}

export const authorizeDirectory = async (
  set: AgentSet,
  _get: AgentGet,
  deps: StoreRuntimeDeps,
): Promise<boolean> => {
  const structuralLease = deps.beginStructural()
  if (!structuralLease) return false
  set({ settingsError: null })
  try {
    const directory = await selectAndAuthorizeReadDirectory()
    if (!directory) return false
    const authorizedFiles = await listAuthorizedReadFiles()
    deps.updateAuthorizedReadFiles(authorizedFiles)
    set({ authorizedFiles, providerMessage: storeT('status.directoryReference.added', { name: directory.name }) })
    return true
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return false
  } finally {
    deps.endStructural(structuralLease)
  }
}

export const revokeFile = async (
  set: AgentSet,
  _get: AgentGet,
  deps: StoreRuntimeDeps,
  path: string,
): Promise<boolean> => {
  const structuralLease = deps.beginStructural()
  if (!structuralLease) return false
  set({ settingsError: null })
  try {
    await revokeAuthorizedReadFile(path)
    const authorizedFiles = await listAuthorizedReadFiles()
    deps.updateAuthorizedReadFiles(authorizedFiles)
    set({ authorizedFiles, providerMessage: storeT('status.fileReference.removed') })
    return true
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return false
  } finally {
    deps.endStructural(structuralLease)
  }
}

export const createNewSession = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  workspacePath?: string,
): Promise<boolean> => {
  const structuralLease = deps.beginStructural(true)
  if (!structuralLease) return false
  set({ settingsError: null })
  try {
    const initialState = get()
    const selectedWorkspace = workspacePath
      ? initialState.authorizedWorkspaces.find((workspace) => workspace.path === workspacePath)
      : initialState.authorizedWorkspace
    if (!selectedWorkspace) {
      set({ settingsError: storeT('status.workspace.pickRequired') })
      return false
    }
    if (!await resetActiveFullAccessForWorkspaceSwitch(
      set,
      get,
      deps,
      selectedWorkspace.path,
    )) return false
    const workspace = isTauriRuntime()
      && initialState.authorizedWorkspace?.path !== selectedWorkspace.path
      ? await activateAuthorizedWorkspace(selectedWorkspace.path)
      : selectedWorkspace
    recordRecent(selectedWorkspace.path)
    const config = get().provider
    const configuredKey = get().providerHasKey
    const created = await deps.getRepository().createSession({
      ...deps.sessionDefaults(config),
      workspace,
    })
    updateSessionMetadata(created.session.id, { workspace })
    const snapshot = { ...created, session: hydrateSessionMetadata(created.session) }
    const projection = await deps.activateCommittedSessionSnapshot({
      repository: deps.getRepository(),
      snapshot,
      config,
      configuredKey,
      fallbackSessions: deps.projectedSessions(snapshot),
      state: {
        running: false,
        authorizedWorkspace: workspace,
      },
    })
    if (projection.status === 'projection_failed') {
      set({ settingsError: storeT('status.workspace.sessionProjectionFailed', { detail: projection.error }) })
    }
    return true
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return false
  } finally {
    deps.endStructural(structuralLease)
  }
}

/**
 * 刷新已授权工作区的 git 分支信息（尽力而为，不触发结构变更、不写 DB）。
 * Rust 端 workspace_summary 每次实时读取 .git/HEAD，因此能反映外部
 * （终端/IDE）的分支切换；仅当任一工作区的分支信息发生变化时才 set，
 * 避免无谓重渲染。非 Tauri 运行时或读取失败时静默跳过，保持旧值。
 */
export const refreshWorkspaceBranchInfo = async (
  set: AgentSet,
  get: AgentGet,
  _deps: StoreRuntimeDeps,
): Promise<void> => {
  if (!isTauriRuntime()) return
  try {
    const latest = await getAuthorizedWorkspaces()
    const byPath = new Map(
      get().authorizedWorkspaces.map((workspace) => [workspace.path, workspace] as const),
    )
    const changed = latest.length !== byPath.size || latest.some((workspace) => {
      const previous = byPath.get(workspace.path)
      return !previous
        || previous.name !== workspace.name
        || (previous.gitBranch ?? null) !== (workspace.gitBranch ?? null)
    })
    if (!changed) return
    const activePath = get().authorizedWorkspace?.path
    const authorizedWorkspace = activePath
      ? latest.find((workspace) => workspace.path === activePath) ?? get().authorizedWorkspace
      : null
    set({
      authorizedWorkspaces: latest,
      ...(authorizedWorkspace ? { authorizedWorkspace } : {}),
    })
  } catch {
    // 刷新是尽力而为：读取失败时保持旧值。
  }
}
