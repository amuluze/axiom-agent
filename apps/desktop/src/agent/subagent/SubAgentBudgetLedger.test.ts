import { describe, expect, it } from 'vitest'
import {
  createParentRunLedger,
  DEFAULT_SUBAGENT_CHILD_BUDGET,
  DEFAULT_SUBAGENT_PARENT_RUN_BUDGET,
} from './contracts'
import {
  estimateModelMessagesBytes,
  SubAgentBudgetLedger,
} from './SubAgentBudgetLedger'
import type { ModelMessage } from '@/agent/core/types'

const parentLedger = () => createParentRunLedger()

describe('SubAgentBudgetLedger', () => {
  it('beginParentCall 计入父 run 次数，超过上限 fail-closed', () => {
    const ledger = new SubAgentBudgetLedger(parentLedger())
    for (let i = 0; i < DEFAULT_SUBAGENT_PARENT_RUN_BUDGET.maxCallsPerParentRun; i += 1) {
      expect(ledger.beginParentCall()).toBeNull()
    }
    expect(ledger.beginParentCall()).toBe('parent_run_call_limit')
  })

  it('debitModelRequest 按 child turn 与父 run 请求计数', () => {
    const ledger = new SubAgentBudgetLedger(parentLedger())
    ledger.beginParentCall()
    expect(ledger.debitModelRequest(10)).toBeNull()
    expect(ledger.childTurns).toBe(1)
    expect(ledger.parentLedger.modelRequestCount).toBe(1)
    expect(ledger.debitModelRequest(10)).toBeNull()
    expect(ledger.childTurns).toBe(2)
  })

  it('child turn 达到 maxTurns 拒绝', () => {
    const ledger = new SubAgentBudgetLedger(parentLedger(), {
      ...DEFAULT_SUBAGENT_CHILD_BUDGET,
      maxTurns: 2,
    })
    ledger.beginParentCall()
    expect(ledger.debitModelRequest(1)).toBeNull()
    expect(ledger.debitModelRequest(1)).toBeNull()
    expect(ledger.debitModelRequest(1)).toBe('child_turn_limit')
  })

  it('父 run 请求达到上限拒绝', () => {
    // maxTurns 放宽到父 run 请求上限之上，单独验证父 run 请求上限
    //（child maxTurns 低于父 run 总请求数时会先触 child 上限）。
    const ledger = new SubAgentBudgetLedger(parentLedger(), {
      ...DEFAULT_SUBAGENT_CHILD_BUDGET,
      maxTurns: DEFAULT_SUBAGENT_PARENT_RUN_BUDGET.maxModelRequestsPerParentRun + 10,
    })
    ledger.beginParentCall()
    for (let i = 0; i < DEFAULT_SUBAGENT_PARENT_RUN_BUDGET.maxModelRequestsPerParentRun; i += 1) {
      expect(ledger.debitModelRequest(1)).toBeNull()
    }
    expect(ledger.debitModelRequest(1)).toBe('parent_run_request_limit')
  })

  it('单次请求消息字节超过 maxMessageBytes 拒绝，峰值追踪而非累加', () => {
    const ledger = new SubAgentBudgetLedger(parentLedger(), {
      ...DEFAULT_SUBAGENT_CHILD_BUDGET,
      maxMessageBytes: 100,
    })
    ledger.beginParentCall()
    expect(ledger.debitModelRequest(60)).toBeNull()
    expect(ledger.childMessageBytes).toBe(60)
    // 完整历史是峰值追踪：后续更小的请求不叠加
    expect(ledger.debitModelRequest(40)).toBeNull()
    expect(ledger.childMessageBytes).toBe(60)
    // 单次请求超过上限才拒绝
    expect(ledger.debitModelRequest(120)).toBe('child_message_bytes')
  })

  it('contextWindow 按 token 估算收窄预算，估算超窗口返回 child_context_window', () => {
    // maxMessageBytes 放宽，验证窗口先于固定字节上限触发
    const ledger = new SubAgentBudgetLedger(parentLedger(), {
      ...DEFAULT_SUBAGENT_CHILD_BUDGET,
      maxMessageBytes: 100_000,
    }, 10)
    ledger.beginParentCall()
    // 30 字节 → ceil(30/3) = 10 tokens，等于窗口，放行
    expect(ledger.debitModelRequest(30)).toBeNull()
    // 31 字节 → 11 tokens > 10，窗口限制先于字节上限触发
    expect(ledger.debitModelRequest(31)).toBe('child_context_window')
  })

  it('contextWindow 为 0 时不启用 token 检查，仅字节上限生效', () => {
    const ledger = new SubAgentBudgetLedger(parentLedger(), {
      ...DEFAULT_SUBAGENT_CHILD_BUDGET,
      maxMessageBytes: 100,
    })
    ledger.beginParentCall()
    // 60 字节 → 20 tokens，若窗口启用（<20 即拒绝）会失败；0 表示不启用
    expect(ledger.debitModelRequest(60)).toBeNull()
    expect(ledger.debitModelRequest(120)).toBe('child_message_bytes')
  })

  it('debitToolCall 超过 maxToolCalls 拒绝', () => {
    const ledger = new SubAgentBudgetLedger(parentLedger(), {
      ...DEFAULT_SUBAGENT_CHILD_BUDGET,
      maxToolCalls: 2,
    })
    expect(ledger.debitToolCall()).toBeNull()
    expect(ledger.debitToolCall()).toBeNull()
    expect(ledger.debitToolCall()).toBe('child_tool_limit')
  })

  it('retry/失败消耗不退款：失败请求仍计 turn', () => {
    const ledger = new SubAgentBudgetLedger(parentLedger(), {
      ...DEFAULT_SUBAGENT_CHILD_BUDGET,
      maxTurns: 3,
    })
    ledger.beginParentCall()
    ledger.debitModelRequest(1)
    ledger.debitModelRequest(1)
    ledger.debitModelRequest(1)
    expect(ledger.debitModelRequest(1)).toBe('child_turn_limit')
  })

  it('settleDuration 只结算一次并累计到父 run', () => {
    const parent = parentLedger()
    const ledger = new SubAgentBudgetLedger(parent)
    ledger.beginParentCall()
    ledger.settleDuration((ledger as unknown as { startedAt: number }).startedAt + 5000)
    ledger.settleDuration((ledger as unknown as { startedAt: number }).startedAt + 9999)
    expect(parent.spentDurationMs).toBe(5000)
    expect(ledger.childDurationMs).toBe(5000)
  })

  it('remainingDurationMs 受绝对 deadline 约束', () => {
    const ledger = new SubAgentBudgetLedger(parentLedger(), {
      ...DEFAULT_SUBAGENT_CHILD_BUDGET,
      maxDurationMs: 10_000,
    })
    ledger.beginParentCall()
    expect(ledger.remainingDurationMs((ledger as unknown as { startedAt: number }).startedAt + 3000)).toBe(7000)
    expect(ledger.remainingDurationMs((ledger as unknown as { startedAt: number }).startedAt + 12_000)).toBe(0)
  })

  it('累计 output token 超 maxOutputTokensPerRun 时下轮 fail-closed', () => {
    const ledger = new SubAgentBudgetLedger(parentLedger(), {
      ...DEFAULT_SUBAGENT_CHILD_BUDGET,
      maxOutputTokensPerRun: 100,
    })
    ledger.beginParentCall()
    expect(ledger.debitModelRequest(10)).toBeNull()
    // 第一轮响应累计 60 output token（60 < 100，下轮放行）
    ledger.debitOutputTokens(60)
    expect(ledger.childOutputTokens).toBe(60)
    expect(ledger.debitModelRequest(10)).toBeNull()
    // 第二轮响应累计 50，总计 110 > 100
    ledger.debitOutputTokens(50)
    // 第三轮拦截
    expect(ledger.debitModelRequest(10)).toBe('child_output_tokens')
  })
})

describe('estimateModelMessagesBytes', () => {
  const message = (role: ModelMessage['role'], content: string): ModelMessage => ({
    id: 'm',
    createdAt: 0,
    role,
    content,
  } as ModelMessage)

  it('累计 text/thinking/tool arguments 字节', () => {
    const messages: ModelMessage[] = [
      message('user', 'abc'),
      {
        ...message('assistant', ''),
        toolCalls: [],
        stopReason: 'tool_use',
        contentBlocks: [
          { type: 'thinking', thinking: 'xyz' },
          { type: 'tool_call', id: 't', name: 'read', arguments: { path: 'src/a.ts' }, rawArguments: '{"path":"src/a.ts"}' },
        ],
      } as unknown as ModelMessage,
    ]
    // 3(user) + 3(thinking) + 4(name 'read') + 19(JSON.stringify({path:"src/a.ts"})) = 29
    expect(estimateModelMessagesBytes(messages)).toBe(29)
  })
})
