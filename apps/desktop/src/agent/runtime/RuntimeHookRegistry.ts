import {
  snapshotAgentContext,
  snapshotAgentMessages,
  snapshotAgentTool,
  snapshotAgentTools,
  snapshotApprovalPresentation,
  snapshotAssistantMessage,
  snapshotModelRequest,
  snapshotToolCall,
  snapshotToolResult,
  snapshotToolResultMessage,
} from '@/agent/core/snapshots'
import type {
  AfterProviderResponseContext,
  AfterToolCallContext,
  AfterToolCallResult,
  BeforeAgentStartContext,
  BeforeAgentStartResult,
  BeforeProviderPayloadContext,
  BeforeProviderPayloadResult,
  BeforeProviderRequestContext,
  BeforeProviderRequestResult,
  BeforeToolCallContext,
  ContextHookContext,
  ContextHookResult,
} from '@/agent/core/types'
import type { AgentLoopTurnUpdate, AgentTurnSnapshot } from '@/agent/core/runAgentLoop'
import type {
  AfterBranchSummaryHookContext,
  AfterCompactionHookContext,
  BeforeBranchSummaryHookContext,
  BeforeBranchSummaryHookResult,
  BeforeCompactionHookContext,
  BeforeCompactionHookResult,
} from './summaryHooks'
import type {
  AgentHarnessCallbackContext,
  AgentHarnessDeferredTaskHandle,
  AgentHarnessDeferredTaskSettlement,
} from './AgentHarness'

export interface ToolCallHookEvent extends BeforeToolCallContext {
  type: 'tool_call'
}

export interface ToolResultHookEvent extends AfterToolCallContext {
  type: 'tool_result'
}

export interface BeforeCompactionHookEvent extends BeforeCompactionHookContext {
  type: 'before_compaction'
}

export interface AfterCompactionHookEvent extends AfterCompactionHookContext {
  type: 'after_compaction'
}

export interface BeforeBranchSummaryHookEvent extends BeforeBranchSummaryHookContext {
  type: 'before_branch_summary'
}

export interface AfterBranchSummaryHookEvent extends AfterBranchSummaryHookContext {
  type: 'after_branch_summary'
}

export interface BeforeProviderRequestHookEvent extends BeforeProviderRequestContext {
  type: 'before_provider_request'
}

export interface BeforeProviderPayloadHookEvent extends BeforeProviderPayloadContext {
  type: 'before_provider_payload'
}

export interface AfterProviderResponseHookEvent extends AfterProviderResponseContext {
  type: 'after_provider_response'
}

export interface BeforeAgentStartHookEvent extends BeforeAgentStartContext {
  type: 'before_agent_start'
}

export interface ContextHookEvent extends ContextHookContext {
  type: 'context'
}

export interface PrepareNextTurnHookEvent {
  type: 'prepare_next_turn'
  snapshot: AgentTurnSnapshot
  signal: AbortSignal
}

export interface RuntimeToolCallResult {
  block?: boolean
  reason?: string
}

export type RuntimeHookEvent =
  | BeforeAgentStartHookEvent
  | ContextHookEvent
  | ToolCallHookEvent
  | ToolResultHookEvent
  | BeforeProviderRequestHookEvent
  | BeforeProviderPayloadHookEvent
  | AfterProviderResponseHookEvent
  | PrepareNextTurnHookEvent
  | BeforeCompactionHookEvent
  | AfterCompactionHookEvent
  | BeforeBranchSummaryHookEvent
  | AfterBranchSummaryHookEvent

export interface RuntimeHookResultMap {
  before_agent_start: BeforeAgentStartResult | undefined
  context: ContextHookResult | undefined
  tool_call: RuntimeToolCallResult | undefined
  tool_result: AfterToolCallResult | undefined
  before_provider_request: BeforeProviderRequestResult | undefined
  before_provider_payload: BeforeProviderPayloadResult | undefined
  after_provider_response: undefined
  prepare_next_turn: AgentLoopTurnUpdate | undefined
  before_compaction: BeforeCompactionHookResult | undefined
  after_compaction: undefined
  before_branch_summary: BeforeBranchSummaryHookResult | undefined
  after_branch_summary: undefined
}

export type RuntimeHookType = keyof RuntimeHookResultMap
export type RuntimeHookEventFor<TType extends RuntimeHookType> = Extract<RuntimeHookEvent, { type: TType }>
export type RuntimeHookHandler<TType extends RuntimeHookType> = (
  event: RuntimeHookEventFor<TType>,
  context: AgentHarnessCallbackContext,
) => RuntimeHookResultMap[TType] | Promise<RuntimeHookResultMap[TType]>

