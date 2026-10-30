import { createId } from '@/agent/core/id'
import type { AgentEventSink, AgentMessage, ModelRequest, ModelTransport } from '@/agent/core/types'
import {
  buildContextProjection,
  evaluateContextBudget,
  postTurnCompactionReason,
} from './budget'
import {
  checkpointNarrative,
  compactModelRequest,
  CompactionProgressError,
  groupContextMessages,
  hashContextSummary,
  type CompactionReplacement,
} from './compaction'
import type { SummaryInstructionOptions } from './summaryInstructions'
import {
  summaryHookCancelled,
  type AfterCompactionHook,
  type BeforeCompactionHook,
  type BeforeCompactionHookContext,
} from '@/agent/runtime/summaryHooks'
import type {
  CompactionReason,
  ContextBudgetUsage,
  ContextCheckpoint,
  ContextPolicy,
} from './types'
import { createContextPolicy } from './types'
import { sanitizeContextMessages } from './sanitize'

interface ContextWindowManagerOptions {
  transport: ModelTransport
  policy: ContextPolicy
  checkpoint?: ContextCheckpoint | null
  emit: AgentEventSink
  beforeCompaction?: BeforeCompactionHook
  afterCompaction?: AfterCompactionHook
}

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError'

interface SpeculativeCompactionCandidate {
  replacement: CompactionReplacement
  prefixHash: string
}

interface SpeculativeCompactionTask {
  controller: AbortController
  checkpointId?: string
  modelProvider: string
  modelId: string
  transport: ModelTransport
  settled: boolean
  candidate?: SpeculativeCompactionCandidate
  promise: Promise<SpeculativeCompactionCandidate | undefined>
}

const compactionPrefix = (
  request: ModelRequest,
  throughMessageId: string,
): AgentMessage[] | undefined => {
  const groups = groupContextMessages(request.messages)
  const boundary = groups.findIndex(
    (group) => group.messages[group.messages.length - 1]?.id === throughMessageId,
  )
  if (boundary < 0) return undefined
  return groups.slice(0, boundary + 1).flatMap((group) => group.messages)
}

const compactionPrefixHash = async (
  request: ModelRequest,
  throughMessageId: string,
): Promise<string | undefined> => {
  const prefix = compactionPrefix(request, throughMessageId)
  return prefix ? hashContextSummary(JSON.stringify(prefix)) : undefined
}

export class ContextWindowManager {
  private checkpoint?: ContextCheckpoint
  private forcedReason?: CompactionReason
  private forcedExcludedMessageIds: string[] = []
  private speculativeTask?: SpeculativeCompactionTask

  constructor(private readonly options: ContextWindowManagerOptions) {
    this.checkpoint = options.checkpoint ?? undefined
  }

  get currentCheckpoint(): ContextCheckpoint | undefined {
    return this.checkpoint
  }

  buildProjection(history: AgentMessage[]): AgentMessage[] {
    return buildContextProjection(history, this.checkpoint)
  }

  private policyFor(request: ModelRequest): ContextPolicy {
    const contextWindow = request.model.contextWindow
    if (!contextWindow || contextWindow === this.options.policy.contextWindow) return this.options.policy
    return createContextPolicy(contextWindow, {
      reserveTokens: this.options.policy.reserveTokens,
      keepRecentTokens: this.options.policy.keepRecentTokens,
      requestByteThreshold: this.options.policy.requestByteThreshold,
    }, request.maxOutputTokens)
  }

  evaluate(
    request: ModelRequest,
    transport: ModelTransport = this.options.transport,
  ): ContextBudgetUsage {
    return evaluateContextBudget(
      request,
      transport,
      this.policyFor(request),
      this.checkpoint,
    )
  }

  requestOverflowRecovery(excludedMessageId: string): void {
    this.forcedReason = 'overflow'
    this.forcedExcludedMessageIds = [excludedMessageId]
  }

  reset(): void {
    this.clearSpeculativeTask(true)
    this.checkpoint = undefined
    this.forcedReason = undefined
    this.forcedExcludedMessageIds = []
  }

  get speculativeCompactionState(): 'idle' | 'running' | 'ready' {
    if (!this.speculativeTask) return 'idle'
    return this.speculativeTask.candidate ? 'ready' : 'running'
  }

  cancelSpeculativeCompaction(): Promise<void> {
    const task = this.speculativeTask
    this.clearSpeculativeTask(true)
    return task ? task.promise.then(() => undefined) : Promise.resolve()
  }

  private clearSpeculativeTask(abort: boolean): void {
    const task = this.speculativeTask
    this.speculativeTask = undefined
    if (abort && task && !task.settled) {
      task.controller.abort(new DOMException('Speculative compaction invalidated', 'AbortError'))
    }
  }

