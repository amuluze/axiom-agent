import type { AgentHarness } from '@/agent/runtime/AgentHarness'
import { isAgentHarnessAbortError } from '@/agent/runtime/AgentHarness'
import type { AgentSessionJournalEntry } from '@/agent/runtime/mutationJournal'
import type { AgentMessage, ImageContentBlock } from '@/agent/core/types'
import {
  normalizeContextPolicySettings,
  type ContextCheckpoint,
  type ContextPolicySettings,
} from '@/agent/context/types'
import type { SummaryInstructionOptions } from '@/agent/context/summaryInstructions'
import {
  createProviderTransport,
  resolveProviderModel,
  type ProviderProfile,
} from '@/agent/transport/provider'
import type { QueuedMessageSnapshot } from '@/agent/runtime/AgentSession'
import {
  acceptedQueueMessage,
  rejectedQueueMessage,
  type QueueAcceptance,
  type QueueMoveTarget,
  type QueueMutationResult,
} from '@/agent/runtime/queueContracts'
import type {
  SessionDefaults,
  SessionRepository,
  SessionSnapshot,
  StoredAgentSession,
} from '@/persistence/types'
import {
  hasOtherRunningRuntime,
  getRuntimeProjection,
  setRuntimeProjection,
} from './runtimeCaches'
import {
  hydrateSessionMetadata,
  hydrateSessionsMetadata,
  sessionMetadataById,
  updateSessionMetadata,
} from './services/sessionMetadata'
import { queuedMessageStateFor } from './sessionActivationCore'
import { generateSessionTitle, promptSessionTitle } from '@/agent/session/title'
import { editBoundaryFor, retryBoundaryFor } from '@/agent/session/branch'
import {
  normalizeReasoningSettings,
  toModelReasoning,
  type ReasoningSettings,
} from '@/agent/runtime/reasoningSettings'
import {
  normalizeAgentLimitsSettings,
  type AgentLimitsSettings,
} from '@/agent/runtime/agentLimitsSettings'
import {
  normalizeQueueModeSettings,
  type QueueModeSettings,
} from '@/agent/runtime/queueSettings'
import {
  persistLocalSettings,
  setActiveAgentLimitsSettings,
  setActiveContextPolicySettings,
  setActiveQueueModeSettings,
  setActiveReasoningSettings,
} from './settingsPersistence'
import {
  AGENT_LIMITS_STORAGE_KEY,
  CONTEXT_POLICY_STORAGE_KEY,
  QUEUE_MODE_STORAGE_KEY,
  REASONING_STORAGE_KEY,
} from './services/providerStorage'
import type { AuthorizedReadFile } from '@/platform/authorizedFiles'
import { storeT } from '@/i18n/storeTranslate'
import type {
  ActivateCachedRuntimeOptions,
  AgentState,
  CommittedProjectionResult,
  RestoredRuntimeState,
  SessionActivationOptions,
} from './agentStateTypes'

export type AgentSet = (partial: Partial<AgentState> | ((state: AgentState) => Partial<AgentState>)) => void
export type AgentGet = () => AgentState

/**
 * 模块级运行时装配的依赖注入束。agentStore 持有 session / repository /
 * structural lease / activation helpers 等模块级单例，拆分出的 action 通过
 * 该束在调用时取用，保持单例语义（session 会在 bindSession 时被替换，
 * 因此必须用 getter 而非捕获值）。
 */
