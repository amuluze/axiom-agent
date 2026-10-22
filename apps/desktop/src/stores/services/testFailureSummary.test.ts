import { describe, expect, it } from 'vitest'
import type { TestRunDetailRecord } from '@/platform/testRuns'
import { buildTestFailureSummary } from './testFailureSummary'

const report: TestRunDetailRecord = {
  summary: {
    id: 'run-1',
    specPath: 'tests/checkout.testspec.json',
    specHash: 'spec-hash',
    environmentId: 'staging',
    batchId: null,
    envFactsJson: null,
    status: 'failed',
    startedAt: 1,
    finishedAt: 2,
  },
  planContentHash: 'plan-hash',
  cases: [{
    id: 'case-run-1',
    caseId: 'checkout',
    caseName: '结算',
    status: 'failed',
    startedAt: 1,
    finishedAt: 2,
    failureKind: 'assertion',
    failureOrigin: 'assertion',
    steps: [{
      id: 'step-run-1',
      stepId: 'assert-total',
      action: 'ui.assert',
      status: 'failed',
      startedAt: 1,
      finishedAt: 2,
      detailsJson: JSON.stringify({ message: '金额不一致' }),
      evidenceContentHash: 'a'.repeat(64),
      evidenceArtifact: null,
    }],
  }],
}

describe('buildTestFailureSummary', () => {
  it('includes run identity, failed steps, bounded messages and evidence hashes', () => {
    const summary = buildTestFailureSummary(report)
    expect(summary).toContain('Run ID: run-1')
    expect(summary).toContain('结算 / assert-total [failed] ui.assert')
    expect(summary).toContain('金额不一致')
    expect(summary).toContain(`证据 SHA-256: ${'a'.repeat(64)}`)
    // 归因统计：修复方一眼分清「先修环境」还是「改断言」。
    expect(summary).toContain('失败归因：断言不成立 ×1')
  })

  it('lists test point coverage with the verifying cases when the caller knows the spec', () => {
    const summary = buildTestFailureSummary(report, {
      testPoints: [
        { specPath: 'tests/checkout.testspec.json', testPointId: 'tp-1', state: 'failed', caseIds: ['checkout'] },
        { specPath: 'tests/checkout.testspec.json', testPointId: 'tp-2', state: 'not-run', caseIds: [] },
      ],
    })

    expect(summary).toContain('测试点覆盖：tp-1 [未通过]（用例 checkout） · tp-2 [未运行]（无用例追溯）')
  })

  it('calls out a green test-point line on a failed run instead of implying product health', () => {
    const summary = buildTestFailureSummary(report, {
      testPoints: [
        { specPath: 'tests/checkout.testspec.json', testPointId: 'tp-1', state: 'passed', caseIds: ['checkout'] },
      ],
    })

    expect(summary).toContain('测试点覆盖：tp-1 [通过]')
    expect(summary).toContain('测试点覆盖为全绿，但本次运行状态为「failed」')
    expect(summary).toContain('hook 或未追溯用例')
  })
})
