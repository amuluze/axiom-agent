/**
 * 修复轮次与上升（宿主计数，T3-3）。
 *
 * 事实基础是**可机械核对的东西**：同一 spec 内容的历史运行 + 每次运行【首个失败步骤】
 * 的 caseId / stepId / 状态 / 归因（失败签名）。同一签名连续未过的轮次越多，越不可能是"再跑一次就好了"——
 * 第三轮起标「需要人工介入」并停止推荐重跑。
 *
 * 为什么按签名而不是按"同一用例"计数：同一条用例的两次失败原因常常完全不同（先超时、
 * 后断言），把它们算作"同一失败"会让计数虚高。签名不同即本轮是新问题，计数从头开始。
 *
 * 不做的事：**不自动重跑**（产品里没有自动重跑回路，这里只负责"推荐/不推荐"），也不判定
 * "测试写错了还是产品有缺陷"（那由用户在发送会话时选方向，usage §4.5）。
 */
import type { TestRunStatus } from './runState'

/** 连续未过轮次达到该值即上升为人工介入。 */
export const REPAIR_ROUND_LIMIT = 3

const REPAIR_FAILURES: readonly TestRunStatus[] = ['failed', 'error']

export const isRepairFailureStatus = (status: TestRunStatus): boolean => REPAIR_FAILURES.includes(status)

/**
 * 失败签名：首个实际失败步骤的 caseId / stepId / 状态 / 归因。取消、拒绝、中断不构成
 * "同一缺陷反复失败"，不会触发人工介入上升。
 */
export const firstRepairFailureSignature = (
  cases: readonly {
    caseId: string
    failureOrigin?: string | null
    steps: readonly { stepId: string; status: TestRunStatus; origin?: string }[]
  }[],
): string | null => {
  for (const testCase of cases) {
    for (const step of testCase.steps) {
      if (!isRepairFailureStatus(step.status)) continue
      const origin = step.origin ?? testCase.failureOrigin ?? (step.status === 'failed' ? 'assertion' : 'driver')
      return JSON.stringify([testCase.caseId, step.stepId, step.status, origin])
    }
  }
  return null
}

/** 同 `spec_path` 的一次历史运行（由调用方按时间倒序、且**已按 specPath 过滤**）。 */
export interface RepairHistoryEntry {
  runId: string
  specPath: string
  specHash: string
  status: TestRunStatus
  failureSignature: string | null
  finishedAt: number | null
}

/**
 * 本轮是第几轮（含本轮）。`previous` 必须按时间**倒序**、只含同一 `spec_path` 的历史运行，
 * 且不含本轮；遇到签名不同或通过即停止累计（连续才计数）。
 * 本轮无失败签名（通过）时记为第 1 轮——它不构成"未过的轮次"。
 */
export const countRepairRounds = (
  current: { runId: string; specPath: string; specHash: string; failureSignature: string | null },
  previous: readonly RepairHistoryEntry[],
): number => {
  if (current.failureSignature === null) return 1
  let rounds = 1
  for (const entry of previous) {
    if (entry.runId === current.runId) continue
    if (entry.specPath !== current.specPath) continue
    if (entry.specHash !== current.specHash) break
    if (entry.failureSignature !== current.failureSignature) break
    if (!isRepairFailureStatus(entry.status)) break
    rounds += 1
    if (rounds >= REPAIR_ROUND_LIMIT) break
  }
  return rounds
}

/** 达到上限即上升：同一失败再怎么重跑也不会自己变绿。 */
export const needsHumanIntervention = (rounds: number): boolean => rounds >= REPAIR_ROUND_LIMIT

/**
 * 需要向宿主回读多少条历史运行详情就能判定轮次：只差 `REPAIR_ROUND_LIMIT - 1` 次连续命中
 * 就足以封顶，剩下的不用查（报告打开路径上不做无界回读）。
 */
export const REPAIR_HISTORY_DETAIL_LIMIT = REPAIR_ROUND_LIMIT - 1
