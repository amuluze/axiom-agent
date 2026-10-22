/**
 * 修复轮次的回读与判定（T3-3）。
 *
 * 报告打开时问一句话："同一文件的同一个失败，已经连续第几轮没过了？"——答不上来（宿主读失败）
 * 就不显示轮次徽标（fail-soft），而不是猜一个数字出来。
 *
 * 回读上界：只需 `REPAIR_HISTORY_DETAIL_LIMIT`（= 2）条历史详情就能判定是否封顶，
 * 报告打开路径上不做无界回读。列表接口本身按 `started_at DESC` 排序（Rust 侧 ORDER BY）。
 */
import {
  REPAIR_HISTORY_DETAIL_LIMIT,
  countRepairRounds,
  firstRepairFailureSignature,
  needsHumanIntervention,
  type RepairHistoryEntry,
} from '@/agent/testing/runner/repairRounds'
import { getTestRunRecord, listTestRunRecords, type TestRunDetailRecord } from '@/platform/testRuns'

/** 一次回读覆盖的历史运行条数（够判定封顶即可）。 */
const HISTORY_LIST_LIMIT = 50

export interface RepairRoundSummary {
  /** 含本轮的第几轮（同一 spec 同一失败签名的连续轮次）。 */
  rounds: number
  needsHuman: boolean
}

/** 判定失败即返回 null：宁可不显示，也不给出一个可能错的轮次。 */
export const resolveRepairRounds = async (report: TestRunDetailRecord): Promise<RepairRoundSummary | null> => {
  const failureSignature = firstRepairFailureSignature(report.cases)
  try {
    if (failureSignature === null) return { rounds: 1, needsHuman: false }
    const summaries = await listTestRunRecords(HISTORY_LIST_LIMIT)
    const candidates = summaries
      .filter((summary) => (
        summary.specPath === report.summary.specPath
        && summary.specHash === report.summary.specHash
        && summary.id !== report.summary.id
      ))
      .slice(0, REPAIR_HISTORY_DETAIL_LIMIT)
    const entries: RepairHistoryEntry[] = []
    for (const candidate of candidates) {
      const detail = await getTestRunRecord(candidate.id)
      // 读不到详情就停在这里：少算一轮好过多算一轮（多算会误报「需要人工介入」）。
      if (!detail) break
      entries.push({
        runId: candidate.id,
        specPath: candidate.specPath,
        specHash: candidate.specHash,
        status: candidate.status,
        failureSignature: firstRepairFailureSignature(detail.cases),
        finishedAt: candidate.finishedAt ?? null,
      })
    }
    const rounds = countRepairRounds(
      {
        runId: report.summary.id,
        specPath: report.summary.specPath,
        specHash: report.summary.specHash,
        failureSignature,
      },
      entries,
    )
    return { rounds, needsHuman: needsHumanIntervention(rounds) }
  } catch {
    return null
  }
}
