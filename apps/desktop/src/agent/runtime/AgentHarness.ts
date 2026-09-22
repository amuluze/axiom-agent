import type { ContextBudgetUsage, ContextCheckpoint } from '@/agent/context/types'
import {
  snapshotAgentContext,
  snapshotAgentEvent,
  snapshotAgentTools,
} from '@/agent/core/snapshots'
import type {
  AgentContext,
  AgentEvent,
  AgentLoopResult,
  AgentMessage,
  AgentTool,
  BeforeAgentStartResult,
  ImageContentBlock,
  ModelReasoning,
  ModelTransport,
  ModelTransportLifecycle,
  RuntimeDependenciesSnapshot,
} from '@/agent/core/types'
import type { AgentLoopTurnUpdate } from '@/agent/core/runAgentLoop'
import type { SummaryInstructionOptions } from '@/agent/context/summaryInstructions'
import {
  generateBranchSummary,
  type GenerateBranchSummaryOptions,
} from '@/agent/session/branchSummary'
import type { BranchSummarySource } from '@/agent/session/branch'
import type { QueueDeliveryMode } from './queueSettings'
import type {
  QueueAcceptance,
  QueueMoveTarget,
  QueueMutationResult,
} from './queueContracts'
import {
  AgentSession,
  type AgentAbortSettlement,
  type AgentRuntimeUpdate,
  type AgentSessionOptions,
  type QueuedMessageSnapshot,
} from './AgentSession'
import { summaryHookCancelled } from './summaryHooks'
import {
  RuntimeHookExecutionError,
  RuntimeHookRegistry,
  runtimeHookEvent,
  snapshotRuntimeHookEvent,
  type RuntimeHookBundleDependency,
  type RuntimeHookEvent,
  type RuntimeHookDiagnostic,
  type RuntimeHookDiagnosticSink,
  type RuntimeHookHandler,
  type RuntimeHookRegistration,
  type RuntimeHookResultMap,
  type RuntimeHookType,
} from './RuntimeHookRegistry'

export type {
  AfterBranchSummaryHookEvent,
  AfterCompactionHookEvent,
  AfterProviderResponseHookEvent,
  BeforeAgentStartHookEvent,
  BeforeBranchSummaryHookEvent,
  BeforeCompactionHookEvent,
  BeforeProviderPayloadHookEvent,
  BeforeProviderRequestHookEvent,
  ContextHookEvent,
  PrepareNextTurnHookEvent,
  RuntimeHookResultMap as AgentHarnessHookResultMap,
  RuntimeToolCallResult as AgentHarnessToolCallResult,
  ToolCallHookEvent,
  ToolResultHookEvent,
} from './RuntimeHookRegistry'

export type AgentHarnessErrorCode =
  | 'busy'
  | 'invalid_state'
  | 'invalid_argument'
  | 'provider'
  | 'session'
  | 'hook'
  | 'compaction'
  | 'aborted'
  | 'unknown'

export type AgentHarnessPhase = 'idle' | 'turn' | 'compaction' | 'branch_summary' | 'retry'
export type AgentHarnessStructuralPhase = Extract<AgentHarnessPhase, 'branch_summary' | 'retry'>

export type AgentHarnessCallbackOperation =
  | 'request_abort'
  | 'steer'
  | 'follow_up'
  | 'next_turn'
  | 'append_message'
  | 'schedule_runtime_update'
  | 'defer_until_idle'

const HOOK_ALLOWED_OPERATIONS: Record<RuntimeHookType, readonly AgentHarnessCallbackOperation[]> = {
  before_agent_start: ['request_abort', 'defer_until_idle'],
  context: ['request_abort', 'defer_until_idle'],
  tool_call: ['request_abort', 'defer_until_idle'],
  tool_result: ['request_abort', 'defer_until_idle'],
  before_provider_request: ['request_abort', 'defer_until_idle'],
  before_provider_payload: ['request_abort', 'defer_until_idle'],
  after_provider_response: ['request_abort', 'defer_until_idle'],
  prepare_next_turn: ['request_abort', 'defer_until_idle'],
  before_compaction: ['request_abort', 'defer_until_idle'],
  after_compaction: ['request_abort', 'defer_until_idle'],
  before_branch_summary: ['request_abort', 'defer_until_idle'],
  after_branch_summary: ['request_abort', 'defer_until_idle'],
}

const isRuntimeHookType = (value: string): value is RuntimeHookType => value in HOOK_ALLOWED_OPERATIONS

export const HARNESS_OPTIONS_HOOK_REGISTRATION: RuntimeHookRegistration = Object.freeze({
  id: 'axiom.runtime.harness-options-hooks',
  version: '7',
  source: 'harness-options',
})

export class AgentHarnessError extends Error {
  readonly cause?: unknown

  constructor(
    public readonly code: AgentHarnessErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message)
    this.name = 'AgentHarnessError'
    this.cause = options?.cause
  }
}

interface ActiveHarnessOperation {
  lease: symbol
  phase: Exclude<AgentHarnessPhase, 'idle'>
  requestAbort: () => boolean
  idle: Promise<void>
  resolveIdle: () => void
}

/** Shared by rebound harness instances so structural operations use one synchronous lock. */
export class AgentHarnessOperationCoordinator {
  private active?: ActiveHarnessOperation

  get phase(): AgentHarnessPhase {
    return this.active?.phase ?? 'idle'
  }

  begin(
    phase: Exclude<AgentHarnessPhase, 'idle'>,
    requestAbort: () => boolean,
  ): symbol {
    if (this.active) throw new AgentHarnessError('busy', `AgentHarness 正在执行 ${this.active.phase}`)
    let resolveIdle = (): void => undefined
    const idle = new Promise<void>((resolve) => { resolveIdle = resolve })
    const lease = Symbol(phase)
    this.active = { lease, phase, requestAbort, idle, resolveIdle }
    return lease
  }

  finish(lease: symbol): void {
    if (this.active?.lease !== lease) return
    const { resolveIdle } = this.active
    this.active = undefined
    resolveIdle()
  }

  requestAbort(): boolean {
    return this.active?.requestAbort() ?? false
  }

