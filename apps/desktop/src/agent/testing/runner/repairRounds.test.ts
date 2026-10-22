import { describe, expect, it } from 'vitest'
import {
  REPAIR_HISTORY_DETAIL_LIMIT,
  REPAIR_ROUND_LIMIT,
  countRepairRounds,
  firstRepairFailureSignature,
  isRepairFailureStatus,
  needsHumanIntervention,
  type RepairHistoryEntry,
} from './repairRounds'

const entry = (overrides: Partial<RepairHistoryEntry> = {}): RepairHistoryEntry => ({
  runId: 'run-old',
  specPath: 'tests/checkout.testspec.json',
  specHash: 'hash-v1',
  status: 'failed',
  failureSignature: JSON.stringify(['checkout', 'assert-total', 'failed', 'assertion']),
  finishedAt: 1,
  ...overrides,
})

describe('repair rounds', () => {
  it('takes a case-scoped signature from the first actual failure', () => {
    expect(firstRepairFailureSignature([
      { caseId: 'checkout', steps: [{ stepId: 'open', status: 'passed' }, { stepId: 'assert-total', status: 'failed' }] },
      { caseId: 'later', steps: [{ stepId: 'assert-total', status: 'error', origin: 'environment' }] },
    ])).toBe(JSON.stringify(['checkout', 'assert-total', 'failed', 'assertion']))
    expect(firstRepairFailureSignature([
      { caseId: 'checkout', steps: [{ stepId: 'canceled-one', status: 'canceled' }] },
    ])).toBeNull()
    expect(isRepairFailureStatus('rejected')).toBe(false)
    expect(isRepairFailureStatus('error')).toBe(true)
  })

  it('counts only consecutive rounds with the same failure signature', () => {
    const current = {
      runId: 'run-3',
      specPath: 'tests/checkout.testspec.json',
      specHash: 'hash-v1',
      failureSignature: JSON.stringify(['checkout', 'assert-total', 'failed', 'assertion']),
    }
    expect(countRepairRounds(current, [])).toBe(1)
    expect(countRepairRounds(current, [entry({ runId: 'run-2' })])).toBe(2)
    expect(countRepairRounds(current, [entry({ runId: 'run-2' }), entry({ runId: 'run-1' })])).toBe(REPAIR_ROUND_LIMIT)
    // 中间出现过通过或换了失败点，则从那一轮断开（连续才计数）。
    expect(countRepairRounds(current, [entry({ runId: 'run-2', status: 'passed', failureSignature: null })])).toBe(1)
    expect(countRepairRounds(current, [entry({ runId: 'run-2', failureSignature: 'other' })])).toBe(1)
    expect(countRepairRounds(current, [entry({ runId: 'run-2', specHash: 'hash-v2' })])).toBe(1)
    // 达到上限即封顶，不做无界回读。
    expect(countRepairRounds(current, [
      entry({ runId: 'run-2' }),
      entry({ runId: 'run-1' }),
      entry({ runId: 'run-0' }),
    ])).toBe(REPAIR_ROUND_LIMIT)
  })

  it('counts a passing round as the first round and escalates at the limit', () => {
    expect(countRepairRounds(
      {
        runId: 'run-9',
        specPath: 'tests/checkout.testspec.json',
        specHash: 'hash-v1',
        failureSignature: null,
      },
      [entry()],
    )).toBe(1)
    expect(needsHumanIntervention(1)).toBe(false)
    expect(needsHumanIntervention(REPAIR_ROUND_LIMIT)).toBe(true)
    expect(REPAIR_HISTORY_DETAIL_LIMIT).toBe(REPAIR_ROUND_LIMIT - 1)
  })
})
