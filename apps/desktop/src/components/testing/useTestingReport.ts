import { useCallback, useRef, useState } from 'react'
import type { CompiledTestPlan } from '@/agent/testing/spec/compileTestPlan'
import type { TestRunDetailRecord } from '@/platform/testRuns'
import { getTestRunRecord } from '@/platform/testRuns'
import type { RepairRoundSummary } from '@/stores/services/testRepairRounds'
import { resolveRepairRounds } from '@/stores/services/testRepairRounds'
import { useT } from '@/i18n'
import { loadPlanArtifact } from './testingViewData'

/**
 * 报告装载（F1 report hook）：选中报告、冻结 plan、修复轮次与步骤展开状态。
 *
 * 装载令牌保证快速连开两份报告时只认最后一份；plan 读取失败 fail-soft（保持 null），
 * 报告读取失败写入共享 error。
 */

export interface TestingReportState {
  selectedReport: TestRunDetailRecord | null
  selectedReportPlan: CompiledTestPlan | null
  repairRounds: RepairRoundSummary | null
  expandedStepKey: string | null
  setExpandedStepKey: (key: string | null) => void
  showReport: (detail: TestRunDetailRecord | null) => void
  openReport: (runId: string) => Promise<void>
}

export const useTestingReport = ({
  setError,
}: {
  setError: (message: string | null) => void
}): TestingReportState => {
  const { t } = useT()
  const [selectedReport, setSelectedReport] = useState<TestRunDetailRecord | null>(null)
  const [selectedReportPlan, setSelectedReportPlan] = useState<CompiledTestPlan | null>(null)
  const [repairRounds, setRepairRounds] = useState<RepairRoundSummary | null>(null)
  const [expandedStepKey, setExpandedStepKey] = useState<string | null>(null)
  const tokenRef = useRef(0)

  /**
   * 装载报告并顺带判定修复轮次：同一失败连续未过的轮次是"要不要继续重跑"的客观依据
   * （T3-3，不自动重跑，只决定推不推荐）。判定失败就不显示轮次徽标。
   */
  const showReport = useCallback((detail: TestRunDetailRecord | null): void => {
    const token = tokenRef.current + 1
    tokenRef.current = token
    setSelectedReport(detail)
    setSelectedReportPlan(null)
    setExpandedStepKey(null)
    setRepairRounds(null)
    if (detail === null) return
    if (detail.planContentHash !== null) {
      // 报告测试点覆盖必须来自运行时的冻结计划；源文件后来被改/删都不影响它。
      void loadPlanArtifact(detail.planContentHash).then((plan) => {
        if (tokenRef.current !== token) return
        if (plan !== null) setSelectedReportPlan(plan)
      })
    }
    void resolveRepairRounds(detail)
      // 快速连开两份报告时只认最后一份：轮次错了比不显示更糟。
      .then((summary) => {
        if (tokenRef.current === token) setRepairRounds(summary)
      })
      .catch(() => undefined)
  }, [])

  const openReport = useCallback(async (runId: string): Promise<void> => {
    setError(null)
    try {
      showReport(await getTestRunRecord(runId))
    } catch {
      setError(t('testing.report.loadError'))
    }
  }, [setError, showReport, t])

  return {
    selectedReport,
    selectedReportPlan,
    repairRounds,
    expandedStepKey,
    setExpandedStepKey,
    showReport,
    openReport,
  }
}