  async waitForIdle(): Promise<void> {
    await this.active?.idle
  }
}

export interface QueueUpdateEvent {
  type: 'queue_update'
  queuedMessages: QueuedMessageSnapshot[]
}

export interface RuntimeUpdateEvent {
  type: 'runtime_update'
  previous: AgentContext
  current: AgentContext
}

export interface AbortEvent {
  type: 'abort'
  sessionId: string
  settlement: AgentAbortSettlement
}

export type AgentHarnessHookEvent = RuntimeHookEvent

export type AgentHarnessEvent =
  | AgentEvent
  | RuntimeHookEvent
  | QueueUpdateEvent
  | RuntimeUpdateEvent
  | AbortEvent

type AgentHarnessObserver = (
  event: AgentHarnessEvent,
  context: AgentHarnessCallbackContext,
) => void | Promise<void>

export type AgentHarnessLifecycleEvent = Extract<AgentEvent, { type: 'agent_settled' }>

export interface AgentHarnessLifecycleEvents {
  readonly delivery: 'best-effort-readonly'
  on: (
    type: 'agent_settled',
    observer: (event: AgentHarnessLifecycleEvent) => void | Promise<void>,
  ) => () => void
}

export interface AgentHarnessCallbackContext {
  readonly phase: AgentHarnessPhase
  readonly signal: AbortSignal
  readonly allowedOperations: readonly AgentHarnessCallbackOperation[]
  can: (operation: AgentHarnessCallbackOperation) => boolean
  requestAbort: () => boolean
  steer: (content: string, images?: ImageContentBlock[]) => Promise<boolean>
  followUp: (content: string, images?: ImageContentBlock[]) => Promise<boolean>
  nextTurn: (content: string, images?: ImageContentBlock[]) => Promise<boolean>
  appendMessage: (message: AgentMessage) => Promise<void>
  scheduleRuntimeUpdate: (update: AgentRuntimeUpdate) => Promise<void>
  deferUntilIdle: (
    operation: (signal: AbortSignal) => void | Promise<void>,
  ) => AgentHarnessDeferredTaskHandle
}

export interface AgentHarnessDeferredTaskSettlement {
  status: 'completed' | 'failed' | 'timed_out' | 'aborted'
  durationMs: number
  error?: unknown
}

export interface AgentHarnessDeferredTaskHandle {
  readonly settlement: Promise<AgentHarnessDeferredTaskSettlement>
  readonly completion: Promise<AgentHarnessDeferredTaskSettlement>
}

export interface AgentHarnessHooks {
  readonly deferredCommitPolicy: 'handler-success'
  on: <TType extends RuntimeHookType>(
    type: TType,
    handler: RuntimeHookHandler<TType>,
    registration: RuntimeHookRegistration,
  ) => () => void
  seal: () => RuntimeHookBundleDependency[]
  dependencies: () => RuntimeHookBundleDependency[]
  diagnostics: () => RuntimeHookDiagnostic[]
}

export interface AgentHarnessHostController {
  scheduleRuntimeUpdate: (update: AgentRuntimeUpdate) => Promise<void>
  updateRuntime: (update: AgentRuntimeUpdate) => Promise<void>
  setModel: (model: AgentContext['model'], transport?: ModelTransport) => Promise<void>
  setReasoning: (reasoning: ModelReasoning | null) => Promise<void>
  setTools: (tools: AgentTool[], activeToolNames?: string[]) => Promise<void>
}

export interface AgentHarnessOptions extends AgentSessionOptions {
  operationCoordinator?: AgentHarnessOperationCoordinator
  observability?: AgentHarnessObservability
  hookDiagnostics?: RuntimeHookDiagnosticSink
}

export interface AgentHarnessObservability {
  observe(event: AgentHarnessEvent): void
}

export type AgentHarnessCleanup = () => void | Promise<void>

let harnessDiagnosticScopeSequence = 0

interface AgentHarnessDeferredTask {
  state: 'pending' | 'running'
  cancel: (reason: unknown) => void
  promise: Promise<void>
}

const AGENT_HARNESS_DEFERRED_TASK_TIMEOUT_MS = 10_000

const normalizeHarnessError = (
  error: unknown,
  fallback: AgentHarnessErrorCode,
): AgentHarnessError => {
  if (error instanceof AgentHarnessError && !isAgentHarnessAbortError(error)) return error
  if (error instanceof RuntimeHookExecutionError) {
    const cause = error.cause instanceof Error ? error.cause : new Error(String(error.cause))
    return new AgentHarnessError('hook', cause.message, { cause })
  }
  if (isAgentHarnessAbortError(error)) {
    const cause = error instanceof Error ? error : new Error(String(error))
    return new AgentHarnessError('aborted', cause.message, { cause })
  }
  const cause = error instanceof Error ? error : new Error(String(error))
  return new AgentHarnessError(fallback, cause.message, { cause })
}

export const isAgentHarnessAbortError = (error: unknown): boolean => {
  const visited = new Set<unknown>()
  let current = error
  while (current && !visited.has(current)) {
    visited.add(current)
    if (current instanceof AgentHarnessError && current.code === 'aborted') return true
    if (current instanceof DOMException && current.name === 'AbortError') return true
    if (current instanceof Error && current.name === 'AbortError') return true
    current = typeof current === 'object' && 'cause' in current
      ? (current as { cause?: unknown }).cause
      : undefined
  }
  return false
}

const snapshotHarnessEvent = (event: AgentHarnessEvent): AgentHarnessEvent => {
  if ('type' in event && [
    'before_agent_start',
    'context',
    'tool_call',
    'tool_result',
    'before_provider_request',
    'before_provider_payload',
    'after_provider_response',
    'prepare_next_turn',
    'before_compaction',
    'after_compaction',
    'before_branch_summary',
    'after_branch_summary',
  ].includes(event.type)) return snapshotRuntimeHookEvent(event as RuntimeHookEvent)
  switch (event.type) {
    case 'queue_update':
      return { ...event, queuedMessages: structuredClone(event.queuedMessages) }
    case 'runtime_update':
      return {
        ...event,
        previous: snapshotAgentContext(event.previous),
        current: snapshotAgentContext(event.current),
      }
    case 'abort':
      return { ...event, settlement: structuredClone(event.settlement) }
    default:
      return snapshotAgentEvent(event as AgentEvent)
  }
}

