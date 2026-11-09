import { useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { StepStatusChange } from '@/agent/testing/runner/runTestPlan'
import type { TestStepApprover } from '@/agent/testing/approval/testStepApprover'
import type { BrowserTabInfo } from '@/platform/browserSession'
import type {
  TestBatchSummaryRecord,
  TestRunDetailRecord,
  TestRunSummaryRecord,
} from '@/platform/testRuns'
import {
  getLatestTestBatchRecord,
  getTestRunRecord,
  listTestRunRecords,
} from '@/platform/testRuns'
import type { TestEnvironmentRecord } from '@/platform/testEnvironments'
import { listTestEnvironmentRecords } from '@/platform/testEnvironments'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import type { TestSuiteRunEntry, TestSuiteRunResult } from '@/stores/services/testSuiteRunner'
import { runTestSuite } from '@/stores/services/testSuiteRunner'
import { useT } from '@/i18n'
import { loadPlanArtifact } from './testingViewData'

/**
 * 运行与批次动作（F3/F5 handler 切片）：运行范围、套件执行、运行中快照、
 * 最近批次回读与环境列表刷新。
 */

export interface ActiveRunView {
  id: string
  path: string
  startedAt: number
  status: TestRunSummaryRecord['status']
  changes: StepStatusChange[]
}

export interface RunActions {
  /** 全部校验通过的用例文件（「运行全部」的目标，也是批次能力的存在依据）。 */
  allTargets: TestSpecIndexEntry[]
  /** 环境条当前选中的用例文件；无效或未选中时为 null。 */
  selectedTarget: TestSpecIndexEntry | null
  canRun: boolean
  canRunAll: boolean
  running: boolean
  activeRun: ActiveRunView | null
  suiteResult: TestSuiteRunResult | null
  suiteProgress: { index: number; total: number; path: string } | null
  batchLoading: boolean
  clock: number
  runSelected: () => void
  runAll: () => void
  runSpecs: (targets: readonly TestSpecIndexEntry[], environmentId: string | null) => Promise<void>
  stop: () => void
  loadRecentBatch: () => void
  refreshEnvironments: (preferredId?: string) => Promise<void>
}

export const useRunActions = ({
  workspacePath,
  specs,
  selectedSpecPath,
  tabs,
  selectedTabId,
  environments,
  selectedEnvironmentId,
  setSelectedEnvironmentId,
  activeSessionId,
  approver,
  latestBatch,
  setRuns,
  setLatestBatch,
  setEnvironments,
  showReport,
  setError,
}: {
  workspacePath: string | undefined
  specs: readonly TestSpecIndexEntry[]
  selectedSpecPath: string | null
  tabs: readonly BrowserTabInfo[]
  selectedTabId: string | null
  environments: readonly TestEnvironmentRecord[]
  selectedEnvironmentId: string | null
  setSelectedEnvironmentId: Dispatch<SetStateAction<string | null>>
  activeSessionId: string | null
  approver: TestStepApprover
  latestBatch: TestBatchSummaryRecord | null
  setRuns: Dispatch<SetStateAction<TestRunSummaryRecord[]>>
  setLatestBatch: Dispatch<SetStateAction<TestBatchSummaryRecord | null>>
  setEnvironments: Dispatch<SetStateAction<TestEnvironmentRecord[]>>
  showReport: (detail: TestRunDetailRecord | null) => void
  setError: (message: string | null) => void
}): RunActions => {
  const { t } = useT()
  const runControllerRef = useRef<AbortController | null>(null)
  const [suiteResult, setSuiteResult] = useState<TestSuiteRunResult | null>(null)
  const [suiteProgress, setSuiteProgress] = useState<{ index: number; total: number; path: string } | null>(null)
  const [activeRun, setActiveRun] = useState<ActiveRunView | null>(null)
  const [running, setRunning] = useState(false)
  const [batchLoading, setBatchLoading] = useState(false)
  const [clock, setClock] = useState(Date.now())

  // 主按钮只跑**环境条选中的用例文件**；「运行全部」是显式的第二动作，不默认扩大执行面。
  // 一个文件失败不阻断后续：批次能力仍在，只是不再由「重放」隐式触发。
  const allTargets = useMemo(
    () => specs.filter((spec) => spec.valid),
    [specs],
  )
  const selectedTarget = useMemo(
    () => specs.find((spec) => spec.path === selectedSpecPath && spec.valid) ?? null,
    [selectedSpecPath, specs],
  )

  const canRun = Boolean(
    workspacePath
    && !running
    && selectedTarget !== null
    && (selectedTarget.uiStepCount === 0 || selectedTabId),
  )
  const canRunAll = Boolean(
    workspacePath
    && !running
    && allTargets.length > 0
    && (allTargets.every((spec) => spec.uiStepCount === 0) || selectedTabId),
  )

  useEffect(() => () => runControllerRef.current?.abort(), [])
  useEffect(() => {
    if (!running) return
    setClock(Date.now())
    const interval = window.setInterval(() => setClock(Date.now()), 250)
    return () => window.clearInterval(interval)
  }, [running])

  const runSpecs = async (
    targets: readonly TestSpecIndexEntry[],
    environmentId: string | null,
  ): Promise<void> => {
    const tab = tabs.find((candidate) => candidate.tabId === selectedTabId)
    const environment = environments.find((candidate) => candidate.id === environmentId)
    if (!workspacePath || targets.length === 0 || running) return
    if (environmentId && !environment) {
      setError(t('testing.run.environmentMissing'))
      return
    }
    // 含 UI 步骤的用例必须有目标标签页：开跑前给可读提示（runner 内还有一道权威校验）。
    if (targets.some((spec) => spec.uiStepCount > 0) && !tab) {
      setError(t('testing.run.selectTab'))
      return
    }
    const controller = new AbortController()
    runControllerRef.current = controller
    setRunning(true)
    setError(null)
    showReport(null)
    setSuiteResult(null)
    setSuiteProgress(null)
    setActiveRun(null)
    try {
      const result = await runTestSuite({
        workspacePath,
        specs: targets.map((spec) => ({
          path: spec.path,
          uiStepCount: spec.uiStepCount,
          apiStepCount: spec.apiStepCount,
        })),
        ...(environment ? { environment } : {}),
        ...(tab ? { tab: { tabId: tab.tabId, url: tab.url } } : {}),
        approver,
        signal: controller.signal,
        ...(activeSessionId ? { sourceSessionId: activeSessionId } : {}),
        onRunStarted: ({ index, total, path, runId }) => {
          setSuiteProgress(total > 1 ? { index, total, path } : null)
          setActiveRun({ id: runId, path, startedAt: Date.now(), status: 'running', changes: [] })
        },
        onStepStatusChange: ({ runId, change }) => {
          setActiveRun((current) => current && current.id === runId
            ? {
                ...current,
                changes: [
                  ...current.changes.filter((candidate) => (
                    candidate.caseId !== change.caseId || candidate.stepId !== change.stepId
                  )),
                  change,
                ],
              }
            : current)
        },
      })
      setSuiteResult(result)
      if (result.blockedReason !== null) {
        setError(result.blockedReason)
        return
      }
      const lastCompleted = [...result.entries].reverse().find((entry) => entry.runId !== null)
      setActiveRun((current) => current && lastCompleted
        ? { ...current, status: lastCompleted.status }
        : current)
      if (lastCompleted?.runId) {
        try {
          showReport(await getTestRunRecord(lastCompleted.runId))
        } catch {
          setError(t('testing.report.loadError'))
        }
      }
      try {
        const [nextRuns, nextLatestBatch] = await Promise.all([
          listTestRunRecords(50),
          getLatestTestBatchRecord(),
        ])
        setRuns(nextRuns)
        setLatestBatch(nextLatestBatch)
      } catch {
        setError(t('testing.index.error'))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('testing.run.error'))
    } finally {
      if (runControllerRef.current === controller) runControllerRef.current = null
      setRunning(false)
      setSuiteProgress(null)
    }
  }

  const runSelected = (): void => {
    void runSpecs(selectedTarget ? [selectedTarget] : [], selectedEnvironmentId)
  }

  const runAll = (): void => {
    void runSpecs(allTargets, selectedEnvironmentId)
  }

  const stop = (): void => {
    runControllerRef.current?.abort()
  }

  const loadRecentBatch = (): void => {
    if (!latestBatch || running || batchLoading) return
    setBatchLoading(true)
    setError(null)
    void (async () => {
      try {
        const entries: TestSuiteRunEntry[] = []
        for (const run of latestBatch.runs) {
          const detail = await getTestRunRecord(run.id)
          if (!detail) {
            entries.push({
              path: run.specPath,
              runId: run.id,
              status: run.status,
              reason: t('testing.batch.detailMissing'),
            })
            continue
          }
          const plan = detail.planContentHash === null
            ? null
            : await loadPlanArtifact(detail.planContentHash)
          entries.push({
            path: run.specPath,
            runId: run.id,
            status: run.status,
            caseStatuses: detail.cases.map((testCase) => ({
              caseId: testCase.caseId,
              status: testCase.status,
            })),
            ...(plan ? {
              testPointIds: plan.testPoints?.map((point) => point.id) ?? [],
              caseIds: plan.cases.map((testCase) => testCase.id),
              caseVerifies: plan.cases.map((testCase) => testCase.verifies ?? []),
            } : {}),
          })
        }
        setSuiteResult({ batchId: latestBatch.batchId, blockedReason: null, entries })
        setSuiteProgress(null)
        setActiveRun(null)
      } catch {
        setError(t('testing.batch.loadError'))
      } finally {
        setBatchLoading(false)
      }
    })()
  }

  const refreshEnvironments = async (preferredId?: string): Promise<void> => {
    const next = await listTestEnvironmentRecords()
    setEnvironments(next)
    setSelectedEnvironmentId((current) => {
      if (preferredId && next.some((environment) => environment.id === preferredId)) return preferredId
      if (current && next.some((environment) => environment.id === current)) return current
      return next[0]?.id ?? null
    })
  }

  return {
    allTargets,
    selectedTarget,
    canRun,
    canRunAll,
    running,
    activeRun,
    suiteResult,
    suiteProgress,
    batchLoading,
    clock,
    runSelected,
    runAll,
    runSpecs,
    stop,
    loadRecentBatch,
    refreshEnvironments,
  }
}
