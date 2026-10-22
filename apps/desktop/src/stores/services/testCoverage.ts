/**
 * 覆盖三数 + 未运行 / 不适用（T3-4，纯函数）。
 *
 * 三个数回答三个不同的问题，任何一个缺失都会让"通过"变成一句空话：
 * - `designed`：**本次运行范围内**解析通过的文件声明了多少个测试点（分母的唯一来源）；
 * - `executed`：其中多少个测试点这次真的跑到了；
 * - `passed`：其中多少个测试点全绿。
 *
 * 分母纪律（与 T0-3 同一份判定，见 `specAudit.ts` 注释）：
 * - 「需要修复」的文件**绝不按 0 计入分母**（否则坏一个文件覆盖率反而变好看）；
 * - **未知/未来协议版本**的文件记「不适用」而不是「未运行」——那不是"没跑"，是"跑不了"；
 * - 范围内已被删除的文件不出现在扫描结果里，因此它既不进分母也不进「需要修复」，
 *   删用例不会让覆盖率上升。
 *
 * 归属规则：测试点的执行证据来自**声明了 `verifies` 该测试点的用例**（v2 的追溯契约）。
 * 一个测试点有多个用例时，全部绿才算通过；跑到了但没全绿记 `failed`；一个都没跑记 `not-run`。
 * 没有任何用例追溯到的测试点永远停在 `not-run`——这本身就是需要修的信号，不假装覆盖。
 */
import type { TestRunStatus } from '@/agent/testing/runner/runState'

export type TestPointCoverage = 'passed' | 'failed' | 'not-run'

/** 扫描得到的单个用例文件（结构上兼容 `specAudit.AuditedSpecFile`）。 */
export interface CoverageSpecFile {
  path: string
  valid: boolean
  issues: readonly { path: string; message: string }[]
  caseIds: readonly string[]
  caseVerifies: readonly (readonly string[])[]
  testPointIds: readonly string[]
}

/** 本次范围内的一次运行（同一 spec 多次运行取**最新**一次；列表按时间倒序传入）。 */
export interface CoverageRunRow {
  specPath: string
  cases: readonly { caseId: string; status: TestRunStatus }[]
}

export interface TestPointCoverageRow {
  specPath: string
  testPointId: string
  state: TestPointCoverage
  /** 声明 `verifies` 该测试点的用例（声明顺序）；空数组 = 没有用例追溯它。 */
  caseIds: readonly string[]
}

export interface TestCoverage {
  designed: number
  executed: number
  passed: number
  notRun: number
  /** 范围内需要修复的文件数（解析失败，且不是版本不支持）。 */
  invalidFiles: number
  /** 范围内无法形成测试点追溯的文件数：未知版本或无 testPoints 的 v1 文件。 */
  notApplicable: number
  byTestPoint: readonly TestPointCoverageRow[]
}

/** 解析器把"版本不支持"记在这个 JSON path 上（`parseTestSpec` 的稳定契约）。 */
const VERSION_ISSUE_PATH = '$.version'

/** 没跑到的状态：排队中与跳过都不算"执行过"。 */
const UNEXECUTED: readonly TestRunStatus[] = ['queued', 'skipped']

export interface TestCoverageInput {
  /**
   * 当前选择面（页面筛选后的扫描结果，含无效文件）：**有效性判定的唯一来源**，
   * 也是「需要修复 / 不适用」两列的统计面——它们正是没能进分母的那批文件。
   */
  files: readonly CoverageSpecFile[]
  /** 本次运行范围（批次内实际尝试的文件）：**只决定分母**（设计/执行/通过三数的范围）。 */
  scopePaths: readonly string[]
  /** 本次范围内的运行行（同一 spec 按时间倒序，取第一条）。 */
  runs: readonly CoverageRunRow[]
}

export const computeTestCoverage = (input: TestCoverageInput): TestCoverage => {
  const scope = new Set(input.scopePaths)
  // 同一 spec 的最新一次运行：列表按时间倒序，第一次出现的即最新。
  const latestRunByPath = new Map<string, CoverageRunRow>()
  for (const run of input.runs) {
    if (!scope.has(run.specPath)) continue
    if (!latestRunByPath.has(run.specPath)) latestRunByPath.set(run.specPath, run)
  }

  let designed = 0
  let executed = 0
  let passed = 0
  let invalidFiles = 0
  let notApplicable = 0
  const byTestPoint: TestPointCoverageRow[] = []

  // 一次遍历选择面：无效文件只进「需要修复 / 不适用」两列；有效但不在本次范围内的文件
  // 既不进分母也不进三数（分母只取本次运行范围）。
  for (const file of input.files) {
    if (!file.valid) {
      if (file.issues.some((issue) => issue.path === VERSION_ISSUE_PATH)) notApplicable += 1
      else invalidFiles += 1
      continue
    }
    if (!scope.has(file.path)) continue
    if (file.testPointIds.length === 0) {
      notApplicable += 1
      continue
    }
    const statuses = new Map<string, TestRunStatus>()
    for (const testCase of latestRunByPath.get(file.path)?.cases ?? []) {
      statuses.set(testCase.caseId, testCase.status)
    }
    for (const testPointId of file.testPointIds) {
      const state = testPointState(file, testPointId, statuses)
      designed += 1
      byTestPoint.push({
        specPath: file.path,
        testPointId,
        state,
        caseIds: verifyingCaseIds(file, testPointId),
      })
      if (state === 'not-run') continue
      executed += 1
      if (state === 'passed') passed += 1
    }
  }

  return {
    designed,
    executed,
    passed,
    notRun: designed - executed,
    invalidFiles,
    notApplicable,
    byTestPoint,
  }
}

