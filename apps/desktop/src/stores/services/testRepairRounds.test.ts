import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TestRunDetailRecord, TestRunSummaryRecord } from '@/platform/testRuns'

const mocks = vi.hoisted(() => ({
  listTestRunRecords: vi.fn(),
  getTestRunRecord: vi.fn(),
}))

vi.mock('@/platform/testRuns', () => ({
  listTestRunRecords: mocks.listTestRunRecords,
  getTestRunRecord: mocks.getTestRunRecord,
}))

import { resolveRepairRounds } from './testRepairRounds'

const summary = (id: string, overrides: Partial<TestRunSummaryRecord> = {}): TestRunSummaryRecord => ({
  id,
  specPath: 'tests/checkout.testspec.json',
  specHash: 'hash',
  environmentId: null,
  batchId: null,
  envFactsJson: null,
  status: 'failed',
  startedAt: 1,
  finishedAt: 2,
  ...overrides,
})

const detail = (id: string, failingStepId: string | null): TestRunDetailRecord => ({
  summary: summary(id),
  planContentHash: 'plan',
  cases: [{
    id: `${id}-case`,
    caseId: 'checkout',
    caseName: '结算',
    status: failingStepId === null ? 'passed' : 'failed',
    startedAt: 1,
    finishedAt: 2,
    failureKind: failingStepId === null ? null : 'assertion',
    failureOrigin: failingStepId === null ? null : 'assertion',
    steps: [{
      id: `${id}-step`,
      stepId: failingStepId ?? 'assert-total',
      action: 'ui.assert',
      status: failingStepId === null ? 'passed' : 'failed',
      startedAt: 1,
      finishedAt: 2,
      detailsJson: null,
      evidenceContentHash: null,
      evidenceArtifact: null,
    }],
  }],
})

describe('resolveRepairRounds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('counts consecutive rounds with the same failing step and escalates at the limit', async () => {
    mocks.listTestRunRecords.mockResolvedValue([
      summary('run-3'),
      summary('run-2'),
      summary('run-1'),
    ])
    mocks.getTestRunRecord.mockImplementation(async (id: string) => detail(id, 'assert-total'))

    await expect(resolveRepairRounds(detail('run-3', 'assert-total'))).resolves.toEqual({ rounds: 3, needsHuman: true })
    // 判定封顶只需两条历史详情：报告打开路径不做无界回读。
    expect(mocks.getTestRunRecord).toHaveBeenCalledTimes(2)
  })

  it('breaks the streak on a passing round or a different failure', async () => {
    mocks.listTestRunRecords.mockResolvedValue([summary('run-2'), summary('run-1')])
    mocks.getTestRunRecord.mockImplementation(async (id: string) =>
      id === 'run-2' ? detail(id, null) : detail(id, 'assert-total'))

    await expect(resolveRepairRounds(detail('run-3', 'assert-total'))).resolves.toEqual({ rounds: 1, needsHuman: false })

    vi.clearAllMocks()
    mocks.listTestRunRecords.mockResolvedValue([summary('run-2')])
    mocks.getTestRunRecord.mockResolvedValue(detail('run-2', 'assert-shipping'))
    await expect(resolveRepairRounds(detail('run-3', 'assert-total'))).resolves.toEqual({ rounds: 1, needsHuman: false })
  })

  it('ignores other specs and stays conservative when history is unreadable', async () => {
    mocks.listTestRunRecords.mockResolvedValue([summary('other', { specPath: 'tests/other.testspec.json' })])
    await expect(resolveRepairRounds(detail('run-3', 'assert-total'))).resolves.toEqual({ rounds: 1, needsHuman: false })
    expect(mocks.getTestRunRecord).not.toHaveBeenCalled()

    mocks.listTestRunRecords.mockRejectedValue(new Error('宿主读取失败'))
    await expect(resolveRepairRounds(detail('run-3', 'assert-total'))).resolves.toBeNull()

    // 详情读不到 → 少算一轮（不给假「需要人工介入」）。
    mocks.listTestRunRecords.mockResolvedValue([summary('run-2')])
    mocks.getTestRunRecord.mockResolvedValue(null)
    await expect(resolveRepairRounds(detail('run-3', 'assert-total'))).resolves.toEqual({ rounds: 1, needsHuman: false })
  })

  it('reports the first round for a passing report without reading history', async () => {
    await expect(resolveRepairRounds(detail('run-3', null))).resolves.toEqual({ rounds: 1, needsHuman: false })
    expect(mocks.listTestRunRecords).not.toHaveBeenCalled()
  })
})
