import { DEFAULT_AGENT_LIMITS } from '@/agent/core/types'

/**
 * 用户可配置的运行时预算子集。
 *
 * 暴露 {@link AgentLimits} 中与任务规模/成本直接相关的三项(轮次/工具调用/token
 * 预算),其余限制(maxDurationMs/maxMessageBytes/maxInlineToolResultBytes)是
 * 安全或工程硬约束,仍回落 {@link DEFAULT_AGENT_LIMITS}。
 */
export interface AgentLimitsSettings {
  maxTurns: number
  maxToolCalls: number
  /** 单次 run 的计费 token 软预算（output + 非缓存 input），触发阈值提醒，不硬停。 */
  maxTotalTokens: number
}

export const DEFAULT_AGENT_LIMITS_SETTINGS: AgentLimitsSettings = {
  maxTurns: DEFAULT_AGENT_LIMITS.maxTurns,
  maxToolCalls: DEFAULT_AGENT_LIMITS.maxToolCalls,
  // DEFAULT_AGENT_LIMITS.maxTotalTokens 类型上是可选的；当前默认恒有值，`??` 仅兜底。
  maxTotalTokens: DEFAULT_AGENT_LIMITS.maxTotalTokens ?? 2_000_000,
}

export const MAX_TURNS_LIMIT = 128
export const MAX_TOOL_CALLS_LIMIT = 512
export const MIN_TOTAL_TOKENS_LIMIT = 10_000
export const MAX_TOTAL_TOKENS_LIMIT = 64_000_000

const boundedInteger = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const normalized = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(maximum, Math.max(minimum, normalized))
}

export const normalizeAgentLimitsSettings = (value: unknown): AgentLimitsSettings => {
  const candidate = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    maxTurns: boundedInteger(
      candidate.maxTurns,
      DEFAULT_AGENT_LIMITS_SETTINGS.maxTurns,
      1,
      MAX_TURNS_LIMIT,
    ),
    maxToolCalls: boundedInteger(
      candidate.maxToolCalls,
      DEFAULT_AGENT_LIMITS_SETTINGS.maxToolCalls,
      1,
      MAX_TOOL_CALLS_LIMIT,
    ),
    maxTotalTokens: boundedInteger(
      candidate.maxTotalTokens,
      DEFAULT_AGENT_LIMITS_SETTINGS.maxTotalTokens,
      MIN_TOTAL_TOKENS_LIMIT,
      MAX_TOTAL_TOKENS_LIMIT,
    ),
  }
}

export const resolveAgentLimitsSettings = (storedValue: string | null): AgentLimitsSettings => {
  if (!storedValue) return normalizeAgentLimitsSettings(DEFAULT_AGENT_LIMITS_SETTINGS)
  try {
    return normalizeAgentLimitsSettings(JSON.parse(storedValue))
  } catch {
    return normalizeAgentLimitsSettings(DEFAULT_AGENT_LIMITS_SETTINGS)
  }
}