export interface RuntimeHookRegistration {
  id: string
  version: string
  source: string
  priority?: number
  timeoutMs?: number
  enabled?: boolean
}

export interface RuntimeHookBundleDependency {
  id: string
  version: string
  fingerprint: string
}

export interface RuntimeHookDiagnostic {
  stage: 'invocation' | 'deferred' | 'deferred_late'
  scopeId: string
  hookType: RuntimeHookType
  id: string
  version: string
  source: string
  status: 'completed' | 'failed' | 'timed_out' | 'aborted'
  durationMs: number
  error?: string
}

export interface RuntimeHookDiagnosticSink {
  record(diagnostic: RuntimeHookDiagnostic): void | Promise<void>
}

export class RuntimeHookDiagnostics implements RuntimeHookDiagnosticSink {
  private readonly recentDiagnostics: RuntimeHookDiagnostic[] = []

  constructor(private readonly capacity = 100) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('Runtime Hook diagnostics capacity 无效')
    }
  }

  record(diagnostic: RuntimeHookDiagnostic): void {
    this.recentDiagnostics.push(structuredClone(diagnostic))
    if (this.recentDiagnostics.length > this.capacity) this.recentDiagnostics.shift()
  }

  snapshot(): RuntimeHookDiagnostic[] {
    return structuredClone(this.recentDiagnostics)
  }
}

interface RuntimeHookHandlerRecord<TType extends RuntimeHookType = RuntimeHookType> {
  sequence: number
  registration: Required<Omit<RuntimeHookRegistration, 'enabled'>>
  handler: RuntimeHookHandler<TType>
}

type RuntimeHookCancellationKind = 'parent' | 'timeout' | 'dispose'

interface ActiveRuntimeHookInvocation {
  cancel(kind: RuntimeHookCancellationKind, reason: unknown): void
}

interface BufferedRuntimeHookDeferredOperation {
  operation: (signal: AbortSignal) => void | Promise<void>
  transferred: boolean
  resolve: (settlement: AgentHarnessDeferredTaskSettlement) => void
  resolveCompletion: (settlement: AgentHarnessDeferredTaskSettlement) => void
  handle: AgentHarnessDeferredTaskHandle
}

const SAFE_HOOK_ERROR_NAMES = new Set([
  'AbortError',
  'AgentHarnessDeferredTaskTimeoutError',
  'AgentHarnessError',
  'Error',
  'RangeError',
  'RuntimeHookInvocationExpiredError',
  'RuntimeHookTimeoutError',
  'SyntaxError',
  'TypeError',
])

const hookErrorName = (error: unknown): string => {
  if (!(error instanceof Error)) return 'UnknownError'
  return SAFE_HOOK_ERROR_NAMES.has(error.name) ? error.name : 'Error'
}

export class RuntimeHookExecutionError extends Error {
  constructor(
    public readonly hookType: RuntimeHookType,
    public readonly hookId: string,
    public readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'RuntimeHookExecutionError'
  }
}

export const runtimeHookEvent = <TType extends RuntimeHookType>(
  type: TType,
  event: Omit<RuntimeHookEventFor<TType>, 'type'>,
): RuntimeHookEventFor<TType> => ({ type, ...event }) as RuntimeHookEventFor<TType>