export interface StoreRuntimeDeps {
  getSession: () => AgentHarness
  getRepository: () => SessionRepository
  beginStructural: (allowRunning?: boolean) => symbol | undefined
  endStructural: (lease: symbol) => void
  bindSession: (
    config: ProviderProfile,
    configuredKey: boolean,
    messages: AgentMessage[],
    sessionId: string,
    checkpoint?: ContextCheckpoint | null,
    restoredRuntime?: RestoredRuntimeState,
    journalEntries?: AgentSessionJournalEntry[],
    contextPolicySettings?: ContextPolicySettings,
  ) => void
  projectedSessions: (
    snapshot: SessionSnapshot,
    removedSessionIds?: string[],
  ) => StoredAgentSession[]
  activateCommittedSessionSnapshot: (
    options: SessionActivationOptions,
  ) => Promise<CommittedProjectionResult>
  activateSessionSnapshot: (options: SessionActivationOptions) => Promise<void>
  activateCachedRuntimeSession: (options: ActivateCachedRuntimeOptions) => Promise<void>
  activateCommittedCachedRuntimeSession: (
    options: ActivateCachedRuntimeOptions,
  ) => Promise<CommittedProjectionResult>
  sessionDefaults: (config: ProviderProfile) => SessionDefaults
  /** 同步 authorizedFiles 状态在 createRuntimeSession 侧的模块级镜像。 */
  updateAuthorizedReadFiles: (files: AuthorizedReadFile[]) => void
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 从 harness 会话读取队列投影，避免 store 与 harness 状态漂移。 */
export const queuedMessageState = (session: AgentHarness) => ({
  pendingSteeringCount: session.pendingSteeringCount,
  pendingFollowUpCount: session.pendingFollowUpCount,
  pendingNextTurnCount: session.pendingNextTurnCount,
  queuedMessages: session.queuedMessages,
  recoveredQueuedMessages: session.recoveredMessages,
  armedQueueMessageId: session.armedQueueMessageId ?? null,
})

const queueMessage = async (
  set: AgentSet,
  get: AgentGet,
  session: AgentHarness,
  content: string,
  operation: (session: AgentHarness, content: string) => Promise<QueueAcceptance>,
): Promise<QueueAcceptance> => {
  if (get().runtimeLifecycle !== 'ready') return rejectedQueueMessage('runtime-not-accepting')
  if (get().compactionRunning || !get().running || !session.canQueueMessages) {
    return rejectedQueueMessage('runtime-not-accepting')
  }
  let accepted: QueueAcceptance
  try {
    accepted = await operation(session, content)
  } catch (error) {
    set({ error: errorMessage(error) })
    return rejectedQueueMessage('runtime-not-accepting')
  }
  if (!accepted.accepted) return accepted
  set(queuedMessageState(session))
  return accepted
}

export const queueSteering = (
  set: AgentSet,
  get: AgentGet,
  session: AgentHarness,
  content: string,
  images?: ImageContentBlock[],
): Promise<QueueAcceptance> =>
  queueMessage(set, get, session, content, (s, c) => s.steer(c, images))

export const queueFollowUp = (
  set: AgentSet,
  get: AgentGet,
  session: AgentHarness,
  content: string,
  images?: ImageContentBlock[],
): Promise<QueueAcceptance> =>
  queueMessage(set, get, session, content, (s, c) => s.followUp(c, images))

export const queueNextTurn = async (
  set: AgentSet,
  get: AgentGet,
  session: AgentHarness,
  content: string,
  images?: ImageContentBlock[],
): Promise<QueueAcceptance> => {
  // next-turn 队列独立于正在运行的任务：不要求 running，只要求未在压缩/结算。
  if (get().runtimeLifecycle !== 'ready') return rejectedQueueMessage('runtime-not-accepting')
  if (get().compactionRunning || get().sessionBusy) {
    return rejectedQueueMessage('runtime-not-accepting')
  }
  let accepted: QueueAcceptance
  try {
    accepted = await session.nextTurn(content, images)
  } catch (error) {
    set({ error: errorMessage(error) })
    return rejectedQueueMessage('runtime-not-accepting')
  }
  if (!accepted.accepted) return accepted
  set(queuedMessageState(session))
  return accepted
}

export const editQueuedMessage = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  messageId: string,
  content: string,
  images?: ImageContentBlock[],
): Promise<QueueMutationResult> => {
  const session = deps.getSession()
  if (get().runtimeLifecycle !== 'ready') return { updated: false, reason: 'runtime-not-accepting' }
  let result: QueueMutationResult
  try {
    result = await session.editQueuedMessage(messageId, content, images)
  } catch (error) {
    set({ error: errorMessage(error) })
    return { updated: false, reason: 'runtime-not-accepting' }
  }
  if (result.updated) set(queuedMessageState(session))
  return result
}

export const moveQueuedMessage = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  messageId: string,
  target: QueueMoveTarget,
): Promise<QueueMutationResult> => {
  const session = deps.getSession()
  if (get().runtimeLifecycle !== 'ready') return { updated: false, reason: 'runtime-not-accepting' }
  let result: QueueMutationResult
  try {
    result = await session.moveQueuedMessage(messageId, target)
  } catch (error) {
    set({ error: errorMessage(error) })
    return { updated: false, reason: 'runtime-not-accepting' }
  }
  if (result.updated) set(queuedMessageState(session))
  return result
}

