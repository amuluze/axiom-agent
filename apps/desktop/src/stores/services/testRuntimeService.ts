import {
  createTestRunRecord,
  transitionTestCaseRecord,
  transitionTestRunRecord,
  transitionTestStepRecord,
  type NewTestRunRecord,
} from '@/platform/testRuns'
import { createUiTestDriver, type UiTestTarget } from '@/platform/testAutomation'
import type { TestStepApprover } from '@/agent/testing/approval/testStepApprover'
import type { CompiledTestPlan } from '@/agent/testing/spec/compileTestPlan'
import {
  runTestPlan,
  testPlanExecutions,
  type StepStatusChange,
  type TestRunReport,
  type UiTestDriver,
} from '@/agent/testing/runner/runTestPlan'
import { canonicalJson } from '@/agent/testing/spec/compileTestPlan'
import { failureOriginForCase } from '@/agent/testing/runner/runState'
import { serializeEnvironmentFacts, type TestEnvironmentFacts } from '@/agent/testing/environment/envFacts'
import { writeJsonArtifact } from '@/platform/artifacts'
import { issueTestTargetGrant, revokeTestTargetGrant } from '@/platform/testTarget'
import { createApiTestDriver } from '@/platform/apiTestAutomation'
import { runtimeFaultCheckpoint } from '@/platform/runtimeFaultInjection'

const UNAVAILABLE_UI_DRIVER: UiTestDriver = {
  runStep: async () => ({ verdict: 'error', message: '当前测试运行未配置 UI 目标' }),
}

const caseRecordId = (runId: string, caseId: string): string => `${runId}:${caseId}`
const stepRecordId = (runId: string, caseId: string, stepId: string): string => `${runId}:${caseId}:${stepId}`

const failureKindFor = (status: TestRunReport['status']): string | undefined => {
  if (status === 'failed') return 'assertion'
  if (status === 'error') return 'driver'
  if (status === 'rejected') return 'approval'
  if (status === 'canceled') return 'canceled'
  if (status === 'interrupted') return 'interrupted'
  return undefined
}

const recordFor = (
  runId: string,
  plan: CompiledTestPlan,
  specPath: string,
  planContentHash: string,
  startedAt: number,
  environmentId?: string,
  environmentFacts?: TestEnvironmentFacts,
  batchId?: string,
  sourceSessionId?: string,
): NewTestRunRecord => ({
  id: runId,
  specPath,
  specHash: plan.specHash,
  planContentHash,
  ...(sourceSessionId ? { sourceSessionId } : {}),
  environmentId,
  ...(batchId === undefined ? {} : { batchId }),
  ...(environmentFacts ? { envFactsJson: serializeEnvironmentFacts(environmentFacts) } : {}),
  startedAt,
  cases: testPlanExecutions(plan).map((execution) => ({
    id: caseRecordId(runId, execution.id),
    caseId: execution.id,
    caseName: execution.name,
    steps: execution.steps.map((step) => ({
      id: stepRecordId(runId, execution.id, step.id),
      stepId: step.id,
      action: step.action,
    })),
  })),
})

export interface StartUiTestRunInput {
  runId: string
  specPath: string
  plan: CompiledTestPlan
  target?: UiTestTarget
  approver: TestStepApprover
  signal: AbortSignal
  now?: () => number
  environmentId?: string
  /** 本次运行的环境与探针事实快照（T1-4），随运行一起落库。 */
  environmentFacts?: TestEnvironmentFacts
  /** 套件运行分组键（T3-1）：同一次套件运行的所有 spec 共享它。 */
  batchId?: string
  /** 发起运行的会话（报告来源追溯）。 */
  sourceSessionId?: string
  onStepStatusChange?: (change: StepStatusChange) => void
}

/**
 * 运行一个已编译的 UI 计划并把状态逐步落库。持久化按事件顺序串行执行；任一落库失败会在运行结束后抛出，
 * 不静默吞掉，避免报告与实际执行脱节。
 */