export const snapshotRuntimeHookEvent = (event: RuntimeHookEvent): RuntimeHookEvent => {
  switch (event.type) {
    case 'before_agent_start':
      return { ...event, prompts: structuredClone(event.prompts), context: snapshotAgentContext(event.context) }
    case 'context':
      return { ...event, messages: structuredClone(event.messages), context: snapshotAgentContext(event.context) }
    case 'tool_call':
      return {
        ...event,
        assistantMessage: snapshotAssistantMessage(event.assistantMessage),
        toolCall: snapshotToolCall(event.toolCall),
        input: structuredClone(event.input),
        context: snapshotAgentContext(event.context),
        presentation: snapshotApprovalPresentation(event.presentation),
      }
    case 'tool_result':
      return {
        ...event,
        assistantMessage: snapshotAssistantMessage(event.assistantMessage),
        toolCall: snapshotToolCall(event.toolCall),
        tool: snapshotAgentTool(event.tool),
        input: structuredClone(event.input),
        result: snapshotToolResult(event.result),
        context: snapshotAgentContext(event.context),
      }
    case 'before_compaction':
      return {
        ...event,
        request: snapshotModelRequest(event.request),
        checkpoint: event.checkpoint ? structuredClone(event.checkpoint) : null,
        summaryInstructions: event.summaryInstructions ? structuredClone(event.summaryInstructions) : undefined,
      }
    case 'after_compaction':
      return {
        ...event,
        request: snapshotModelRequest(event.request),
        checkpoint: event.checkpoint ? structuredClone(event.checkpoint) : null,
        summaryInstructions: event.summaryInstructions ? structuredClone(event.summaryInstructions) : undefined,
        result: structuredClone(event.result),
      }
    case 'before_branch_summary':
      return {
        ...event,
        messages: structuredClone(event.messages),
        model: structuredClone(event.model),
        summaryInstructions: event.summaryInstructions ? structuredClone(event.summaryInstructions) : undefined,
      }
    case 'after_branch_summary':
      return {
        ...event,
        messages: structuredClone(event.messages),
        model: structuredClone(event.model),
        summaryInstructions: event.summaryInstructions ? structuredClone(event.summaryInstructions) : undefined,
        result: structuredClone(event.result),
      }
    case 'prepare_next_turn':
      return {
        ...event,
        snapshot: {
          ...event.snapshot,
          message: snapshotAssistantMessage(event.snapshot.message),
          toolResults: event.snapshot.toolResults.map(snapshotToolResultMessage),
          context: snapshotAgentContext(event.snapshot.context),
          newMessages: snapshotAgentMessages(event.snapshot.newMessages),
          messages: snapshotAgentMessages(event.snapshot.messages),
        },
      }
    case 'before_provider_request':
    case 'after_provider_response':
      return { ...event, model: structuredClone(event.model) }
    case 'before_provider_payload':
      return { ...event, model: structuredClone(event.model), payload: structuredClone(event.payload) }
  }
}

const snapshotTurnUpdate = (update: AgentLoopTurnUpdate): AgentLoopTurnUpdate => ({
  ...update,
  context: update.context ? snapshotAgentContext(update.context) : undefined,
  model: update.model ? structuredClone(update.model) : undefined,
  reasoning: update.reasoning ? structuredClone(update.reasoning) : update.reasoning,
  tools: update.tools ? snapshotAgentTools(update.tools) : undefined,
  activeToolNames: update.activeToolNames?.slice(),
  transport: update.transport,
  appendMessages: update.appendMessages ? snapshotAgentMessages(update.appendMessages) : undefined,
  runtimeUpdates: update.runtimeUpdates?.map(snapshotTurnUpdate),
})

const snapshotRuntimeHookResult = <TType extends RuntimeHookType>(
  type: TType,
  result: Exclude<RuntimeHookResultMap[TType], undefined>,
): Exclude<RuntimeHookResultMap[TType], undefined> => (
  type === 'prepare_next_turn'
    ? snapshotTurnUpdate(result as AgentLoopTurnUpdate)
    : structuredClone(result)
) as Exclude<RuntimeHookResultMap[TType], undefined>

const snapshotRuntimeHookInvocationEvent = <TType extends RuntimeHookType>(
  event: RuntimeHookEventFor<TType>,
  signal: AbortSignal,
): RuntimeHookEventFor<TType> => snapshotRuntimeHookEvent({
  ...event,
  signal,
} as RuntimeHookEvent) as RuntimeHookEventFor<TType>

export class RuntimeHookRegistry {
  private readonly handlers = new Map<RuntimeHookType, RuntimeHookHandlerRecord<any>[]>()
  private readonly recentDiagnostics: RuntimeHookDiagnostic[] = []
  private readonly activeInvocations = new Set<ActiveRuntimeHookInvocation>()
  private sequence = 0
  private lifecycle: 'open' | 'sealed' | 'disposing' | 'disposed' = 'open'
  private sealedDependencies?: RuntimeHookBundleDependency[]

  constructor(
    private readonly diagnosticSink?: RuntimeHookDiagnosticSink,
    private readonly diagnosticScopeId = 'standalone',
  ) {}

