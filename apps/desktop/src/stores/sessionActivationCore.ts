import type { AgentHarness } from '@/agent/runtime/AgentHarness'
import type { QueuedMessageSnapshot } from '@/agent/runtime/AgentSession'
import type { ProviderProfile } from '@/agent/transport/provider'
import type { ContextCheckpoint, ContextPolicySettings, ContextBudgetUsage } from '@/agent/context/types'
import type { AgentMessage, AgentRunEndReason, AgentEvent } from '@/agent/core/types'
import type { ReasoningSettings } from '@/agent/runtime/reasoningSettings'
import type { StoredAgentSession } from '@/persistence/types'
import type { AgentTool } from '@/agent/core/types'
import type { RuntimeDependencyManifest } from '@/agent/runtime/runtimeDependencyManifest'
import { getRuntimeProjection, getRuntimeProvider, setRuntimeProjection, type ActiveToolInfo } from './runtimeCaches'
import { promptSessionTitle } from '@/agent/session/title'
import { applyStreamingEvent, initStreamingDraft } from '@/agent/core/streamingDraft'

/**
 * The setState payload written by `commitSessionActivation`. Module-local to
 * `sessionActivationCore` because the store's full `AgentState` interface
 * includes a couple of dozen action functions that this core does not need
 * to know about. Consumers should pass a thin record type so the core
 * stays free of the full store surface.
 */
export interface PreparedActivationInputs {
  config: ProviderProfile
  configuredKey: boolean
  contextPolicySettings: ContextPolicySettings
  reasoningSettings: ReasoningSettings
  sessions: StoredAgentSession[]
  snapshot: {
    messages: AgentMessage[]
    checkpoint: ContextCheckpoint | null
    session: { id: string }
  }
}

export interface SessionActivationStateOverrides {
  state?: Record<string, unknown>
  persistProvider?: boolean
  fallbackSessions?: StoredAgentSession[]
}

export interface AgentCoreProjection {
  provider: ProviderProfile
  providerProfiles: ProviderProfile[]
  providerHasKey: boolean
  contextPolicySettings: ContextPolicySettings
  reasoningSettings: ReasoningSettings
  sessions: StoredAgentSession[]
  activeSessionId: string
  messages: AgentMessage[]
  activeTools: Record<string, ActiveToolInfo>
  endReason: AgentRunEndReason | null
  error: string | null
  contextCheckpoint: ContextCheckpoint | null
  contextUsage: ContextBudgetUsage | null
  pendingSteeringCount: number
  pendingFollowUpCount: number
  pendingNextTurnCount: number
  queuedMessages: QueuedMessageSnapshot[]
  recoveredQueuedMessages: QueuedMessageSnapshot[]
  providerSetupRequired: boolean
  /**
   * 流式期间尚未提交的 assistant 消息草稿：每个 text_delta / thinking_delta
   * 写入这里，message_end 时一次性合并进 `messages`。这样流式期间
   * `messages` 数组引用稳定，历史消息组件不会随每次 delta 重渲染。
   */
  streamingDraft: import('@/agent/core/types').AssistantMessage | null
  settingsError?: string
  [extra: string]: unknown
}

export interface CoreStoreBindings {
  setState: ((partial: AgentCoreProjection) => void) & ((reducer: (state: AgentCoreProjection) => Partial<AgentCoreProjection>) => void)
}

/**
 * Apply the atomic multi-field setState that `commitSessionActivation`
 * performs after `bindSession` has succeeded. This isolates the projection
 * shape from the store so it can be unit-tested with a mock `bindings`.
 *
 * NOTE: this helper assumes the caller has already written the active
 * context-policy and reasoning singletons; it does not roll them back on
 * failure (callers do so themselves because rollback needs to happen
 * regardless of the setState outcome).
 */
export const applySessionActivationState = (
  prepared: PreparedActivationInputs,
  nextProviderProfiles: ProviderProfile[],
  queuedMessageState: {
    pendingSteeringCount: number
    pendingFollowUpCount: number
    pendingNextTurnCount: number
    queuedMessages: QueuedMessageSnapshot[]
    recoveredQueuedMessages: QueuedMessageSnapshot[]
  },
  contextUsage: AgentCoreProjection['contextUsage'],
  providerSetupRequired: boolean,
  providerPersistenceError: string | undefined,
  options: SessionActivationStateOverrides,
  bindings: CoreStoreBindings,
): void => {
  bindings.setState({
    provider: prepared.config,
    providerProfiles: nextProviderProfiles,
    providerHasKey: prepared.configuredKey,
    contextPolicySettings: prepared.contextPolicySettings,
    reasoningSettings: prepared.reasoningSettings,
    sessions: prepared.sessions,
    activeSessionId: prepared.snapshot.session.id,
    messages: prepared.snapshot.messages,
    activeTools: {},
    endReason: null,
    error: null,
    contextCheckpoint: prepared.snapshot.checkpoint,
    contextUsage,
    pendingSteeringCount: queuedMessageState.pendingSteeringCount,
    pendingFollowUpCount: queuedMessageState.pendingFollowUpCount,
    pendingNextTurnCount: queuedMessageState.pendingNextTurnCount,
    queuedMessages: queuedMessageState.queuedMessages,
    recoveredQueuedMessages: queuedMessageState.recoveredQueuedMessages,
    streamingDraft: null,
    ...(options.state ?? {}),
    providerSetupRequired,
    ...(providerPersistenceError ? { settingsError: providerPersistenceError } : {}),
  })
}

