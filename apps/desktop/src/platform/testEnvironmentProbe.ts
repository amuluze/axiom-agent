/**
 * 环境就绪探针（宿主侧）：审批 → 一次性租约 → 真打一次接口 → 分类结论。
 *
 * 复用 Runner 的同一条执行路径：审批卡用 `describeApiTestStepApproval`（与运行步骤完全同卡，
 * 不会漂移），执行用 `runApiTestStepWithLease`（Rust 权威出网策略、Secret 注入、脱敏证据）。
 * 这里不走 `createApiTestDriver` 的唯一原因是**探针还需要状态码**来做就绪分类，而 Driver 的
 * 返回值只带 verdict/message——判据在 `agent/testing/environment/readiness.ts` 里。
 *
 * 多服务拓扑（v2）：`recipe.probes[]` 声明每个服务的就绪判据，**全部通过才算就绪**；
 * 任一探针未就绪即短路返回那一项的事实，报告因此能定位到具体服务。
 */
import type { TestStepApprover } from '@/agent/testing/approval/testStepApprover'
import { describeApiTestStepApproval } from '@/agent/testing/approval/testStepApproval'
import type { EnvironmentProbeFact } from '@/agent/testing/environment/envFacts'
import {
  canceledReadiness,
  classifyReadiness,
  readinessProbePlans,
  rejectedReadiness,
  unusableReadiness,
  type EnvironmentProbePlan,
  type EnvironmentReadiness,
} from '@/agent/testing/environment/readiness'
import type { TestEnvironmentRecord } from './testEnvironments'
import { runApiTestStepWithLease } from './apiTestAutomation'

export interface ProbeEnvironmentInput {
  environment: TestEnvironmentRecord
  /** 运行期变量投影（含 v2 自定义服务地址）；缺省退回环境记录自身的两列。 */
  vars?: Readonly<Record<string, string>>
  /** 探针的审批 actor 绑定这次运行：审批卡与后续步骤在同一个 run 下，停止运行即取消探针。 */
  runId: string
  approver: TestStepApprover
  signal: AbortSignal
}

export interface ProbeEnvironmentResult {
  readiness: EnvironmentReadiness
  /** 实际探测目标（报告事实要记的就是它）；`null` 表示压根没探（环境不可探测）。 */
  probe: { method: string; url: string } | null
  /** v2：多服务探针的逐项事实（单探针时为一项）。 */
  probes: readonly EnvironmentProbeFact[]
}

const probeFact = (plan: EnvironmentProbePlan, readiness: EnvironmentReadiness): EnvironmentProbeFact => ({
  ...(plan.var === undefined ? {} : { var: plan.var }),
  method: plan.step.method,
  url: plan.step.url,
  status: readiness.status,
  verdict: readiness.verdict,
})

export const probeEnvironmentReadiness = async (
  input: ProbeEnvironmentInput,
): Promise<ProbeEnvironmentResult> => {
  const { environment, vars, runId, approver, signal } = input
  const plans = readinessProbePlans({
    apiBaseUrl: environment.apiBaseUrl,
    ...(vars ? { vars } : {}),
    recipeJson: environment.recipeJson,
    stepId: `env-probe:${environment.id}`,
  })
  if (!plans.ok) return { readiness: unusableReadiness(plans.reason), probe: null, probes: [] }

  const facts: EnvironmentProbeFact[] = []
  let firstProbe: { method: string; url: string } | null = null
  let observed = 0
  let lastStatus: number | null = null
  for (const plan of plans.plans) {
    const probe = { method: plan.step.method, url: plan.step.url }
    if (firstProbe === null) firstProbe = probe
    if (signal.aborted) {
      return { readiness: canceledReadiness(), probe: firstProbe, probes: facts }
    }

    const approved = await approver.approve(
      {
        actor: { kind: 'testStep', testRunId: runId, stepId: plan.step.id },
        card: describeApiTestStepApproval(plan.step),
      },
      signal,
    )
    if (signal.aborted) {
      return { readiness: canceledReadiness(), probe: firstProbe, probes: facts }
    }
    if (!approved) return { readiness: rejectedReadiness(), probe: firstProbe, probes: facts }

    const result = await runApiTestStepWithLease(
      { runId, environmentId: environment.id },
      plan.step,
      signal,
    )
    observed += result.elapsedMs
    lastStatus = result.statusCode
    const readiness = classifyReadiness(plan, {
      transport: result.transport,
      statusCode: result.statusCode,
      message: result.message,
      elapsedMs: result.elapsedMs,
    })
    if (plan.var !== undefined) facts.push(probeFact(plan, readiness))
    // 任一服务未就绪即短路：坏环境不该继续点后续探针，报告定位到这一项。
    if (!readiness.ready) {
      return {
        readiness: {
          ...readiness,
          elapsedMs: observed,
          ...(plans.plans.length > 1 ? { reason: `${readiness.reason}（服务变量 ${plan.var ?? 'API_BASE_URL'}）` } : {}),
        },
        probe,
        probes: facts,
      }
    }
  }

  // 全部探针通过：总耗时如实累加，摘要说明覆盖了几个服务。
  const last = plans.plans[plans.plans.length - 1]
  const readiness: EnvironmentReadiness = {
    ready: true,
    verdict: 'ready',
    reason: plans.plans.length > 1
      ? `环境就绪：${plans.plans.length} 个服务探针全部通过（${observed} ms）`
      : `环境就绪：${last?.step.method ?? 'GET'} ${last?.step.url ?? ''} 返回 ${lastStatus ?? '—'}（${observed} ms）`,
    status: lastStatus,
    elapsedMs: observed,
  }
  return { readiness, probe: firstProbe, probes: facts }
}
