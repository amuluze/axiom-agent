import { useMemo } from 'react'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import type { TestSuiteRunResult } from '@/stores/services/testSuiteRunner'
import { computeSuiteCoverage, computeSuiteSummary } from './testingViewData'

/**
 * 批次覆盖/摘要派生（F3 展示切片）：
 * - 覆盖分母只取本次运行范围，执行证据来自套件运行器；
 * - 摘要按通过/失败/其他聚合，并点名未通过文件。
 */

export const useTestingSuiteSummary = ({
  suiteResult,
  specs,
  filteredSpecs,
}: {
  suiteResult: TestSuiteRunResult | null
  specs: readonly TestSpecIndexEntry[]
  filteredSpecs: readonly TestSpecIndexEntry[]
}) => {
  const suiteCoverage = useMemo(() => (
    suiteResult ? computeSuiteCoverage({ entries: suiteResult.entries, specs, filteredSpecs }) : null
  ), [filteredSpecs, suiteResult, specs])

  const suiteSummary = useMemo(
    () => (suiteResult ? computeSuiteSummary(suiteResult.entries) : null),
    [suiteResult],
  )

  return { suiteCoverage, suiteSummary }
}