export const promoteQueuedMessage = (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  messageId: string,
): Promise<QueueMutationResult> =>
  moveQueuedMessage(set, get, deps, messageId, {
    kind: 'steering',
    placement: { position: 'top' },
  })

export const deleteQueuedMessage = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  messageId: string,
): Promise<QueueMutationResult> => {
  const session = deps.getSession()
  if (get().runtimeLifecycle !== 'ready') return { updated: false, reason: 'runtime-not-accepting' }
  let result: QueueMutationResult
  try {
    result = await session.deleteQueuedMessage(messageId)
  } catch (error) {
    set({ error: errorMessage(error) })
    return { updated: false, reason: 'runtime-not-accepting' }
  }
  if (result.updated) set(queuedMessageState(session))
  return result
}

/* ------------------------------------------------------------------ *
 * 会话运行 action（send / clear / retry / compact / settings）
 * ------------------------------------------------------------------ */

/**
 * 空闲发送的前置条件（send 的早退守卫，抽出共享）：返回阻断原因文案。
 * idle sendQueuedNow 必须在 restoreQueuedMessage **之前**校验——restore 会把
 * 队列项移出队列并 discard journal，若 send 随后早退，内容既不在队列也不在
 * 输入框，等于静默丢失。
 */
const idleRunStartBlocker = (state: {
  providerReady: boolean
  providerSetupRequired: boolean
  sessions: Array<{ id: string; workspace?: { path: string } | null }>
  activeSessionId: string | null
  authorizedWorkspaces: Array<{ path: string }>
}): string | undefined => {
  if (!state.providerReady) return 'Axiom 桌面能力仍在初始化，请稍候'
  if (state.providerSetupRequired) return '请先在设置中完成真实模型 Provider 配置'
  const activeWorkspace = state.sessions.find((stored) => (
    stored.id === state.activeSessionId
  ))?.workspace
  if (!activeWorkspace || !state.authorizedWorkspaces.some((workspace) => (
    workspace.path === activeWorkspace.path
  ))) {
    return '开始任务前请先选择一个已授权的工作目录'
  }
  return undefined
}