const mergeTurnUpdates = (
  current: AgentLoopTurnUpdate | undefined,
  next: AgentLoopTurnUpdate,
): AgentLoopTurnUpdate => ({
  ...current,
  ...next,
  ...(current?.appendMessages || next.appendMessages
    ? { appendMessages: [...(current?.appendMessages ?? []), ...(next.appendMessages ?? [])] }
    : {}),
  ...(current?.runtimeUpdates || next.runtimeUpdates
    ? { runtimeUpdates: [...(current?.runtimeUpdates ?? []), ...(next.runtimeUpdates ?? [])] }
    : {}),
})

export class AgentHarness {
  private readonly session: AgentSession
  private readonly operationCoordinator: AgentHarnessOperationCoordinator
  private readonly observability?: AgentHarnessObservability
  private readonly observers = new Set<AgentHarnessObserver>()
  private readonly lifecycleObservers = new Set<(
    event: AgentHarnessLifecycleEvent,
  ) => void | Promise<void>>()
  private readonly hookRegistry: RuntimeHookRegistry
  private readonly hostTransports = new WeakSet<object>()
  private readonly cleanupHandlers = new Set<AgentHarnessCleanup>()
  private readonly deferredTasks = new Set<AgentHarnessDeferredTask>()
  private lifecycleState: 'active' | 'disposing' | 'disposed' = 'active'
  private ownedOperationLease?: symbol
  private disposePromise?: Promise<void>
  readonly hooks: AgentHarnessHooks
  readonly lifecycle: AgentHarnessLifecycleEvents
  readonly host: AgentHarnessHostController

