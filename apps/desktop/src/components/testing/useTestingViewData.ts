import { useCallback, useEffect, useState } from 'react'
import type { TestBatchSummaryRecord, TestRunSummaryRecord } from '@/platform/testRuns'
import type { TestEnvironmentRecord } from '@/platform/testEnvironments'
import type { EnvironmentFileEntry } from '@/stores/services/testEnvironmentFiles'
import { scanEnvironmentFiles } from '@/stores/services/testEnvironmentFiles'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import { scanTestSpecs } from '@/stores/services/testSpecIndex'
import {
  getLatestTestBatchRecord,
  listTestRunRecords,
} from '@/platform/testRuns'
import { listTestEnvironmentRecords } from '@/platform/testEnvironments'
import { useT } from '@/i18n'

/**
 * 测试页索引/批次数据（F1 扫描 hook）：
 * 工作区扫描、用例索引、环境文件、历史运行、最近批次与环境列表。
 *
 * 错误写入由调用方注入（error 与运行/固化等动作共享）；选中明细与运行生命周期
 * 仍由 TestingView 持有。
 */

export interface TestingViewData {
  specs: TestSpecIndexEntry[]
  environmentFiles: EnvironmentFileEntry[]
  runs: TestRunSummaryRecord[]
  environments: TestEnvironmentRecord[]
  latestBatch: TestBatchSummaryRecord | null
  selectedSpecPath: string | null
  setSelectedSpecPath: React.Dispatch<React.SetStateAction<string | null>>
  selectedEnvironmentId: string | null
  setSelectedEnvironmentId: React.Dispatch<React.SetStateAction<string | null>>
  syncedAt: Date | null
  loading: boolean
  setRuns: React.Dispatch<React.SetStateAction<TestRunSummaryRecord[]>>
  setEnvironments: React.Dispatch<React.SetStateAction<TestEnvironmentRecord[]>>
  setLatestBatch: React.Dispatch<React.SetStateAction<TestBatchSummaryRecord | null>>
  scan: (signal: AbortSignal) => Promise<void>
  rescan: () => void
}

export const useTestingViewData = ({
  workspacePath,
  setError,
}: {
  workspacePath: string | undefined
  setError: (message: string | null) => void
}): TestingViewData => {
  const { t } = useT()
  const [specs, setSpecs] = useState<TestSpecIndexEntry[]>([])
  const [environmentFiles, setEnvironmentFiles] = useState<EnvironmentFileEntry[]>([])
  const [runs, setRuns] = useState<TestRunSummaryRecord[]>([])
  const [environments, setEnvironments] = useState<TestEnvironmentRecord[]>([])
  const [selectedSpecPath, setSelectedSpecPath] = useState<string | null>(null)
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string | null>(null)
  const [syncedAt, setSyncedAt] = useState<Date | null>(null)
  const [loading, setLoading] = useState(false)
  const [latestBatch, setLatestBatch] = useState<TestBatchSummaryRecord | null>(null)

  const scan = useCallback(async (signal: AbortSignal): Promise<void> => {
    if (!workspacePath) {
      setSpecs([])
      setEnvironmentFiles([])
      setRuns([])
      setLatestBatch(null)
      setEnvironments([])
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [nextSpecs, nextEnvironmentFiles, nextRuns, nextLatestBatch, nextEnvironments] = await Promise.all([
        scanTestSpecs(workspacePath, signal),
        scanEnvironmentFiles(workspacePath, signal),
        listTestRunRecords(50),
        getLatestTestBatchRecord(),
        listTestEnvironmentRecords(),
      ])
      if (signal.aborted) return
      setSpecs(nextSpecs)
      setEnvironmentFiles(nextEnvironmentFiles)
      setRuns(nextRuns)
      setLatestBatch(nextLatestBatch)
      setEnvironments(nextEnvironments)
      setSyncedAt(new Date())
      setSelectedSpecPath((current) => {
        if (current && nextSpecs.some((spec) => spec.valid && spec.path === current)) return current
        return nextSpecs.find((spec) => spec.valid)?.path ?? null
      })
      setSelectedEnvironmentId((current) => (
        current && nextEnvironments.some((environment) => environment.id === current)
          ? current
          : nextEnvironments[0]?.id ?? null
      ))
    } catch (error) {
      if (!signal.aborted) {
        console.error('[testing] 索引扫描失败', error)
        setError(t('testing.index.error'))
      }
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }, [setError, t, workspacePath])

  useEffect(() => {
    const controller = new AbortController()
    void scan(controller.signal)
    return () => controller.abort()
  }, [scan])

  const rescan = useCallback((): void => {
    void scan(new AbortController().signal)
  }, [scan])

  return {
    specs,
    environmentFiles,
    runs,
    environments,
    latestBatch,
    selectedSpecPath,
    setSelectedSpecPath,
    selectedEnvironmentId,
    setSelectedEnvironmentId,
    syncedAt,
    loading,
    setRuns,
    setEnvironments,
    setLatestBatch,
    scan,
    rescan,
  }
}
