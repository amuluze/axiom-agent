import { createId } from '@/agent/core/id'
import type { AgentEventSink, AgentMessage, ModelRequest, ModelTransport } from '@/agent/core/types'
import {
  buildContextProjection,
  evaluateContextBudget,
  postTurnCompactionReason,
} from './budget'
import { compactModelRequest } from './compaction'
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

export class ContextWindowManager {
  private checkpoint?: ContextCheckpoint
  private forcedReason?: CompactionReason
  private forcedExcludedMessageIds: string[] = []

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
    this.checkpoint = undefined
    this.forcedReason = undefined
    this.forcedExcludedMessageIds = []
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

    if (!forcedReason && !usage.needsCompaction) return request

    try {
      const compacted = await this.runCompaction(
        request,
        forcedReason ?? usage.reason ?? 'token_threshold',
        signal,
        excludedMessageIds,
        transport,
      )
      if (compacted) return compacted
      if (forcedReason === 'overflow') {
        throw new Error('Provider 上下文溢出后没有足够的完整消息组可供压缩')
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error
      if (
        usage.requestBytes > policy.hardRequestByteLimit
        || usage.estimatedTokens > policy.contextWindow
        || forcedReason === 'overflow'
      ) {
        throw error
      }
    }

    if (usage.requestBytes > policy.hardRequestByteLimit) {
      throw new Error('模型请求超过 Rust 2 MiB 硬上限，且当前上下文无法继续压缩')
    }
    if (usage.estimatedTokens > policy.contextWindow) {
      throw new Error('模型请求超过配置的上下文窗口，且当前上下文无法继续压缩')
    }
    return request
  }

  async compactManually(
    request: ModelRequest,
    signal: AbortSignal,
    transport: ModelTransport = this.options.transport,
    summaryInstructions?: SummaryInstructionOptions,
  ): Promise<ModelRequest> {
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

  /**
   * post-turn 空闲压缩（对齐 codex 的 post-turn compaction slot）：在回合结算后的
   * 空隙里按软水位（硬阈值的 85%/90%，见 budget.ts）提前压缩，让下一个请求不必
   * 为上一轮的历史膨胀同步买单。best-effort——没有可压缩空间或压缩失败时静默
   * 返回 false，硬阈值兜底仍在 prepareModelRequest；pending 的 overflow 恢复
   * 优先于空闲压缩，不在此消费 forced 状态。
   */
  async compactIfIdleDue(
    request: ModelRequest,
    signal: AbortSignal,
    transport: ModelTransport = this.options.transport,
  ): Promise<boolean> {
    if (this.forcedReason) return false
    const reason = postTurnCompactionReason(this.evaluate(request, transport), this.policyFor(request))
    if (!reason) return false
    try {
      const compacted = await this.runCompaction(request, reason, signal, [], transport)
      return Boolean(compacted)
    } catch {
      return false
    }
  }

  private async runCompaction(
    request: ModelRequest,
    reason: CompactionReason,
    signal: AbortSignal,
    excludedMessageIds: string[],
    transport: ModelTransport,
    summaryInstructions?: SummaryInstructionOptions,
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
        replacement: hookResult?.replacement,
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