  constructor(options: AgentHarnessOptions) {
    harnessDiagnosticScopeSequence += 1
    this.hookRegistry = new RuntimeHookRegistry(
      options.hookDiagnostics,
      `harness-${harnessDiagnosticScopeSequence}`,
    )
    this.operationCoordinator = options.operationCoordinator ?? new AgentHarnessOperationCoordinator()
    this.observability = options.observability
    this.hostTransports.add(options.transport)
    this.hooks = Object.freeze({
      deferredCommitPolicy: 'handler-success' as const,
      on: <TType extends RuntimeHookType>(
        type: TType,
        handler: RuntimeHookHandler<TType>,
        registration: RuntimeHookRegistration,
      ): (() => void) => {
        this.assertActive(`hooks.on:${type}`)
        if (!registration) throw new AgentHarnessError('invalid_argument', 'Runtime Hook 必须提供 identity')
        return this.hookRegistry.register(type, handler, registration)
      },
      seal: () => this.hookRegistry.seal(),
      dependencies: () => this.hookRegistry.dependencies(),
      diagnostics: () => this.hookRegistry.diagnostics(),
    })
    this.lifecycle = Object.freeze({
      delivery: 'best-effort-readonly' as const,
      on: (
        type: 'agent_settled',
        observer: (event: AgentHarnessLifecycleEvent) => void | Promise<void>,
      ): (() => void) => {
        this.assertActive(`lifecycle.on:${type}`)
        this.lifecycleObservers.add(observer)
        return () => this.lifecycleObservers.delete(observer)
      },
    })
    this.host = Object.freeze({
      scheduleRuntimeUpdate: (update: AgentRuntimeUpdate) => this.scheduleRuntimeUpdate(update, true),
      updateRuntime: (update: AgentRuntimeUpdate) => this.updateRuntime(update),
      setModel: (model: AgentContext['model'], transport?: ModelTransport) => this.updateRuntime({
        model,
        ...(transport ? { transport } : {}),
      }),
      setReasoning: (reasoning: ModelReasoning | null) => this.updateRuntime({ reasoning }),
      setTools: (tools: AgentTool[], activeToolNames?: string[]) => this.updateRuntime({
        tools: snapshotAgentTools(tools),
        activeToolNames,
      }),
    })
    const hostApproval = options.beforeToolCall

    if (options.beforeAgentStart) this.hookRegistry.register(
      'before_agent_start',
      (event) => options.beforeAgentStart?.(event),
      HARNESS_OPTIONS_HOOK_REGISTRATION,
    )
    if (options.transformContext) this.hookRegistry.register(
      'context',
      async (event) => ({
        messages: await options.transformContext?.(
          event.messages,
          event.signal,
          event.context,
          event.runId,
        ) ?? event.messages,
      }),
      HARNESS_OPTIONS_HOOK_REGISTRATION,
    )
    if (options.afterToolCall) this.hookRegistry.register(
      'tool_result',
      (event) => options.afterToolCall?.(event),
      HARNESS_OPTIONS_HOOK_REGISTRATION,
    )
    if (options.providerLifecycle?.beforeRequest) this.hookRegistry.register(
      'before_provider_request',
      (event) => options.providerLifecycle?.beforeRequest?.(event),
      HARNESS_OPTIONS_HOOK_REGISTRATION,
    )
    if (options.providerLifecycle?.beforePayload) this.hookRegistry.register(
      'before_provider_payload',
      (event) => options.providerLifecycle?.beforePayload?.(event),
      HARNESS_OPTIONS_HOOK_REGISTRATION,
    )
    if (options.providerLifecycle?.afterResponse) this.hookRegistry.register(
      'after_provider_response',
      async (event) => {
        await options.providerLifecycle?.afterResponse?.(event)
        return undefined
      },
      HARNESS_OPTIONS_HOOK_REGISTRATION,
    )
    if (options.prepareNextTurn) this.hookRegistry.register(
      'prepare_next_turn',
      async (event) => {
        const result = await options.prepareNextTurn?.(event.snapshot, event.signal)
        if (result) this.rememberHostTransports(result)
        return result
      },
      HARNESS_OPTIONS_HOOK_REGISTRATION,
    )
    if (options.beforeCompaction) this.hookRegistry.register(
      'before_compaction',
      (event) => options.beforeCompaction?.(event),
      HARNESS_OPTIONS_HOOK_REGISTRATION,
    )
    if (options.afterCompaction) this.hookRegistry.register(
      'after_compaction',
      async (event) => {
        await options.afterCompaction?.(event)
        return undefined
      },
      HARNESS_OPTIONS_HOOK_REGISTRATION,
    )

    const providerLifecycle: ModelTransportLifecycle = {
      beforeRequest: async (context) => {
        const event = runtimeHookEvent('before_provider_request', context)
        this.notify(event)
        let timeoutMs = context.timeoutMs
        const results = await this.hookRegistry.dispatch(
          'before_provider_request',
          event,
          this.callbackContext(event),
          (current, result) => {
            timeoutMs = result.timeoutMs ?? timeoutMs
            return { ...current, timeoutMs }
          },
        )
        return results.length === 0 ? undefined : { timeoutMs }
      },
      beforePayload: async (context) => {
        let payload = structuredClone(context.payload)
        const event = runtimeHookEvent('before_provider_payload', { ...context, payload })
        this.notify(event)
        await this.hookRegistry.dispatch(
          'before_provider_payload',
          event,
          this.callbackContext(event),
          (current, result) => {
            payload = structuredClone(result.payload)
            return { ...current, payload }
          },
        )
        return { payload }
      },
      afterResponse: async (context) => {
        const event = runtimeHookEvent('after_provider_response', context)
        this.notify(event)
        await this.hookRegistry.dispatch('after_provider_response', event, this.callbackContext(event))
      },
    }

    this.session = new AgentSession({
      ...options,
      beforeAgentStart: async (context) => {
        let prompts = structuredClone(context.prompts)
        let systemPrompt = context.systemPrompt
        let appended: AgentMessage[] = []
        const event = runtimeHookEvent('before_agent_start', {
          ...context,
          prompts,
          systemPrompt,
        })
        this.notify(event)
        await this.hookRegistry.dispatch(
          'before_agent_start',
          event,
          this.callbackContext(event),
          (current, result) => {
            if (result.prompts) prompts = structuredClone(result.prompts)
            if (result.appendMessages) appended = [...appended, ...structuredClone(result.appendMessages)]
            if (result.systemPrompt !== undefined) systemPrompt = result.systemPrompt
            return { ...current, prompts, systemPrompt }
          },
        )
        const current: BeforeAgentStartResult = {
          prompts,
          ...(appended.length ? { appendMessages: appended } : {}),
          ...(systemPrompt !== context.systemPrompt ? { systemPrompt } : {}),
        }
        return {
          ...current,
          prompts: structuredClone(current.prompts),
          ...(current.appendMessages ? { appendMessages: structuredClone(current.appendMessages) } : {}),
        }
      },
      transformContext: async (messages, signal, context, runId) => {
        let current = structuredClone(messages)
        const runtime = context ?? this.session.runtimeContext
        const event = runtimeHookEvent('context', {
          sessionId: runtime.sessionId,
          runId: runId ?? 'context',
          messages: current,
          context: runtime,
          signal,
        })
        this.notify(event)
        await this.hookRegistry.dispatch('context', event, this.callbackContext(event), (previous, result) => {
          current = structuredClone(result.messages)
          return { ...previous, messages: current }
        })
        return current
      },
      providerLifecycle,
      beforeToolCall: async (context) => {
        const event = runtimeHookEvent('tool_call', context)
        this.notify(event)
        for (const result of await this.hookRegistry.dispatch(
          'tool_call',
          event,
          this.callbackContext(event),
          undefined,
          (result) => result.block === true,
        )) {
          if (result?.block) return { decision: 'denied', reason: result.reason }
        }
        if (hostApproval) return hostApproval(context)
        return context.requiresApproval
          ? { decision: 'denied', reason: '没有可用的用户审批处理器' }
          : { decision: 'approved' }
      },
      afterToolCall: async (context) => {
        let current: RuntimeHookResultMap['tool_result']
        let currentContext = context
        const event = runtimeHookEvent('tool_result', currentContext)
        this.notify(event)
        await this.hookRegistry.dispatch('tool_result', event, this.callbackContext(event), (previous, result) => {
          current = {
            result: result.result ?? current?.result,
            isError: result.isError ?? current?.isError,
          }
          currentContext = {
            ...currentContext,
            result: result.result ?? currentContext.result,
            isError: result.isError ?? currentContext.isError,
          }
          return { ...previous, ...currentContext }
        })
        return current
      },
      prepareNextTurn: async (snapshot, signal) => {
        const event = runtimeHookEvent('prepare_next_turn', { snapshot, signal })
        this.notify(event)
        let update: AgentLoopTurnUpdate | undefined
        for (const result of await this.hookRegistry.dispatch(
          'prepare_next_turn',
          event,
          this.callbackContext(event),
          undefined,
          undefined,
          (hookResult) => this.assertHostOwnedTransports(hookResult, 'prepare_next_turn'),
        )) {
          if (result) update = mergeTurnUpdates(update, result)
        }
        return update
      },
      beforeCompaction: async (context) => {
        let current: RuntimeHookResultMap['before_compaction']
        const event = runtimeHookEvent('before_compaction', context)
        this.notify(event)
        for (const result of await this.hookRegistry.dispatch(
          'before_compaction',
          event,
          this.callbackContext(event),
          undefined,
          (result) => result.cancel === true,
        )) {
          if (!result) continue
          current = {
            cancel: result.cancel ?? current?.cancel,
            replacement: result.replacement ?? current?.replacement,
          }
          if (current.cancel) return current
        }
        return current
      },
      afterCompaction: async (context) => {
        const event = runtimeHookEvent('after_compaction', context)
        this.notify(event)
        await this.hookRegistry.dispatch('after_compaction', event, this.callbackContext(event))
      },
    })

    const unsubscribeSession = this.session.subscribe((event) => {
      this.notify(snapshotAgentEvent(event))
    })
    this.cleanupHandlers.add(unsubscribeSession)
  }

