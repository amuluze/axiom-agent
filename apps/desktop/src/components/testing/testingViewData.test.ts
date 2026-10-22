import { describe, expect, it } from 'vitest'
import type { CompiledTestPlan } from '@/agent/testing/spec/compileTestPlan'
import type { TestRunDetailRecord } from '@/platform/testRuns'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import type { TestSuiteRunEntry } from '@/stores/services/testSuiteRunner'
import {
  buildReportTestPoints,
  computeReportKpis,
  computeSuiteCoverage,
  computeSuiteSummary,
  detailValue,
  durationLabel,
  findReportFailure,
  stepDetails,
} from './testingViewData'

const spec = (overrides: Partial<TestSpecIndexEntry> = {}): TestSpecIndexEntry => ({
  path: 'tests/a.testspec.json',
  valid: true,
  id: 'a',
  name: 'A',
  caseCount: 1,
  stepCount: 1,
  uiStepCount: 0,
  apiStepCount: 1,
  issues: [],
  testPointIds: ['tp-1'],
  caseIds: ['case-1'],
  caseVerifies: [['tp-1']],
  ...overrides,
})

const report = (overrides: Partial<TestRunDetailRecord> = {}): TestRunDetailRecord => ({
  summary: {
    id: 'run-1',
    specPath: 'tests/a.testspec.json',
    specHash: 'hash',
    environmentId: null,
    batchId: null,
    envFactsJson: null,
    status: 'failed',
    startedAt: 1_000,
    finishedAt: 2_500,
  },
  planContentHash: 'plan-hash',
  cases: [{
    id: 'case-run',
    caseId: 'case-1',
    caseName: 'case',
    status: 'failed',
    startedAt: 1_000,
    finishedAt: 2_000,
    failureKind: 'assertion',
    failureOrigin: 'assertion',
    steps: [
      {
        id: 'step-1', stepId: 'step-1', action: 'api.request', status: 'passed',
        startedAt: 1_000, finishedAt: 1_100, detailsJson: null,
        evidenceContentHash: null, evidenceArtifact: null,
      },
      {
        id: 'step-2', stepId: 'step-2', action: 'api.request', status: 'failed',
        startedAt: 1_100, finishedAt: 2_000, detailsJson: '{"message":"boom"}',
        evidenceContentHash: null, evidenceArtifact: null,
      },
    ],
  }],
  ...overrides,
})

describe('testingViewData', () => {
  it('summarizes suite entries and keeps problem entries', () => {
    const entries: TestSuiteRunEntry[] = [
      { path: 'a', runId: '1', status: 'passed' },
      { path: 'b', runId: '2', status: 'failed' },
      { path: 'c', runId: '3', status: 'skipped' },
    ]
    expect(computeSuiteSummary(entries)).toMatchObject({
      passed: 1, failed: 1, other: 1, total: 3,
      problems: [{ path: 'b' }, { path: 'c' }],
    })
    expect(computeSuiteSummary([])).toBeNull()
  })

  it('aggregates report KPIs by steps and falls back to case status', () => {
    expect(computeReportKpis(report())).toMatchObject({
      passed: 1, failed: 1, error: 0, rejected: 0, skipped: 0, duration: '1.5 s',
    })
    const noSteps = report({
      cases: [{
        ...report().cases[0]!,
        steps: [],
      }],
    })
    expect(computeReportKpis(noSteps)).toMatchObject({ passed: 0, failed: 1 })
    expect(computeReportKpis(null)).toBeNull()
  })

  it('finds the first failed case and its first failed step', () => {
    expect(findReportFailure(report())).toMatchObject({
      testCase: { caseId: 'case-1' },
      step: { stepId: 'step-2' },
    })
    const passed = report({ cases: [{ ...report().cases[0]!, status: 'passed' }] })
    expect(findReportFailure(passed)).toBeNull()
    expect(findReportFailure(null)).toBeNull()
  })

  it('computes suite coverage from frozen metadata and current filtered specs', () => {
    const coverage = computeSuiteCoverage({
      entries: [{
        path: 'tests/a.testspec.json',
        runId: 'run-1',
        status: 'passed',
        caseStatuses: [{ caseId: 'case-1', status: 'passed' }],
        testPointIds: ['tp-1'],
        caseIds: ['case-1'],
        caseVerifies: [['tp-1']],
      }],
      specs: [spec()],
      filteredSpecs: [spec(), spec({ path: 'tests/bad.testspec.json', valid: false, issues: [{ path: '$', message: 'bad' }] })],
    })
    expect(coverage).toMatchObject({ designed: 1, executed: 1, passed: 1, invalidFiles: 1 })
    expect(computeSuiteCoverage({ entries: [], specs: [], filteredSpecs: [] })).toBeNull()
  })

  it('prefers the frozen plan for report test points and falls back to the scan', () => {
    const frozen: CompiledTestPlan = {
      specId: 'a',
      name: 'A',
      specVersion: 2,
      specHash: 'hash',
      target: {},
      environmentNames: [],
      testPoints: [{ id: 'tp-1', kind: 'new_feature', title: 'tp', acceptance: 'ok' }],
      cases: [{ id: 'case-1', name: 'case', verifies: ['tp-1'], steps: [] }],
    } as unknown as CompiledTestPlan
    expect(buildReportTestPoints({ report: report(), frozenPlan: frozen, scannedSpec: undefined }))
      .toMatchObject([{ testPointId: 'tp-1', state: 'failed' }])
    expect(buildReportTestPoints({
      report: report({ planContentHash: null }),
      frozenPlan: null,
      scannedSpec: spec(),
    })).toMatchObject([{ testPointId: 'tp-1', state: 'failed' }])
    expect(buildReportTestPoints({ report: report(), frozenPlan: null, scannedSpec: spec() })).toBeUndefined()
  })

  it('parses step details and formats durations', () => {
    expect(stepDetails('{"message":"x","expected":1}')).toMatchObject({ message: 'x', expected: 1 })
    expect(stepDetails('not json')).toEqual({})
    expect(stepDetails(null)).toEqual({})
    expect(detailValue({ a: 1 })).toBe('{"a":1}')
    expect(detailValue('x')).toBe('x')
    expect(durationLabel(1_000, 1_500)).toBe('500 ms')
    expect(durationLabel(1_000, 2_500)).toBe('1.5 s')
    expect(durationLabel(null, 2_500)).toBeNull()
  })
})