/* ------------------------------------------------------------------ *
 * handleSessionEvent core
 * ------------------------------------------------------------------ */

export interface SessionEventBindings {
  setState: (reducer: (state: AgentCoreProjection) => Partial<AgentCoreProjection>) => void
  getState: () => AgentCoreProjection
  getRegisteredTools: () => AgentTool[]
  buildRuntimeManifest: (provider: ProviderProfile, runtime: AgentHarness) => unknown
}

export const queuedMessageStateFor = (runtime: AgentHarness) => ({
  pendingSteeringCount: runtime.pendingSteeringCount,
  pendingFollowUpCount: runtime.pendingFollowUpCount,
  pendingNextTurnCount: runtime.pendingNextTurnCount,
  queuedMessages: runtime.queuedMessages,
  recoveredQueuedMessages: runtime.recoveredMessages,
})

/**
 * 流式重放阴影：messageId → 当前 streamingDraft 各 contentBlock 的 contentIndex
 * 升序列表。message_update 只携带增量，消费端据此把 delta 写回对应的 block。
 * message_start 重置、message_end 清理；非活动会话的残留由 message_start 覆盖。
 */
const streamingContentIndexesByMessageId = new Map<string, number[]>()

const upsertMessage = (messages: AgentMessage[], message: AgentMessage): AgentMessage[] => {
  const index = messages.findIndex((candidate) => candidate.id === message.id)
  if (index < 0) return [...messages, message]
  return messages.map((candidate, candidateIndex) => candidateIndex === index ? message : candidate)
}

// (Manifest construction is delegated to bindings so this core stays free
// of runtimeDependencyManifest's transitive dependencies. The store passes
// a closure that invokes its local createRuntimeDependencyManifest.)

/**
 * Reducer that turns an `AgentEvent` into the zustand setState payload.
 * Returns the `state` unchanged for events that should not produce a
 * visible projection change (e.g. `runtime_tools_update` while the
 * store is focused on a different session).
 *
 * Mirrors the inline implementation that used to live in
 * `agentStore.handleSessionEvent`. Now exported from this core so it
 * can be unit-tested with mock bindings.
 */
