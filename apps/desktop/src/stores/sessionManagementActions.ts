import { isAgentHarnessAbortError } from '@/agent/runtime/AgentHarness'
import { createProviderTransport } from '@/agent/transport/provider'
import { normalizeSessionTitle } from '@/agent/session/branch'
import type { SummaryInstructionOptions } from '@/agent/context/summaryInstructions'
import type { SessionSnapshot } from '@/persistence/types'
import {
  dropRuntimeCachesForSession,
  getRuntimeSession,
} from './runtimeCaches'
import {
  hydrateSessionMetadata,
  removeSessionMetadata,
  sessionMetadataById,
  updateSessionMetadata,
} from './services/sessionMetadata'
import { sessionWorkspacePaths } from './workspaceActions'
import { forgetSshApprovalGrants } from './services/sshApprovalGrants'
import { activateAuthorizedWorkspace } from '@/platform/workspace'
import type { AgentGet, AgentSet, StoreRuntimeDeps } from './sessionActions'
import { useUiStore } from './uiStore'
import { storeT } from '@/i18n/storeTranslate'

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const branchFromMessage = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  messageId: string,
  summarize = false,
  summaryInstructions?: SummaryInstructionOptions,
): Promise<boolean> => {
  const { activeSessionId, providerReady, providerSetupRequired, running, sessionBusy } = get()
  if (running || sessionBusy || !activeSessionId) {
    set({ error: running
      ? '会话正在运行，无法创建分支'
      : sessionBusy
        ? '会话正在处理其他操作，请稍后重试'
        : '当前没有可用的会话' })
    return false
  }
  const sourceWorkspace = sessionMetadataById[activeSessionId]?.workspace
  if (!sourceWorkspace || !get().authorizedWorkspaces.some((workspace) => (
    workspace.path === sourceWorkspace.path
  ))) {
    set({ error: '当前会话没有可用的工作目录，请先在输入框中选择或重新授权' })
    return false
  }
  if (summarize && (!providerReady || providerSetupRequired)) {
    set({ error: '生成 Branch Summary 前请先完成真实模型 Provider 配置' })
    return false
  }
  const structuralLease = deps.beginStructural()
  if (!structuralLease) return false
  set({ error: null })
  try {
    const operationSession = deps.getSession()
    return await operationSession.runStructuralOperation('branch_summary', async (signal) => {
      // 从 repository 重读权威消息计算分支边界，避免 store 快照与 repo 在对话框
      // 填写期间发生消息追加导致 sourceThroughMessageId 与 assertBranchSummarySource 失配。
      const source = await deps.getRepository().loadSession(activeSessionId)
      const boundaryIndex = source.messages.findIndex((message) => message.id === messageId)
      if (boundaryIndex < 0) throw new Error('分支边界消息不存在于当前会话')
      const abandonedMessages = source.messages.slice(boundaryIndex + 1)
      const summary = summarize
        ? await (() => {
          if (abandonedMessages.length === 0) throw new Error('当前消息之后没有需要总结的分支内容')
          const { model, transport } = createProviderTransport(get().provider, get().providerHasKey)
          set({ branchSummaryRunning: true })
          return operationSession.summarizeBranch({
            messages: abandonedMessages,
            model,
            transport,
            ...summaryInstructions,
          }, signal)
        })()
        : undefined
      if (signal.aborted) throw signal.reason
      const created = await deps.getRepository().branchSession({
        sourceSessionId: activeSessionId,
        throughMessageId: messageId,
        kind: 'branch',
        summary,
        defaults: {
          ...deps.sessionDefaults(get().provider),
          workspace: sourceWorkspace,
        },
      })
      updateSessionMetadata(created.session.id, { workspace: sourceWorkspace })
      const snapshot = { ...created, session: hydrateSessionMetadata(created.session) }
      const projection = await deps.activateCommittedSessionSnapshot({
        repository: deps.getRepository(),
        snapshot,
        config: get().provider,
        configuredKey: get().providerHasKey,
        fallbackSessions: deps.projectedSessions(snapshot),
      })
      if (projection.status === 'projection_failed') {
        set({ error: `分支已创建，但运行时投影失败，请在侧栏重新选择该分支：${projection.error}` })
      }
      return true
    })
  } catch (error) {
    set({ error: isAgentHarnessAbortError(error) ? null : errorMessage(error) })
    return false
  } finally {
    set({ branchSummaryRunning: false })
    deps.endStructural(structuralLease)
  }
}