/** 追溯该测试点的用例 id（按声明顺序）。 */
const verifyingCaseIds = (file: CoverageSpecFile, testPointId: string): readonly string[] =>
  file.caseIds.filter((_, index) => (file.caseVerifies[index] ?? []).includes(testPointId))

const testPointState = (
  file: CoverageSpecFile,
  testPointId: string,
  statuses: ReadonlyMap<string, TestRunStatus>,
): TestPointCoverage => {
  let sawCase = false
  let sawExecution = false
  let allPassed = true
  for (const [index, caseId] of file.caseIds.entries()) {
    if (!(file.caseVerifies[index] ?? []).includes(testPointId)) continue
    sawCase = true
    const status = statuses.get(caseId)
    // 报告里缺这条用例（计划与结果不一致）按"没跑到"处理，不猜通过。
    if (status === undefined || UNEXECUTED.includes(status)) {
      allPassed = false
      continue
    }
    sawExecution = true
    if (status !== 'passed') allPassed = false
  }
  if (!sawCase || !sawExecution) return 'not-run'
  return allPassed ? 'passed' : 'failed'
}

export interface FrozenCoverageMetadata {
  testPointIds: readonly string[]
  caseIds: readonly string[]
  caseVerifies: readonly (readonly string[])[]
}

export interface CaseStatusRow {
  caseId: string
  status: TestRunStatus
}

const AFTER_EACH_PREFIX = '$afterEach:'
const AFTER_ALL_ID = '$afterAll'

/**
 * 把清理钩子失败折叠回用例：主步骤全过、但清理步骤失败时，测试点不能算通过。
 * - `afterEach` 只影响目标 case；
 * - `afterAll` 是套件级清理，失败会让该文件全部用例失去「通过」资格——它是整批
 *   共享的收尾，不能只把某一条 case 标红，也不能让其余 case 保持绿色；
 * - `beforeEach` 失败会让主 case 变 skipped（保留 not-run），不在这里改成 failed。
 */
export const foldHookFailuresIntoCaseStatuses = (
  cases: readonly CaseStatusRow[],
): CaseStatusRow[] => {
  const statusById = new Map<string, TestRunStatus>(cases.map((item) => [item.caseId, item.status]))
  for (const [caseId, status] of statusById) {
    if (!caseId.startsWith(AFTER_EACH_PREFIX)) continue
    if (status === 'passed' || status === 'skipped') continue
    const targetId = caseId.slice(AFTER_EACH_PREFIX.length)
    if (statusById.get(targetId) === 'passed') statusById.set(targetId, status)
  }
  const afterAllStatus = statusById.get(AFTER_ALL_ID)
  if (afterAllStatus !== undefined && afterAllStatus !== 'passed' && afterAllStatus !== 'skipped') {
    for (const [caseId, status] of statusById) {
      if (caseId.startsWith('$')) continue
      if (status === 'passed') statusById.set(caseId, afterAllStatus)
    }
  }
  return cases.map((item) => ({ caseId: item.caseId, status: statusById.get(item.caseId) ?? item.status }))
}

/**
 * 单份报告的测试点覆盖。`metadata` 必须来自运行时冻结的 plan（或旧报告的当前扫描
 * 回退），绝不能由调用方在报告打开时重新推断 `verifies`。
 */
export const computeReportTestPointCoverage = (input: {
  specPath: string
  cases: readonly { caseId: string; status: TestRunStatus }[]
  metadata: FrozenCoverageMetadata
}): readonly TestPointCoverageRow[] => computeTestCoverage({
  files: [{
    path: input.specPath,
    valid: true,
    issues: [],
    ...input.metadata,
  }],
  scopePaths: [input.specPath],
  runs: [{ specPath: input.specPath, cases: input.cases }],
}).byTestPoint

/**
 * 结论：只有"分母非零且全部通过"才算通过——**全 skipped 绝不能显示成通过**
 * （executed = 0 时 `passed === designed` 只在 designed = 0 时成立，已被 designed > 0 排除）。
 */
export const coverageVerdict = (coverage: TestCoverage): 'passed' | 'not-passed' | 'empty' => {
  if (coverage.designed === 0) return 'empty'
  return coverage.passed === coverage.designed ? 'passed' : 'not-passed'
}