export const startUiTestRun = async (input: StartUiTestRunInput): Promise<TestRunReport> => {
  const { runId, specPath, plan, target, approver, signal } = input
  const now = input.now ?? Date.now
  const executions = testPlanExecutions(plan)
  const hasUiSteps = executions.some((execution) => execution.steps.some((step) => step.action !== 'api.request'))
  if (hasUiSteps && !target) throw new Error('UI 测试计划缺少浏览器目标')

  if (target) {
    await issueTestTargetGrant({
      runId,
      tabId: target.tabId,
      expectedOrigin: target.origin,
      ...(plan.target.viewport ? { viewport: plan.target.viewport } : {}),
    })
  }
  let runStarted = false
  try {
    const planArtifact = await writeJsonArtifact(canonicalJson(plan))
    await createTestRunRecord(recordFor(
      runId,
      plan,
      specPath,
      planArtifact.contentHash,
      now(),
      input.environmentId,
      input.environmentFacts,
      input.batchId,
      input.sourceSessionId,
    ))
    await transitionTestRunRecord(runId, 'running')
    runStarted = true

    let chain: Promise<void> = Promise.resolve()
    const persistence: { error?: unknown } = {}
    const started = new Set<string>()
    const steps = new Map(executions.flatMap((execution) => execution.steps.map((step) => [
      `${execution.id}:${step.id}`,
      step,
    ] as const)))
    const persist = (work: () => Promise<void>): void => {
      chain = chain.then(work).catch((error: unknown) => {
        persistence.error ??= error
      })
    }

    const onStepStatusChange = (change: StepStatusChange): void => {
      if (change.status === 'running' && !started.has(change.caseId)) {
        started.add(change.caseId)
        const caseId = caseRecordId(runId, change.caseId)
        persist(() => transitionTestCaseRecord(caseId, 'running', now()))
      }
      const stepId = stepRecordId(runId, change.caseId, change.stepId)
      const step = steps.get(`${change.caseId}:${change.stepId}`)
      const terminal = !['queued', 'running', 'waiting_approval'].includes(change.status)
      const details = terminal
        ? JSON.stringify({
            ...(change.message !== undefined ? { message: change.message } : {}),
            ...(step && 'expect' in step ? { expected: step.expect } : {}),
            ...(step?.action === 'ui.screenshot' && step.name !== undefined ? { name: step.name } : {}),
            ...(change.variables !== undefined ? { variables: change.variables } : {}),
            actual: change.message ?? { verdict: change.status },
          })
        : undefined
      persist(() => transitionTestStepRecord(stepId, change.status, now(), details, change.evidenceContentHash))
      if (change.status === 'waiting_approval') {
        // H1-4 故障窗口：等待审批已落库、审批尚未放行。挂在同一持久化链上保证
        // SIGKILL 之前状态确实已提交；非 E2E 构建里 runtimeFaultCheckpoint 为 no-op。
        chain = chain
          .then(() => runtimeFaultCheckpoint('test_step_awaiting_approval'))
          .catch(() => undefined)
      }
      input.onStepStatusChange?.(change)
    }

    const report = await runTestPlan({
      plan,
      ui: target ? createUiTestDriver(target, { approve: approver.approve }) : UNAVAILABLE_UI_DRIVER,
      api: createApiTestDriver({
        runId,
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      }, approver),
      signal,
      onStepStatusChange,
    })
    await chain
    if (persistence.error !== undefined) throw persistence.error

    for (const caseReport of report.cases) {
      persist(() => transitionTestCaseRecord(
        caseRecordId(runId, caseReport.caseId),
        caseReport.status,
        now(),
        failureKindFor(caseReport.status),
        // 归因来自**首个未通过步骤**的宿主判定（environment/approval/driver/assertion）；
        // 「测试写错了还是产品有缺陷」不在这里判——那由用户选修复方向（usage §4.5）。
        failureOriginForCase(caseReport.steps) ?? undefined,
      ))
    }
    await chain
    if (persistence.error !== undefined) throw persistence.error

    await transitionTestRunRecord(runId, report.status, now())
    return report
  } catch (error) {
    // 运行已经开始后任何持久化/执行异常都不能让记录停在 running：否则 UI 打不开
    // 报告，且只能等下次启动恢复才变 interrupted。尽力收敛为 error，保留原始异常。
    if (runStarted) {
      try {
        await transitionTestRunRecord(runId, 'error', now())
      } catch {
        // 数据库本身不可用时无法再写；启动恢复仍会把遗留 run 标为 interrupted。
      }
    }
    throw error
  } finally {
    if (target) await revokeTestTargetGrant(runId)
  }
}