export const send = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  content: string,
  images?: ImageContentBlock[],
): Promise<void> => {
  const initialState = get()
  if (initialState.running || initialState.sessionBusy || (!content.trim() && !images?.length)) return
  const blockedBy = idleRunStartBlocker(initialState)
  if (blockedBy) {
    set({ error: blockedBy })
    return
  }
  const runSession = deps.getSession()
  const runRepository = deps.getRepository()
  const sessionId = initialState.activeSessionId
  const provider = { ...initialState.provider }
  const providerHasKey = initialState.providerHasKey
  const shouldGenerateTitle = Boolean(
    sessionId
    && initialState.messages.length === 0
    && provider.providerId !== 'demo',
  )
  const expectedPromptTitle = promptSessionTitle(content)
  let queuedRecoveryAttempted = false
  let queuedRecoveryFailure: string | undefined
  set({ running: true, error: null, endReason: null })
  try {
    const result = await runSession.prompt(content, images)
    const assistant = [...result.newMessages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.content.trim())
    if (shouldGenerateTitle && sessionId && result.reason === 'completed' && assistant?.role === 'assistant') {
      const { transport, model } = createProviderTransport(provider, providerHasKey)
      void generateSessionTitle({
        sessionId,
        userContent: content,
        assistantContent: assistant.content,
        model,
        transport,
      }).then(async (title) => {
        const renamed = await runRepository.renameSessionIfTitle(sessionId, expectedPromptTitle, title)
        if (!renamed || deps.getRepository() !== runRepository) return
        const updatedAt = Date.now()
        set((state) => ({
          sessions: state.sessions
            .map((stored) => stored.id === sessionId && stored.title === expectedPromptTitle
              ? { ...stored, title, updatedAt }
              : stored)
            .sort((left, right) => right.updatedAt - left.updatedAt),
        }))
      }).catch(() => undefined)
    }
  } catch (error) {
    const runError = errorMessage(error)
    let recoveryError: string | undefined
    const anotherRuntimeRunning = sessionId ? hasOtherRunningRuntime(sessionId) : false
    if (sessionId && get().activeSessionId === sessionId) {
      try {
        // 其他会话仍在运行时不能做全局恢复（会干扰它们），改用会话级局部恢复，
        // 只复位当前会话的卡死运行态，解除「Session 不在空闲状态」的粘性阻塞。
        const recovered = anotherRuntimeRunning
          ? await runRepository.recoverRuntimeStateForSession(sessionId)
          : await runRepository.recoverRuntimeState()
        const [snapshot, sessions] = await Promise.all([
          runRepository.loadSession(sessionId),
          runRepository.listSessions(),
        ])
        if (deps.getRepository() === runRepository && get().activeSessionId === sessionId) {
          queuedRecoveryAttempted = true
          try {
            await runSession.takeQueuedMessages()
          } catch (error) {
            queuedRecoveryFailure = errorMessage(error)
          }
          deps.bindSession(
            provider,
            providerHasKey,
            snapshot.messages,
            sessionId,
            snapshot.checkpoint,
            hydrateSessionMetadata(snapshot.session),
            snapshot.journalEntries,
          )
          set((state) => ({
            running: false,
            messages: snapshot.messages,
            sessions: hydrateSessionsMetadata(sessions),
            activeTools: {},
            contextCheckpoint: snapshot.checkpoint,
            contextUsage: deps.getSession().getContextUsage(),
            recoveredRuns: state.recoveredRuns + recovered.recoveredRuns,
            ...queuedMessageState(deps.getSession()),
          }))
        }
      } catch (recoveryFailure) {
        recoveryError = errorMessage(recoveryFailure)
      }
    }
    const recoveryDetails = [
      recoveryError,
      queuedRecoveryFailure ? `排队消息恢复失败：${queuedRecoveryFailure}` : undefined,
    ].filter((detail): detail is string => Boolean(detail))
    const failure = recoveryDetails.length > 0
      ? `${runError}；状态恢复失败：${recoveryDetails.join('；')}`
      : runError
    const projection = sessionId ? getRuntimeProjection(sessionId) : undefined
    if (projection) {
      projection.error = failure
      setRuntimeProjection(sessionId!, projection)
    }
    if (get().activeSessionId === sessionId) set({ running: false, error: failure })
  } finally {
    let recoveryError = queuedRecoveryFailure
    if (!queuedRecoveryAttempted) {
      try {
        await runSession.takeQueuedMessages()
      } catch (error) {
        recoveryError = errorMessage(error)
      }
    }
    set((state) => {
      if (state.activeSessionId !== sessionId) return state
      return {
        running: false,
        ...queuedMessageStateFor(runSession),
        ...(recoveryError && !state.error ? { error: recoveryError } : {}),
      }
    })
  }
}

export const clearQueuedMessages = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
): Promise<void> => {
  if (get().runtimeLifecycle !== 'ready') return
  const session = deps.getSession()
  try {
    await session.clearQueuedMessages()
  } catch (error) {
    set({ error: errorMessage(error) })
    return
  }
  set(queuedMessageState(session))
}

export const restoreQueuedMessage = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  messageId: string,
): Promise<QueuedMessageSnapshot | null> => {
  if (get().runtimeLifecycle !== 'ready') return null
  const session = deps.getSession()
  let queued: QueuedMessageSnapshot | undefined
  try {
    queued = await session.restoreQueuedMessage(messageId)
  } catch (error) {
    set({ error: errorMessage(error) })
    return null
  }
  if (queued) {
    set(queuedMessageState(session))
    return queued
  }
  return null
}

export const discardRecoveredMessage = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  messageId: string,
): Promise<void> => {
  if (get().runtimeLifecycle !== 'ready') return
  const session = deps.getSession()
  try {
    if (!await session.discardRecoveredMessage(messageId)) return
    set(queuedMessageState(session))
  } catch (error) {
    set({ error: errorMessage(error) })
  }
}