export const applySessionEvent = (
  event: AgentEvent,
  boundSessionId: string,
  boundRuntime: AgentHarness,
  bindings: SessionEventBindings,
): void => {
  const reducer = (state: AgentCoreProjection): Partial<AgentCoreProjection> => {
    const projection = getRuntimeProjection(boundSessionId) ?? {
      activeTools: {},
      endReason: null,
      error: null,
      compactionRunning: false,
    }
    if (event.type === 'tool_execution_start') {
      projection.activeTools = {
        ...projection.activeTools,
        [event.toolCallId]: { toolName: event.toolName, content: '', details: undefined },
      }
    } else if (event.type === 'tool_execution_update') {
      projection.activeTools = {
        ...projection.activeTools,
        [event.toolCallId]: {
          toolName: event.toolName,
          content: event.content,
          details: event.details,
        },
      }
    } else if (event.type === 'tool_execution_end') {
      projection.activeTools = { ...projection.activeTools }
      delete projection.activeTools[event.toolCallId]
    } else if (event.type === 'agent_start') {
      projection.endReason = null
      projection.error = null
    } else if (event.type === 'agent_end') {
      projection.activeTools = {}
      projection.endReason = event.reason
      projection.error = event.errorMessage ?? null
    } else if (event.type === 'compaction_start') {
      projection.compactionRunning = true
      projection.error = null
    } else if (event.type === 'compaction_end') {
      projection.compactionRunning = false
      projection.error = event.errorMessage ?? projection.error
    }
    setRuntimeProjection(boundSessionId, projection)

    let sessions = state.sessions
    const updateStored = (update: (stored: StoredAgentSession) => StoredAgentSession): void => {
      sessions = sessions.map((stored) => stored.id === boundSessionId ? update(stored) : stored)
    }
    if (event.type === 'agent_start') {
      updateStored((stored) => ({ ...stored, status: 'running' }))
    } else if (event.type === 'agent_settled') {
      updateStored((stored) => ({
        ...stored,
        status: 'idle',
        messageCount: Math.max(stored.messageCount, boundRuntime.messages.length),
        updatedAt: Date.now(),
      }))
    } else if (event.type === 'message_end' || event.type === 'session_message_append') {
      updateStored((stored) => ({
        ...stored,
        title: stored.title === '新会话' && event.message.role === 'user'
          ? promptSessionTitle(event.message.content)
          : stored.title,
        messageCount: Math.max(stored.messageCount, boundRuntime.messages.length),
        updatedAt: Date.now(),
      }))
      sessions = sessions.sort((left, right) => right.updatedAt - left.updatedAt)
    } else if (event.type === 'runtime_system_prompt_update') {
      updateStored((stored) => ({ ...stored, systemPrompt: event.current, updatedAt: Date.now() }))
    } else if (event.type === 'runtime_model_update') {
      updateStored((stored) => ({
        ...stored,
        modelProvider: event.current.provider,
        modelId: event.current.model,
        updatedAt: Date.now(),
      }))
    } else if (event.type === 'runtime_reasoning_update') {
      updateStored((stored) => ({ ...stored, reasoning: event.current, updatedAt: Date.now() }))
    } else if (event.type === 'runtime_tools_update') {
      const runtimeProvider = getRuntimeProvider(boundSessionId)?.config ?? state.provider
      const manifest = bindings.buildRuntimeManifest(runtimeProvider, boundRuntime)
      updateStored((stored) => ({
        ...stored,
        activeToolNames: event.current.activeToolNames,
        runtimeManifest: manifest as RuntimeDependencyManifest,
        updatedAt: Date.now(),
      }))
    }

    if (state.activeSessionId !== boundSessionId) {
      // 后台会话事件只允许更新 sidebar sessions。store 的 streamingDraft 只可能属于
      // 活动会话（非活动事件在上文即 return，从不写 store），切走遗留草稿已由各
      // 切换路径（applySessionActivationState / activateCachedRuntimeSession）统一置
      // null。此处绝不能清空 streamingDraft，否则后台会话的 tool/流式事件会撕裂
      // 前台正在流式的消息渲染。
      return { sessions }
    }
    const base = {
      sessions,
      ...queuedMessageStateFor(boundRuntime),
    }

    switch (event.type) {
      case 'compaction_start':
        return { ...base, running: true, compactionRunning: true, error: null }
      case 'compaction_end':
        return {
          ...base,
          running: state.running,
          compactionRunning: false,
          contextCheckpoint: event.checkpoint ?? state.contextCheckpoint,
          contextUsage: event.usage ?? state.contextUsage,
          error: event.errorMessage ?? state.error,
        }
      case 'context_usage':
        return { ...base, contextUsage: event.usage }
      case 'agent_start':
        return { ...base, running: true, error: null, endReason: null }
      case 'agent_end':
        return {
          ...base,
          running: state.running,
          activeTools: {},
          endReason: event.reason,
          error: event.errorMessage ?? null,
        }
      case 'agent_settled':
        return { ...base, running: false }
      case 'message_start': {
        // assistant 的 message_start 也写到 streamingDraft 而非 messages：
        // 后续 message_update 才能命中同一 id 的 draft，避免初次消息
        // 进入 messages 后再被整列更新撕裂历史消息组件的 memo。
        if (event.message.role === 'assistant') {
          streamingContentIndexesByMessageId.delete(event.message.id)
          return { ...base, streamingDraft: initStreamingDraft(event.message) }
        }
        return { ...base, messages: upsertMessage(state.messages, event.message) }
      }
      case 'message_end': {
        // 若 draft 命中该 message id，先把 draft 合并进 messages 并清空 draft。
        streamingContentIndexesByMessageId.delete(event.message.id)
        const draft = state.streamingDraft
        if (draft && event.message.role === 'assistant' && draft.id === event.message.id) {
          const messages = upsertMessage(state.messages, event.message)
          return { ...base, messages, streamingDraft: null, sessions }
        }
        // 异常路径：draft 不存在或 id 不匹配 → 回退到原 upsertMessage 行为。
        const messages = upsertMessage(state.messages, event.message)
        return { ...base, messages, streamingDraft: null, sessions }
      }
      case 'session_message_append': {
        // 恢复路径不走 streaming，常规 upsert；若 draft 残留，清空它。
        const messages = upsertMessage(state.messages, event.message)
        return {
          ...base,
          messages,
          sessions,
          ...(state.streamingDraft ? { streamingDraft: null } : {}),
        }
      }
      case 'runtime_system_prompt_update':
        return base
      case 'runtime_model_update':
        return base
      case 'runtime_reasoning_update':
        return base
      case 'runtime_tools_update':
        return base
      case 'message_update': {
        // assistant 增量按 contentIndex 重放进 streamingDraft，不动 messages
        // 数组引用；历史消息组件由此保持 memo 稳定。
        const draft = state.streamingDraft
        if (draft?.role === 'assistant' && draft.id === event.messageId) {
          const shadow = streamingContentIndexesByMessageId.get(draft.id) ?? []
          const replayed = applyStreamingEvent(draft, shadow, event.assistantMessageEvent)
          streamingContentIndexesByMessageId.set(draft.id, replayed.contentIndexes)
          return { ...base, streamingDraft: replayed.message }
        }
        // draft 缺失或 id 不匹配（异常路径）：不产生投影变化。
        return base
      }
      case 'tool_execution_start':
        return { ...base, activeTools: { ...projection.activeTools } }
      case 'tool_execution_update':
        return { ...base, activeTools: { ...projection.activeTools } }
      case 'tool_execution_end':
        return { ...base, activeTools: { ...projection.activeTools } }
      default:
        return base
    }
  }

  bindings.setState((state: AgentCoreProjection) => reducer(state))
}
