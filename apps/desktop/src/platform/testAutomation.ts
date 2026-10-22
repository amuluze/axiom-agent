import type { ExtractedTestValue, UiExpectation, UiExtraction, UiLocator, UiStepSpec } from '@/agent/testing/spec/types'
import type { StepExecutionContext, StepOutcome, UiTestDriver } from '@/agent/testing/runner/runTestPlan'
import {
  describeTestStepApproval,
  type TestStepApprovalActor,
  type TestStepApprovalCard,
} from '@/agent/testing/approval/testStepApproval'
import { revokeTestTargetGrant } from '@/platform/testTarget'
import { invoke } from '@tauri-apps/api/core'

/**
 * UI 测试的平台层：判定与证据全部由 Rust 产生，这里只做类型化转发与结果映射。
 * 断言对象的 JSON 形状（单键）与 Rust `ui_test::UiExpectation` 逐字一致，无需转换。
 */
export type UiReadVerdict = (
  | { verdict: 'passed' }
  | { verdict: 'failed'; message: string }
  | { verdict: 'error'; message: string }) & { extracted?: Record<string, ExtractedTestValue> }

export interface UiReadStepRequest {
  runId: string
  tabId: string
  locator?: UiLocator
  expect: UiExpectation
  mode: 'assert' | 'wait'
  timeoutMs?: number
  extract?: Record<string, UiExtraction>
}

export interface UiEvidenceResult {
  artifact: { contentHash: string; mediaType: string; sizeBytes: number }
  width: number
  height: number
}

export const runUiReadStep = (request: UiReadStepRequest): Promise<UiReadVerdict> =>
  invoke<UiReadVerdict>('run_ui_read_step', { request })

export const captureUiEvidence = (request: { runId: string; tabId: string }): Promise<UiEvidenceResult> =>
  invoke<UiEvidenceResult>('capture_ui_evidence', { request })

export interface TestStepLeaseRequest {
  runId: string
  stepId: string
  tabId: string
  origin: string
  locator?: UiLocator
  action: UiStepSpec
}

export interface TestStepLeaseIssued {
  leaseId: string
  ttlMs: number
}

/** 写步骤的执行凭据：Rust 从 locator 与 action 原文计算摘要，WebView 不能指定摘要。 */
export interface UiWriteStepRequest extends TestStepLeaseRequest {
  leaseId: string
}

export const runUiWriteStep = (request: UiWriteStepRequest): Promise<UiReadVerdict> =>
  invoke<UiReadVerdict>('run_ui_write_step', { request })

export const issueTestStepLease = (request: TestStepLeaseRequest): Promise<TestStepLeaseIssued> =>
  invoke<TestStepLeaseIssued>('issue_test_step_lease', { request })

const fromVerdict = (verdict: UiReadVerdict): StepOutcome =>
  verdict.verdict === 'passed'
    ? { verdict: 'passed', ...(verdict.extracted ? { extractedVariables: verdict.extracted } : {}) }
    : { verdict: verdict.verdict, message: verdict.message }

export interface UiTestTarget {
  runId: string
  tabId: string
  /** 当前授权的 origin（U1-2）；写步骤的租约绑定它。 */
  origin: string
}

export interface UiTestDriverOptions {
  /**
   * 写步骤的人工审批入口。未提供时写步骤一律拒绝执行（fail-closed）。
   * 返回 true 表示用户确认，false 表示拒绝。
   */
  approve?: (
    request: { actor: TestStepApprovalActor; card: TestStepApprovalCard },
    signal: AbortSignal,
  ) => Promise<boolean>
}

/**
 * 把 UI 步骤映射为 Runner 的 Driver。
 * - 读步骤与截图：Rust 判定与证据，本层只做转发与映射。
 * - 写步骤：先经审批门控；用户拒绝 → rejected（Runner 停止整个 run）；通过后由 Rust 签发
 *   绑定内容摘要的单次租约。写执行器属于 U1-4，在此之前明确返回 error，不伪装成通过。
 */
export const createUiTestDriver = (
  target: UiTestTarget,
  options: UiTestDriverOptions = {},
): UiTestDriver => {
  const runWithCancellation = async <T>(
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T | null> => {
    if (signal.aborted) return null
    const onAbort = (): void => { void revokeTestTargetGrant(target.runId) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await work()
      return signal.aborted ? null : result
    } catch (error) {
      if (signal.aborted) return null
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  const runWriteStep = async (step: UiStepSpec, context: StepExecutionContext): Promise<StepOutcome> => {
    if (!options.approve) return { verdict: 'error', message: '未配置审批入口，写步骤已拒绝执行' }
    context.markWaitingApproval()
    const approved = await options.approve(
      {
        actor: { kind: 'testStep', testRunId: target.runId, stepId: step.id },
        card: describeTestStepApproval(step, target.origin),
      },
      context.signal,
    )
    if (context.signal.aborted) return { verdict: 'canceled', message: '运行已停止' }
    if (!approved) return { verdict: 'rejected', message: '用户拒绝了本步骤' }
    context.markRunning()
    const verdict = await runWithCancellation(context.signal, async () => {
      const lease = await issueTestStepLease({
        runId: target.runId,
        stepId: step.id,
        tabId: target.tabId,
        origin: target.origin,
        ...('locator' in step && step.locator ? { locator: step.locator } : {}),
        action: step,
      })
      if (context.signal.aborted) return null
      return runUiWriteStep({
        runId: target.runId,
        stepId: step.id,
        tabId: target.tabId,
        origin: target.origin,
        ...('locator' in step && step.locator ? { locator: step.locator } : {}),
        action: step,
        leaseId: lease.leaseId,
      })
    })
    return verdict === null ? { verdict: 'canceled', message: '运行已停止' } : fromVerdict(verdict)
  }

  return {
    runStep: async (step: UiStepSpec, context: StepExecutionContext): Promise<StepOutcome> => {
      if (context.signal.aborted) return { verdict: 'canceled', message: '运行已停止，本步骤未发起' }
      switch (step.action) {
        case 'ui.assert': {
          const verdict = await runWithCancellation(context.signal, () => runUiReadStep({
            runId: target.runId,
            tabId: target.tabId,
            ...(step.locator ? { locator: step.locator } : {}),
            expect: step.expect,
            mode: 'assert',
            ...(step.extract ? { extract: step.extract } : {}),
          }))
          return verdict === null ? { verdict: 'canceled', message: '运行已停止' } : fromVerdict(verdict)
        }
        case 'ui.wait': {
          const verdict = await runWithCancellation(context.signal, () => runUiReadStep({
            runId: target.runId,
            tabId: target.tabId,
            ...(step.locator ? { locator: step.locator } : {}),
            expect: step.expect,
            mode: 'wait',
            ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
            ...(step.extract ? { extract: step.extract } : {}),
          }))
          return verdict === null ? { verdict: 'canceled', message: '运行已停止' } : fromVerdict(verdict)
        }
        case 'ui.screenshot': {
          const evidence = await runWithCancellation(
            context.signal,
            () => captureUiEvidence({ runId: target.runId, tabId: target.tabId }),
          )
          if (evidence === null) return { verdict: 'canceled', message: '运行已停止' }
          return { verdict: 'passed', evidenceContentHash: evidence.artifact.contentHash }
        }
        default:
          return runWriteStep(step, context)
      }
    },
  }
}
