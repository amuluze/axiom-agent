import { describe, expect, it } from 'vitest'
import {
  computeReportTestPointCoverage,
  computeTestCoverage,
  coverageVerdict,
  foldHookFailuresIntoCaseStatuses,
  type CoverageSpecFile,
} from './testCoverage'

const file = (overrides: Partial<CoverageSpecFile> = {}): CoverageSpecFile => ({
  path: 'tests/checkout.testspec.json',
  valid: true,
  issues: [],
  caseIds: ['c1'],
  caseVerifies: [['tp-1']],
  testPointIds: ['tp-1'],
  ...overrides,
})

describe('computeTestCoverage', () => {
  it('takes the denominator from the run scope, not from the whole workspace', () => {
    const coverage = computeTestCoverage({
      scopePaths: ['tests/checkout.testspec.json'],
      files: [
        file(),
        file({ path: 'tests/other.testspec.json', caseIds: ['c9'], caseVerifies: [['tp-9']], testPointIds: ['tp-9'] }),
      ],
      runs: [{ specPath: 'tests/checkout.testspec.json', cases: [{ caseId: 'c1', status: 'passed' }] }],
    })

    expect(coverage).toMatchObject({ designed: 1, executed: 1, passed: 1, notRun: 0 })
    expect(coverage.byTestPoint).toEqual([
      { specPath: 'tests/checkout.testspec.json', testPointId: 'tp-1', state: 'passed', caseIds: ['c1'] },
    ])
  })

  it('never raises the denominator when a file disappears', () => {
    const scanned = [file()]
    const inScope = ['tests/checkout.testspec.json', 'tests/deleted.testspec.json']
    const coverage = computeTestCoverage({
      scopePaths: inScope,
      files: scanned,
      runs: [{ specPath: 'tests/deleted.testspec.json', cases: [{ caseId: 'gone', status: 'passed' }] }],
    })

    expect(coverage).toMatchObject({ designed: 1, executed: 0, notRun: 1, invalidFiles: 0 })
  })

  it('never reads as passed when everything was skipped', () => {
    const coverage = computeTestCoverage({
      scopePaths: ['tests/checkout.testspec.json'],
      files: [file()],
      runs: [{ specPath: 'tests/checkout.testspec.json', cases: [{ caseId: 'c1', status: 'skipped' }] }],
    })

    expect(coverage).toMatchObject({ designed: 1, executed: 0, passed: 0, notRun: 1 })
    expect(coverageVerdict(coverage)).toBe('not-passed')
    expect(coverageVerdict(computeTestCoverage({ scopePaths: [], files: [], runs: [] }))).toBe('empty')
  })

  it('separates files that need repair from files whose version is not applicable', () => {
    const coverage = computeTestCoverage({
      scopePaths: ['tests/broken.testspec.json', 'tests/future.testspec.json', 'tests/checkout.testspec.json'],
      files: [
        file({ path: 'tests/broken.testspec.json', valid: false, caseIds: [], caseVerifies: [], testPointIds: [], issues: [{ path: '$.cases', message: '缺少 cases' }] }),
        file({ path: 'tests/future.testspec.json', valid: false, caseIds: [], caseVerifies: [], testPointIds: [], issues: [{ path: '$.version', message: '不支持的版本，当前支持 1 / 2 / 3' }] }),
        file(),
      ],
      runs: [],
    })

    // 坏文件不计入分母（否则坏一个文件覆盖率反而变好看）；版本不支持记「不适用」而非「未运行」。
    expect(coverage).toMatchObject({ designed: 1, executed: 0, notRun: 1, invalidFiles: 1, notApplicable: 1 })
  })

  it('counts files that need repair outside the run scope, but keeps them out of the denominator', () => {
    const coverage = computeTestCoverage({
      scopePaths: ['tests/checkout.testspec.json'],
      files: [
        file(),
        file({ path: 'tests/broken.testspec.json', valid: false, caseIds: [], caseVerifies: [], testPointIds: [], issues: [{ path: '$.cases', message: '缺少 cases' }] }),
        file({ path: 'tests/future.testspec.json', valid: false, caseIds: [], caseVerifies: [], testPointIds: [], issues: [{ path: '$.version', message: '不支持的版本' }] }),
      ],
      runs: [],
    })

    expect(coverage).toMatchObject({ designed: 1, invalidFiles: 1, notApplicable: 1 })
  })

  it('requires every verifying case to pass and keeps unattributed points uncovered', () => {
    const coverage = computeTestCoverage({
      scopePaths: ['tests/checkout.testspec.json'],
      files: [file({
        caseIds: ['c1', 'c2', 'c3'],
        caseVerifies: [['tp-1'], ['tp-1'], []],
        testPointIds: ['tp-1', 'tp-2'],
      })],
      runs: [{ specPath: 'tests/checkout.testspec.json', cases: [
        { caseId: 'c1', status: 'passed' },
        { caseId: 'c2', status: 'failed' },
        { caseId: 'c3', status: 'passed' },
      ] }],
    })

    expect(coverage).toMatchObject({ designed: 2, executed: 1, passed: 0, notRun: 1 })
    expect(coverage.byTestPoint).toEqual([
      { specPath: 'tests/checkout.testspec.json', testPointId: 'tp-1', state: 'failed', caseIds: ['c1', 'c2'] },
      // 没有任何用例追溯到的测试点永远停在未运行：不假装覆盖。
      { specPath: 'tests/checkout.testspec.json', testPointId: 'tp-2', state: 'not-run', caseIds: [] },
    ])
  })

  it('uses the newest run of the same spec', () => {
    const coverage = computeTestCoverage({
      scopePaths: ['tests/checkout.testspec.json'],
      files: [file()],
      runs: [
        { specPath: 'tests/checkout.testspec.json', cases: [{ caseId: 'c1', status: 'passed' }] },
        { specPath: 'tests/checkout.testspec.json', cases: [{ caseId: 'c1', status: 'failed' }] },
      ],
    })

    expect(coverage).toMatchObject({ passed: 1, executed: 1 })
  })

  it('reports legacy v1 files without test points as not applicable', () => {
    const coverage = computeTestCoverage({
      scopePaths: ['tests/legacy.testspec.json'],
      files: [file({
        path: 'tests/legacy.testspec.json',
        caseIds: ['c1'],
        caseVerifies: [[]],
        testPointIds: [],
      })],
      runs: [{ specPath: 'tests/legacy.testspec.json', cases: [{ caseId: 'c1', status: 'passed' }] }],
    })

    expect(coverage).toMatchObject({ designed: 0, executed: 0, passed: 0, notApplicable: 1 })
    expect(coverageVerdict(coverage)).toBe('empty')
  })

  it('computes report test points from frozen metadata (not from a later spec edit)', () => {
    const rows = computeReportTestPointCoverage({
      specPath: 'tests/checkout.testspec.json',
      cases: [
        { caseId: 'c1', status: 'passed' },
        { caseId: 'c2', status: 'failed' },
      ],
      metadata: {
        testPointIds: ['tp-frozen'],
        caseIds: ['c1'],
        caseVerifies: [['tp-frozen']],
      },
    })

    expect(rows).toEqual([{
      specPath: 'tests/checkout.testspec.json',
      testPointId: 'tp-frozen',
      state: 'passed',
      caseIds: ['c1'],
    }])
  })

  it('folds an afterEach failure into the target case so the test point cannot pass', () => {
    const folded = foldHookFailuresIntoCaseStatuses([
      { caseId: 'c1', status: 'passed' },
      { caseId: '$afterEach:c1', status: 'failed' },
      { caseId: 'c2', status: 'passed' },
      { caseId: '$afterEach:c2', status: 'passed' },
    ])
    expect(folded).toEqual([
      { caseId: 'c1', status: 'failed' },
      { caseId: '$afterEach:c1', status: 'failed' },
      { caseId: 'c2', status: 'passed' },
      { caseId: '$afterEach:c2', status: 'passed' },
    ])
  })

  it('folds an afterAll failure into every passed case in the suite', () => {
    const folded = foldHookFailuresIntoCaseStatuses([
      { caseId: 'c1', status: 'passed' },
      { caseId: 'c2', status: 'passed' },
      { caseId: 'c3', status: 'skipped' },
      { caseId: '$afterAll', status: 'failed' },
    ])
    expect(folded).toEqual([
      { caseId: 'c1', status: 'failed' },
      { caseId: 'c2', status: 'failed' },
      { caseId: 'c3', status: 'skipped' },
      { caseId: '$afterAll', status: 'failed' },
    ])
  })

  it('does not downgrade cases when afterAll passed or was skipped', () => {
    for (const status of ['passed', 'skipped'] as const) {
      const folded = foldHookFailuresIntoCaseStatuses([
        { caseId: 'c1', status: 'passed' },
        { caseId: '$afterAll', status },
      ])
      expect(folded).toEqual([
        { caseId: 'c1', status: 'passed' },
        { caseId: '$afterAll', status },
      ])
    }
  })
})
