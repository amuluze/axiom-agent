import type { AssistantMessage } from '@/agent/core/types'
import { describe, expect, it } from 'vitest'
import { RuntimeObservability } from './observability'

const secret = 'AXIOM_OBSERVABILITY_MUST_REDACT_THIS'
const assistant: AssistantMessage = {
  id: secret,
  role: 'assistant',
  content: secret,
  toolCalls: [],
  stopReason: 'stop',
  createdAt: 1,
}

describe('Runtime observability', () => {
  it('records prompt, turn, and Provider timings without retaining payloads or runtime IDs', () => {
    let now = 0
    const observability = new RuntimeObservability({ capacity: 8, now: () => ++now })
    observability.observe({ type: 'agent_start', sessionId: secret, runId: secret })
    observability.observe({ type: 'turn_start', runId: secret, turn: 1 })
    observability.observe({
      type: 'provider_request_start',
      requestId: secret,
      runId: secret,
      assistantMessageId: secret,
      modelProvider: secret,
      modelId: secret,
      messageCount: 2,
      toolCount: 1,
    })
    observability.observe({
      type: 'provider_response_received',
      requestId: secret,
      runId: secret,
      assistantMessageId: secret,
      message: assistant,
    })
    observability.observe({
      type: 'turn_end',
      runId: secret,
      turn: 1,
      message: assistant,
      toolResults: [],
    })
    observability.observe({
      type: 'agent_end',
      sessionId: secret,
      runId: secret,
      reason: 'completed',
      messages: [assistant],
    })
    observability.observe({
      type: 'agent_settled',
      savePoint: { sessionId: secret, runId: secret, messageCount: 1, createdAt: 1 },
    })

    const snapshot = observability.snapshot()
    expect(snapshot.spans.map((span) => span.kind)).toEqual(['prompt', 'turn', 'provider'])
    expect(snapshot.spans.every((span) => span.status === 'completed')).toBe(true)
    expect(snapshot.spans.find((span) => span.kind === 'provider')?.attributes)
      .toEqual({ messageCount: 2, toolCount: 1, outcome: 'stop' })
    expect(JSON.stringify(snapshot)).not.toContain(secret)
  })

  it('covers tool, compaction, and mutation spans while enforcing ring capacity', () => {
    let now = 100
    const observability = new RuntimeObservability({ capacity: 3, now: () => ++now })
    observability.observe({ type: 'agent_start', sessionId: 'session', runId: 'run' })
    observability.observe({
      type: 'tool_execution_start',
      runId: 'run',
      toolCallId: secret,
      toolName: secret,
      arguments: { secret },
      approvalState: 'not_required',
      recoveryPolicy: 'idempotent',
      idempotencyKey: secret,
    })
    observability.observe({
      type: 'tool_execution_end',
      runId: 'run',
      toolCallId: secret,
      toolName: secret,
      result: { content: secret },
      isError: false,
      approvalState: 'not_required',
    })
    observability.observe({ type: 'compaction_start', compactionId: secret, reason: 'manual' })
    observability.observe({
      type: 'compaction_end',
      compactionId: secret,
      reason: 'manual',
      aborted: false,
    })
    observability.observe({
      type: 'session_message_append',
      sessionId: secret,
      message: { id: secret, role: 'user', content: secret, createdAt: 1 },
    })
    observability.observe({
      type: 'agent_end',
      sessionId: 'session',
      runId: 'run',
      reason: 'completed',
      messages: [],
    })
    observability.observe({
      type: 'agent_settled',
      savePoint: { sessionId: 'session', runId: 'run', messageCount: 0, createdAt: 1 },
    })

    const snapshot = observability.snapshot()
    expect(snapshot.spans).toHaveLength(3)
    expect(snapshot.droppedSpans).toBe(1)
    expect(snapshot.spans.map((span) => span.kind)).toEqual(['prompt', 'compaction', 'mutation'])
    expect(JSON.stringify(snapshot)).not.toContain(secret)
  })
})
