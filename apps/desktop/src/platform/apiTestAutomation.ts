import type { TestStepApprover } from '@/agent/testing/approval/testStepApprover'
import { describeApiTestStepApproval } from '@/agent/testing/approval/testStepApproval'
import { normalizeTestOrigin } from '@/agent/testing/environment/trustScope'
import type { ApiTestDriver, StepOutcome } from '@/agent/testing/runner/runTestPlan'
import type { ApiDriverStep, ExtractedTestValue } from '@/agent/testing/spec/types'
import { invoke } from '@tauri-apps/api/core'

export interface ApiTestTarget {
  runId: string
  environmentId?: string
}

/**
 * 驱动层选项。
 *
 * `trustedOrigins` 非空表示当前环境是受信档：列出的 origin 内的步骤免弹 WebView
 * 审批卡。**权威判定在 Rust 侧**（`api_test::within_trusted_scope` 读 SQLite 的
 * 环境记录），这里只是让界面与实际放行行为一致。
 */
export interface ApiTestDriverOptions {
  trustedOrigins?: readonly string[]
}

interface ApiTestLeaseIssued {
  leaseId: string
  ttlMs: number
}

/**
 * 宿主对单个 API 测试步骤的权威结果（Rust `run_api_test_step` 的原样投影）。
 * `message` 与 `evidenceContentHash` 都来自 Rust 侧脱敏后的证据，正文不回灌 WebView。
 */
export interface ApiTestStepResult {
  verdict: 'passed' | 'failed' | 'not_evaluated'
  runnerVerdict: StepOutcome['verdict']
  transport: 'received' | 'timeout' | 'blocked' | 'network_error' | 'canceled'
  message: string
  evidenceContentHash: string
  statusCode: number | null
  elapsedMs: number
  extracted: Record<string, ExtractedTestValue>
}

/** 宿主原生确认框被用户取消；调用方应记为 `rejected`，而不是驱动错误。 */
export class NativeApprovalCanceledError extends Error {
  constructor() {
    super('用户在原生确认中取消了本步骤')
    this.name = 'NativeApprovalCanceledError'
  }
}

const requestFor = (target: ApiTestTarget, step: ApiDriverStep) => ({
  runId: target.runId,
  stepId: step.id,
  ...(target.environmentId ? { environmentId: target.environmentId } : {}),
  action: step,
})

/** 带 Secret 的步骤会先弹原生内容确认；取消时返回 null（不签发租约）。 */
export const issueApiTestStepLease = (
  target: ApiTestTarget,
  step: ApiDriverStep,
): Promise<ApiTestLeaseIssued | null> => invoke<ApiTestLeaseIssued | null>('issue_api_test_step_lease', {
  request: requestFor(target, step),
})

export const runApiTestStep = (
  target: ApiTestTarget,
  step: ApiDriverStep,
  leaseId: string,
  sensitiveValues: readonly string[] = [],
  credentialVariables: Readonly<Record<string, string>> = {},
): Promise<ApiTestStepResult> => invoke<ApiTestStepResult>('run_api_test_step', {
  request: { ...requestFor(target, step), leaseId, sensitiveValues, variableValues: credentialVariables },
})

export const cancelApiTestRun = (runId: string): Promise<boolean> =>
  invoke<boolean>('cancel_api_test_run', { runId })

/**
 * 单步骤执行接缝：签发一次性租约 → 运行步骤 → 运行期 abort 时按 `runId` 主动取消宿主请求。
 *
 * 与 {@link createApiTestDriver} 共用这一条路径（审批在各自的调用方，本函数不做审批）：
 * Runner 经测试步骤审批器后调用它，探索工具（`api_request`）经 Agent 层逐次审批后调用它。
 * 租约仍是宿主权威的「单次消费、绑定 runId/stepId/environmentId/generation」能力。
 */
export const runApiTestStepWithLease = async (
  target: ApiTestTarget,
  step: ApiDriverStep,
  signal: AbortSignal,
  sensitiveValues: readonly string[] = [],
  credentialVariables: Readonly<Record<string, string>> = {},
): Promise<ApiTestStepResult> => {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const onAbort = (): void => { void cancelApiTestRun(target.runId) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const lease = await issueApiTestStepLease(target, step)
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (lease === null) throw new NativeApprovalCanceledError()
    return await runApiTestStep(target, step, lease.leaseId, sensitiveValues, credentialVariables)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export const createApiTestDriver = (
  target: ApiTestTarget,
  approver: TestStepApprover,
  options: ApiTestDriverOptions = {},
): ApiTestDriver => ({
  runStep: async (step, context): Promise<StepOutcome> => {
    if (context.signal.aborted) return { verdict: 'canceled', message: '运行已停止' }
    // 受信环境：目标落在环境声明的 origin 集合内时不弹 WebView 审批卡。
    // **Rust 侧独立判定**（读 SQLite 的环境记录）——这里的跳过只是界面与之一致，
    // 越界目标照样会被 Rust 的原生确认拦下。
    const trusted = (options.trustedOrigins ?? []).includes(normalizeTestOrigin(step.url) ?? '')
    if (!trusted) {
      context.markWaitingApproval()
      const approved = await approver.approve(
        {
          actor: { kind: 'testStep', testRunId: target.runId, stepId: step.id },
          card: describeApiTestStepApproval(step),
        },
        context.signal,
      )
      if (context.signal.aborted) return { verdict: 'canceled', message: '运行已停止' }
      if (!approved) return { verdict: 'rejected', message: '用户拒绝了本步骤' }
    }
    context.markRunning()
    let result: ApiTestStepResult
    try {
      result = await runApiTestStepWithLease(
        target,
        step,
        context.signal,
        context.sensitiveValues ?? [],
        context.credentialVariables ?? {},
      )
    } catch (error) {
      if (error instanceof NativeApprovalCanceledError) {
        return { verdict: 'rejected', message: '用户在原生确认中取消了本步骤' }
      }
      throw error
    }
    // 传输层失败（超时/连接失败/宿主策略拒绝）是**环境**问题，不是断言不成立：
    // 事实直接来自 Rust 的 transport 字段，不靠消息文本猜。
    const transportFailure = result.transport === 'timeout'
      || result.transport === 'network_error'
      || result.transport === 'blocked'
    return {
      verdict: result.runnerVerdict,
      ...(transportFailure && result.runnerVerdict === 'error' ? { origin: 'environment' as const } : {}),
      message: result.message,
      evidenceContentHash: result.evidenceContentHash,
      extractedVariables: result.extracted,
    }
  },
})
