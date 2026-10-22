import { useEffect, useMemo, useRef, useState } from 'react'
import type { TestRunDetailRecord, TestRunStatus, TestRunSummaryRecord } from '@/platform/testRuns'
import { getTestRunRecord } from '@/platform/testRuns'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import type { SpecDetail } from '@/stores/services/testSpecDetail'
import { loadSpecDetail } from '@/stores/services/testSpecDetail'

/**
 * 选中 spec 的明细投影（F1 选中明细 hook）：
 * - 按需读取用例明细（序号守卫，迟到结果不回写）；
 * - 选中 spec 的最近一次运行明细；
 * - 用例 id → 最近运行状态（用例表状态列）。
 *
 * 读取失败一律 fail-soft 为 null，不写共享 error（与扫描/运行错误分开）。
 */

export interface SelectedSpecDetail {
  specDetail: SpecDetail | null
  latestRun: TestRunSummaryRecord | null
  caseStatusById: ReadonlyMap<string, TestRunStatus>
}

export const useSelectedSpecDetail = ({
  specs,
  runs,
  selectedSpecPath,
  workspacePath,
}: {
  specs: readonly TestSpecIndexEntry[]
  runs: readonly TestRunSummaryRecord[]
  selectedSpecPath: string | null
  workspacePath: string | undefined
}): SelectedSpecDetail => {
  const [specDetail, setSpecDetail] = useState<SpecDetail | null>(null)
  const [latestRunDetail, setLatestRunDetail] = useState<TestRunDetailRecord | null>(null)

  // 选中 spec 变化 → 按需解析用例明细（序号守卫：迟到的解析结果不回写）。
  const specDetailSeqRef = useRef(0)
  useEffect(() => {
    const seq = ++specDetailSeqRef.current
    const spec = specs.find((candidate) => candidate.path === selectedSpecPath)
    if (!spec?.valid || !workspacePath) {
      setSpecDetail(null)
      return
    }
    void loadSpecDetail(spec.path, workspacePath).then((detail) => {
      if (specDetailSeqRef.current === seq) setSpecDetail(detail)
    })
  }, [selectedSpecPath, specs, workspacePath])

  // 选中 spec 的最近一次运行明细（KPI「最近重放」+ 用例表状态列）。
  const latestRun = useMemo(
    () => runs.find((run) => run.specPath === selectedSpecPath) ?? null,
    [runs, selectedSpecPath],
  )
  useEffect(() => {
    if (!latestRun) {
      setLatestRunDetail(null)
      return
    }
    let canceled = false
    getTestRunRecord(latestRun.id)
      .then((detail) => { if (!canceled) setLatestRunDetail(detail) })
      .catch(() => { if (!canceled) setLatestRunDetail(null) })
    return () => { canceled = true }
  }, [latestRun])

  const caseStatusById = useMemo(() => {
    const map = new Map<string, TestRunStatus>()
    if (latestRunDetail && latestRunDetail.summary.specPath === selectedSpecPath) {
      for (const testCase of latestRunDetail.cases) map.set(testCase.caseId, testCase.status)
    }
    return map
  }, [latestRunDetail, selectedSpecPath])

  return { specDetail, latestRun, caseStatusById }
}
