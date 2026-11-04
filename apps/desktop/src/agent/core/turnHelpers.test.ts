import { describe, expect, it } from 'vitest'
import type { AgentLimits, AgentRunTokenUsage } from './types'
import { computeBudgetThresholds, DEFAULT_AGENT_LIMITS } from './types'
import {
  appendBudgetNoticesToSystemPrompt,
  buildBudgetNotices,
  buildTurnSavePoint,
  classifyStopCorrection,
  stopCorrectionNotice,
} from './turnHelpers'
import { PLANNING_GUARD_DIAGNOSTIC } from './planningGuard'

const limits: AgentLimits = DEFAULT_AGENT_LIMITS
const thresholds = computeBudgetThresholds(limits)
const zeroUsage: AgentRunTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  billableTokens: 0,
  totalTokens: 0,
}

describe('buildBudgetNotices', () => {
  it('阶段额度接近上限时要求交接，不强制提前交付；token 总预算提醒仍生效', () => {
    const notices = buildBudgetNotices(limits.maxTurns, limits.maxToolCalls, limits, thresholds, {
      ...zeroUsage, billableTokens: limits.maxTotalTokens ?? 0,
    }, true)
    expect(notices.some((notice) => notice.includes('阶段预算提示'))).toBe(true)
    expect(notices.some((notice) => notice.includes('必须立即停止扩展探索范围'))).toBe(false)
    expect(notices.some((notice) => notice.includes('token 预算硬约束'))).toBe(true)
  })
  it('produces no notices while budgets are comfortable', () => {
    expect(buildBudgetNotices(1, 1, limits, thresholds, zeroUsage)).toEqual([])
  })

  it('soft-warns on turn budget pressure', () => {
    const softTurn = thresholds.turnSoftNotice
    const notices = buildBudgetNotices(limits.maxTurns - softTurn + 1, 1, limits, thresholds, zeroUsage)
    expect(notices.some((notice) => notice.includes('轮次预算提示'))).toBe(true)
    expect(notices.some((notice) => notice.includes('轮次预算硬约束'))).toBe(false)
  })

  it('hard-constrains when turns are nearly exhausted', () => {
    const hardTurn = thresholds.turnHardNotice
    const notices = buildBudgetNotices(limits.maxTurns - hardTurn + 1, 1, limits, thresholds, zeroUsage)
    expect(notices.some((notice) => notice.includes('轮次预算硬约束'))).toBe(true)
  })

  it('warns on tool-call budget pressure', () => {
    const toolNotice = thresholds.toolCallNotice
    const notices = buildBudgetNotices(1, limits.maxToolCalls - toolNotice + 1, limits, thresholds, zeroUsage)
    expect(notices.some((notice) => notice.includes('工具预算提示'))).toBe(true)
  })

  it('is pure: does not mutate inputs', () => {
    const frozenLimits = Object.freeze({ ...limits })
    const frozenThresholds = Object.freeze({ ...thresholds })
    const notices = buildBudgetNotices(1, 1, frozenLimits, frozenThresholds, zeroUsage)
    expect(notices).toEqual([])
  })

  it('emits no token notices when maxTotalTokens is unset', () => {
    const tokenLimits: AgentLimits = { ...limits, maxTotalTokens: undefined }
    const usage: AgentRunTokenUsage = {
      inputTokens: 10_000_000,
      outputTokens: 10_000_000,
      billableTokens: 10_000_000,
      totalTokens: 20_000_000,
    }
    expect(buildBudgetNotices(1, 1, tokenLimits, computeBudgetThresholds(tokenLimits), usage)).toEqual([])
  })

  it('soft-warns and hard-constrains on token budget pressure', () => {
    const tokenLimits: AgentLimits = { ...limits, maxTotalTokens: 100_000 }
    const tokenThresholds = computeBudgetThresholds(tokenLimits)
    const softUsage: AgentRunTokenUsage = {
      inputTokens: 76_000,
      outputTokens: 0,
      billableTokens: 76_000,
      totalTokens: 76_000,
    }
    const soft = buildBudgetNotices(1, 1, tokenLimits, tokenThresholds, softUsage)
    expect(soft.some((notice) => notice.includes('token 预算提示'))).toBe(true)
    expect(soft.some((notice) => notice.includes('token 预算硬约束'))).toBe(false)
    // cacheRead 不计费：91k input 中 20k 为缓存命中 → billable 71k，低于软线
    const cachedUsage: AgentRunTokenUsage = {
      inputTokens: 91_000,
      outputTokens: 0,
      billableTokens: 71_000,
      totalTokens: 91_000,
    }
    expect(
      buildBudgetNotices(1, 1, tokenLimits, tokenThresholds, cachedUsage)
        .some((notice) => notice.includes('token 预算')),
    ).toBe(false)
    const hardUsage: AgentRunTokenUsage = {
      inputTokens: 0,
      outputTokens: 91_000,
      billableTokens: 91_000,
      totalTokens: 91_000,
    }
    const hard = buildBudgetNotices(1, 1, tokenLimits, tokenThresholds, hardUsage)
    expect(hard.some((notice) => notice.includes('token 预算硬约束'))).toBe(true)
  })
})

