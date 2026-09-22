import { describe, expect, it } from 'vitest'
import type { ContextBudgetUsage, ContextPolicy } from './types'
import { createContextPolicy } from './types'
import {
  POST_TURN_BYTE_SOFT_RATIO,
  POST_TURN_TOKEN_SOFT_RATIO,
  postTurnCompactionReason,
} from './budget'

const policy: ContextPolicy = createContextPolicy(1_000_000, {
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  requestByteThreshold: 1_000_000,
})

const usage = (overrides: Partial<ContextBudgetUsage>): ContextBudgetUsage => ({
  estimatedTokens: 0,
  contextWindow: policy.contextWindow,
  tokenThreshold: policy.contextWindow - policy.reserveTokens,
  requestBytes: 0,
  requestByteThreshold: policy.requestByteThreshold,
  hardRequestByteLimit: policy.hardRequestByteLimit,
  tokenPercent: 0,
  bytePercent: 0,
  needsCompaction: false,
  ...overrides,
})

describe('postTurnCompactionReason', () => {
  it('returns undefined below the soft watermarks', () => {
    expect(postTurnCompactionReason(usage({}), policy)).toBeUndefined()
    expect(
      postTurnCompactionReason(
        usage({
          estimatedTokens: Math.floor((policy.contextWindow - policy.reserveTokens) * POST_TURN_TOKEN_SOFT_RATIO),
          requestBytes: Math.floor(policy.requestByteThreshold * POST_TURN_BYTE_SOFT_RATIO),
        }),
        policy,
      ),
    ).toBeUndefined()
  })

  it('returns token_threshold above the soft token watermark', () => {
    const result = postTurnCompactionReason(
      usage({ estimatedTokens: Math.ceil((policy.contextWindow - policy.reserveTokens) * POST_TURN_TOKEN_SOFT_RATIO) + 1 }),
      policy,
    )
    expect(result).toBe('token_threshold')
  })

  it('returns byte_threshold above the soft byte watermark and wins over token', () => {
    const result = postTurnCompactionReason(
      usage({
        requestBytes: Math.floor(policy.requestByteThreshold * POST_TURN_BYTE_SOFT_RATIO) + 1,
        estimatedTokens: 1,
      }),
      policy,
    )
    expect(result).toBe('byte_threshold')
  })

  it('never fires at or above the hard line via the soft path only', () => {
    // 硬线之上时 postTurn 判定同样返回原因，但消费方（compactIfIdleDue）只负责
    // 空闲时机的提前压缩；真正的硬阈值兜底在 prepareModelRequest。
    const result = postTurnCompactionReason(usage({ requestBytes: policy.hardRequestByteLimit + 1 }), policy)
    expect(result).toBe('byte_threshold')
  })
})