  get id(): string { return this.session.id }
  get phase(): AgentHarnessPhase { return this.operationCoordinator.phase }
  get isRunning(): boolean { return this.phase !== 'idle' }
  get isDisposed(): boolean { return this.lifecycleState === 'disposed' }
  get canQueueMessages(): boolean { return this.lifecycleState === 'active' && this.session.canQueueMessages }
  get signal(): AbortSignal | undefined { return this.session.signal }
  get pendingSteeringCount(): number { return this.session.pendingSteeringCount }
  get pendingFollowUpCount(): number { return this.session.pendingFollowUpCount }
  get pendingNextTurnCount(): number { return this.session.pendingNextTurnCount }
  get queuedMessages(): QueuedMessageSnapshot[] { return this.session.queuedMessages }
  get recoveredMessages(): QueuedMessageSnapshot[] { return this.session.recoveredMessages }
  /** sendQueuedNow 的武装目标：点击「立即发送」已接受、等待 turn 边界注入的队列项。 */
  get armedQueueMessageId(): string | undefined { return this.session.armedQueueMessageId }
  /** 当前队列模式（投递档 + autoDrain）：宿主在缓存激活等边界对齐全局设置用。 */
  get queueModes(): { steering: QueueDeliveryMode; followUp: QueueDeliveryMode; autoDrain: boolean } {
    return this.session.queueModes
  }
  get messages(): AgentMessage[] { return this.session.messages }
  get checkpoint(): ContextCheckpoint | null { return this.session.checkpoint }
  get runtimeContext(): AgentContext { return this.session.runtimeContext }
  get systemPrompt(): string { return this.session.systemPrompt }
  get activeToolNames(): readonly string[] { return this.session.activeToolNames }

  subscribe(observer: AgentHarnessObserver): () => void {
    this.assertActive('subscribe')
    this.observers.add(observer)
    return () => this.observers.delete(observer)
  }

  /** Runtime listeners are awaited by AgentSession and remain part of save-point settlement. */
  subscribeRuntime(listener: (
    event: AgentEvent,
    signal: AbortSignal,
    context: AgentHarnessCallbackContext,
  ) => void | Promise<void>): () => void {
    this.assertActive('subscribeRuntime')
    const unsubscribe = this.session.subscribe((event, signal) =>
      listener(event, signal, this.callbackContext(event, signal)))
    this.cleanupHandlers.add(unsubscribe)
    return () => {
      this.cleanupHandlers.delete(unsubscribe)
      unsubscribe()
    }
  }

  async prompt(content: string, images?: ImageContentBlock[]): Promise<AgentLoopResult> {
    return this.runInPhase('turn', 'invalid_argument', () => this.session.prompt(content, images))
  }

  async promptMessages(messages: AgentMessage[]): Promise<AgentLoopResult> {
    return this.runInPhase('turn', 'invalid_argument', () => this.session.promptMessages(messages))
  }

  async continue(): Promise<AgentLoopResult> {
    return this.runInPhase('turn', 'invalid_state', () => this.session.continue())
  }

  async retry(): Promise<AgentLoopResult> {
    return this.runInPhase('retry', 'invalid_state', () => this.session.retry())
  }

  async steer(content: string, images?: ImageContentBlock[]): Promise<QueueAcceptance> {
    this.assertActive('steer')
    const accepted = await this.session.steer(content, images)
    if (accepted.accepted) this.emitQueueUpdate()
    return accepted
  }

  async followUp(content: string, images?: ImageContentBlock[]): Promise<QueueAcceptance> {
    this.assertActive('followUp')
    const accepted = await this.session.followUp(content, images)
    if (accepted.accepted) this.emitQueueUpdate()
    return accepted
  }

  async nextTurn(content: string, images?: ImageContentBlock[]): Promise<QueueAcceptance> {
    this.assertActive('nextTurn')
    const accepted = await this.session.nextTurn(content, images)
    if (accepted.accepted) this.emitQueueUpdate()
    return accepted
  }

  /** 手动放行一条队列项（对齐 ZCode sendQueuedNow）：移到 steering 队首并武装立即注入。 */
  async sendQueuedNow(messageId?: string): Promise<QueueAcceptance> {
    this.assertActive('sendQueuedNow')
    const accepted = await this.session.sendQueuedNow(messageId)
    if (accepted.accepted) this.emitQueueUpdate()
    return accepted
  }

  setAutoDrain(enabled: boolean): void {
    this.assertActive('setAutoDrain')
    this.session.setAutoDrain(enabled)
  }

  async editQueuedMessage(
    messageId: string,
    content: string,
    images?: ImageContentBlock[],
  ): Promise<QueueMutationResult> {
    this.assertActive('editQueuedMessage')
    const result = await this.session.editQueuedMessage(messageId, content, images)
    if (result.updated) this.emitQueueUpdate()
    return result
  }

  async moveQueuedMessage(
    messageId: string,
    target: QueueMoveTarget,
  ): Promise<QueueMutationResult> {
    this.assertActive('moveQueuedMessage')
    const result = await this.session.moveQueuedMessage(messageId, target)
    if (result.updated) this.emitQueueUpdate()
    return result
  }

  async promoteQueuedMessage(messageId: string): Promise<QueueMutationResult> {
    this.assertActive('promoteQueuedMessage')
    const result = await this.session.promoteQueuedMessage(messageId)
    if (result.updated) this.emitQueueUpdate()
    return result
  }

  async deleteQueuedMessage(messageId: string): Promise<QueueMutationResult> {
    this.assertActive('deleteQueuedMessage')
    const result = await this.session.deleteQueuedMessage(messageId)
    if (result.updated) this.emitQueueUpdate()
    return result
  }

  async clearQueuedMessages(): Promise<void> {
    this.assertActive('clearQueuedMessages')
    await this.session.clearQueuedMessages()
    this.emitQueueUpdate()
  }

  async restoreQueuedMessage(messageId: string): Promise<QueuedMessageSnapshot | undefined> {
    this.assertActive('restoreQueuedMessage')
    const restored = await this.session.restoreQueuedMessage(messageId)
    if (restored) this.emitQueueUpdate()
    return restored
  }

  async takeQueuedMessages(): Promise<QueuedMessageSnapshot[]> {
    this.assertActive('takeQueuedMessages')
    const messages = await this.session.takeQueuedMessages()
    if (messages.length > 0) this.emitQueueUpdate()
    return messages
  }

