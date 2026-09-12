import type { SubAgentBudgetLedger } from './SubAgentBudgetLedger'

/**
 * 子 Agent 的有效单次请求字节上限：名义上限与「上下文窗口 × 3 bytes/token」
 * （与 SubAgentBudgetLedger.debitModelRequest 的估算口径一致）取小者。
 * contextWindow 为 0（宿主未提供窗口）时退化为仅名义上限。
 * 运行时 fail-closed 边界始终按窗口折算；此处产出同一数值供提示词渲染与预算状态消息使用，
 * 避免模型按幻影额度（名义 512 KiB）规划而实际更早中止。
 */
export const computeEffectiveMessageBytes = (
  maxMessageBytes: number,
  contextWindow: number,
): number => (
  contextWindow > 0
    ? Math.min(maxMessageBytes, contextWindow * 3)
    : maxMessageBytes
)

const ROUND = 0.75

/** 预算状态消息的任一维度占比（已用 / 上限）。 */
const fraction = (used: number, cap: number): number => (cap > 0 ? used / cap : 0)

/**
 * 预算接近上限时的模型可见状态消息；未触发阈值返回 null（零开销）。
 * 纯函数、无副作用，由 SubAgentRuntime 在每次模型请求前（prepareModelRequest）
 * 调用并把返回的消息注入该次请求，不进子历史、不累积。
 *
 * 阈值语义：任一维度使用率达到 75% 即注入，让「感知型收口」变成「确定性收口」——
 * 模型在中止前 2-3 轮拿到精确剩余量，可自行决定收口或把未覆盖部分写进总结。
 *
 * 维度覆盖两组：
 * - 子会话自身：轮次 / 工具调用 / 消息字节 / 累计输出 token / 剩余时长。输出 token
 *   必须渲染——推理模型 thinking 常使它先于轮次触顶，状态行缺这一维时模型无从自愈。
 * - 父 run 共享配额（SDD 链路 inspect→examine→review + 返工重审共用）：模型请求总数
 *   与剩余委派次数。子 Agent 对共享配额无预感时，父配额会在审查中段以
 *   parent_run_request_limit 突然硬停且无总结——提前注入让后续委派自节奏收口。
 */
export const buildBudgetStatusMessage = (
  ledger: SubAgentBudgetLedger,
  effectiveMaxMessageBytes: number,
  now = Date.now(),
): string | null => {
  const { childBudget, parentLedger } = ledger
  const remainingMs = ledger.remainingDurationMs(now)
  const parentRemainingCalls = Math.max(
    0,
    parentLedger.budget.maxCallsPerParentRun - parentLedger.callCount,
  )
  const childCrossed = (
    fraction(ledger.childTurns, childBudget.maxTurns) >= ROUND
    || fraction(ledger.childToolCalls, childBudget.maxToolCalls) >= ROUND
    || fraction(ledger.childMessageBytes, effectiveMaxMessageBytes) >= ROUND
    || fraction(ledger.childOutputTokens, childBudget.maxOutputTokensPerRun) >= ROUND
    || remainingMs <= childBudget.maxDurationMs * (1 - ROUND)
  )
  const parentCrossed = (
    fraction(parentLedger.modelRequestCount, parentLedger.budget.maxModelRequestsPerParentRun) >= ROUND
    || fraction(parentLedger.callCount, parentLedger.budget.maxCallsPerParentRun) >= ROUND
  )
  if (!childCrossed && !parentCrossed) return null
  return [
    `[预算状态] 已用 ${ledger.childTurns}/${childBudget.maxTurns} 轮、`
      + `${ledger.childToolCalls}/${childBudget.maxToolCalls} 次工具调用，`
      + `累计输出 ${ledger.childOutputTokens}/${childBudget.maxOutputTokensPerRun} tokens，`
      + `消息 ${Math.round(ledger.childMessageBytes / 1024)}/`
      + `${Math.round(effectiveMaxMessageBytes / 1024)} KiB，`
      + `剩余约 ${Math.max(0, Math.round(remainingMs / 1000))}s。`,
    `父 run 共享配额：子 Agent 累计 ${parentLedger.modelRequestCount}/${parentLedger.budget.maxModelRequestsPerParentRun} 次模型请求，`
      + `剩余 ${parentRemainingCalls} 次委派。`,
    '预算接近上限：证据足够就立即输出总结；不足则在总结中说明已覆盖与未覆盖的部分，交由父 Agent 决定是否收窄范围继续。'
      + (parentCrossed ? '父 run 共享配额也将尽：本轮务必收口，父 run 后续委派可能被直接拒绝。' : ''),
  ].join('')
}