export const saveQueueModes = (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  settings: QueueModeSettings,
): boolean => {
  if (get().runtimeLifecycle !== 'ready' || get().running || get().sessionBusy) return false
  const normalized = normalizeQueueModeSettings(settings)
  setActiveQueueModeSettings(normalized)
  deps.getSession().setQueueModes(normalized.steering, normalized.followUp)
  deps.getSession().setAutoDrain(normalized.autoDrain)
  const queuePersistError = persistLocalSettings(QUEUE_MODE_STORAGE_KEY, normalized)
  if (queuePersistError) {
    set({ error: queuePersistError })
    return false
  }
  set({ queueModeSettings: normalized, providerMessage: storeT('status.queue.saved') })
  return true
}

/**
 * 切换队列自动出队（对齐 ZCode setAutoDrain）：与 saveQueueModes 的差别是允许
 * 运行中即时切换——autoDrain 控制的是「队列暂停/恢复」，暂停中的队列项不出队、
 * 恢复后按队列顺序继续，不需要等待 run 边界。
 */
export const saveQueueAutoDrain = (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  enabled: boolean,
): boolean => {
  if (get().runtimeLifecycle !== 'ready') return false
  const normalized = normalizeQueueModeSettings({ ...get().queueModeSettings, autoDrain: enabled })
  setActiveQueueModeSettings(normalized)
  deps.getSession().setAutoDrain(normalized.autoDrain)
  // setAutoDrain 会作废悬挂的武装目标，队列投影（含 armedQueueMessageId）须同步刷新。
  set(queuedMessageState(deps.getSession()))
  const persistError = persistLocalSettings(QUEUE_MODE_STORAGE_KEY, normalized)
  if (persistError) {
    set({ error: persistError })
    return false
  }
  set({ queueModeSettings: normalized })
  return true
}

/**
 * 立即发送一条队列项（对齐 ZCode sendQueuedNow）：运行中注入当前 run（移到
 * steering 队首并武装单次立即消费）；空闲时从队列/恢复草稿取出该条走完整
 * send 链路（标题生成/错误恢复/队列结算全部复用），不在 runtime 侧另起分支。
 */
export const sendQueuedNow = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  messageId?: string,
): Promise<QueueAcceptance> => {
  const session = deps.getSession()
  if (get().runtimeLifecycle !== 'ready') return rejectedQueueMessage('runtime-not-accepting')
  if (get().running) {
    let acceptance: QueueAcceptance
    try {
      acceptance = await session.sendQueuedNow(messageId)
    } catch (error) {
      set({ error: errorMessage(error) })
      return rejectedQueueMessage('runtime-not-accepting')
    }
    if (acceptance.accepted) set(queuedMessageState(session))
    return acceptance
  }
  if (get().sessionBusy || get().compactionRunning) {
    return rejectedQueueMessage('runtime-not-accepting')
  }
  // send 的其余前置（Provider 就绪/工作区授权）必须在 restore 之前判定：restore 会
  // 把队列项移出队列并 discard journal，send 早退时内容已无处可寻（静默丢失）。
  const blockedBy = idleRunStartBlocker(get())
  if (blockedBy) {
    set({ error: blockedBy })
    return rejectedQueueMessage('runtime-not-accepting')
  }
  const targetId = messageId
    ?? session.queuedMessages[0]?.id
    ?? session.recoveredMessages[0]?.id
  if (!targetId) return rejectedQueueMessage('unknown-message')
  let snapshot: QueuedMessageSnapshot | undefined
  try {
    snapshot = await session.restoreQueuedMessage(targetId)
  } catch (error) {
    set({ error: errorMessage(error) })
    return rejectedQueueMessage('unknown-message')
  }
  if (!snapshot) return rejectedQueueMessage('unknown-message')
  await send(set, get, deps, snapshot.content, snapshot.images?.length ? snapshot.images : undefined)
  return acceptedQueueMessage(targetId)
}

export const saveAgentLimits = (
  set: AgentSet,
  _get: AgentGet,
  _deps: StoreRuntimeDeps,
  settings: AgentLimitsSettings,
): boolean => {
  // Limits are merged once at runAgentLoop startup; applying mid-run has no
  // effect, so this persists for the next session.
  const normalized = normalizeAgentLimitsSettings(settings)
  setActiveAgentLimitsSettings(normalized)
  const limitsPersistError = persistLocalSettings(AGENT_LIMITS_STORAGE_KEY, normalized)
  if (limitsPersistError) {
    set({ error: limitsPersistError })
    return false
  }
  set({ agentLimitsSettings: normalized, providerMessage: storeT('status.limits.saved') })
  return true
}

