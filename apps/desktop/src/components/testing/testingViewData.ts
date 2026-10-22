import type { CompiledTestPlan } from '@/agent/testing/spec/compileTestPlan'
import { readArtifactText } from '@/platform/artifacts'
import type {
  TestCaseDetailRecord,
  TestRunDetailRecord,
  TestRunStatus,
  TestStepDetailRecord,
} from '@/platform/testRuns'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import type { TestSuiteRunEntry } from '@/stores/services/testSuiteRunner'
import {
  computeReportTestPointCoverage,
  computeTestCoverage,
  foldHookFailuresIntoCaseStatuses,
  type CoverageSpecFile,
  type FrozenCoverageMetadata,
} from '@/stores/services/testCoverage'

/**
 * 测试页的数据投影与 artifact 读取（F1 切片）。
 *
 * 这里只放**无 React 状态**的纯函数/读取器：TestingView 继续持有扫描、选择与运行
 * 生命周期；数据形状、覆盖归因与报告 KPI 的判定集中在此，便于单测。
 */

/** plan artifact 的最小形状校验：测试点覆盖只需要 cases[].verifies / testPoints。 */
export const parseReportPlan = (text: string): CompiledTestPlan | null => {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { cases?: unknown }).cases)) {
      return null
    }
    return parsed as CompiledTestPlan
  } catch {
    return null
  }
}

/** 读取并解析 plan artifact；读不到返回 null，由调用方决定 fail-soft 口径。 */
export const loadPlanArtifact = async (contentHash: string): Promise<CompiledTestPlan | null> => {
  try {
    return parseReportPlan(await readArtifactText(contentHash))
  } catch {
    return null
  }
}

export const coverageEntryFromIndex = (spec: TestSpecIndexEntry): CoverageSpecFile => ({
  path: spec.path,
  valid: spec.valid,
  issues: spec.issues,
  testPointIds: spec.testPointIds ?? [],
  caseIds: spec.caseIds ?? [],
  caseVerifies: spec.caseVerifies ?? [],
})

export interface StepDetails {
  message?: string
  expected?: unknown
  actual?: unknown
  name?: string
}

export const stepDetails = (detailsJson: string | null): StepDetails => {
  if (!detailsJson) return {}
  try {
    const parsed: unknown = JSON.parse(detailsJson)
    if (typeof parsed === 'object' && parsed !== null) return parsed as StepDetails
  } catch {
    return {}
  }
  return {}
}

export const detailValue = (details: unknown): string =>
  typeof details === 'string' ? details : JSON.stringify(details)