export const cancelBranchSummary = (
  _set: AgentSet,
  _get: AgentGet,
  deps: StoreRuntimeDeps,
): void => {
  deps.getSession().requestAbort()
}

export const renameSession = async (
  set: AgentSet,
  _get: AgentGet,
  deps: StoreRuntimeDeps,
  sessionId: string,
  title: string,
): Promise<boolean> => {
  const structuralLease = deps.beginStructural()
  if (!structuralLease) return false
  set({ settingsError: null })
  try {
    await deps.getRepository().renameSession(sessionId, title)
    const normalizedTitle = normalizeSessionTitle(title)
    const updatedAt = Date.now()
    set((state) => ({
      sessions: state.sessions
        .map((stored) => stored.id === sessionId
          ? { ...stored, title: normalizedTitle, updatedAt }
          : stored)
        .sort((left, right) => right.updatedAt - left.updatedAt),
    }))
    return true
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return false
  } finally {
    deps.endStructural(structuralLease)
  }
}

export const selectSession = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  sessionId: string,
): Promise<boolean> => {
  if (sessionId === get().activeSessionId) return false
  const structuralLease = deps.beginStructural(true)
  if (!structuralLease) return false
  set({ settingsError: null })
  try {
    const loaded = await deps.getRepository().loadSession(sessionId)
    const snapshot = { ...loaded, session: hydrateSessionMetadata(loaded.session) }
    const cached = getRuntimeSession(sessionId)
    if (cached && !cached.isDisposed) {
      await deps.activateCachedRuntimeSession({
        repository: deps.getRepository(),
        snapshot,
        runtime: cached,
        fallbackSessions: get().sessions,
      })
      return true
    }
    await deps.activateSessionSnapshot({
      repository: deps.getRepository(),
      snapshot,
      persistProvider: true,
      state: {
        running: false,
        authorizedWorkspace: snapshot.session.workspace
          && get().authorizedWorkspaces.some((candidate) => (
            candidate.path === snapshot.session.workspace?.path
          ))
          ? await activateAuthorizedWorkspace(snapshot.session.workspace.path)
          : null,
      },
    })
    return true
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return false
  } finally {
    deps.endStructural(structuralLease)
  }
}