export const continueConversation = async (
  set: AgentSet,
  get: AgentGet,
  _deps: StoreRuntimeDeps,
): Promise<void> => {
  if (get().messages.length === 0) return
  await send(set, get, _deps, '请继续。')
}

export const clear = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
): Promise<void> => {
  const { activeSessionId } = get()
  if (!activeSessionId) return
  const structuralLease = deps.beginStructural()
  if (!structuralLease) return
  let cleared = false
  try {
    await deps.getRepository().clearSession(activeSessionId)
    cleared = true
    const session = deps.getSession()
    session.reset()
    set({
      messages: [],
      activeTools: {},
      endReason: null,
      error: null,
      contextCheckpoint: null,
      contextUsage: session.getContextUsage(),
      ...queuedMessageState(session),
    })
    const storageStatsPromise = deps.getRepository().getStats().catch(() => null)
    const clearedSnapshot = await deps.getRepository().loadSession(activeSessionId)
    const projection = await deps.activateCommittedSessionSnapshot({
      repository: deps.getRepository(),
      snapshot: clearedSnapshot,
      fallbackSessions: deps.projectedSessions(clearedSnapshot),
    })
    if (projection.status === 'projection_failed') {
      set({ error: `Session 已清空，但界面状态同步失败：${projection.error}` })
    }
    set({ storageStats: await storageStatsPromise })
  } catch (error) {
    set({
      error: cleared
        ? `Session 已清空，但界面状态同步失败：${errorMessage(error)}`
        : errorMessage(error),
    })
  } finally {
    deps.endStructural(structuralLease)
  }
}

export const retryFailedAssistant = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  messageId: string,
): Promise<boolean> => {
  const initialState = get()
  if (initialState.running || initialState.sessionBusy || !initialState.activeSessionId) return false
  if (!initialState.providerReady || initialState.providerSetupRequired) {
    set({ error: '请先完成真实模型 Provider 配置' })
    return false
  }
  const failedMessage = initialState.messages[initialState.messages.length - 1]
  if (failedMessage?.id !== messageId
    || failedMessage.role !== 'assistant'
    || (failedMessage.stopReason !== 'error' && failedMessage.stopReason !== 'aborted')) {
    set({ error: '只能在当前会话中重试最后一条失败或已中止的回答' })
    return false
  }
  const sourceWorkspace = sessionMetadataById[initialState.activeSessionId]?.workspace
  if (!sourceWorkspace || !initialState.authorizedWorkspaces.some((workspace) => (
    workspace.path === sourceWorkspace.path
  ))) {
    set({ error: '当前会话没有可用的工作目录，请先在输入框中选择或重新授权' })
    return false
  }
  const runSession = deps.getSession()
  const sessionId = initialState.activeSessionId
  set({ running: true, error: null, endReason: null })
  try {
    await runSession.retry()
    return true
  } catch (error) {
    if (get().activeSessionId === sessionId) {
      set({ running: false, error: errorMessage(error) })
    }
    return false
  } finally {
    let recoveryError: string | undefined
    try {
      await runSession.takeQueuedMessages()
    } catch (error) {
      recoveryError = errorMessage(error)
    }
    set((state) => {
      if (state.activeSessionId !== sessionId) return state
      return {
        running: false,
        ...queuedMessageStateFor(runSession),
        ...(recoveryError && !state.error ? { error: recoveryError } : {}),
      }
    })
  }
}