  register<TType extends RuntimeHookType>(
    type: TType,
    handler: RuntimeHookHandler<TType>,
    registration: RuntimeHookRegistration,
  ): () => void {
    if (this.lifecycle !== 'open') {
      throw new Error(`RuntimeHookRegistry 已${this.lifecycle === 'sealed' ? '封存' : '失效'}`)
    }
    const normalized = this.normalizeRegistration(registration)
    if (registration.enabled === false) return () => undefined
    for (const records of this.handlers.values()) {
      const conflict = records.find((record) => record.registration.id === normalized.id)
      if (conflict && (
        conflict.registration.version !== normalized.version
        || conflict.registration.source !== normalized.source
        || conflict.registration.priority !== normalized.priority
        || conflict.registration.timeoutMs !== normalized.timeoutMs
      )) {
        throw new Error(`Runtime Hook bundle identity 冲突：${normalized.id}`)
      }
    }
    const handlers = this.handlers.get(type) ?? []
    const record: RuntimeHookHandlerRecord<TType> = {
      sequence: this.sequence,
      registration: normalized,
      handler,
    }
    this.sequence += 1
    handlers.push(record)
    handlers.sort((left, right) => (
      right.registration.priority - left.registration.priority || left.sequence - right.sequence
    ))
    this.handlers.set(type, handlers)
    let registered = true
    return () => {
      if (!registered) return
      if (this.lifecycle === 'sealed') throw new Error('RuntimeHookRegistry 已封存')
      registered = false
      const index = handlers.indexOf(record)
      if (index >= 0) handlers.splice(index, 1)
    }
  }

  dependencies(): RuntimeHookBundleDependency[] {
    if (!this.sealedDependencies) throw new Error('RuntimeHookRegistry 尚未封存')
    return structuredClone(this.sealedDependencies)
  }

  seal(): RuntimeHookBundleDependency[] {
    if (this.lifecycle === 'sealed') return this.dependencies()
    if (this.lifecycle !== 'open') throw new Error('RuntimeHookRegistry 已失效')
    this.sealedDependencies = this.collectDependencies()
    this.lifecycle = 'sealed'
    return this.dependencies()
  }

