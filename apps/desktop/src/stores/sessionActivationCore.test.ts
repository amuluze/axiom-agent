import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applySessionEvent,
  withSessionQueueCount,
  type AgentCoreProjection,
  type SessionEventBindings,
} from './sessionActivationCore'
import type {
  AgentEvent,
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from '@/agent/core/types'
import type { ContextBudgetUsage, ContextCheckpoint } from '@/agent/context/types'
import type { ProviderApiFormat } from '@/agent/core/types'
import type { ProviderProfile } from '@/agent/transport/providerProfile'
import type { AgentHarness } from '@/agent/runtime/AgentHarness'
import type { StoredAgentSession } from '@/persistence/types'

// runtimeCaches 的 module-level Map 用 mock 隔离，避免测试间通过 module
// 状态污染投影。getRuntimeProjection 返回 undefined 让 reducer 走默认投影
// 兜底；setRuntimeProjection / getRuntimeProvider 是 no-op。
vi.mock('./runtimeCaches', () => ({
  getRuntimeProjection: () => undefined,
  setRuntimeProjection: () => undefined,
  getRuntimeProvider: () => undefined,
}))

const baseProvider = (): ProviderProfile => ({
  providerId: 'demo',
  profileId: 'demo-default',
  apiFormat: 'anthropic' as ProviderApiFormat,
  modelId: 'demo-model',
  contextWindow: 8000,
  maxOutputTokens: 1024,
} as unknown as ProviderProfile)

const baseCheckpoint = (): ContextCheckpoint => ({
  summary: 'summary',
  createdAt: 0,
  reason: 'manual',
} as unknown as ContextCheckpoint)

const baseUsage = (): ContextBudgetUsage => ({
  estimatedTokens: 0,
  contextWindow: 8000,
  tokenPercent: 0,
  requestBytes: 0,
  bytePercent: 0,
  tokenThreshold: 0,
  requestByteThreshold: 0,
  hardRequestByteLimit: 0,
  needsCompaction: false,
})

const baseProjection = (): AgentCoreProjection => ({
  provider: baseProvider(),
  providerProfiles: [],
  providerHasKey: false,
  contextPolicySettings: {
    keepRecentTokens: 4,
    reserveTokens: 0,
    requestByteThreshold: 0,
  },
  reasoningSettings: { level: 'off', mode: 'enabled', budgetTokens: 0 },
  sessions: [],
  activeSessionId: 's1',
  messages: [],
  activeTools: {},
  endReason: null,
  error: null,
  contextCheckpoint: null,
  contextUsage: baseUsage(),
  pendingSteeringCount: 0,
  pendingFollowUpCount: 0,
  pendingNextTurnCount: 0,
  queuedMessages: [],
  recoveredQueuedMessages: [],
  providerSetupRequired: false,
  streamingDraft: null,
})

const userMessage = (id: string, content: string): UserMessage => ({
  id,
  createdAt: 0,
  role: 'user',
  content,
})

const assistantMessage = (id: string, content: string, blocks?: AssistantContentBlock[]): AssistantMessage => ({
  id,
  createdAt: 0,
  role: 'assistant',
  content,
  contentBlocks: blocks ?? [{ type: 'text', text: content }],
  toolCalls: [],
  stopReason: 'stop',
})

const toolResult = (id: string, toolCallId: string, content: string): ToolResultMessage => ({
  id,
  createdAt: 0,
  role: 'tool',
  toolCallId,
  toolName: 'read',
  content,
  isError: false,
})

const baseStoredSession = (): StoredAgentSession => ({
  id: 's1',
  title: '新会话',
  systemPrompt: '',
  modelProvider: 'demo',
  modelId: 'demo-model',
  reasoning: null,
  activeToolNames: [],
  providerConfig: null,
  runtimeManifest: null,
  status: 'idle',
  createdAt: 0,
  updatedAt: 0,
  messageCount: 0,
  parentSessionId: null,
  forkedFromMessageId: null,
  branchKind: null,
  retriedMessageId: null,
})

interface HarnessStub {
  messages: AgentMessage[]
  pendingSteeringCount: number
  pendingFollowUpCount: number
  pendingNextTurnCount: number
  queuedMessages: never[]
  recoveredMessages: never[]
  isRunning: boolean
  checkpoint: ContextCheckpoint | null
  getContextUsage: () => ContextBudgetUsage
  hooks: { dependencies: () => unknown[] }
}

const harnessStub = (): HarnessStub => ({
  messages: [],
  pendingSteeringCount: 0,
  pendingFollowUpCount: 0,
  pendingNextTurnCount: 0,
  queuedMessages: [],
  recoveredMessages: [],
  isRunning: false,
  checkpoint: baseCheckpoint(),
  getContextUsage: () => baseUsage(),
  hooks: { dependencies: () => [] },
})

const buildBindings = (): {
  bindings: SessionEventBindings
  stateRef: { current: AgentCoreProjection }
  recorded: Array<Partial<AgentCoreProjection> | ((state: AgentCoreProjection) => Partial<AgentCoreProjection>)>
} => {
  const recorded: Array<Partial<AgentCoreProjection> | ((state: AgentCoreProjection) => Partial<AgentCoreProjection>)> = []
  const stateRef: { current: AgentCoreProjection } = { current: baseProjection() }
  const bindings: SessionEventBindings = {
    setState: (arg) => {
      recorded.push(arg as never)
      if (typeof arg === 'function') {
        const partial = (arg as (s: AgentCoreProjection) => Partial<AgentCoreProjection>)(stateRef.current)
        stateRef.current = { ...stateRef.current, ...partial }
      } else {
        stateRef.current = { ...stateRef.current, ...(arg as Partial<AgentCoreProjection>) }
      }
    },
    getState: () => stateRef.current,
    getRegisteredTools: () => [],
    buildRuntimeManifest: () => ({}),
  }
  return { bindings, stateRef, recorded }
}

const driveEvents = (
  bindings: SessionEventBindings,
  harness: AgentHarness,
  events: AgentEvent[],
): void => {
  for (const event of events) applySessionEvent(event, 's1', harness, bindings)
}

describe('applySessionEvent — streamingDraft flow', () => {
  let harness: AgentHarness
  beforeEach(() => {
    harness = harnessStub() as unknown as AgentHarness
  })

  it('writes assistant message_start to streamingDraft without touching messages', () => {
    const { bindings, stateRef } = buildBindings()
    driveEvents(bindings, harness, [
      { type: 'message_start', runId: 'r1', message: assistantMessage('a1', '') },
    ])
    expect(stateRef.current.streamingDraft?.id).toBe('a1')
    expect(stateRef.current.messages).toEqual([])
  })

  it('keeps messages reference stable across message_update deltas', () => {
    const { bindings, stateRef } = buildBindings()
    driveEvents(bindings, harness, [
      { type: 'message_start', runId: 'r1', message: assistantMessage('a1', '') },
    ])
    const messagesAfterStart = stateRef.current.messages
    driveEvents(bindings, harness, [
      { type: 'message_update', runId: 'r1', messageId: 'a1',
        update: 'text', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hel' } },
      { type: 'message_update', runId: 'r1', messageId: 'a1',
        update: 'text', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'lo' } },
    ])
    expect(stateRef.current.messages).toBe(messagesAfterStart)
    expect(stateRef.current.streamingDraft?.content).toBe('hello')
  })

  it('commits streamingDraft into messages on message_end and clears draft', () => {
    const { bindings, stateRef } = buildBindings()
    driveEvents(bindings, harness, [
      { type: 'message_start', runId: 'r1', message: assistantMessage('a1', '') },
      { type: 'message_update', runId: 'r1', messageId: 'a1',
        update: 'text', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi' } },
      { type: 'message_end', runId: 'r1', message: assistantMessage('a1', 'hi') },
    ])
    expect(stateRef.current.streamingDraft).toBeNull()
    expect(stateRef.current.messages).toHaveLength(1)
    expect(stateRef.current.messages[0]?.id).toBe('a1')
    expect(stateRef.current.messages[0]?.content).toBe('hi')
  })

  it('falls back to upsertMessage when message_end arrives without a matching draft', () => {
    const { bindings, stateRef } = buildBindings()
    driveEvents(bindings, harness, [
      // 跳过 message_start，直接 message_end（异常路径）
      { type: 'message_end', runId: 'r1', message: assistantMessage('a1', 'hi') },
    ])
    expect(stateRef.current.streamingDraft).toBeNull()
    expect(stateRef.current.messages).toHaveLength(1)
    expect(stateRef.current.messages[0]?.id).toBe('a1')
  })

  it('upserts non-assistant message_start directly into messages', () => {
    const { bindings, stateRef } = buildBindings()
    driveEvents(bindings, harness, [
      { type: 'message_start', runId: 'r1', message: userMessage('u1', 'hello') },
    ])
    expect(stateRef.current.streamingDraft).toBeNull()
    expect(stateRef.current.messages).toHaveLength(1)
    expect(stateRef.current.messages[0]?.id).toBe('u1')
  })

  it('preserves the active session streamingDraft when a background session event arrives', () => {
    const { bindings, stateRef } = buildBindings()
    // 活动会话 s2 正在流式：store 的 streamingDraft 只属于活动会话。
    stateRef.current.activeSessionId = 's2'
    stateRef.current.streamingDraft = assistantMessage('a2', 'part')
    // 后台会话 s1（driveEvents 固定 boundSessionId='s1'）产生一整轮流式事件。
    driveEvents(bindings, harness, [
      { type: 'message_start', runId: 'r1', message: assistantMessage('a1', '') },
      { type: 'message_update', runId: 'r1', messageId: 'a1',
        update: 'text', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' } },
      { type: 'message_end', runId: 'r1', message: assistantMessage('a1', 'x') },
    ])
    // 后台事件不得撕裂前台流式草稿，也不得把后台消息写进 store.messages。
    expect(stateRef.current.streamingDraft?.id).toBe('a2')
    expect(stateRef.current.streamingDraft?.content).toBe('part')
    expect(stateRef.current.messages).toEqual([])
  })

  it('still applies background session metadata to the stored session list', () => {
    const { bindings, stateRef } = buildBindings()
    stateRef.current.activeSessionId = 's2'
    stateRef.current.streamingDraft = assistantMessage('a2', 'part')
    stateRef.current.sessions = [{ ...baseStoredSession() }]
    driveEvents(bindings, harness, [
      { type: 'message_end', runId: 'r1', message: userMessage('u1', 'background user turn') },
    ])
    // 后台会话的 sidebar 元数据仍被更新（title 由 promptSessionTitle 改写），
    // 但活动会话草稿与 messages 不受影响。
    const stored = stateRef.current.sessions.find((candidate) => candidate.id === 's1')
    expect(stored?.title).not.toBe('新会话')
    expect(stateRef.current.streamingDraft?.id).toBe('a2')
    expect(stateRef.current.messages).toEqual([])
  })

  it('session_message_append keeps messages but clears any stale draft', () => {
    const { bindings, stateRef } = buildBindings()
    driveEvents(bindings, harness, [
      { type: 'message_start', runId: 'r1', message: assistantMessage('a1', '') },
    ])
    expect(stateRef.current.streamingDraft?.id).toBe('a1')
    driveEvents(bindings, harness, [
      { type: 'session_message_append', sessionId: 's1', message: toolResult('t1', 'tc', 'output') },
    ])
    expect(stateRef.current.streamingDraft).toBeNull()
    expect(stateRef.current.messages).toHaveLength(1)
    expect(stateRef.current.messages[0]?.id).toBe('t1')
  })

  it('session_message_append clears the streaming draft even if a turn is mid-stream', () => {
    const { bindings, stateRef } = buildBindings()
    driveEvents(bindings, harness, [
      { type: 'message_start', runId: 'r1', message: assistantMessage('a1', '') },
      { type: 'message_update', runId: 'r1', messageId: 'a1',
        update: 'text', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' } },
      { type: 'session_message_append', sessionId: 's1', message: toolResult('t1', 'tc', 'out') },
    ])
    // session_message_append 是恢复/append 路径，把 draft 清掉以避免后续
    // message_end 命中 draft 时误覆盖刚 append 的 tool result。
    expect(stateRef.current.streamingDraft).toBeNull()
    expect(stateRef.current.messages).toHaveLength(1)
    expect(stateRef.current.messages[0]?.id).toBe('t1')
  })
})

describe('withSessionQueueCount', () => {
  it('按会话维护待发送条数：新增、更新、归零删除', () => {
    expect(withSessionQueueCount({}, 'a', 2)).toEqual({ a: 2 })
    expect(withSessionQueueCount({ a: 2 }, 'b', 1)).toEqual({ a: 2, b: 1 })
    expect(withSessionQueueCount({ a: 2, b: 1 }, 'a', 3)).toEqual({ a: 3, b: 1 })
    // 归零即删除键：计数不随会话数单调增长。
    expect(withSessionQueueCount({ a: 3, b: 1 }, 'a', 0)).toEqual({ b: 1 })
  })

  it('未变化时返回原对象引用，避免后台事件引发无谓重渲染', () => {
    const current = { a: 2 }
    expect(withSessionQueueCount(current, 'a', 2)).toBe(current)
    expect(withSessionQueueCount(current, 'b', 0)).toBe(current)
    expect(withSessionQueueCount(current, 'a', 0)).not.toBe(current)
  })
})