export const retryAssistant = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  messageId: string,
): Promise<boolean> => {
  const { activeSessionId, messages, providerReady, providerSetupRequired, running, sessionBusy } = get()
  if (running || sessionBusy || !activeSessionId) return false
  if (!providerReady || providerSetupRequired) {
    set({ error: '请先完成真实模型 Provider 配置' })
    return false
  }
  const sourceWorkspace = sessionMetadataById[activeSessionId]?.workspace
  if (!sourceWorkspace || !get().authorizedWorkspaces.some((workspace) => (
    workspace.path === sourceWorkspace.path
  ))) {
    set({ error: '当前会话没有可用的工作目录，请先在输入框中选择或重新授权' })
    return false
  }
  const throughMessageId = retryBoundaryFor(messages, messageId)
  if (!throughMessageId) {
    set({ error: '这条 Assistant 消息之前没有安全的 Retry 分支边界' })
    return false
  }
  const structuralLease = deps.beginStructural()
  if (!structuralLease) return false
  set({ error: null })
  try {
    const operationSession = deps.getSession()
    const activated = await operationSession.runStructuralOperation('retry', async (signal) => {
      if (signal.aborted) throw signal.reason
      const created = await deps.getRepository().branchSession({
        sourceSessionId: activeSessionId,
        throughMessageId,
        kind: 'retry',
        retriedMessageId: messageId,
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
        state: {
          running: true,
        },
      })
      if (projection.status === 'projection_failed') {
        set({
          running: false,
          error: `Retry 分支已创建，但运行时投影失败：${projection.error}`,
        })
        return false
      }
      return true
    })
    if (!activated) return true
    await deps.getSession().continue()
    return true
  } catch (error) {
    set({ running: false, error: errorMessage(error) })
    return false
  } finally {
    let recoveryError: string | undefined
    const session = deps.getSession()
    try {
      await session.takeQueuedMessages()
    } catch (error) {
      recoveryError = errorMessage(error)
    }
    set((state) => ({
      running: false,
      ...queuedMessageState(session),
      ...(recoveryError && !state.error ? { error: recoveryError } : {}),
    }))
    deps.endStructural(structuralLease)
  }
}

/**
 * 编辑已发送的用户消息并重发：从该消息**之前**的边界创建分支，再把编辑后的内容
 * 作为新分支的首条用户消息发出。原会话历史（含被替换的消息）保留为独立会话，
 * 与「从此分支」「重试回答」同属不可变历史模型。
 */
export const editUserMessage = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  messageId: string,
  content: string,
  images?: ImageContentBlock[],
): Promise<boolean> => {
  const edited = content.trim()
  if (!edited && !images?.length) {
    set({ error: '编辑后的消息不能为空' })
    return false
  }
  const { activeSessionId, providerReady, providerSetupRequired, running, sessionBusy } = get()
  if (running || sessionBusy || !activeSessionId) {
    set({ error: running
      ? '会话正在运行，无法编辑已发送的消息'
      : sessionBusy
        ? '会话正在处理其他操作，请稍后重试'
        : '当前没有可用的会话' })
    return false
  }
  if (!providerReady || providerSetupRequired) {
    set({ error: '编辑消息并重发前请先完成真实模型 Provider 配置' })
    return false
  }
  const sourceWorkspace = sessionMetadataById[activeSessionId]?.workspace
  if (!sourceWorkspace || !get().authorizedWorkspaces.some((workspace) => (
    workspace.path === sourceWorkspace.path
  ))) {
    set({ error: '当前会话没有可用的工作目录，请先在输入框中选择或重新授权' })
    return false
  }
  const structuralLease = deps.beginStructural()
  if (!structuralLease) return false
  set({ error: null })
  try {
    const operationSession = deps.getSession()
    const activated = await operationSession.runStructuralOperation('branch_summary', async (signal) => {
      // 从 repository 重读权威消息计算边界：store 快照可能在输入期间被追加新消息，
      // 直接用快照会让边界与实际历史失配。
      const source = await deps.getRepository().loadSession(activeSessionId)
      const throughMessageId = editBoundaryFor(source.messages, messageId)
      if (!throughMessageId) throw new Error('这条消息之前没有安全的分支边界，无法编辑')
      if (signal.aborted) throw signal.reason
      const created = await deps.getRepository().branchSession({
        sourceSessionId: activeSessionId,
        throughMessageId,
        kind: 'branch',
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
        state: {
          running: true,
        },
      })
      if (projection.status === 'projection_failed') {
        set({
          running: false,
          error: `编辑分支已创建，但运行时投影失败：${projection.error}`,
        })
        return false
      }
      return true
    })
    if (!activated) return false
    // 原消息的图片块随编辑重发保留：分支从被编辑消息之前的边界重建，
    // 不带 images 会让贴图消息编辑后图片丢失。
    await deps.getSession().prompt(edited, images)
    return true
  } catch (error) {
    set({ running: false, error: errorMessage(error) })
    return false
  } finally {
    let recoveryError: string | undefined
    const session = deps.getSession()
    try {
      await session.takeQueuedMessages()
    } catch (error) {
      recoveryError = errorMessage(error)
    }
    set((state) => ({
      running: false,
      ...queuedMessageState(session),
      ...(recoveryError && !state.error ? { error: recoveryError } : {}),
    }))
    deps.endStructural(structuralLease)
  }
}