  async discardRecoveredMessage(messageId: string): Promise<boolean> {
    this.assertActive('discardRecoveredMessage')
    const discarded = await this.session.discardRecoveredMessage(messageId)
    if (discarded) this.emitQueueUpdate()
    return discarded
  }

  setQueueModes(steering: QueueDeliveryMode, followUp: QueueDeliveryMode): void {
    this.assertActive('setQueueModes')
    this.session.setQueueModes(steering, followUp)
  }

  async appendMessage(message: AgentMessage): Promise<void> {
    this.assertActive('appendMessage')
    return this.run('session', () => this.session.appendMessage(message))
  }

  private async scheduleRuntimeUpdate(update: AgentRuntimeUpdate, hostOwned: boolean): Promise<void> {
    this.assertActive('scheduleRuntimeUpdate')
    if (update.transport) {
      if (hostOwned) this.hostTransports.add(update.transport)
      else this.assertHostOwnedTransports(update, 'schedule_runtime_update')
    }
    const previous = snapshotAgentContext(this.session.runtimeContext)
    await this.run('invalid_argument', () => this.session.scheduleRuntimeUpdate(update))
    this.notify({
      type: 'runtime_update',
      previous,
      current: this.projectRuntimeUpdate(previous, update),
    })
  }

  private async updateRuntime(update: AgentRuntimeUpdate): Promise<void> {
    this.assertActive('updateRuntime')
    if (this.phase !== 'idle') {
      throw new AgentHarnessError('busy', `AgentHarness 正在执行 ${this.phase}`)
    }
    if (update.transport) this.hostTransports.add(update.transport)
    const previous = snapshotAgentContext(this.session.runtimeContext)
    try {
      await this.session.updateRuntime(update)
      this.notify({
        type: 'runtime_update',
        previous,
        current: snapshotAgentContext(this.session.runtimeContext),
      })
    } catch (error) {
      throw normalizeHarnessError(error, this.session.isRunning ? 'busy' : 'invalid_argument')
    }
  }

  async compact(options?: SummaryInstructionOptions): Promise<ContextCheckpoint> {
    await this.runInPhase('compaction', 'compaction', () => this.session.compact(options))
    const checkpoint = this.session.checkpoint
    if (!checkpoint) throw new AgentHarnessError('compaction', 'Compaction 未生成上下文检查点')
    return checkpoint
  }

  /** 原子替换 Runtime dependencies（skills reload 用），委托底层 AgentSession。 */
  async updateRuntimeDependencies(input: {
    previous: RuntimeDependenciesSnapshot
    current: RuntimeDependenciesSnapshot
  }): Promise<void> {
    this.assertActive('updateRuntimeDependencies')
    if (this.phase !== 'idle') {
      throw new AgentHarnessError('busy', `AgentHarness 正在执行 ${this.phase}`)
    }
    try {
      await this.session.updateRuntimeDependencies(input)
    } catch (error) {
      throw normalizeHarnessError(error, this.session.isRunning ? 'busy' : 'invalid_state')
    }
  }

  async summarizeBranch(
    options: Omit<GenerateBranchSummaryOptions, 'sessionId' | 'signal' | 'hooks'>,
    activeSignal?: AbortSignal,
  ): Promise<BranchSummarySource> {
    const summarize = async (signal: AbortSignal): Promise<BranchSummarySource> => generateBranchSummary({
      ...options,
      sessionId: this.id,
      signal,
      hooks: {
        beforeBranchSummary: async (context) => {
          let current: RuntimeHookResultMap['before_branch_summary']
          let summaryInstructions = context.summaryInstructions
          let replacement: { content: string } | undefined
          const event = runtimeHookEvent('before_branch_summary', context)
          this.notify(event)
          for (const result of await this.hookRegistry.dispatch(
            'before_branch_summary',
            event,
            this.callbackContext(event),
            (previous, result) => {
              summaryInstructions = {
                customInstructions: result.customInstructions
                  ?? summaryInstructions?.customInstructions,
                replaceInstructions: result.replaceInstructions
                  ?? summaryInstructions?.replaceInstructions,
              }
              replacement = result.replacement ?? replacement
              return { ...previous, summaryInstructions }
            },
            (result) => result.cancel === true,
          )) {
            if (!result) continue
            current = {
              cancel: result.cancel ?? current?.cancel,
              customInstructions: result.customInstructions
                ?? current?.customInstructions,
              replaceInstructions: result.replaceInstructions
                ?? current?.replaceInstructions,
              replacement: result.replacement ?? current?.replacement,
            }
            if (current.cancel) throw summaryHookCancelled('branch-summary')
          }
          return current
        },
        afterBranchSummary: async (context) => {
          const event = runtimeHookEvent('after_branch_summary', context)
          this.notify(event)
          await this.hookRegistry.dispatch('after_branch_summary', event, this.callbackContext(event))
        },
      },
    })
    if (activeSignal) {
      if (this.phase !== 'branch_summary') {
        throw new AgentHarnessError('invalid_state', 'Branch Summary Hook 必须在结构化操作内执行')
      }
      return summarize(activeSignal)
    }
    return this.runStructuralOperation('branch_summary', summarize)
  }

  getContextUsage(): ContextBudgetUsage {
    return this.session.getContextUsage()
  }

  async runStructuralOperation<T>(
    phase: AgentHarnessStructuralPhase,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.assertActive(`runStructuralOperation:${phase}`)
    const controller = new AbortController()
    const lease = this.operationCoordinator.begin(phase, () => {
      if (controller.signal.aborted) return false
      controller.abort(new DOMException(`AgentHarness ${phase} aborted`, 'AbortError'))
      return true
    })
    this.ownedOperationLease = lease
    try {
      return await operation(controller.signal)
    } catch (error) {
      throw normalizeHarnessError(error, phase === 'branch_summary' ? 'session' : 'invalid_state')
    } finally {
      this.operationCoordinator.finish(lease)
      if (this.ownedOperationLease === lease) this.ownedOperationLease = undefined
    }
  }

  requestAbort(): boolean {
    this.assertActive('requestAbort')
    return this.operationCoordinator.requestAbort()
  }

