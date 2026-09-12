import type { AgentRunEndReason } from '@/agent/core/types'
import type { AgentHarnessEvent } from './AgentHarness'

export type RuntimeSpanKind =
  | 'prompt'
  | 'turn'
  | 'provider'
  | 'tool'
  | 'compaction'
  | 'mutation'

export type RuntimeSpanStatus = 'running' | 'completed' | 'error' | 'aborted'

export interface RuntimeSpanAttributes {
  turn?: number
  messageCount?: number
  toolCount?: number
  approvalState?: string
  recoveryPolicy?: string
  mutationKind?: string
  mutationSource?: string
  compactionReason?: string
  checkpointCreated?: boolean
  outcome?: string
  isError?: boolean
}

export interface RuntimeSpan {
  spanId: string
  traceId: string
  parentSpanId?: string
  kind: RuntimeSpanKind
  status: RuntimeSpanStatus
  startedAt: number
  endedAt?: number
  durationMs?: number
  attributes: RuntimeSpanAttributes
}

export interface RuntimeObservabilitySnapshot {
  capacity: number
  droppedSpans: number
  spans: RuntimeSpan[]
}

interface RuntimeObservabilityOptions {
  capacity?: number
  now?: () => number
}

const statusForOutcome = (
  outcome: string | undefined,
): Exclude<RuntimeSpanStatus, 'running'> => {
  if (outcome === 'aborted' || outcome === 'stopped') return 'aborted'
  if (outcome === 'error' || outcome === 'turn_limit'
    || outcome === 'tool_limit' || outcome === 'time_limit') return 'error'
  return 'completed'
}

const statusForMessage = (
  stopReason: string | undefined,
): Exclude<RuntimeSpanStatus, 'running'> => {
  if (stopReason === 'aborted') return 'aborted'
  if (stopReason === 'error') return 'error'
  return 'completed'
}

/**
 * Content-free in-memory tracing for the active desktop process.
 *
 * Only fixed categories, counters, booleans, and timing data are retained.
 * Prompt/model content, tool names, arguments/results, paths, and runtime IDs
 * are deliberately used only as private correlation keys and never exported.
 */
export class RuntimeObservability {
  private readonly capacity: number
  private readonly now: () => number
  private readonly completed: RuntimeSpan[] = []
  private readonly active = new Map<string, RuntimeSpan>()
  private readonly tracesByRun = new Map<string, string>()
  private readonly promptSpansByRun = new Map<string, string>()
  private readonly outcomesByRun = new Map<string, AgentRunEndReason>()
  private nextTrace = 1
  private nextSpan = 1
  private droppedSpans = 0
  private latestRunId?: string