export const compactContext = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  summaryInstructions?: SummaryInstructionOptions,
): Promise<boolean> => {
  if (get().runtimeLifecycle !== 'ready' || get().running || get().sessionBusy) return false
  const session = deps.getSession()
  // 摘要 LLM 请求可达数十秒，期间允许切走（createNewSession/selectSession 都是
  // allowRunning 的 structural lease）。结束时 checkpoint/usage/错误全局态只允许
  // 写回仍处于激活位的同一会话：激活路径本就按各会话投影恢复这些字段，跨会话
  // 补写会把旧会话的压缩结果盖到新会话视图上，finally 复位 running 还会清掉
  // 新会话正在进行的 run 状态。切走会话的投影由 compaction_* 事件自身维护。
  const compactedSessionId = session.id
  const stillActive = (): boolean => get().activeSessionId === compactedSessionId
  set({ compactionRunning: true, running: true, error: null })
  try {
    await session.compact(summaryInstructions)
    if (stillActive()) {
      set({
        contextCheckpoint: session.checkpoint,
        contextUsage: session.getContextUsage(),
      })
    }
    return true
  } catch (error) {
    if (stillActive()) {
      set({ error: isAgentHarnessAbortError(error) ? null : errorMessage(error) })
    }
    return false
  } finally {
    if (stillActive()) set({ compactionRunning: false, running: false })
  }
}

export const saveContextPolicy = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  settings: ContextPolicySettings,
): Promise<boolean> => {
  const structuralLease = deps.beginStructural()
  if (!structuralLease) return false
  set({ contextPolicySaving: true, providerMessage: null, settingsError: null })
  try {
    const activeSessionId = get().activeSessionId
    if (!activeSessionId) throw new Error(storeT('status.session.noActive'))
    const normalized = normalizeContextPolicySettings(
      settings,
      get().provider.contextWindow,
      get().provider.maxOutputTokens,
    )
    const reboundSnapshot = await deps.getRepository().loadSession(activeSessionId)
    deps.bindSession(
      get().provider,
      get().providerHasKey,
      get().messages,
      activeSessionId,
      get().contextCheckpoint,
      reboundSnapshot.session,
      reboundSnapshot.journalEntries,
      normalized,
    )
    setActiveContextPolicySettings(normalized)
    const contextPolicyPersistError = persistLocalSettings(CONTEXT_POLICY_STORAGE_KEY, normalized)
    const persistenceError = contextPolicyPersistError
      ? `上下文策略已应用，但本地投影失败：${contextPolicyPersistError}`
      : undefined
    const session = deps.getSession()
    set({
      contextPolicySettings: normalized,
      contextUsage: session.getContextUsage(),
      providerMessage: storeT('status.contextPolicy.saved'),
      ...(persistenceError ? { settingsError: persistenceError } : {}),
      ...queuedMessageState(session),
    })
    return true
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return false
  } finally {
    set({ contextPolicySaving: false })
    deps.endStructural(structuralLease)
  }
}

export const saveReasoningSettings = async (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
  settings: ReasoningSettings,
): Promise<boolean> => {
  const structuralLease = deps.beginStructural()
  if (!structuralLease) return false
  try {
    const provider = get().provider
    const normalized = normalizeReasoningSettings(
      settings,
      provider.apiFormat,
      provider.maxOutputTokens,
    )
    const model = resolveProviderModel(provider)
    await deps.getSession().host.updateRuntime({ reasoning: toModelReasoning(normalized, model) ?? null })
    setActiveReasoningSettings(normalized)
    const reasoningPersistError = persistLocalSettings(REASONING_STORAGE_KEY, normalized)
    if (reasoningPersistError) {
      set({ settingsError: reasoningPersistError })
      return false
    }
    set({
      reasoningSettings: normalized,
      providerMessage: normalized.level === 'off'
        ? storeT('status.reasoning.off')
        : storeT('status.reasoning.updated', { level: normalized.level, mode: normalized.mode }),
      settingsError: null,
    })
    return true
  } catch (error) {
    set({ settingsError: errorMessage(error) })
    return false
  } finally {
    deps.endStructural(structuralLease)
  }
}
