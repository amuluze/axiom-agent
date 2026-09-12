import type { ContextBudgetUsage, ContextCheckpoint, ContextPolicy } from './types'
import type {
  AgentMessage,
  AssistantMessage,
  ModelRequest,
  ModelTransport,
  UserMessage,
} from '@/agent/core/types'
import { canBranchThrough } from '@/agent/session/branch'
import { hasMeaningfulAssistantContent } from '@/agent/core/messages'
import { createContextLedgerMessage, isContextLedgerMessage } from './ledger'
import { createRecoveryPreambleMessage, isRecoveryPreambleMessage } from './recoveryPreamble'

const encoder = new TextEncoder()
const SUMMARY_MESSAGE_PREFIX = 'context-summary:'

export const utf8ByteLength = (value: string): number => encoder.encode(value).byteLength

export const estimateMessageTokens = (message: AgentMessage): number =>
  Math.max(1, Math.ceil(utf8ByteLength(JSON.stringify(message)) / 3))

const lastReliableUsage = (
  messages: AgentMessage[],
  checkpoint?: ContextCheckpoint,
): { index: number; tokens: number } | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant' || !message.usage || message.stopReason === 'error' || message.stopReason === 'aborted') {
      continue
    }
    if (checkpoint && message.createdAt <= checkpoint.createdAt) continue
    const tokens = message.usage.totalTokens || message.usage.inputTokens + message.usage.outputTokens
    if (tokens > 0) return { index, tokens }
  }
  return undefined
}

export const estimateContextTokens = (
  request: ModelRequest,
  requestBytes: number,
  checkpoint?: ContextCheckpoint,
): number => {
  const serializedEstimate = Math.max(1, Math.ceil(requestBytes / 3))
  const usage = lastReliableUsage(request.messages, checkpoint)
  if (!usage) return serializedEstimate
  const trailing = request.messages
    .slice(usage.index + 1)
    .reduce((total, message) => total + estimateMessageTokens(message), 0)
  return Math.max(serializedEstimate, usage.tokens + trailing)
}

export const modelRequestByteLength = (
  request: ModelRequest,
  transport: ModelTransport,
): number => transport.requestByteLength?.(request) ?? utf8ByteLength(JSON.stringify(request))

export const evaluateContextBudget = (
  request: ModelRequest,
  transport: ModelTransport,
  policy: ContextPolicy,
  checkpoint?: ContextCheckpoint,
): ContextBudgetUsage => {
  const requestBytes = modelRequestByteLength(request, transport)
  const estimatedTokens = estimateContextTokens(request, requestBytes, checkpoint)
  const tokenThreshold = Math.max(1, policy.contextWindow - policy.reserveTokens)
  const tokenExceeded = estimatedTokens > tokenThreshold
  const byteExceeded = requestBytes > policy.requestByteThreshold
  return {
    estimatedTokens,
    contextWindow: policy.contextWindow,
    tokenThreshold,
    requestBytes,
    requestByteThreshold: policy.requestByteThreshold,
    hardRequestByteLimit: policy.hardRequestByteLimit,
    tokenPercent: (estimatedTokens / policy.contextWindow) * 100,
    bytePercent: (requestBytes / policy.hardRequestByteLimit) * 100,
    needsCompaction: tokenExceeded || byteExceeded,
    reason: byteExceeded ? 'byte_threshold' : tokenExceeded ? 'token_threshold' : undefined,
  }
}

export const createContextSummaryMessage = (checkpoint: ContextCheckpoint): UserMessage => ({
  id: `${SUMMARY_MESSAGE_PREFIX}${checkpoint.id}`,
  role: 'user',
  content: `此前对话已压缩为以下可审计上下文检查点：\n\n<context-summary>\n${checkpoint.summary}\n</context-summary>`,
  createdAt: checkpoint.createdAt,
})

export const isContextSummaryMessage = (message: AgentMessage): boolean =>
  message.id.startsWith(SUMMARY_MESSAGE_PREFIX)

/** 投影级注入消息（摘要 / 工作账本 / 恢复前导语）。压缩分组与摘要输入应排除它们。 */
export const isContextProjectionMessage = (message: AgentMessage): boolean =>
  isContextSummaryMessage(message) || isContextLedgerMessage(message) || isRecoveryPreambleMessage(message)

export const buildContextProjection = (
  history: AgentMessage[],
  checkpoint?: ContextCheckpoint | null,
): AgentMessage[] => {
  const includedInModelContext = (message: AgentMessage): boolean => {
    if (message.role !== 'assistant') return true
    if (message.excludeFromModelContext === true) return false
    // 早期版本落盘的旧"成功/截断终态"空 assistant 消息（未标记 excludeFromModelContext，
    // 如 message_start 后直接 message_stop 的空流、仅含 thinking 块的空响应）同样不得
    // 进入模型上下文：Anthropic-compatible 会对 { role:'assistant', content:[] } 返回 400。
    // error/aborted 终态的空消息由 streamAssistantMessage 负责标记 exclude，
    // 且 continue()/runtimeContext 依赖它们留在投影中做边界判断，此处不重复过滤。
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return true
    return hasMeaningfulAssistantContent(message)
  }
  let recent: AgentMessage[]
  let summary: UserMessage | undefined
  if (!checkpoint) {
    recent = history.filter(includedInModelContext)
  } else {
    const boundaryIndex = history.findIndex((message) => message.id === checkpoint.throughMessageId)
    if (boundaryIndex < 0) throw new Error('上下文检查点边界消息不存在于恢复历史')
    if (!canBranchThrough(history, checkpoint.throughMessageId)) {
      throw new Error('上下文检查点恢复边界会拆分 ToolCall/ToolResult 消息组')
    }
    const excluded = new Set(checkpoint.excludedMessageIds)
    const historyIds = new Set(history.map((message) => message.id))
    if (checkpoint.excludedMessageIds.some((messageId) => !historyIds.has(messageId))) {
      throw new Error('上下文检查点排除消息不存在于恢复历史')
    }
    recent = history
      .slice(boundaryIndex + 1)
      .filter((message) => !excluded.has(message.id) && includedInModelContext(message))
    summary = createContextSummaryMessage(checkpoint)
  }
  const preamble = createRecoveryPreambleMessage(history, checkpoint ?? null)
  const ledger = checkpoint ? createContextLedgerMessage(checkpoint) : undefined
  // 顺序：恢复前导语 → 上下文摘要 → 确定性工作账本 → 未排除的最近原始消息。
  return [preamble, summary, ledger, ...recent].filter((message): message is AgentMessage => Boolean(message))
}

export const isOverflowAssistant = (message: AgentMessage | undefined): message is AssistantMessage => {
  if (message?.role !== 'assistant' || message.stopReason !== 'error' || !message.errorMessage) return false
  if (message.providerError?.kind === 'context_overflow') return true
  return [
    /context window exceeds limit/iu,
    /context[_ ]length[_ ]exceeded/iu,
    /exceeds the context window/iu,
    /maximum context length/iu,
    /prompt is too long/iu,
    /request_too_large/iu,
    /too many tokens/iu,
    /token limit exceeded/iu,
  ].some((pattern) => pattern.test(message.errorMessage ?? ''))
}