  constructor(options: RuntimeObservabilityOptions = {}) {
    const capacity = options.capacity ?? 256
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 2048) {
      throw new Error('Observability ring buffer capacity 必须是 1–2048 的整数')
    }
    this.capacity = capacity
    this.now = options.now ?? Date.now
  }

  observe(event: AgentHarnessEvent): void {
    const observedAt = this.now()
    switch (event.type) {
      case 'agent_start': {
        const traceId = this.createTraceId()
        this.tracesByRun.set(event.runId, traceId)
        this.latestRunId = event.runId
        const span = this.begin(
          `prompt:${event.runId}`,
          traceId,
          'prompt',
          observedAt,
        )
        this.promptSpansByRun.set(event.runId, span.spanId)
        return
      }
      case 'agent_end':
        this.outcomesByRun.set(event.runId, event.reason)
        return
      case 'agent_settled': {
        const { runId } = event.savePoint
        const traceId = this.tracesByRun.get(runId)
        const outcome = this.outcomesByRun.get(runId)
        const status = statusForOutcome(outcome)
        if (traceId) this.finishTraceChildren(traceId, status, observedAt, `prompt:${runId}`)
        this.finish(`prompt:${runId}`, status, observedAt, {
          outcome: outcome ?? 'settled',
          messageCount: event.savePoint.messageCount,
        })
        this.tracesByRun.delete(runId)
        this.promptSpansByRun.delete(runId)
        this.outcomesByRun.delete(runId)
        if (this.latestRunId === runId) this.latestRunId = undefined
        return
      }
      case 'turn_start':
        this.begin(
          `turn:${event.runId}:${event.turn}`,
          this.traceForRun(event.runId),
          'turn',
          observedAt,
          { turn: event.turn },
          this.promptSpansByRun.get(event.runId),
        )
        return
      case 'turn_end':
        this.finish(
          `turn:${event.runId}:${event.turn}`,
          statusForMessage(event.message.stopReason),
          observedAt,
          { turn: event.turn, outcome: event.message.stopReason },
        )
        return
      case 'provider_request_start':
        this.begin(
          `provider:${event.requestId}`,
          this.traceForRun(event.runId),
          'provider',
          observedAt,
          { messageCount: event.messageCount, toolCount: event.toolCount },
          this.promptSpansByRun.get(event.runId),
        )
        return
      case 'provider_response_received':
        this.finish(
          `provider:${event.requestId}`,
          statusForMessage(event.message.stopReason),
          observedAt,
          { outcome: event.message.stopReason },
        )
        return
      case 'tool_execution_start':
        this.begin(
          `tool:${event.runId}:${event.toolCallId}`,
          this.traceForRun(event.runId),
          'tool',
          observedAt,
          {
            approvalState: event.approvalState,
            recoveryPolicy: event.recoveryPolicy,
          },
          this.promptSpansByRun.get(event.runId),
        )
        return
      case 'tool_execution_end':
        this.finish(
          `tool:${event.runId}:${event.toolCallId}`,
          event.isError ? 'error' : 'completed',
          observedAt,
          { approvalState: event.approvalState, isError: event.isError },
        )
        return
      case 'compaction_start': {
        const runId = this.latestRunId
        this.begin(
          `compaction:${event.compactionId}`,
          runId ? this.traceForRun(runId) : this.createTraceId(),
          'compaction',
          observedAt,
          { compactionReason: event.reason },
          runId ? this.promptSpansByRun.get(runId) : undefined,
        )
        return
      }
      case 'compaction_end':
        this.finish(
          `compaction:${event.compactionId}`,
          event.aborted ? 'aborted' : event.errorMessage ? 'error' : 'completed',
          observedAt,
          {
            compactionReason: event.reason,
            checkpointCreated: Boolean(event.checkpoint),
            isError: Boolean(event.errorMessage),
          },
        )
        return
      case 'session_message_append':
        this.instantMutation('message_append', undefined, observedAt)
        return
      case 'runtime_system_prompt_update':
        this.instantMutation('system_prompt_update', event.source, observedAt)
        return
      case 'runtime_model_update':
        this.instantMutation('model_update', event.source, observedAt)
        return
      case 'runtime_reasoning_update':
        this.instantMutation('reasoning_update', event.source, observedAt)
        return
      case 'runtime_tools_update':
        this.instantMutation('tools_update', event.source, observedAt)
        return
      default:
        return
    }
  }

  snapshot(): RuntimeObservabilitySnapshot {
    const active = [...this.active.values()].map((span) => ({
      ...span,
      attributes: { ...span.attributes },
    }))
    const spans = [...this.completed, ...active]
      .sort((left, right) => left.startedAt - right.startedAt || left.spanId.localeCompare(right.spanId))
      .slice(-this.capacity)
    return {
      capacity: this.capacity,
      droppedSpans: this.droppedSpans,
      spans: structuredClone(spans),
    }
  }

  clear(): void {
    this.completed.splice(0)
    this.active.clear()
    this.tracesByRun.clear()
    this.promptSpansByRun.clear()
    this.outcomesByRun.clear()
    this.latestRunId = undefined
    this.droppedSpans = 0
  }

  private createTraceId(): string {
    return `trace-${this.nextTrace++}`
  }

  private createSpanId(): string {
    return `span-${this.nextSpan++}`
  }

  private traceForRun(runId: string): string {
    let traceId = this.tracesByRun.get(runId)
    if (!traceId) {
      traceId = this.createTraceId()
      this.tracesByRun.set(runId, traceId)
    }
    return traceId
  }

  private begin(
    key: string,
    traceId: string,
    kind: RuntimeSpanKind,
    startedAt: number,
    attributes: RuntimeSpanAttributes = {},
    parentSpanId?: string,
  ): RuntimeSpan {
    const existing = this.active.get(key)
    if (existing) return existing
    const span: RuntimeSpan = {
      spanId: this.createSpanId(),
      traceId,
      ...(parentSpanId ? { parentSpanId } : {}),
      kind,
      status: 'running',
      startedAt,
      attributes: { ...attributes },
    }
    this.active.set(key, span)
    return span
  }

  private finish(
    key: string,
    status: Exclude<RuntimeSpanStatus, 'running'>,
    endedAt: number,
    attributes: RuntimeSpanAttributes = {},
  ): void {
    const span = this.active.get(key)
    if (!span) return
    this.active.delete(key)
    this.push({
      ...span,
      status,
      endedAt,
      durationMs: Math.max(0, endedAt - span.startedAt),
      attributes: { ...span.attributes, ...attributes },
    })
  }

  private finishTraceChildren(
    traceId: string,
    status: Exclude<RuntimeSpanStatus, 'running'>,
    endedAt: number,
    excludedKey: string,
  ): void {
    for (const [key, span] of [...this.active]) {
      if (key !== excludedKey && span.traceId === traceId) this.finish(key, status, endedAt)
    }
  }

  private instantMutation(kind: string, source: string | undefined, observedAt: number): void {
    const runId = this.latestRunId
    this.push({
      spanId: this.createSpanId(),
      traceId: runId ? this.traceForRun(runId) : this.createTraceId(),
      ...(runId && this.promptSpansByRun.get(runId)
        ? { parentSpanId: this.promptSpansByRun.get(runId) }
        : {}),
      kind: 'mutation',
      status: 'completed',
      startedAt: observedAt,
      endedAt: observedAt,
      durationMs: 0,
      attributes: {
        mutationKind: kind,
        ...(source ? { mutationSource: source } : {}),
      },
    })
  }

  private push(span: RuntimeSpan): void {
    this.completed.push(span)
    while (this.completed.length > this.capacity) {
      this.completed.shift()
      this.droppedSpans += 1
    }
  }
}
