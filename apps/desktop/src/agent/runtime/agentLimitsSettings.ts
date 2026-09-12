import { DEFAULT_AGENT_LIMITS } from '@/agent/core/types'

/**
 * 用户可配置的运行时预算子集。
 *
 * 只暴露 {@link AgentLimits} 中与任务规模直接相关的两项(轮次/工具调用),
 * 其余限制(maxDurationMs/maxMessageBytes/maxInlineToolResultBytes)是安全或
 * 工程硬约束,仍回落 {@link DEFAULT_AGENT_LIMITS}。
 */
export interface AgentLimitsSettings {
  maxTurns: number
  maxToolCalls: number
}

export const DEFAULT_AGENT_LIMITS_SETTINGS: AgentLimitsSettings = {
  maxTurns: DEFAULT_AGENT_LIMITS.maxTurns,
  maxToolCalls: DEFAULT_AGENT_LIMITS.maxToolCalls,
}

export const MAX_TURNS_LIMIT = 128
export const MAX_TOOL_CALLS_LIMIT = 512

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
