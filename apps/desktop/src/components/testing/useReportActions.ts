import { useEffect, useMemo, useState } from 'react'
import type { TestRunDetailRecord } from '@/platform/testRuns'
import type { TestEnvironmentRecord } from '@/platform/testEnvironments'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import { buildTestFailureSummary } from '@/stores/services/testFailureSummary'
import { useT } from '@/i18n'
import { buildReportTestPoints } from './testingViewData'

/**
 * 报告派生与交接动作（F4 handler 切片）：
 * - 报告对应的 spec / 测试点覆盖 / 是否可重跑；
 * - 重跑报告对应文件；
 * - 把失败摘要交接给会话。
 */

export interface ReportActions {
  handoffSessionId: string | null
  setHandoffSessionId: (sessionId: string | null) => void
  handoffSending: boolean
  reportSpec: TestSpecIndexEntry | undefined
  reportTestPoints: ReturnType<typeof buildReportTestPoints>
  canRerun: boolean
  rerunReport: () => void
  handoffReport: () => void
}

export const useReportActions = ({
  selectedReport,
  selectedReportPlan,
  specs,
  selectedTabId,
  running,
  environments,
  handoffSessions,
  activeSessionId,
  selectSession,
  sendToSession,
  onOpenSession,
  setSelectedSpecPath,
  setSelectedEnvironmentId,
  runSpecs,
  setError,
}: {
  selectedReport: TestRunDetailRecord | null
  selectedReportPlan: Parameters<typeof buildReportTestPoints>[0]['frozenPlan']
  specs: readonly TestSpecIndexEntry[]
  selectedTabId: string | null
  running: boolean
  environments: readonly TestEnvironmentRecord[]
  handoffSessions: readonly { id: string; title: string }[]
  activeSessionId: string | null
  selectSession: (sessionId: string) => Promise<boolean>
  sendToSession: (sessionId: string, content: string) => Promise<boolean>
  onOpenSession: () => void
  setSelectedSpecPath: (path: string | null) => void
  setSelectedEnvironmentId: (environmentId: string | null) => void
  runSpecs: (targets: readonly TestSpecIndexEntry[], environmentId: string | null) => Promise<void>
  setError: (message: string | null) => void
}): ReportActions => {
  const { t } = useT()
  const [handoffSessionId, setHandoffSessionId] = useState<string | null>(null)
  const [handoffSending, setHandoffSending] = useState(false)

  useEffect(() => {
    setHandoffSessionId((current) => {
      if (current && handoffSessions.some((session) => session.id === current)) return current
      if (activeSessionId && handoffSessions.some((session) => session.id === activeSessionId)) return activeSessionId
      return handoffSessions[0]?.id ?? null
    })
  }, [activeSessionId, handoffSessions])

  const reportSpec = selectedReport
    ? specs.find((spec) => spec.path === selectedReport.summary.specPath)
    : undefined
  const reportTestPoints = useMemo(() => buildReportTestPoints({
    report: selectedReport,
    frozenPlan: selectedReportPlan,
    scannedSpec: reportSpec,
  }), [reportSpec, selectedReport, selectedReportPlan])

  const canRerun = Boolean(
    selectedReport
    && reportSpec?.valid
    && (reportSpec.uiStepCount === 0 || selectedTabId)
    && !running
    && (!selectedReport.summary.environmentId
      || environments.some((environment) => environment.id === selectedReport.summary.environmentId)),
  )

  const rerunReport = (): void => {
    if (!selectedReport || !canRerun) return
    const { specPath, environmentId } = selectedReport.summary
    setSelectedSpecPath(specPath)
    setSelectedEnvironmentId(environmentId)
    // 重跑只跑这份报告对应的用例文件，与「运行范围」无关。
    const target = specs.find((spec) => spec.path === specPath)
    if (!target?.valid) return
    void runSpecs([target], environmentId)
  }

  const handoffReport = (): void => {
    if (!selectedReport || !handoffSessionId || handoffSending) return
    setHandoffSending(true)
    setError(null)
    void (async () => {
      try {
        if (handoffSessionId !== activeSessionId && !await selectSession(handoffSessionId)) {
          setError(t('testing.report.handoffError'))
          return
        }
        const summary = buildTestFailureSummary(selectedReport, {
          ...(reportTestPoints === undefined ? {} : { testPoints: reportTestPoints }),
        })
        if (!await sendToSession(handoffSessionId, summary)) {
          setError(t('testing.report.handoffError'))
          return
        }
        onOpenSession()
      } finally {
        setHandoffSending(false)
      }
    })()
  }

  return {
    handoffSessionId,
    setHandoffSessionId,
    handoffSending,
    reportSpec,
    reportTestPoints,
    canRerun,
    rerunReport,
    handoffReport,
  }
}