export const deleteSession = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  sessionId: string,
): Promise<boolean> => {
  if (get().sessions.find((stored) => stored.id === sessionId)?.status === 'running') {
    set({ settingsError: '运行中的会话不能删除，请先停止该会话' })
    return false
  }
  const structuralLease = deps.beginStructural()
  if (!structuralLease) return false
  set({ settingsError: null })
  try {
    const deletingActiveSession = sessionId === get().activeSessionId
    let successorSnapshot: SessionSnapshot | undefined
    let deletedWithSuccessor = false
    if (deletingActiveSession) {
      const successor = get().sessions.find((stored) => (
        stored.id !== sessionId && !stored.archivedAt
      )) ?? get().sessions.find((stored) => stored.id !== sessionId)
      if (successor) {
        successorSnapshot = await deps.getRepository().loadSession(successor.id)
      } else {
        successorSnapshot = await deps.getRepository().deleteSessionWithSuccessor(
          sessionId,
          deps.sessionDefaults(get().provider),
        )
        updateSessionMetadata(successorSnapshot.session.id, {
          workspace: sessionMetadataById[sessionId]?.workspace ?? get().authorizedWorkspace,
        })
        deletedWithSuccessor = true
      }
    }
    if (!deletedWithSuccessor) await deps.getRepository().deleteSession(sessionId)
    removeSessionMetadata(sessionId)
    const deletedRuntime = dropRuntimeCachesForSession(sessionId)
    sessionWorkspacePaths.delete(sessionId)
    // 回收该会话的 SSH 远程主机授权（Rust 权威表 + TS 免卡片镜像；best-effort）。
    forgetSshApprovalGrants(sessionId)
    if (deletedRuntime) void deletedRuntime.dispose().catch(() => undefined)
    if (successorSnapshot) {
      successorSnapshot = {
        ...successorSnapshot,
        session: hydrateSessionMetadata(successorSnapshot.session),
      }
      const fallbackSessions = deps.projectedSessions(successorSnapshot, [sessionId])
      const successorRuntime = getRuntimeSession(successorSnapshot.session.id)
      const projection = successorRuntime && !successorRuntime.isDisposed
        ? await deps.activateCommittedCachedRuntimeSession({
            repository: deps.getRepository(),
            snapshot: successorSnapshot,
            runtime: successorRuntime,
            fallbackSessions,
          })
        : await deps.activateCommittedSessionSnapshot({
            repository: deps.getRepository(),
            snapshot: successorSnapshot,
            persistProvider: true,
            fallbackSessions,
          })
      if (projection.status === 'projection_failed') {
        set({
          providerReady: false,
          activeSessionId: null,
          messages: [],
          // 与 applySessionActivationState / activateCachedRuntimeSession 一致：
          // 解除活动会话绑定时统一清空流式草稿，避免残留 draft 在无活动会话时
          // 无人兜底清除（后台会话事件不再清 streamingDraft）。
          streamingDraft: null,
          sessions: deps.projectedSessions(successorSnapshot, [sessionId]),
          initializationError: `Session 已删除，但运行时投影恢复失败：${projection.error}`,
          settingsError: `Session 已删除，但运行时投影恢复失败：${projection.error}`,
        })
      }
    } else {
      set((state) => ({
        sessions: state.sessions.filter((stored) => stored.id !== sessionId),
      }))
    }
    const storageStats = await deps.getRepository().getStats().catch(() => null)
    set({ storageStats })
    return true
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return false
  } finally {
    deps.endStructural(structuralLease)
  }
}

export const archiveSession = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  sessionId: string,
): Promise<boolean> => {
  const stored = get().sessions.find((candidate) => candidate.id === sessionId)
  if (!stored) return false
  if (stored.status === 'running') {
    set({ settingsError: '运行中的会话不能归档，请先停止该会话' })
    return false
  }
  if (sessionId === get().activeSessionId) {
    const successor = get().sessions.find((candidate) => (
      candidate.id !== sessionId && !candidate.archivedAt
    ))
    if (!successor) {
      set({ settingsError: '请先新建或选择另一个会话，再归档当前会话' })
      return false
    }
    if (!await get().selectSession(successor.id)) return false
  }
  const archivedAt = Date.now()
  try {
    await deps.getRepository().archiveSession(sessionId, archivedAt)
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return false
  }
  updateSessionMetadata(sessionId, { archivedAt })
  set((state) => ({
    sessions: state.sessions.map((candidate) => candidate.id === sessionId
      ? { ...candidate, archivedAt }
      : candidate),
    settingsError: null,
    providerMessage: storeT('status.session.archived'),
  }))
  return true
}

export const restoreSession = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  sessionId: string,
): Promise<boolean> => {
  if (!get().sessions.some((candidate) => candidate.id === sessionId)) return false
  try {
    await deps.getRepository().restoreSession(sessionId)
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return false
  }
  updateSessionMetadata(sessionId, { archivedAt: null })
  const now = Date.now()
  set((state) => ({
    sessions: state.sessions.map((candidate) => candidate.id === sessionId
      ? { ...candidate, archivedAt: null, updatedAt: now }
      : candidate)
      .sort((left, right) => right.updatedAt - left.updatedAt),
    settingsError: null,
    providerMessage: storeT('status.session.restored'),
  }))
  if (get().activeSessionId !== sessionId) {
    const activated = await selectSession(set, get, deps, sessionId)
    if (activated) useUiStore.getState().setView('session')
  }
  return true
}
