/**
 * 环境就绪探针（宿主侧）：审批 → 一次性租约 → 真打一次接口 → 分类结论。
 *
 * 复用 Runner 的同一条执行路径：审批卡用 `describeApiTestStepApproval`（与运行步骤完全同卡，
 * 不会漂移），执行用 `runApiTestStepWithLease`（Rust 权威出网策略、Secret 注入、脱敏证据）。
 * 这里不走 `createApiTestDriver` 的唯一原因是**探针还需要状态码**来做就绪分类，而 Driver 的
 * 返回值只带 verdict/message——判据在 `agent/testing/environment/readiness.ts` 里。
 */
import type { TestStepApprover } from '@/agent/testing/approval/testStepApprover'
import { describeApiTestStepApproval } from '@/agent/testing/approval/testStepApproval'
import {
  canceledReadiness,
  classifyReadiness,
  readinessProbePlan,
  rejectedReadiness,
  unusableReadiness,
  type EnvironmentReadiness,
} from '@/agent/testing/environment/readiness'
import type { TestEnvironmentRecord } from './testEnvironments'
import { runApiTestStepWithLease } from './apiTestAutomation'

export interface ProbeEnvironmentInput {
  environment: TestEnvironmentRecord
  /** 探针的审批 actor 绑定这次运行：审批卡与后续步骤在同一个 run 下，停止运行即取消探针。 */
  runId: string
  approver: TestStepApprover
  signal: AbortSignal
}

export interface ProbeEnvironmentResult {
  readiness: EnvironmentReadiness
  /** 实际探测目标（报告事实要记的就是它）；`null` 表示压根没探（环境不可探测）。 */
  probe: { method: string; url: string } | null
}

export const probeEnvironmentReadiness = async (
  input: ProbeEnvironmentInput,
): Promise<ProbeEnvironmentResult> => {
  const { environment, runId, approver, signal } = input
  const plan = readinessProbePlan({
    apiBaseUrl: environment.apiBaseUrl,
    recipeJson: environment.recipeJson,
    stepId: `env-probe:${environment.id}`,
  })
  if (!plan.ok) return { readiness: unusableReadiness(plan.reason), probe: null }
  const probe = { method: plan.plan.step.method, url: plan.plan.step.url }
  if (signal.aborted) return { readiness: canceledReadiness(), probe }

  const approved = await approver.approve(
    {
      actor: { kind: 'testStep', testRunId: runId, stepId: plan.plan.step.id },
      card: describeApiTestStepApproval(plan.plan.step),
    },
    signal,
  )
  if (signal.aborted) return { readiness: canceledReadiness(), probe }
  if (!approved) return { readiness: rejectedReadiness(), probe }

  const result = await runApiTestStepWithLease(
    { runId, environmentId: environment.id },
    plan.plan.step,
    signal,
  )
  return {
    readiness: classifyReadiness(plan.plan, {
      transport: result.transport,
      statusCode: result.statusCode,
      message: result.message,
      elapsedMs: result.elapsedMs,
    }),
    probe,
  }
}