  private collectDependencies(): RuntimeHookBundleDependency[] {
    const dependencies = new Map<string, {
      registration: Required<Omit<RuntimeHookRegistration, 'enabled'>>
      hookCounts: Map<RuntimeHookType, number>
    }>()
    for (const [hookType, records] of this.handlers) {
      for (const record of records) {
        const dependency = dependencies.get(record.registration.id) ?? {
          registration: record.registration,
          hookCounts: new Map<RuntimeHookType, number>(),
        }
        dependency.hookCounts.set(hookType, (dependency.hookCounts.get(hookType) ?? 0) + 1)
        dependencies.set(record.registration.id, dependency)
      }
    }
    return [...dependencies].map(([id, dependency]) => ({
      id,
      version: dependency.registration.version,
      fingerprint: JSON.stringify({
        schemaVersion: 1,
        source: dependency.registration.source,
        priority: dependency.registration.priority,
        timeoutMs: dependency.registration.timeoutMs,
        hooks: [...dependency.hookCounts]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([type, count]) => ({ type, count })),
      }),
    }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  diagnostics(): RuntimeHookDiagnostic[] {
    return structuredClone(this.recentDiagnostics)
  }

  async dispatch<TType extends RuntimeHookType>(
    type: TType,
    event: RuntimeHookEventFor<TType>,
    context: AgentHarnessCallbackContext,
    advance?: (
      event: RuntimeHookEventFor<TType>,
      result: Exclude<RuntimeHookResultMap[TType], undefined>,
    ) => RuntimeHookEventFor<TType>,
    stop?: (result: Exclude<RuntimeHookResultMap[TType], undefined>) => boolean,
    validate?: (result: Exclude<RuntimeHookResultMap[TType], undefined>) => void,
  ): Promise<RuntimeHookResultMap[TType][]> {
    if (this.lifecycle === 'disposing' || this.lifecycle === 'disposed') {
      throw new Error('RuntimeHookRegistry 已失效')
    }
    const handlers = [...(this.handlers.get(type) ?? [])] as RuntimeHookHandlerRecord<TType>[]
    const results: RuntimeHookResultMap[TType][] = []
    let currentEvent = event
    for (const record of handlers) {
      const startedAt = Date.now()
      const controller = new AbortController()
      const deferredOperations: BufferedRuntimeHookDeferredOperation[] = []
      let invocationActive = true
      let cancellationKind: RuntimeHookCancellationKind | undefined
      const revokeInvocation = (kind: RuntimeHookCancellationKind, reason: unknown): void => {
        if (!invocationActive) return
        invocationActive = false
        cancellationKind = kind
        controller.abort(reason)
      }
      const activeInvocation: ActiveRuntimeHookInvocation = {
        cancel: revokeInvocation,
      }
      const abortFromParent = (): void => revokeInvocation('parent', context.signal.reason)
      this.activeInvocations.add(activeInvocation)
      if (context.signal.aborted) abortFromParent()
      else context.signal.addEventListener('abort', abortFromParent, { once: true })
      const invocationContext = this.createInvocationContext(
        context,
        controller.signal,
        () => invocationActive,
        record.registration.id,
        deferredOperations,
      )
      try {
        const result = await this.withTimeout(
          Promise.resolve().then(() => {
            if (controller.signal.aborted) throw this.abortReason(controller.signal)
            return record.handler(
              snapshotRuntimeHookInvocationEvent(currentEvent, controller.signal),
              invocationContext,
            )
          }),
          record.registration.timeoutMs,
          record.registration.id,
          (reason) => revokeInvocation('timeout', reason),
          controller.signal,
        )
        const snapshot = result === undefined
          ? undefined
          : snapshotRuntimeHookResult(type, result as Exclude<RuntimeHookResultMap[TType], undefined>)
        if (snapshot !== undefined) {
          validate?.(snapshot as Exclude<RuntimeHookResultMap[TType], undefined>)
        }
        for (const operation of deferredOperations) {
          const deferred = context.deferUntilIdle(operation.operation)
          operation.transferred = true
          void deferred.settlement.then((settlement) => {
            operation.resolve(settlement)
            this.recordDiagnostic(
              record,
              type,
              settlement.status,
              Date.now(),
              settlement.error,
              'deferred',
              settlement.durationMs,
            )
          })
          void Promise.all([deferred.settlement, deferred.completion]).then(([
            settlement,
            completion,
          ]) => {
            operation.resolveCompletion(completion)
            if ((settlement.status === 'timed_out' || settlement.status === 'aborted')
              && (completion.status === 'completed' || completion.status === 'failed')) {
              this.recordDiagnostic(
                record,
                type,
                completion.status,
                Date.now(),
                completion.error,
                'deferred_late',
                completion.durationMs,
              )
            }
          })
        }
        results.push(snapshot)
        if (snapshot !== undefined && advance) {
          currentEvent = advance(
            currentEvent,
            snapshot as Exclude<RuntimeHookResultMap[TType], undefined>,
          )
        }
        const shouldStop = snapshot !== undefined
          && stop?.(snapshot as Exclude<RuntimeHookResultMap[TType], undefined>) === true
        this.recordDiagnostic(record, type, 'completed', startedAt)
        if (shouldStop) break
      } catch (error) {
        const status = cancellationKind === 'timeout'
          ? 'timed_out'
          : cancellationKind === 'parent' || cancellationKind === 'dispose'
            ? 'aborted'
            : 'failed'
        this.recordDiagnostic(record, type, status, startedAt, error)
        if (status === 'aborted') break
        throw new RuntimeHookExecutionError(type, record.registration.id, error)
      } finally {
        for (const operation of deferredOperations) {
          if (!operation.transferred) {
            operation.resolve({
              status: 'aborted',
              durationMs: 0,
              error: new DOMException('Runtime Hook deferred work 未提交', 'AbortError'),
            })
            operation.resolveCompletion({
              status: 'aborted',
              durationMs: 0,
              error: new DOMException('Runtime Hook deferred work 未提交', 'AbortError'),
            })
          }
        }
        context.signal.removeEventListener('abort', abortFromParent)
        this.activeInvocations.delete(activeInvocation)
        if (invocationActive) {
          invocationActive = false
          controller.abort(new DOMException(
            `Runtime Hook invocation 已结束：${record.registration.id}`,
            'AbortError',
          ))
        }
      }
    }
    return results
  }

  dispose(): void {
    if (this.lifecycle === 'disposed') return
    this.lifecycle = 'disposed'
    this.abortActiveInvocations(new DOMException('RuntimeHookRegistry 已释放', 'AbortError'))
    this.handlers.clear()
  }

  beginDispose(): void {
    if (this.lifecycle === 'disposed' || this.lifecycle === 'disposing') return
    this.lifecycle = 'disposing'
  }

  abortActiveInvocations(reason: unknown): void {
    for (const invocation of this.activeInvocations) invocation.cancel('dispose', reason)
  }

  private normalizeRegistration(
    registration: RuntimeHookRegistration,
  ): Required<Omit<RuntimeHookRegistration, 'enabled'>> {
    const id = registration.id.trim()
    const version = registration.version.trim()
    const source = registration.source.trim()
    const priority = registration.priority ?? 0
    const timeoutMs = registration.timeoutMs ?? 10_000
    if (!id || !version || !source) throw new Error('Runtime Hook identity 无效')
    if (!Number.isSafeInteger(priority) || priority < -1_000 || priority > 1_000) {
      throw new Error('Runtime Hook priority 无效')
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new Error('Runtime Hook timeout 无效')
    }
    return { id, version, source, priority, timeoutMs }
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    hookId: string,
    onTimeout: (reason: Error) => void,
    signal: AbortSignal,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectAborted: (() => void) | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Runtime Hook 执行超时：${hookId}`)
        error.name = 'RuntimeHookTimeoutError'
        onTimeout(error)
        reject(error)
      }, timeoutMs)
    })
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = (): void => reject(this.abortReason(signal))
      if (signal.aborted) rejectAborted()
      else signal.addEventListener('abort', rejectAborted, { once: true })
    })
    try {
      return await Promise.race([operation, timeout, aborted])
    } finally {
      if (timer) clearTimeout(timer)
      if (rejectAborted) signal.removeEventListener('abort', rejectAborted)
    }
  }

  private createInvocationContext(
    context: AgentHarnessCallbackContext,
    signal: AbortSignal,
    isActive: () => boolean,
    hookId: string,
    deferredOperations: BufferedRuntimeHookDeferredOperation[],
  ): AgentHarnessCallbackContext {
    const requireActive = <T>(operation: () => T): T => {
      if (!isActive() || signal.aborted) {
        const error = new Error(`Runtime Hook invocation 已失效：${hookId}`)
        error.name = 'RuntimeHookInvocationExpiredError'
        throw error
      }
      return operation()
    }
    return {
      phase: context.phase,
      signal,
      allowedOperations: context.allowedOperations,
      can: (operation) => isActive() && !signal.aborted && context.can(operation),
      requestAbort: () => requireActive(context.requestAbort),
      steer: (content, images) => requireActive(() => context.steer(content, images)),
      followUp: (content, images) => requireActive(() => context.followUp(content, images)),
      nextTurn: (content, images) => requireActive(() => context.nextTurn(content, images)),
      appendMessage: (message) => requireActive(() => context.appendMessage(message)),
      scheduleRuntimeUpdate: (update) => requireActive(() => context.scheduleRuntimeUpdate(update)),
      deferUntilIdle: (operation) => requireActive(() => {
        if (!context.can('defer_until_idle')) return context.deferUntilIdle(operation)
        let resolve!: (settlement: AgentHarnessDeferredTaskSettlement) => void
        let resolveCompletion!: (settlement: AgentHarnessDeferredTaskSettlement) => void
        const handle = Object.freeze({
          settlement: new Promise<AgentHarnessDeferredTaskSettlement>((settle) => {
            resolve = settle
          }),
          completion: new Promise<AgentHarnessDeferredTaskSettlement>((settle) => {
            resolveCompletion = settle
          }),
        })
        deferredOperations.push({
          operation,
          transferred: false,
          resolve,
          resolveCompletion,
          handle,
        })
        return handle
      }),
    }
  }

  private abortReason(signal: AbortSignal): Error {
    if (signal.reason instanceof Error) return signal.reason
    return new DOMException('Runtime Hook invocation 已取消', 'AbortError')
  }

  private recordDiagnostic(
    record: RuntimeHookHandlerRecord<any>,
    hookType: RuntimeHookType,
    status: RuntimeHookDiagnostic['status'],
    startedAt: number,
    error?: unknown,
    stage: RuntimeHookDiagnostic['stage'] = 'invocation',
    durationMs?: number,
  ): void {
    const diagnostic: RuntimeHookDiagnostic = {
      stage,
      scopeId: this.diagnosticScopeId,
      hookType,
      id: record.registration.id,
      version: record.registration.version,
      source: record.registration.source,
      status,
      durationMs: durationMs ?? Math.max(0, Date.now() - startedAt),
      ...(error === undefined ? {} : { error: hookErrorName(error) }),
    }
    this.recentDiagnostics.push(structuredClone(diagnostic))
    if (this.recentDiagnostics.length > 100) this.recentDiagnostics.shift()
    try {
      const result = this.diagnosticSink?.record(structuredClone(diagnostic))
      if (result) void result.catch(() => undefined)
    } catch {
      return
    }
  }
}
