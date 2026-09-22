import { describe, expect, it } from 'vitest'
import type { AgentLimits, AgentRunTokenUsage } from './types'
import { computeBudgetThresholds, DEFAULT_AGENT_LIMITS } from './types'
import {
  appendBudgetNoticesToSystemPrompt,
  buildBudgetNotices,
  buildTurnSavePoint,
} from './turnHelpers'

const limits: AgentLimits = DEFAULT_AGENT_LIMITS
const thresholds = computeBudgetThresholds(limits)
const zeroUsage: AgentRunTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  billableTokens: 0,
  totalTokens: 0,
}

describe('buildBudgetNotices', () => {
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
