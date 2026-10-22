import { materializeTestStepVariables, type CompiledTestPlan } from '../spec/compileTestPlan'
import type { ApiStepSpec, ExtractedTestValue, TestPointSpec, TestStepSpec, TestValue, UiStepSpec } from '../spec/types'
import {
  aggregateStatus,
  failureOriginForOutcome,
  transitionStatus,
  type FailureOrigin,
  type StepVerdict,
  type TestRunStatus,
} from './runState'

/** 驱动返回的首次判定。verdict 由宿主产生，模型不得覆盖。`message` 必须已脱敏。 */
export interface StepOutcome {
  verdict: StepVerdict
  /**
   * 失败归因的**驱动事实**（只有 `error` 用得上）：驱动明确知道是传输层还是步骤层。
   * 缺省时按 `driver` 解释（见 `runState.failureOriginForOutcome`）。
   */
  origin?: FailureOrigin
  message?: string
  /** 证据 Artifact 的内容 hash；由 Rust 直写后回传引用，不携带图片内容。 */
  evidenceContentHash?: string
  extractedVariables?: Record<string, ExtractedTestValue>
}

export interface StepExecutionContext {
  signal: AbortSignal
  /** 前序敏感提取值：API 驱动将它们用于证据脱敏；UI 驱动忽略。 */
  sensitiveValues?: readonly string[]
  markWaitingApproval: () => void
  markRunning: () => void
}

export interface UiTestDriver {
  runStep: (step: UiStepSpec, context: StepExecutionContext) => Promise<StepOutcome>
}

export interface ApiTestDriver {
  runStep: (step: ApiStepSpec, context: StepExecutionContext) => Promise<StepOutcome>
}

export interface StepReport {
  stepId: string
  action: TestStepSpec['action']
  status: TestRunStatus
  /** 失败的客观归因（宿主判定，报告与失败摘要消费）；通过/取消时为 undefined。 */
  origin?: FailureOrigin
  message?: string
  evidenceContentHash?: string
  variables?: Record<string, VariableProjection>
}

export interface VariableProjection {
  sourceStepId: string
  value: TestValue | '[REDACTED]'
  sensitive: boolean
}

export interface CaseReport {
  caseId: string
  name: string
  scope?: TestExecutionScope
  status: TestRunStatus
  steps: StepReport[]
}

export type TestHookName = 'beforeAll' | 'beforeEach' | 'afterEach' | 'afterAll'

export type TestExecutionScope =
  | { kind: 'case' }
  | { kind: 'hook'; hook: TestHookName; targetCaseId?: string }

export interface TestPlanExecution {
  id: string
  name: string
  scope: TestExecutionScope
  steps: readonly TestStepSpec[]
}

export interface TestRunReport {
  specHash: string
  status: TestRunStatus
  cases: CaseReport[]
  /**
   * 编译期冻结的覆盖元数据：报告/覆盖统计必须用它，而不是运行结束后重新扫描
   * 工作区（源文件可能已被修改或删除）。`caseVerifies` 与 plan.cases 同序。
   */
  testPoints: readonly TestPointSpec[]
  caseIds: readonly string[]
  caseVerifies: readonly (readonly string[])[]
}

export interface StepStatusChange {
  caseId: string
  stepId: string
  status: TestRunStatus
  message?: string
  evidenceContentHash?: string
  variables?: Record<string, VariableProjection>
}

export interface RunTestPlanOptions {
  plan: CompiledTestPlan
  ui: UiTestDriver
  api: ApiTestDriver
  signal: AbortSignal
  onStepStatusChange?: (change: StepStatusChange) => void
}

const UNEXPECTED_DRIVER_MESSAGE = '驱动执行异常，详情已省略以避免泄漏敏感信息'
const INVALID_EXTRACTION_MESSAGE = '驱动返回的变量提取结果与测试计划不一致'

export const testPlanExecutions = (plan: CompiledTestPlan): TestPlanExecution[] => {
  const executions: TestPlanExecution[] = []
  if (plan.hooks?.beforeAll) {
    executions.push({ id: '$beforeAll', name: 'beforeAll', scope: { kind: 'hook', hook: 'beforeAll' }, steps: plan.hooks.beforeAll })
  }
  for (const testCase of plan.cases) {
    if (plan.hooks?.beforeEach) {
      executions.push({
        id: `$beforeEach:${testCase.id}`,
        name: `beforeEach · ${testCase.name}`,
        scope: { kind: 'hook', hook: 'beforeEach', targetCaseId: testCase.id },
        steps: plan.hooks.beforeEach,
      })
    }
    executions.push({ id: testCase.id, name: testCase.name, scope: { kind: 'case' }, steps: testCase.steps })
    if (plan.hooks?.afterEach) {
      executions.push({
        id: `$afterEach:${testCase.id}`,
        name: `afterEach · ${testCase.name}`,
        scope: { kind: 'hook', hook: 'afterEach', targetCaseId: testCase.id },
        steps: plan.hooks.afterEach,
      })
    }
  }
  if (plan.hooks?.afterAll) {
    executions.push({ id: '$afterAll', name: 'afterAll', scope: { kind: 'hook', hook: 'afterAll' }, steps: plan.hooks.afterAll })
  }
  return executions
}