  private speculativeTaskMatches(
    task: SpeculativeCompactionTask,
    request: ModelRequest,
    transport: ModelTransport,
  ): boolean {
    return task.checkpointId === this.checkpoint?.id
      && task.modelProvider === request.model.provider
      && task.modelId === request.model.model
      && task.transport === transport
  }

  speculateIfIdleDue(
    request: ModelRequest,
    transport: ModelTransport = this.options.transport,
  ): Promise<boolean> {
    if (this.forcedReason) return Promise.resolve(false)
    const policy = this.policyFor(request)
    if (!postTurnCompactionReason(this.evaluate(request, transport), policy)) {
      return Promise.resolve(false)
    }
    const existing = this.speculativeTask
    if (existing && this.speculativeTaskMatches(existing, request, transport)) {
      if (!existing.settled || existing.candidate) {
        return existing.promise.then((candidate) => Boolean(candidate))
      }
    }
    this.clearSpeculativeTask(true)

    const controller = new AbortController()
    const snapshot = structuredClone(request)
    const task: SpeculativeCompactionTask = {
      controller,
      checkpointId: this.checkpoint?.id,
      modelProvider: request.model.provider,
      modelId: request.model.model,
      transport,
      settled: false,
      promise: Promise.resolve(undefined),
    }
    task.promise = compactModelRequest({
      request: snapshot,
      transport,
      policy,
      checkpoint: this.checkpoint ? structuredClone(this.checkpoint) : undefined,
      reason: 'manual',
      signal: controller.signal,
    }).then(async (result) => {
      if (!result || controller.signal.aborted) return undefined
      const summary = checkpointNarrative(result.checkpoint)
      if (!summary) return undefined
      const prefixHash = await compactionPrefixHash(snapshot, result.checkpoint.throughMessageId)
      if (!prefixHash || controller.signal.aborted) return undefined
      const candidate: SpeculativeCompactionCandidate = {
        replacement: {
          summary,
          throughMessageId: result.checkpoint.throughMessageId,
        },
        prefixHash,
      }
      task.candidate = candidate
      return candidate
    }).catch(() => undefined).finally(() => {
      task.settled = true
    })
    this.speculativeTask = task
    return task.promise.then((candidate) => Boolean(candidate))
  }

