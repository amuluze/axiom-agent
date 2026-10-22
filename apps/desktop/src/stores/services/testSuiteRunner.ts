/**
 * 套件运行（T3-1）：一次跑多个用例文件。
 *
 * 三条纪律（对齐 safeline 的逐模块编排）：
 * - **串行**：一个文件一个 run，顺序执行；同一次运行共享一个 `batch_id`，报告按它聚合。
 * - **不短路（断言/驱动/准备失败）**：某个文件的断言失败、驱动故障或准备失败，都如实记账后
 *   继续跑下一个——「一个模块红掉不短路」是把「一次跑一整轮」变成可用的关键。但
 *   `environment`/`approval` 归因仍停止后续文件：坏环境不给刷屏，用户拒绝后不再代为批准。
 * - **环境就绪只探一次**：整批共享一次探针结论与事实（逐文件重复探测既扰民又浪费审批），
 *   未就绪则整批不创建任何 run（fail-closed，见 `testEnvironmentReadiness`）。
 *
 * 单文件运行也走这里（`specs` 长度为 1）：执行路径只有一条，才不会出现「单文件能跑、
 * 套件跑不动」这类分叉。
 */
import { createId } from '@/agent/core/id'
import type { TestStepApprover } from '@/agent/testing/approval/testStepApprover'
import type { TestEnvironmentFacts } from '@/agent/testing/environment/envFacts'
import type { CompiledTestPlan } from '@/agent/testing/spec/compileTestPlan'
import { testPlanExecutions, type StepStatusChange } from '@/agent/testing/runner/runTestPlan'
import { stopsBatch, type FailureOrigin } from '@/agent/testing/runner/runState'
import type { TestEnvironmentRecord } from '@/platform/testEnvironments'
import type { TestRunStatus } from '@/platform/testRuns'
import { browserTargetOrigin, prepareUiTestRun } from './testRunPreparation'
import { ensureEnvironmentReady } from './testEnvironmentReadiness'
import { testEnvironmentRuntimeConfig } from './testEnvironmentRuntime'
import { startUiTestRun } from './testRuntimeService'

export interface TestSuiteSpecInput {
  path: string
  /** 来自扫描索引：含 UI 步骤时必须有目标 Browser Tab。 */
  uiStepCount: number
  /** 来自扫描索引：用于判断纯 UI 套件能否跳过 API 就绪探针。 */
  apiStepCount?: number
  /** 来自扫描索引：覆盖分母（测试点）与用例→测试点的追溯（T3-4）。 */
  testPointIds?: readonly string[]
  caseIds?: readonly string[]
  caseVerifies?: readonly (readonly string[])[]
}

export interface TestSuiteRunInput {
  workspacePath: string
  /** 要运行的用例文件（调用方已按范围筛好，且都校验通过）。 */
  specs: readonly TestSuiteSpecInput[]
  environment?: TestEnvironmentRecord
  tab?: { tabId: string; url: string }
  approver: TestStepApprover
  signal: AbortSignal
  /** 发起运行的会话（报告来源追溯）；页面运行通常传当前活动会话。 */
  sourceSessionId?: string
  /** 逐个文件开跑前回调（供 UI 显示「第 n/m 个」并挂上当前 run 的实时视图）。 */
  onRunStarted?: (progress: { index: number; total: number; path: string; runId: string }) => void
  /** 步骤级实时事件（带 runId，供 UI 只更新当前文件）。 */
  onStepStatusChange?: (info: { runId: string; change: StepStatusChange }) => void
}

export interface TestSuiteRunEntry {
  path: string
  /** 只有 `startUiTestRun` 正常返回时才有；准备/目标校验/运行失败均为 `null`（记录可能不存在）。 */
  runId: string | null
  status: TestRunStatus
  /** 未运行/失败的可读原因。 */
  reason?: string
  /**
   * 该文件本次运行的用例状态（覆盖统计 T3-4 的运行证据）。直接取自运行器手里的报告——
   * 覆盖 KPI 因此不需要为批次再回读一遍宿主，也就不会随文件数放大 IPC。
   */
  caseStatuses?: readonly { caseId: string; status: TestRunStatus }[]
  /** 运行计划里冻结的测试点与用例→测试点追溯（覆盖分母，不随源文件修改漂移）。 */
  testPointIds?: readonly string[]
  caseIds?: readonly string[]
  caseVerifies?: readonly (readonly string[])[]
}

export interface TestSuiteRunResult {
  batchId: string
  /** 环境未就绪时非 null：批次级前置失败，`entries` 为空（没有任何 run 被创建）。 */
  blockedReason: string | null
  entries: TestSuiteRunEntry[]
}

/**
 * 含 UI 步骤的用例必须有目标标签页，且页面 origin 必须与用例声明的 webBaseUrl 一致；
 * hook 步骤同样会驱动浏览器，只看 cases 会漏判纯 UI 的 beforeAll/afterEach。
 */
