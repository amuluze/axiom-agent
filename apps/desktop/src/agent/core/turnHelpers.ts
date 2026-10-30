import type {
  AgentContext,
  AgentLimits,
  AgentMessage,
  AgentRunTokenUsage,
  AgentTurnSavePoint,
  AssistantMessage,
  BudgetThresholds,
  ToolResultMessage,
} from './types'
import type { AgentTurnSnapshot } from './runAgentLoop'
import { snapshotAgentMessages, snapshotAgentContext, snapshotAssistantMessage, snapshotToolResultMessage } from './snapshots'
import { PLANNING_GUARD_DIAGNOSTIC } from './planningGuard'
import { STEERING_INTERRUPT_DIAGNOSTIC } from './streamInterruption'

export type StopCorrectionKind =
  | 'length_with_tools'
  | 'length_without_tools'
  | 'empty_stop'
  | 'textual_tool_call'
  | 'planning_loop'

const textualToolCallName = (content: string): string | undefined => {
  const trimmed = content.trim()
  if (!/<(?:tool_call|function_call)\b/iu.test(trimmed) && !/^```(?:json|tool|tool_call|function_call)\b[\s\S]*```$/iu.test(trimmed)) {
    return undefined
  }
  return /["']name["']\s*:\s*["']([^"']+)["']/iu.exec(trimmed)?.[1]
}

export const classifyStopCorrection = (
  message: AssistantMessage,
  activeToolNames: Iterable<string>,
): StopCorrectionKind | undefined => {
  if (message.diagnostics?.some((diagnostic) => diagnostic.type === STEERING_INTERRUPT_DIAGNOSTIC)) {
    return undefined
  }
  if (message.diagnostics?.some((diagnostic) => diagnostic.type === PLANNING_GUARD_DIAGNOSTIC)) {
    return 'planning_loop'
  }
  if (message.stopReason === 'length') {
    return message.toolCalls.length > 0 ? 'length_with_tools' : 'length_without_tools'
  }
  if (message.stopReason !== 'stop' || message.toolCalls.length > 0) return undefined
  if (message.excludeFromModelContext === true || !message.content.trim()) return 'empty_stop'
  const toolName = textualToolCallName(message.content)
  if (toolName && new Set(activeToolNames).has(toolName)) return 'textual_tool_call'
  return undefined
}

export const stopCorrectionNotice = (kind: StopCorrectionKind): string => {
  switch (kind) {
    case 'length_with_tools':
      return '运行时纠错：上一轮达到输出长度上限，其中的工具参数可能不完整且工具未执行。不要假设调用已生效；如仍需该工具，请重新发出完整的原生工具调用。'
    case 'length_without_tools':
      return '运行时纠错：上一轮达到输出长度上限。请从中断处继续并尽快收口，不要重复已经完整输出的内容。'
    case 'empty_stop':
      return '运行时纠错：上一轮在没有可见内容或工具调用时停止。当前轮必须给出有效答复，或使用已注册工具的原生调用协议。'
    case 'textual_tool_call':
      return '运行时纠错：上一轮把工具调用写成了普通文本，因此没有执行。需要工具时必须使用已注册工具的原生调用协议，不要再次输出伪造的工具调用文本。'
    case 'planning_loop':
      return '运行时纠错：上一轮长时间停留在重复规划且没有调用工具，已由运行时提前中止。请停止重复描述计划；需要证据时立即调用合适的只读工具，否则直接基于已有信息给出结论。'
  }
}

/**
 * runAgentLoop 的纯函数拆件。把预算提示注入、turn 快照与 save point 结构构建从主循环
 * 闭包中抽出，降低单函数复杂度并可直接单测（不依赖闭包状态）。
 * 约定：这些函数只做「读入 → 输出新对象」，不修改任何入参（不可变边界）。
 */

/** 预算提示注入：按轮次/工具调用/token 累计量生成软/硬提醒文案（纯函数）。 */
export const buildBudgetNotices = (
  turns: number,
  toolCalls: number,
  limits: AgentLimits,
  budgetThresholds: BudgetThresholds,
  tokenUsage: AgentRunTokenUsage,
): string[] => {
  const notices: string[] = []
  const remainingTurns = limits.maxTurns - turns + 1
  const remainingToolCalls = limits.maxToolCalls - toolCalls
  if (remainingTurns <= budgetThresholds.turnSoftNotice) {
    notices.push(
      `运行时轮次预算提示：当前是第 ${turns}/${limits.maxTurns} 轮（含本轮最多剩余 ${remainingTurns} 轮）。请在同一轮并行调用多个互不依赖的只读工具，停止逐文件串行浏览和重复读取，并开始规划收口。`,
    )
  }
  if (remainingTurns <= budgetThresholds.turnHardNotice) {
    notices.push(
      `运行时轮次预算硬约束：剩余轮次已不足 ${budgetThresholds.turnHardNotice} 轮，必须立即停止扩展探索范围，基于已有证据给出最终结论与交付。`,
    )
  }
  if (remainingToolCalls <= budgetThresholds.toolCallNotice) {
    notices.push(
      `运行时工具预算提示：本次任务还可调用 ${remainingToolCalls} 次工具。请合并搜索与读取范围；信息足够时立即总结结论并完成任务。`,
    )
  }
  if (
    limits.maxTotalTokens !== undefined
    && tokenUsage.billableTokens >= budgetThresholds.tokenHardNotice
  ) {
    notices.push(
      `运行时 token 预算硬约束：本次运行累计计费 ${tokenUsage.billableTokens} tokens（预算 ${limits.maxTotalTokens}）。请停止大范围检索与重复读取，立即基于已有信息收口。`,
    )
  } else if (
    limits.maxTotalTokens !== undefined
    && tokenUsage.billableTokens >= budgetThresholds.tokenSoftNotice
  ) {
    notices.push(
      `运行时 token 预算提示：本次运行已累计计费 ${tokenUsage.billableTokens}/${limits.maxTotalTokens} tokens。请合并读取范围、避免重复加载大文件，规划收口路径。`,
    )
  }
  return notices
}

/** 把预算提示追加到系统提示词后（无提示时原样返回，不产生无意义拼接）。 */
export const appendBudgetNoticesToSystemPrompt = (
  systemPrompt: string,
  notices: string[],
): string => (
  notices.length > 0 ? `${systemPrompt}\n\n${notices.join('\n')}` : systemPrompt
)

/** turn 快照构建（runAgentLoop 中 prepareNextTurn/shouldStopAfterTurn 共用同一构造）。 */
export const buildTurnSnapshot = (
  message: AssistantMessage,
  toolResults: ToolResultMessage[],
  context: AgentContext,
  newMessages: AgentMessage[],
  turn: number,
  toolCalls: number,
  hasTemporarySystemPrompt: boolean,
): AgentTurnSnapshot => ({
  message: snapshotAssistantMessage(message),
  toolResults: toolResults.map((result) => snapshotToolResultMessage(result)),
  context: snapshotAgentContext(context),
  newMessages: snapshotAgentMessages(newMessages),
  messages: snapshotAgentMessages(context.messages),
  turn,
  toolCalls,
  hasTemporarySystemPrompt,
})

/** save point 结构构建：由调用方注入已结算的 mutation batch id 与持久化边界信息。 */
export const buildTurnSavePoint = ({
  sessionId,
  runId,
  turn,
  mutationBatchIds,
  historyMessageCount,
  newMessageCount,
  lastDurableMessageId,
  historyLastMessageId,
  checkpointId,
  createdAt,
}: {
  sessionId: string
  runId: string
  turn: number
  mutationBatchIds: string[]
  historyMessageCount: number
  newMessageCount: number
  lastDurableMessageId?: string
  historyLastMessageId?: string
  checkpointId?: string
  createdAt: number
}): AgentTurnSavePoint => ({
  sessionId,
  runId,
  turn,
  mutationBatchIds: mutationBatchIds.slice(),
  hadPendingMutations: mutationBatchIds.length > 0,
  messageCount: historyMessageCount + newMessageCount,
  ...(lastDurableMessageId
    ? { lastMessageId: lastDurableMessageId }
    : historyLastMessageId ? { lastMessageId: historyLastMessageId } : {}),
  ...(checkpointId ? { checkpointId } : {}),
  createdAt,
})