  async abortAndWait(): Promise<AgentAbortSettlement> {
    this.assertActive('abortAndWait')
    const phase = this.phase
    let settlement: AgentAbortSettlement
    if (phase === 'turn' || phase === 'compaction' || phase === 'retry') {
      settlement = await this.session.abort()
      await this.operationCoordinator.waitForIdle()
    } else {
      this.requestAbort()
      await this.operationCoordinator.waitForIdle()
      settlement = await this.session.abort()
    }
    this.emitQueueUpdate()
    this.notify({ type: 'abort', sessionId: this.id, settlement })
    return settlement
  }

  /** @deprecated Prefer requestAbort() in callbacks and abortAndWait() at external boundaries. */
  async abort(): Promise<AgentAbortSettlement> {
    return this.abortAndWait()
  }

  async waitForIdle(): Promise<void> {
    await this.operationCoordinator.waitForIdle()
    return this.run('session', () => this.session.waitForIdle())
  }

  reset(): void {
    this.assertActive('reset')
    try {
      if (this.phase !== 'idle') throw new AgentHarnessError('busy', `AgentHarness 正在执行 ${this.phase}`)
      this.session.reset()
      this.emitQueueUpdate()
    } catch (error) {
      throw normalizeHarnessError(error, this.session.isRunning ? 'busy' : 'invalid_state')
    }
  }

