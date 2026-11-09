import { useMemo } from 'react'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import type { TestSuiteRunResult } from '@/stores/services/testSuiteRunner'
import { computeSuiteCoverage, computeSuiteSummary } from './testingViewData'

/**
 * 批次覆盖/摘要派生（F3 展示切片）：
 * - 覆盖分母取本次批次实际尝试的文件 + 扫描面的无效文件（「需要修复 / 不适用」）；
 * - 摘要按通过/失败/其他聚合，并点名未通过文件。
 */

export const useTestingSuiteSummary = ({
  suiteResult,
  specs,
}: {
  suiteResult: TestSuiteRunResult | null
  specs: readonly TestSpecIndexEntry[]
}) => {
  const suiteCoverage = useMemo(() => (
    suiteResult
      ? computeSuiteCoverage({ entries: suiteResult.entries, specs, filteredSpecs: specs })
      : null
  ), [suiteResult, specs])

  const suiteSummary = useMemo(
    () => (suiteResult ? computeSuiteSummary(suiteResult.entries) : null),
    [suiteResult],
  )

  return { suiteCoverage, suiteSummary }
}
