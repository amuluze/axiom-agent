import { createId } from '@/agent/core/id'
import type { AgentLoopResult, AgentMessage, CustomAgentMessage } from '@/agent/core/types'

const TYPE = 'axiom.task-summary.v1'
const reasons = ['completed', 'turn_limit', 'tool_limit', 'time_limit', 'aborted', 'error', 'stopped']
type Summary = { reason: AgentLoopResult['reason']; usage: NonNullable<AgentLoopResult['taskUsage']> }

export function createTaskSummary(result: AgentLoopResult): CustomAgentMessage {
  if (!result.taskUsage) throw new Error('任务结算缺少累计账本')
  const usage = structuredClone(result.taskUsage)
  return {
    id: createId('task-summary'), role: 'custom', customType: TYPE,
    excludeFromModelContext: true, createdAt: Date.now(),
    content: `任务累计：${usage.stages} 个阶段 · ${usage.turns} 轮 · ${usage.toolCalls} 次工具 · ${usage.tokenUsage.billableTokens} 计费 tokens`,
    data: { version: 1, reason: result.reason, usage: { ...usage, tokenUsage: { ...usage.tokenUsage } } },
  }
}

/** 只接受末尾结算记录；后续用户输入或未完成运行会自然使旧记录失效。 */
export function readTaskSummary(messages: AgentMessage[]): Summary | undefined {
  const last = messages[messages.length - 1]
  if (last?.role !== 'custom' || last.customType !== TYPE || last.excludeFromModelContext !== true) return
  const data = last.data
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1
    || typeof data.reason !== 'string' || !reasons.includes(data.reason)) return
  const usage = data.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return
  const tokens = usage.tokenUsage
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return
  for (const value of [usage.stages, usage.continuations, usage.turns, usage.toolCalls, usage.elapsedMs,
    tokens.inputTokens, tokens.outputTokens, tokens.billableTokens, tokens.totalTokens]) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return
  }
  if (typeof usage.continuationDecision !== 'string'
    || !['terminal', 'cancelled', 'duration_limit', 'continuation_limit', 'no_progress'].includes(usage.continuationDecision)) return
  if ((usage.stages as number) < 1 || (usage.continuations as number) > 3
    || (usage.continuations as number) >= (usage.stages as number)) return
  return structuredClone({ reason: data.reason, usage }) as unknown as Summary
}