  addCleanup(cleanup: AgentHarnessCleanup): () => void {
    this.assertActive('addCleanup')
    this.cleanupHandlers.add(cleanup)
    return () => this.cleanupHandlers.delete(cleanup)
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.lifecycleState = 'disposing'
    this.hookRegistry.beginDispose()
    const disposeReason = new DOMException('AgentHarness 正在释放', 'AbortError')
    for (const task of this.deferredTasks) {
      task.cancel(disposeReason)
    }
    this.hookRegistry.abortActiveInvocations(disposeReason)
    this.disposePromise = (async () => {
      const cleanupErrors: unknown[] = []
      try {
        await this.settleForDispose()
      } catch (error) {
        cleanupErrors.push(error)
      }
      await Promise.allSettled([...this.deferredTasks].map((task) => task.promise))
      const handlers = [...this.cleanupHandlers].reverse()
      this.cleanupHandlers.clear()
      for (const cleanup of handlers) {
        try {
          await cleanup()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      this.hookRegistry.dispose()
      this.observers.clear()
      this.lifecycleObservers.clear()
      this.lifecycleState = 'disposed'
      if (cleanupErrors.length > 0) {
        throw new AgentHarnessError('session', 'AgentHarness dispose/cleanup 失败', {
          cause: cleanupErrors[0],
        })
      }
    })()
    return this.disposePromise
  }

  private notify(event: AgentHarnessEvent): void {
    try {
      this.observability?.observe(snapshotHarnessEvent(event))
    } catch {
      // Telemetry is a best-effort in-memory projection and never blocks Runtime settlement.
    }
    for (const observer of this.observers) {
      try {
        const result = observer(snapshotHarnessEvent(event), this.callbackContext(event))
        if (result) void result.catch(() => undefined)
      } catch {
        // Observers are best-effort projections; durable runtime listeners remain strict.
      }
    }
    if (event.type === 'agent_settled') {
      for (const observer of this.lifecycleObservers) {
        try {
          const result = observer(structuredClone(event))
          if (result) void result.catch(() => undefined)
        } catch {}
      }
    }
  }

  private emitQueueUpdate(): void {
    this.notify({ type: 'queue_update', queuedMessages: this.queuedMessages })
  }

  private projectRuntimeUpdate(context: AgentContext, update: AgentRuntimeUpdate): AgentContext {
    const tools = update.tools ? snapshotAgentTools(update.tools) : context.tools
    return snapshotAgentContext({
      ...context,
      systemPrompt: update.systemPrompt ?? context.systemPrompt,
      model: update.model ? structuredClone(update.model) : context.model,
      reasoning: update.reasoning === null
        ? undefined
        : update.reasoning ? structuredClone(update.reasoning) : context.reasoning,
      tools,
      activeToolNames: update.activeToolNames?.slice()
        ?? (update.tools ? tools.map((tool) => tool.name) : context.activeToolNames),
    })
  }

  private callbackContext(
    event: Pick<AgentHarnessEvent, 'type'>,
    signal = this.signal ?? new AbortController().signal,
  ): AgentHarnessCallbackContext {
    const phase = this.phase
    const settling = event.type === 'agent_end' || event.type === 'agent_settled'
    const allowedOperations: AgentHarnessCallbackOperation[] = this.lifecycleState !== 'active'
      ? []
      : isRuntimeHookType(event.type)
        ? [...HOOK_ALLOWED_OPERATIONS[event.type]]
        : phase === 'idle'
        ? ['next_turn', 'append_message', 'schedule_runtime_update', 'defer_until_idle']
        : phase === 'turn' || phase === 'retry'
          ? settling
            ? ['next_turn', 'defer_until_idle']
            : [
                'request_abort',
                'steer',
                'follow_up',
                'next_turn',
                'append_message',
                'schedule_runtime_update',
                'defer_until_idle',
              ]
          : ['request_abort', 'next_turn', 'defer_until_idle']
    const requireAllowed = <T>(
      operation: AgentHarnessCallbackOperation,
      callback: () => T,
    ): T => {
      if (!allowedOperations.includes(operation)) {
        throw new AgentHarnessError(
          'invalid_state',
          `回调 ${event.type} 在 ${phase} 阶段不能执行 ${operation}`,
        )
      }
      return callback()
    }
    return {
      phase,
      signal,
      allowedOperations: Object.freeze(allowedOperations.slice()),
      can: (operation) => allowedOperations.includes(operation),
      requestAbort: () => requireAllowed('request_abort', () => this.requestAbort()),
      // 回调上下文面向 hook handler，只暴露「是否被接受」这一位信息：拒绝原因（ack）是给
      // UI/store 的，扩到这里会改动已封存的 hook 契约。
      steer: (content, images) => requireAllowed('steer', async () =>
        (await this.steer(content, images)).accepted),
      followUp: (content, images) => requireAllowed('follow_up', async () =>
        (await this.followUp(content, images)).accepted),
      nextTurn: (content, images) => requireAllowed('next_turn', async () =>
        (await this.nextTurn(content, images)).accepted),
      appendMessage: (message) => requireAllowed('append_message', () => this.appendMessage(message)),
      scheduleRuntimeUpdate: (update) => requireAllowed(
        'schedule_runtime_update',
        () => {
          this.assertHostOwnedTransports(update, event.type)
          return this.scheduleRuntimeUpdate(update, false)
        },
      ),
      deferUntilIdle: (operation) => requireAllowed('defer_until_idle', () => {
        this.assertActive('deferUntilIdle')
        const controller = new AbortController()
        let settle!: (settlement: AgentHarnessDeferredTaskSettlement) => void
        let complete!: (settlement: AgentHarnessDeferredTaskSettlement) => void
        let settled = false
        let completed = false
        const settlement = new Promise<AgentHarnessDeferredTaskSettlement>((resolve) => {
          settle = (result) => {
            if (settled) return
            settled = true
            resolve(result)
          }
        })
        const completion = new Promise<AgentHarnessDeferredTaskSettlement>((resolve) => {
          complete = (result) => {
            if (completed) return
            completed = true
            resolve(result)
          }
        })
        const task: AgentHarnessDeferredTask = {
          state: 'pending',
          cancel: (reason) => {
            if (settled) return
            controller.abort(reason)
            if (task.state === 'pending') {
              const result: AgentHarnessDeferredTaskSettlement = {
                status: 'aborted',
                durationMs: 0,
                error: controller.signal.reason,
              }
              settle(result)
              complete(result)
            }
          },
          promise: Promise.resolve(),
        }
        task.promise = this.operationCoordinator.waitForIdle()
          .then(async () => {
            if (settled || this.lifecycleState !== 'active') {
              task.cancel(new DOMException('AgentHarness deferred task 已取消', 'AbortError'))
              return
            }
            task.state = 'running'
            const startedAt = Date.now()
            let timer: ReturnType<typeof setTimeout> | undefined
            let rejectAborted: (() => void) | undefined
            const timeout = new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                const error = new Error('AgentHarness deferred task 执行超时')
                error.name = 'AgentHarnessDeferredTaskTimeoutError'
                controller.abort(error)
                reject(error)
              }, AGENT_HARNESS_DEFERRED_TASK_TIMEOUT_MS)
            })
            const aborted = new Promise<never>((_resolve, reject) => {
              rejectAborted = () => reject(
                controller.signal.reason ?? new DOMException('Deferred task aborted', 'AbortError'),
              )
              if (controller.signal.aborted) rejectAborted()
              else controller.signal.addEventListener('abort', rejectAborted, { once: true })
            })
            const operationPromise = Promise.resolve().then(() => operation(controller.signal))
            void operationPromise.then(
              () => complete({
                status: 'completed',
                durationMs: Math.max(0, Date.now() - startedAt),
              }),
              (error: unknown) => complete({
                status: 'failed',
                durationMs: Math.max(0, Date.now() - startedAt),
                error,
              }),
            )
            try {
              await Promise.race([
                operationPromise,
                timeout,
                aborted,
              ])
              settle({ status: 'completed', durationMs: Math.max(0, Date.now() - startedAt) })
            } catch (error) {
              settle({
                status: error instanceof Error && error.name === 'AgentHarnessDeferredTaskTimeoutError'
                  ? 'timed_out'
                  : controller.signal.aborted ? 'aborted' : 'failed',
                durationMs: Math.max(0, Date.now() - startedAt),
                error,
              })
            } finally {
              if (timer) clearTimeout(timer)
              if (rejectAborted) controller.signal.removeEventListener('abort', rejectAborted)
            }
          })
          .catch((error) => {
            const result: AgentHarnessDeferredTaskSettlement = {
              status: 'failed',
              durationMs: 0,
              error,
            }
            settle(result)
            complete(result)
          })
          .finally(() => this.deferredTasks.delete(task))
        this.deferredTasks.add(task)
        return Object.freeze({ settlement, completion })
      }),
    }
  }

  private async runInPhase<T>(
    phase: Exclude<AgentHarnessPhase, 'idle' | 'branch_summary'>,
    code: AgentHarnessErrorCode,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertActive(`runInPhase:${phase}`)
    const lease = this.operationCoordinator.begin(phase, () => this.session.requestAbort())
    this.ownedOperationLease = lease
    try {
      return await this.run(code, operation)
    } finally {
      this.operationCoordinator.finish(lease)
      if (this.ownedOperationLease === lease) this.ownedOperationLease = undefined
    }
  }

  private rememberHostTransports(update: AgentLoopTurnUpdate): void {
    if (update.transport) this.hostTransports.add(update.transport)
    for (const nested of update.runtimeUpdates ?? []) this.rememberHostTransports(nested)
  }

  private assertHostOwnedTransports(
    update: Pick<AgentLoopTurnUpdate, 'transport' | 'runtimeUpdates'>,
    source: string,
  ): void {
    if (update.transport && !this.hostTransports.has(update.transport)) {
      throw new Error(`${source} 只能切换宿主拥有的 Transport`)
    }
    for (const nested of update.runtimeUpdates ?? []) {
      this.assertHostOwnedTransports(nested, source)
    }
  }

  private async run<T>(code: AgentHarnessErrorCode, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      throw normalizeHarnessError(error, code)
    }
  }

  private assertActive(operation: string): void {
    if (this.lifecycleState === 'active') return
    throw new AgentHarnessError(
      'invalid_state',
      `AgentHarness 已${this.lifecycleState === 'disposed' ? '释放' : '进入释放流程'}，不能执行 ${operation}`,
    )
  }

  private async settleForDispose(): Promise<void> {
    if (this.ownedOperationLease) {
      const phase = this.phase
      if (phase === 'turn' || phase === 'compaction' || phase === 'retry') {
        await this.session.abort()
      } else {
        this.operationCoordinator.requestAbort()
      }
      await this.operationCoordinator.waitForIdle()
    } else {
      await this.session.abort()
    }
    await this.session.waitForIdle()
  }
}