describe('appendBudgetNoticesToSystemPrompt', () => {
  it('appends notices after the prompt separated by blank lines', () => {
    expect(appendBudgetNoticesToSystemPrompt('base', ['A', 'B'])).toBe('base\n\nA\nB')
  })

  it('returns the prompt unchanged when there are no notices', () => {
    expect(appendBudgetNoticesToSystemPrompt('base', [])).toBe('base')
  })
})

describe('stop correction', () => {
  const assistant = (content: string, stopReason: 'stop' | 'length' = 'stop') => ({
    id: 'a1',
    role: 'assistant' as const,
    content,
    toolCalls: [],
    stopReason,
    createdAt: 1,
  })

  it('classifies empty and length-truncated responses', () => {
    expect(classifyStopCorrection(assistant(''), [])).toBe('empty_stop')
    expect(classifyStopCorrection(assistant('partial', 'length'), [])).toBe('length_without_tools')
  })

  it('only classifies textual calls for an active tool with an explicit wrapper', () => {
    expect(classifyStopCorrection(
      assistant('<tool_call>{"name":"echo","arguments":{"value":"x"}}</tool_call>'),
      ['echo'],
    )).toBe('textual_tool_call')
    expect(classifyStopCorrection(
      assistant('示例：{"name":"echo","arguments":{}}'),
      ['echo'],
    )).toBeUndefined()
    expect(classifyStopCorrection(
      assistant('<tool_call>{"name":"unknown","arguments":{}}</tool_call>'),
      ['echo'],
    )).toBeUndefined()
  })

  it('provides a targeted notice for each correction kind', () => {
    expect(stopCorrectionNotice('length_with_tools')).toContain('参数可能不完整')
    expect(stopCorrectionNotice('textual_tool_call')).toContain('原生调用协议')
    expect(stopCorrectionNotice('planning_loop')).toContain('重复规划')
  })

  it('classifies a planning guard interruption from its durable diagnostic', () => {
    expect(classifyStopCorrection({
      ...assistant('partial planning'),
      diagnostics: [{ type: PLANNING_GUARD_DIAGNOSTIC, timestamp: 1 }],
    }, ['read'])).toBe('planning_loop')
  })
})

describe('buildTurnSavePoint', () => {
  it('computes messageCount and hadPendingMutations from inputs', () => {
    const savePoint = buildTurnSavePoint({
      sessionId: 'session-1',
      runId: 'run-1',
      turn: 3,
      mutationBatchIds: ['m-1', 'm-2'],
      historyMessageCount: 10,
      newMessageCount: 2,
      createdAt: 1,
    })
    expect(savePoint.sessionId).toBe('session-1')
    expect(savePoint.turn).toBe(3)
    expect(savePoint.messageCount).toBe(12)
    expect(savePoint.hadPendingMutations).toBe(true)
    expect(savePoint.mutationBatchIds).toEqual(['m-1', 'm-2'])
    expect(savePoint.lastMessageId).toBeUndefined()
  })

  it('prefers the durable last message id over the history fallback', () => {
    const savePoint = buildTurnSavePoint({
      sessionId: 's',
      runId: 'r',
      turn: 1,
      mutationBatchIds: [],
      historyMessageCount: 0,
      newMessageCount: 1,
      lastDurableMessageId: 'new-1',
      historyLastMessageId: 'old-1',
      createdAt: 0,
    })
    expect(savePoint.hadPendingMutations).toBe(false)
    expect(savePoint.lastMessageId).toBe('new-1')
  })

  it('falls back to the history last message id', () => {
    const savePoint = buildTurnSavePoint({
      sessionId: 's',
      runId: 'r',
      turn: 1,
      mutationBatchIds: [],
      historyMessageCount: 5,
      newMessageCount: 0,
      historyLastMessageId: 'old-1',
      checkpointId: 'cp-1',
      createdAt: 0,
    })
    expect(savePoint.lastMessageId).toBe('old-1')
    expect(savePoint.checkpointId).toBe('cp-1')
  })

  it('clones the mutation batch id list', () => {
    const ids = ['m-1']
    const savePoint = buildTurnSavePoint({
      sessionId: 's',
      runId: 'r',
      turn: 1,
      mutationBatchIds: ids,
      historyMessageCount: 0,
      newMessageCount: 0,
      createdAt: 0,
    })
    ids.push('m-2')
    expect(savePoint.mutationBatchIds).toEqual(['m-1'])
  })
})
