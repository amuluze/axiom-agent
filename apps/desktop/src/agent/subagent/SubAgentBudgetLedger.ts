import type { ModelMessage } from '@/agent/core/types'
import {
  DEFAULT_SUBAGENT_CHILD_BUDGET,
  type SubAgentChildBudget,
  type SubAgentParentRunLedger,
} from './contracts'

export type SubAgentBudgetExhaustion =
  | 'parent_run_call_limit'
  | 'parent_run_request_limit'
  | 'parent_run_duration_limit'
  | 'child_turn_limit'
  | 'child_tool_limit'
  | 'child_duration_limit'
  | 'child_message_bytes'
  | 'child_context_window'
  | 'child_output_tokens'

/**
 * 单次 child 探索的固定预算 ledger。所有尝试（含安全 retry）累计；
 * 重试/失败消耗不退款。debit 必须在模型请求发送前 / 工具执行开始前原子完成，
 * 且不可由观察器失败跳过——强制预算 ledger 与可失败 observability sink 分离，
 * 避免遥测故障变成成本绕过。
 */
export class SubAgentBudgetLedger {
  readonly childBudget: SubAgentChildBudget
  /** 共享父 run ledger（AgentSession 按 (parentSessionId, parentRunId) 维护）。 */
  readonly parentLedger: SubAgentParentRunLedger
  /** 子模型上下文窗口（tokens）；0 表示宿主未提供窗口，退化为仅字节检查。 */
  readonly contextWindow: number

  childTurns = 0
  childToolCalls = 0
  childMessageBytes = 0
  childDurationMs = 0
  childOutputTokens = 0

  /** 最近一次 debit 的耗尽原因；runAgentLoop 把 onModelRequest 抛错转成 error 消息后，
   *  SubAgentRuntime 据此事后判定 fail-closed 收口（context_limit / parent_run_budget）。 */
  exhaustion?: SubAgentBudgetExhaustion

  private startedAt = 0
  private settled = false

  constructor(
    parentLedger: SubAgentParentRunLedger,
    childBudget: SubAgentChildBudget = DEFAULT_SUBAGENT_CHILD_BUDGET,
    contextWindow = 0,
  ) {
    this.parentLedger = parentLedger
    this.childBudget = childBudget
    this.contextWindow = contextWindow
  }

  /** delegate 开始前调用：父 run 次数立即计入（校验失败、启动失败和 child error 也占一次）。 */
  beginParentCall(): SubAgentBudgetExhaustion | null {
    if (this.parentLedger.callCount >= this.parentLedger.budget.maxCallsPerParentRun) {
      return 'parent_run_call_limit'
    }
    this.parentLedger.callCount += 1
    this.startedAt = Date.now()
    return null
  }

  /**
   * 模型请求发送前原子 debit：父 run 请求次数、child 轮次与消息字节。
   * 返回耗尽原因（fail-closed）或 null（放行）。不得超过预算，不退款。
   */
  debitModelRequest(messageBytes: number): SubAgentBudgetExhaustion | null {
    // 上轮响应累计的 output token 超额时拦截（本轮累计、下轮拦截的事后 fail-closed）。
    if (this.childOutputTokens >= this.childBudget.maxOutputTokensPerRun) {
      this.exhaustion = 'child_output_tokens'
      return this.exhaustion
    }
    if (
      this.parentLedger.modelRequestCount
      >= this.parentLedger.budget.maxModelRequestsPerParentRun
    ) {
      this.exhaustion = 'parent_run_request_limit'
      return this.exhaustion
    }
    if (this.childTurns >= this.childBudget.maxTurns) {
      this.exhaustion = 'child_turn_limit'
      return this.exhaustion
    }
    // 先按真实模型窗口折算 token（与 context/budget.ts 的 serializedEstimate 口径一致：
    // 字节 / 3），让 fail-closed 边界随模型缩放，而非依赖固定字节上限。contextWindow
    // 为 0 时表示宿主未提供窗口，退化为仅字节检查。
    if (this.contextWindow > 0) {
      const estimatedTokens = Math.max(1, Math.ceil(messageBytes / 3))
      if (estimatedTokens > this.contextWindow) {
        this.exhaustion = 'child_context_window'
        return this.exhaustion
      }
    }
    // modelRequest.messages 是完整对话历史（非逐轮增量）：maxMessageBytes 语义是
    // "单次请求消息不超过上限"，用峰值追踪而非逐次累加，避免 O(N^2) 膨胀导致预算过早耗尽。
    if (messageBytes > this.childBudget.maxMessageBytes) {
      this.exhaustion = 'child_message_bytes'
      return this.exhaustion
    }
    this.childTurns += 1
    this.childMessageBytes = Math.max(this.childMessageBytes, messageBytes)
    this.parentLedger.modelRequestCount += 1
    return null
  }

  /** 工具执行开始前原子 debit。返回耗尽原因（fail-closed）或 null。 */
  debitToolCall(): SubAgentBudgetExhaustion | null {
    if (this.childToolCalls >= this.childBudget.maxToolCalls) {
      this.exhaustion = 'child_tool_limit'
      return this.exhaustion
    }
    this.childToolCalls += 1
    return null
  }

  /** 模型响应后累计 output token（下轮 debitModelRequest 拦截）。output 只能在响应后得知，
   *  故天然是"本轮累计、下轮拦截"的事后 fail-closed，不违反"debit 必须在请求发送前完成"的不变量。 */
  debitOutputTokens(tokens: number): void {
    this.childOutputTokens += tokens
  }

  /** 绝对 deadline 内的剩余时长（所有尝试共享同一 deadline，不为 retry 重置）。 */
  remainingDurationMs(now = Date.now()): number {
    return Math.max(0, this.startedAt + this.childBudget.maxDurationMs - now)
  }

  /** run finally 结算 duration 到父 run ledger（只结算一次）。 */
  settleDuration(now = Date.now()): void {
    if (this.settled) return
    this.settled = true
    this.childDurationMs = now - this.startedAt
    this.parentLedger.spentDurationMs += this.childDurationMs
  }
}

/**
 * 按方案口径估算模型消息字节：累计 text、thinking、tool name/arguments。
 * 不依赖 transport 的 requestByteLength，保证 budget 判定自包含。
 */
export const estimateModelMessagesBytes = (messages: ModelMessage[]): number => {
  let total = 0
  for (const message of messages) {
    switch (message.role) {
      case 'user':
        total += byteLength(message.content)
        break
      case 'assistant':
        total += byteLength(message.content)
        for (const block of message.contentBlocks ?? []) {
          if (block.type === 'thinking') total += byteLength(block.thinking)
          if (block.type === 'tool_call') {
            total += byteLength(block.name)
            total += byteLength(
              typeof block.arguments === 'string'
                ? block.arguments
                : JSON.stringify(block.arguments),
            )
          }
        }
        break
      case 'tool':
        total += byteLength(message.content)
        break
      default:
        break
    }
  }
  return total
}

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength
