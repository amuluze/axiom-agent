import type { AgentMessage, TokenUsage } from '@/agent/core/types'

/** 千位以上缩写，保持 3 个有效位；预算面板、底栏环与悬浮层共用同一口径。 */
export const formatTokens = (tokens: number): string => tokens >= 1_000
  ? `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}K`
  : String(tokens)

/** 取最后一条携带 usage 的 assistant 消息用量（usage 随消息持久化并回放，只读投影即可）。 */
export const lastAssistantUsage = (messages: AgentMessage[]): TokenUsage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant' && message.usage) return message.usage
  }
  return undefined
}

/**
 * 缓存命中率（百分比）：缓存读 / 上报输入，不按 provider 归一化——`inputTokens` 语义在
 * Provider 间分叉（OpenAI 系含缓存命中、Anthropic 系不含），归一化只允许发生在展示层，
 * 且不得回写已持久化的 usage；代价是 Anthropic 系可能算出 >100%。
 * 契约见 `.specs/domain/usage-metrics.md`。字段未上报或上报输入为 0 时返回 undefined。
 */
export const cacheHitRate = (usage: TokenUsage): number | undefined => {
  if (!usage.cacheReadTokens || usage.inputTokens <= 0) return undefined
  return (usage.cacheReadTokens / usage.inputTokens) * 100
}

/** 命中率文案：超过 100% 如实标为超出，不截断成假值；不可得时用调用方给的占位。 */
export const formatHitRate = (rate: number | undefined, fallback: string): string => {
  if (rate === undefined) return fallback
  return rate > 100 ? '>100%' : `${rate.toFixed(1)}%`
}