const createReport = (plan: CompiledTestPlan): TestRunReport => ({
  specHash: plan.specHash,
  status: 'queued',
  testPoints: plan.testPoints ?? [],
  caseIds: plan.cases.map((testCase) => testCase.id),
  caseVerifies: plan.cases.map((testCase) => testCase.verifies ?? []),
  cases: testPlanExecutions(plan).map((execution) => ({
    caseId: execution.id,
    name: execution.name,
    ...(execution.scope.kind === 'hook' ? { scope: execution.scope } : {}),
    status: 'queued',
    steps: execution.steps.map((step) => ({ stepId: step.id, action: step.action, status: 'queued' })),
  })),
})

/**
 * 串行执行已编译计划。默认 fail-fast：任一步骤非 passed 即停止整个 run，其后步骤按原因
 * 记为 skipped（失败/拒绝）或 canceled（用户停止）。每步只执行一次，不做隐式重试。
 * 驱动抛出的异常记为 error，且只保存固定文案，不回传原始错误信息。
 */
export const runTestPlan = async (options: RunTestPlanOptions): Promise<TestRunReport> => {
  const { plan, ui, api, signal, onStepStatusChange } = options
  const report = createReport(plan)
  const executions = testPlanExecutions(plan)
  const executionIndexes = new Map(executions.map((execution, index) => [execution.id, index]))
  /** 全部敏感提取值：只用于驱动证据脱敏，不进入报告/计划。 */
  const sensitiveValues = new Set<string>()

  const setStepStatus = (
    caseIndex: number,
    stepIndex: number,
    next: TestRunStatus,
    message?: string,
    evidenceContentHash?: string,
    variables?: Record<string, VariableProjection>,
    origin?: FailureOrigin,
  ): void => {
    const caseReport = report.cases[caseIndex]
    const stepReport = caseReport?.steps[stepIndex]
    if (!caseReport || !stepReport) return
    stepReport.status = transitionStatus(stepReport.status, next)
    if (message !== undefined) stepReport.message = message
    if (evidenceContentHash !== undefined) stepReport.evidenceContentHash = evidenceContentHash
    if (variables !== undefined) stepReport.variables = variables
    if (origin !== undefined) stepReport.origin = origin
    onStepStatusChange?.({
      caseId: caseReport.caseId,
      stepId: stepReport.stepId,
      status: stepReport.status,
      ...(stepReport.message !== undefined ? { message: stepReport.message } : {}),
      ...(stepReport.evidenceContentHash !== undefined ? { evidenceContentHash: stepReport.evidenceContentHash } : {}),
      ...(stepReport.variables !== undefined ? { variables: stepReport.variables } : {}),
    })
  }

  const currentStatus = (caseIndex: number, stepIndex: number): TestRunStatus | undefined =>
    report.cases[caseIndex]?.steps[stepIndex]?.status

  const context = (caseIndex: number, stepIndex: number): StepExecutionContext => ({
    signal,
    ...(sensitiveValues.size > 0 ? { sensitiveValues: [...sensitiveValues] } : {}),
    markWaitingApproval: () => setStepStatus(caseIndex, stepIndex, 'waiting_approval'),
    markRunning: () => {
      if (currentStatus(caseIndex, stepIndex) !== 'running') setStepStatus(caseIndex, stepIndex, 'running')
    },
  })

  const skipExecution = (executionId: string, canceled: boolean): void => {
    const caseIndex = executionIndexes.get(executionId)
    if (caseIndex === undefined) return
    const execution = executions[caseIndex]
    if (!execution) return
    execution.steps.forEach((_, stepIndex) => {
      setStepStatus(caseIndex, stepIndex, canceled ? 'canceled' : 'skipped')
    })
  }

  const execute = async (
    executionId: string,
    variables: Record<string, TestValue>,
  ): Promise<'passed' | 'failure' | 'canceled'> => {
    const caseIndex = executionIndexes.get(executionId)
    if (caseIndex === undefined) return 'passed'
    const execution = executions[caseIndex]
    if (!execution) return 'passed'
    let result: 'passed' | 'failure' | 'canceled' = 'passed'
    for (const [stepIndex, sourceStep] of execution.steps.entries()) {
      if (result !== 'passed' || signal.aborted) {
        const canceled: boolean = result === 'canceled' || signal.aborted
        setStepStatus(caseIndex, stepIndex, canceled ? 'canceled' : 'skipped')
        result = canceled ? 'canceled' : result
        continue
      }

      setStepStatus(caseIndex, stepIndex, 'running')
      const stepContext = context(caseIndex, stepIndex)
      let outcome: StepOutcome
      try {
        const step = materializeTestStepVariables(sourceStep, variables, plan.target)
        outcome = step.action === 'api.request'
          ? await api.runStep(step, stepContext)
          : await ui.runStep(step, stepContext)
      } catch {
        outcome = signal.aborted
          ? { verdict: 'canceled', message: '运行已停止' }
          : { verdict: 'error', message: UNEXPECTED_DRIVER_MESSAGE }
      }

      let variableProjection: Record<string, VariableProjection> | undefined
      if (outcome.verdict === 'passed') {
        const expectedNames = 'extract' in sourceStep && sourceStep.extract
          ? Object.keys(sourceStep.extract).sort()
          : []
        const actualNames = Object.keys(outcome.extractedVariables ?? {}).sort()
        const valid = expectedNames.length === actualNames.length
          && expectedNames.every((name, index) => name === actualNames[index])
          && actualNames.every((name) => {
            const value = outcome.extractedVariables?.[name]?.value
            return value === null || ['string', 'number', 'boolean'].includes(typeof value)
          })
        if (!valid) {
          outcome = { verdict: 'error', message: INVALID_EXTRACTION_MESSAGE }
        } else if (actualNames.length > 0) {
          variableProjection = {}
          for (const name of actualNames) {
            const extracted = outcome.extractedVariables?.[name]
            if (!extracted) continue
            variables[name] = extracted.value
            if (extracted.sensitive) {
              sensitiveValues.add(extracted.value === null ? 'null' : String(extracted.value))
            }
            variableProjection[name] = {
              sourceStepId: sourceStep.id,
              value: extracted.sensitive ? '[REDACTED]' : extracted.value,
              sensitive: extracted.sensitive,
            }
          }
        }
      }

      if (
        currentStatus(caseIndex, stepIndex) === 'waiting_approval'
        && outcome.verdict !== 'rejected'
        && outcome.verdict !== 'canceled'
      ) {
        setStepStatus(caseIndex, stepIndex, 'running')
      }
      setStepStatus(
        caseIndex,
        stepIndex,
        outcome.verdict,
        outcome.message,
        outcome.evidenceContentHash,
        variableProjection,
        failureOriginForOutcome(outcome) ?? undefined,
      )
      if (outcome.verdict !== 'passed') {
        result = outcome.verdict === 'canceled' ? 'canceled' : 'failure'
      }
    }
    return result
  }

  const suiteVariables: Record<string, TestValue> = {}
  let stopped = false
  let canceled = signal.aborted
  if (plan.hooks?.beforeAll) {
    const result = canceled ? 'canceled' : await execute('$beforeAll', suiteVariables)
    if (canceled) skipExecution('$beforeAll', true)
    canceled = result === 'canceled'
    stopped = result === 'failure'
  }

  for (const testCase of plan.cases) {
    const beforeEachId = `$beforeEach:${testCase.id}`
    const afterEachId = `$afterEach:${testCase.id}`
    if (stopped || canceled) {
      if (plan.hooks?.beforeEach) skipExecution(beforeEachId, canceled)
      skipExecution(testCase.id, canceled)
      if (plan.hooks?.afterEach) skipExecution(afterEachId, canceled)
      continue
    }

    const caseVariables = { ...suiteVariables }
    let caseResult: 'passed' | 'failure' | 'canceled' = 'passed'
    if (plan.hooks?.beforeEach) caseResult = await execute(beforeEachId, caseVariables)
    if (caseResult === 'passed') caseResult = await execute(testCase.id, caseVariables)
    else skipExecution(testCase.id, caseResult === 'canceled')

    let cleanupResult: 'passed' | 'failure' | 'canceled' = 'passed'
    if (plan.hooks?.afterEach) {
      if (caseResult === 'canceled' || signal.aborted) {
        cleanupResult = 'canceled'
        skipExecution(afterEachId, true)
      } else {
        cleanupResult = await execute(afterEachId, caseVariables)
      }
    }
    canceled = caseResult === 'canceled' || cleanupResult === 'canceled'
    stopped = caseResult === 'failure' || cleanupResult === 'failure'
  }

  if (plan.hooks?.afterAll) {
    if (canceled || signal.aborted) skipExecution('$afterAll', true)
    else await execute('$afterAll', suiteVariables)
  }

  for (const caseReport of report.cases) {
    caseReport.status = aggregateStatus(caseReport.steps.map((step) => step.status))
  }
  report.status = aggregateStatus(report.cases.map((caseReport) => caseReport.status))
  return report
}