  private async takeSpeculativeReplacement(
    request: ModelRequest,
    reason: CompactionReason,
    excludedMessageIds: string[],
    signal: AbortSignal,
    transport: ModelTransport,
  ): Promise<CompactionReplacement | undefined> {
    const task = this.speculativeTask
    if (!task || !this.speculativeTaskMatches(task, request, transport)) {
      if (task) this.clearSpeculativeTask(true)
      return undefined
    }
    const abort = (): void => task.controller.abort(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    const candidate = await task.promise.finally(() => signal.removeEventListener('abort', abort))
    if (this.speculativeTask === task) this.clearSpeculativeTask(false)
    if (!candidate || signal.aborted) return undefined
    const prefixHash = await compactionPrefixHash(request, candidate.replacement.throughMessageId)
    if (prefixHash !== candidate.prefixHash) return undefined
    try {
      const preview = await compactModelRequest({
        request,
        transport,
        policy: this.policyFor(request),
        checkpoint: this.checkpoint,
        reason,
        signal,
        excludedMessageIds,
        replacement: candidate.replacement,
      })
      return preview ? candidate.replacement : undefined
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error
      return undefined
    }
  }

  prepareModelRequest = async (
    request: ModelRequest,
    signal: AbortSignal,
    transport: ModelTransport = this.options.transport,
  ): Promise<ModelRequest> => {
    const policy = this.policyFor(request)
    const usage = this.evaluate(request, transport)
    await this.options.emit({
      type: 'context_usage',
      usage,
      checkpointId: this.checkpoint?.id,
    })
    const forcedReason = this.forcedReason
    const excludedMessageIds = this.forcedExcludedMessageIds
    this.forcedReason = undefined
    this.forcedExcludedMessageIds = []

    if (!forcedReason && !usage.needsCompaction) {
      if (this.speculativeTask && !this.speculativeTask.settled) this.clearSpeculativeTask(true)
      return request
    }

    const reason = forcedReason ?? usage.reason ?? 'token_threshold'
    const speculativeReplacement = await this.takeSpeculativeReplacement(
      request,
      reason,
      excludedMessageIds,
      signal,
      transport,
    )
    if (speculativeReplacement) {
      const compacted = await this.runCompaction(
        request,
        reason,
        signal,
        excludedMessageIds,
        transport,
        undefined,
        speculativeReplacement,
      )
      if (compacted) return compacted
    }

    const rescuedRequest: ModelRequest = {
      ...request,
      messages: sanitizeContextMessages(request.messages, { aggressive: true }),
    }
    const rescuedUsage = evaluateContextBudget(
      rescuedRequest,
      transport,
      policy,
      this.checkpoint,
    )
    if (!forcedReason && !rescuedUsage.needsCompaction) {
      await this.options.emit({
        type: 'context_usage',
        usage: rescuedUsage,
        checkpointId: this.checkpoint?.id,
      })
      return rescuedRequest
    }

    try {
      const compacted = await this.runCompaction(
        rescuedRequest,
        forcedReason ?? rescuedUsage.reason ?? usage.reason ?? 'token_threshold',
        signal,
        excludedMessageIds,
        transport,
      )
      if (compacted) return compacted
      throw new CompactionProgressError(
        forcedReason === 'overflow'
          ? 'Provider 上下文溢出后没有足够的完整消息组可供压缩'
          : '上下文已超过压缩阈值，但没有足够的完整消息组可供压缩',
      )
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error
      if (error instanceof CompactionProgressError) throw error
      if (
        usage.requestBytes > policy.hardRequestByteLimit
        || usage.estimatedTokens > policy.contextWindow
        || forcedReason === 'overflow'
      ) {
        throw error
      }
    }

    if (rescuedUsage.requestBytes > policy.hardRequestByteLimit) {
      throw new Error('模型请求超过 Rust 2 MiB 硬上限，且当前上下文无法继续压缩')
    }
    if (rescuedUsage.estimatedTokens > policy.contextWindow) {
      throw new Error('模型请求超过配置的上下文窗口，且当前上下文无法继续压缩')
    }
    return rescuedRequest
  }

  async compactManually(
    request: ModelRequest,
    signal: AbortSignal,
    transport: ModelTransport = this.options.transport,
    summaryInstructions?: SummaryInstructionOptions,
  ): Promise<ModelRequest> {
    this.clearSpeculativeTask(true)
    const compacted = await this.runCompaction(
      request,
      'manual',
      signal,
      [],
      transport,
      summaryInstructions,
    )
    if (!compacted) throw new Error('当前会话没有足够的旧上下文可供压缩')
    return compacted
  }

  private async runCompaction(
    request: ModelRequest,
    reason: CompactionReason,
    signal: AbortSignal,
    excludedMessageIds: string[],
    transport: ModelTransport,
    summaryInstructions?: SummaryInstructionOptions,
    speculativeReplacement?: CompactionReplacement,
  ): Promise<ModelRequest | undefined> {
    const compactionId = createId('compaction')
    await this.options.emit({ type: 'compaction_start', compactionId, reason })
    try {
      const hookContext: BeforeCompactionHookContext = {
        request: structuredClone(request),
        reason,
        checkpoint: this.checkpoint ? structuredClone(this.checkpoint) : null,
        ...(summaryInstructions ? { summaryInstructions: { ...summaryInstructions } } : {}),
        signal,
      }
      const hookResult = await this.options.beforeCompaction?.(hookContext)
      if (hookResult?.cancel) throw summaryHookCancelled('compaction')
      const result = await compactModelRequest({
        request,
        transport,
        policy: this.policyFor(request),
        checkpoint: this.checkpoint,
        reason,
        signal,
        excludedMessageIds,
        summaryInstructions,
        replacement: hookResult?.replacement ?? speculativeReplacement,
      })
      if (!result) {
        await this.options.emit({
          type: 'compaction_end',
          compactionId,
          reason,
          aborted: false,
          errorMessage: '没有可压缩的完整消息组',
        })
        return undefined
      }

      await this.options.afterCompaction?.({
        ...hookContext,
        result: structuredClone(result),
        replaced: Boolean(hookResult?.replacement),
      })

      // Event listeners persist the checkpoint. Only switch the in-memory projection
      // after every listener has completed successfully.
      await this.options.emit({
        type: 'compaction_end',
        compactionId,
        reason,
        checkpoint: result.checkpoint,
        usage: result.usageAfter,
        aborted: false,
      })
      this.checkpoint = result.checkpoint
      this.clearSpeculativeTask(true)
      await this.options.emit({
        type: 'context_usage',
        usage: result.usageAfter,
        checkpointId: result.checkpoint.id,
      })
      return result.request
    } catch (error) {
      const aborted = signal.aborted
        || (error instanceof DOMException && error.name === 'AbortError')
        || (error instanceof Error && error.name === 'AbortError')
      await this.options.emit({
        type: 'compaction_end',
        compactionId,
        reason,
        aborted,
        errorMessage: aborted ? undefined : error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}