const uiTargetFor = (input: {
  plan: CompiledTestPlan
  tab: { tabId: string; url: string } | undefined
  runId: string
}): { runId: string; tabId: string; origin: string } | undefined => {
  const hasUiSteps = testPlanExecutions(input.plan)
    .some((execution) => execution.steps.some((step) => step.action !== 'api.request'))
  if (!hasUiSteps) return undefined
  if (!input.tab) throw new Error('含 UI 步骤的用例需要先选择一个已打开对应站点的 Browser Tab')
  const origin = browserTargetOrigin(input.tab.url)
  if (input.plan.target.webBaseUrl !== undefined) {
    const expected = browserTargetOrigin(input.plan.target.webBaseUrl)
    if (expected !== origin) {
      throw new Error(`目标标签页与用例站点不一致：用例需要 ${expected}，当前标签页是 ${origin}`)
    }
  }
  return { runId: input.runId, tabId: input.tab.tabId, origin }
}

export const runTestSuite = async (input: TestSuiteRunInput): Promise<TestSuiteRunResult> => {
  const batchId = createId('test-batch')
  const total = input.specs.length
  const entries: TestSuiteRunEntry[] = []
  const runtimeEnvironment = testEnvironmentRuntimeConfig(input.environment)
  const hasApiSteps = input.specs.some((spec) => (spec.apiStepCount ?? 0) > 0)

  let environmentFacts: TestEnvironmentFacts | undefined
  // 纯 UI 套件 + 无 API Base URL 的 remote 环境：没有 API 副作用可探，环境只提供
  // Web target/视口；此时强制 API 探针只会把本来可跑的 UI 测试挡在门外。
  const needsEnvironmentProbe = input.environment !== undefined
    && !(input.environment.apiBaseUrl === null && !hasApiSteps)
  if (input.environment && needsEnvironmentProbe) {
    const gate = await ensureEnvironmentReady({
      environment: input.environment,
      runId: batchId,
      approver: input.approver,
      signal: input.signal,
    })
    if (!gate.readiness.ready) {
      return { batchId, blockedReason: gate.readiness.reason, entries: [] }
    }
    environmentFacts = gate.facts
  }

  /** 已触发批次的归因中断：`environment`（环境坏了）或 `approval`（用户已表态）。 */
  let stopOrigin: FailureOrigin | null = null

  for (const [index, spec] of input.specs.entries()) {
    if (stopOrigin !== null) {
      entries.push({
        path: spec.path,
        runId: null,
        status: 'skipped',
        reason: stopOrigin === 'environment'
          ? '环境不可用（传输层失败或探针未就绪），后续用例未执行'
          : '上一个用例被用户拒绝，后续用例未执行',
      })
      continue
    }
    if (input.signal.aborted) {
      entries.push({ path: spec.path, runId: null, status: 'canceled', reason: '运行已停止，未执行' })
      continue
    }
    const runId = createId('test-run')
    try {
      const plan = await prepareUiTestRun({
        path: spec.path,
        workspacePath: input.workspacePath,
        environment: runtimeEnvironment.values,
        targetOverrides: runtimeEnvironment.targetOverrides,
        runId,
      })
      const target = uiTargetFor({ plan, tab: input.tab, runId })
      // 计划与目标都准备好后再通知 UI：prepare/目标校验失败时 activeRun 不应指向一个
      // 不存在的运行记录，运行页也不会先显示一半再被错误条目取代。
      input.onRunStarted?.({ index: index + 1, total, path: spec.path, runId })
      const report = await startUiTestRun({
        runId,
        specPath: spec.path,
        plan,
        ...(target ? { target } : {}),
        approver: input.approver,
        signal: input.signal,
        ...(input.environment ? { environmentId: input.environment.id } : {}),
        ...(environmentFacts ? { environmentFacts } : {}),
        batchId,
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
        ...(input.onStepStatusChange
          ? { onStepStatusChange: (change) => input.onStepStatusChange?.({ runId, change }) }
          : {}),
      })
      entries.push({
        path: spec.path,
        runId,
        status: report.status,
        caseStatuses: report.cases.map((caseReport) => ({ caseId: caseReport.caseId, status: caseReport.status })),
        testPointIds: (report.testPoints ?? []).map((point) => point.id),
        caseIds: report.caseIds ?? [],
        caseVerifies: report.caseVerifies ?? [],
      })
      // 后果处理：环境坏了就别给坏环境刷屏；用户已拒绝就别替他继续批准。
      // 「测试写错了还是产品有缺陷」不在这里判——那由用户选修复方向。
      const stoppedBy = report.cases
        .flatMap((caseReport) => caseReport.steps.map((step) => step.origin ?? null))
        .find((origin) => stopsBatch(origin))
      if (stoppedBy !== null && stoppedBy !== undefined) stopOrigin = stoppedBy
    } catch (cause) {
      // 一个文件出问题不阻断后续：如实记 error + 原因，继续跑下一个。
      // `runId` 只在 `startUiTestRun` 正常返回时才给出：失败可能发生在「创建运行记录」之前，
      // 此时指向一个不存在的记录会让报告入口变成死链。批次内真实存在的 run 由调用方按
      // batchId 从运行列表里取。
      entries.push({
        path: spec.path,
        runId: null,
        status: 'error',
        reason: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  return { batchId, blockedReason: null, entries }
}