export const durationLabel = (startedAt: number | null, finishedAt: number | null): string | null => {
  if (startedAt === null || finishedAt === null) return null
  const milliseconds = Math.max(0, finishedAt - startedAt)
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`
}

/** 批次摘要：通过/失败/其他 + 未通过的文件与原因。 */
export const computeSuiteSummary = (entries: readonly TestSuiteRunEntry[]) => {
  if (entries.length === 0) return null
  const counts = { passed: 0, failed: 0, other: 0 }
  for (const entry of entries) {
    if (entry.status === 'passed') counts.passed += 1
    else if (['failed', 'error', 'rejected', 'interrupted'].includes(entry.status)) counts.failed += 1
    else counts.other += 1
  }
  return {
    ...counts,
    total: entries.length,
    problems: entries.filter((entry) => entry.status !== 'passed'),
  }
}

/** 报告 KPI：按步骤聚合、无步骤回退用例。 */
export const computeReportKpis = (report: TestRunDetailRecord | null) => {
  if (!report) return null
  const units = report.cases.flatMap((testCase) => testCase.steps.length > 0
    ? testCase.steps.map((step) => step.status)
    : [testCase.status])
  const count = (...statuses: TestRunStatus[]): number =>
    units.filter((status) => statuses.includes(status)).length
  return {
    passed: count('passed'),
    failed: count('failed'),
    error: count('error', 'interrupted'),
    rejected: count('rejected'),
    skipped: count('skipped', 'canceled', 'queued'),
    duration: durationLabel(report.summary.startedAt, report.summary.finishedAt),
  }
}

/** 报告失败详情卡：首个 failed/error 用例与其首个失败步骤（无失败步骤则取首步）。 */
export const findReportFailure = (
  report: TestRunDetailRecord | null,
): { testCase: TestCaseDetailRecord; step: TestStepDetailRecord | null } | null => {
  if (!report) return null
  for (const testCase of report.cases) {
    if (testCase.status !== 'failed' && testCase.status !== 'error') continue
    const step = testCase.steps.find((candidate) => candidate.status === 'failed' || candidate.status === 'error')
      ?? testCase.steps[0]
    return { testCase, step: step ?? null }
  }
  return null
}

/**
 * 覆盖三数：分母只取本次运行范围，执行证据来自套件运行器手里的报告；
 * 范围文件的测试点/追溯优先用运行时冻结的 plan 元数据。
 */
export const computeSuiteCoverage = (input: {
  entries: readonly TestSuiteRunEntry[]
  specs: readonly TestSpecIndexEntry[]
  filteredSpecs: readonly TestSpecIndexEntry[]
}) => {
  if (input.entries.length === 0) return null
  const scopePaths = input.entries.map((entry) => entry.path)
  const byPath = new Map(input.specs.map((spec) => [spec.path, spec] as const))
  const files: CoverageSpecFile[] = []
  const covered = new Set<string>()
  for (const entry of input.entries) {
    if (entry.testPointIds !== undefined || entry.caseIds !== undefined || entry.caseVerifies !== undefined) {
      files.push({
        path: entry.path,
        valid: true,
        issues: [],
        testPointIds: entry.testPointIds ?? [],
        caseIds: entry.caseIds ?? [],
        caseVerifies: entry.caseVerifies ?? [],
      })
      covered.add(entry.path)
      continue
    }
    const current = byPath.get(entry.path)
    if (current) {
      files.push(coverageEntryFromIndex(current))
      covered.add(entry.path)
      continue
    }
    files.push({
      path: entry.path,
      valid: false,
      issues: [{ path: '$', message: entry.reason ?? '用例文件已不存在' }],
      testPointIds: [],
      caseIds: [],
      caseVerifies: [],
    })
    covered.add(entry.path)
  }
  for (const spec of input.filteredSpecs) {
    if (!covered.has(spec.path)) files.push(coverageEntryFromIndex(spec))
  }
  return computeTestCoverage({
    files,
    scopePaths,
    runs: input.entries
      .filter((entry) => entry.caseStatuses !== undefined)
      .map((entry) => ({
        specPath: entry.path,
        cases: foldHookFailuresIntoCaseStatuses(entry.caseStatuses ?? []),
      })),
  })
}

/**
 * 报告所属 spec 的测试点覆盖：优先冻结 plan；只有旧报告没有 plan artifact 时
 * 才回退到当前扫描结果。
 */
export const buildReportTestPoints = (input: {
  report: TestRunDetailRecord | null
  frozenPlan: CompiledTestPlan | null
  scannedSpec: TestSpecIndexEntry | undefined
}) => {
  if (!input.report) return undefined
  if (input.report.planContentHash !== null && input.frozenPlan === null) return undefined
  const metadata: FrozenCoverageMetadata | null = input.frozenPlan !== null
    ? {
        testPointIds: input.frozenPlan.testPoints?.map((point) => point.id) ?? [],
        caseIds: input.frozenPlan.cases.map((testCase) => testCase.id),
        caseVerifies: input.frozenPlan.cases.map((testCase) => testCase.verifies ?? []),
      }
    : input.scannedSpec !== undefined
      ? {
          testPointIds: input.scannedSpec.testPointIds,
          caseIds: input.scannedSpec.caseIds,
          caseVerifies: input.scannedSpec.caseVerifies,
        }
      : null
  if (metadata === null) return undefined
  return computeReportTestPointCoverage({
    specPath: input.report.summary.specPath,
    cases: foldHookFailuresIntoCaseStatuses(input.report.cases.map((testCase) => ({
      caseId: testCase.caseId,
      status: testCase.status,
    }))),
    metadata,
  })
}
