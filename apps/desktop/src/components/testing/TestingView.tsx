/**
 * 测试视图（AppView 'testing'，从侧栏「测试」进入；侧栏此时切换为测试助手会话列）。
 * 形态按 .pen 设计稿四页对齐：tsCases（用例总览）/ tsRunng（运行中）/
 * tsRprt（运行报告）/ tsEmpt（空态）。
 *
 * 结构（自上而下）：
 * - 顶栏（Shared31）：同步时间 + 刷新 + 重放选中文件 + 运行全部（多个可运行文件时）
 * - 环境条（eNvBar）：运行环境 / 用例文件选择（决定重放目标与下方展示）/ 视口 / 校验状态；
 *   存在含 UI 步骤的用例文件时显示目标标签页
 * - 主体按状态切换：用例表 + KPI（默认）｜进度 + 步骤流（运行中）｜KPI + 失败详情 +
 *   断言项表（报告）
 * - 底栏：文件 · 用例数｜协议版本｜导出报告
 *
 * 用例文件是测试的唯一事实来源：本页负责确定性重放与报告；起草/修改由左侧助手
 * 会话完成（写 .testspec.json 走会话的写工具审批链），本页不提供第二个创作入口。
 */
import { useMemo, useState } from 'react'
import { createTestStepApprover } from '@/agent/testing/approval/testStepApprover'
import { useT } from '@/i18n'
import { useAgentStore } from '@/stores/agentStore'
import { useBrowserStore } from '@/stores/browserStore'
import { useUiStore } from '@/stores/uiStore'
import { downloadTestRunJUnit, downloadTestRunReport } from '@/stores/services/testReportExport'
import { TestEnvironmentDialog } from './TestEnvironmentDialog'
import { TestingEmptyState } from './testingViewRows'
import { RunProgress } from './RunProgress'
import { RunReport } from './RunReport'
import { TestingEnvironmentBar, TestingTopbar } from './TestingHeader'
import { CasesOverview } from './CasesOverview'
import { TestingSuiteSummary } from './TestingSuiteSummary'
import { RecentRunsPanel } from './RecentRunsPanel'
import { useTestingViewData } from './useTestingViewData'
import { useSelectedSpecDetail } from './useSelectedSpecDetail'
import { useTestingReport } from './useTestingReport'
import { TestingFooter } from './TestingFooter'
import { useRunActions } from './useRunActions'
import { useReportActions } from './useReportActions'
import { useTestingPromptContext } from './useTestingPromptContext'
import { useTestingSuiteSummary } from './useTestingSuiteSummary'
import { useSelectedBrowserTab } from './useSelectedBrowserTab'
import { useTestingViewDerived } from './useTestingViewDerived'

export const TestingView = () => {
  const { t } = useT()
  const workspace = useAgentStore((state) => state.authorizedWorkspace)
  const sessions = useAgentStore((state) => state.sessions)
  const activeSessionId = useAgentStore((state) => state.activeSessionId)
  const selectSession = useAgentStore((state) => state.selectSession)
  const sendToSession = useAgentStore((state) => state.sendToSession)
  const tabs = useBrowserStore((state) => state.tabs)
  const { selectedTabId, setSelectedTabId } = useSelectedBrowserTab(tabs)
  const openRuntimeRailPane = useUiStore((state) => state.openRuntimeRailPane)
  const setView = useUiStore((state) => state.setView)
  const approver = useMemo(() => createTestStepApprover(), [])
  const [envDialogOpen, setEnvDialogOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const {
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
    rescan,
  } = useTestingViewData({ workspacePath: workspace?.path, setError })

  /**
   * 最近一个批次。由 Rust 按 `batch_id` 直接回读（而不是从运行列表里猜），
   * 因此批次文件数不再受列表窗口限制；超过硬上限时 `truncated` 由宿主如实标出。
   */
  const recentBatch = latestBatch
  const handoffSessions = useMemo(
    () => sessions.filter((session) => (
      !session.archivedAt && session.workspace?.path === workspace?.path
    )),
    [sessions, workspace?.path],
  )

  useTestingPromptContext({ activeSessionId, specs, environments })

  // 选中 spec 的明细投影（用例明细 / 最近运行 / 用例状态列）。
  const { specDetail, latestRun, caseStatusById } = useSelectedSpecDetail({
    specs,
    runs,
    selectedSpecPath,
    workspacePath: workspace?.path,
  })

  const {
    selectedReport,
    selectedReportPlan,
    repairRounds,
    expandedStepKey,
    setExpandedStepKey,
    showReport,
    openReport,
  } = useTestingReport({ setError })

  /**
   * 切换用例文件（唯一入口：环境条选择器）。已打开的报告属于**另一份** spec；
   * 不清掉它，下方会一直停在那份旧报告，直到下一次回放结束才换成新文件的内容。
   */
  const selectSpec = (path: string | null): void => {
    setSelectedSpecPath(path)
    showReport(null)
  }

  const {
    allTargets,
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
  } = useRunActions({
    workspacePath: workspace?.path,
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
  })

  const selectedSpec = specs.find((spec) => spec.path === selectedSpecPath)
  const showBrowserTarget = allTargets.some((spec) => spec.uiStepCount > 0)

  const { suiteCoverage, suiteSummary } = useTestingSuiteSummary({ suiteResult, specs })

  const {
    handoffSessionId,
    setHandoffSessionId,
    handoffSending,
    reportSpec,
    canRerun,
    rerunReport,
    handoffReport,
  } = useReportActions({
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
    onOpenSession: () => setView('session'),
    setSelectedSpecPath,
    setSelectedEnvironmentId,
    runSpecs,
    setError,
  })

  // ── 派生展示数据 ──────────────────────────────────────────────

  /** 主运行入口不可用时给出**具体**原因，而不是一个沉默的 disabled 按钮。 */
  const runBlockedReason = canRun
    ? null
    : !workspace
      ? t('testing.topbar.blockedNoWorkspace')
      : running
        ? t('testing.topbar.blockedRunning')
        : !selectedSpec
          ? t('testing.topbar.blockedNoSelectedSpec')
          : !selectedSpec.valid
            ? t('testing.topbar.blockedInvalidSpec')
            : t('testing.topbar.blockedNoTab')

  /** 「运行全部」的不可用原因（与主按钮分开：选中的文件可跑不代表整批可跑）。 */
  const runAllBlockedReason = canRunAll
    ? null
    : !workspace
      ? t('testing.topbar.blockedNoWorkspace')
      : running
        ? t('testing.topbar.blockedRunning')
        : allTargets.length === 0
          ? t('testing.topbar.blockedNoSpec')
          : t('testing.topbar.blockedNoTab')

  const { selectedEnvironment, syncedLabel, specIssueCount, activeRunSpec } =
    useTestingViewDerived({
      environments,
      selectedEnvironmentId,
      syncedAt,
      selectedSpec,
      activeRun,
      specs,
    })

  // ── 空态（tsEmpt）────────────────────────────────────────────

  if (specs.length === 0 && !loading) {
    return (
      <TestingEmptyState
        hasWorkspace={Boolean(workspace)}
        scanning={loading}
        error={error}
        onRescan={rescan}
      />
    )
  }

  // ── 主布局 ───────────────────────────────────────────────────

  return (
    <section className="testing-view">
      <TestingTopbar
        syncedLabel={syncedLabel}
        loading={loading}
        workspaceReady={Boolean(workspace)}
        onRescan={rescan}
        canRun={canRun}
        runBlockedReason={runBlockedReason}
        onRun={runSelected}
        replayTarget={selectedSpec?.path ?? null}
        showRunAll={allTargets.length > 1}
        runAllCount={allTargets.length}
        canRunAll={canRunAll}
        runAllBlockedReason={runAllBlockedReason}
        onRunAll={runAll}
      />

      <TestingEnvironmentBar
        selectedEnvironment={selectedEnvironment}
        showBrowserTarget={showBrowserTarget}
        selectedTabId={selectedTabId}
        onSelectTab={setSelectedTabId}
        tabs={tabs}
        specs={specs}
        selectedSpecPath={selectedSpecPath}
        onSelectSpec={selectSpec}
        selectedSpec={selectedSpec}
        specIssueCount={specIssueCount}
        onOpenEnvironment={() => setEnvDialogOpen(true)}
        onOpenBrowser={() => openRuntimeRailPane('browser')}
      />

      <TestEnvironmentDialog
        open={envDialogOpen}
        environments={environments}
        environmentFiles={environmentFiles}
        selectedId={selectedEnvironmentId}
        disabled={!workspace || running}
        onSelect={setSelectedEnvironmentId}
        onChanged={refreshEnvironments}
        onClose={() => setEnvDialogOpen(false)}
      />

      {/* 批次摘要只在套件运行出现过时才占位置：常驻的「最近批次」入口在运行历史卡里。 */}
      {(running || suiteResult !== null) && (
        <TestingSuiteSummary
          suiteSummary={suiteSummary}
          suiteCoverage={suiteCoverage}
        />
      )}

      {error && <div role="alert" className="testing-view__error">{error}</div>}

      <div className="testing-view__body" aria-live="polite">
        {running && activeRun ? (
          <RunProgress
            activeRun={activeRun}
            activeRunSpec={activeRunSpec}
            suiteProgress={suiteProgress}
            clock={clock}
            approver={approver}
            onStop={stop}
          />
        ) : selectedReport ? (
          <RunReport
            report={selectedReport}
            specName={reportSpec?.name ?? undefined}
            repairRounds={repairRounds}
            handoffSessionId={handoffSessionId}
            handoffSessions={handoffSessions}
            handoffSending={handoffSending}
            canRerun={canRerun}
            expandedStepKey={expandedStepKey}
            onHandoffSessionChange={setHandoffSessionId}
            onHandoff={handoffReport}
            onRerun={rerunReport}
            onBack={() => showReport(null)}
            onExport={() => downloadTestRunReport(selectedReport)}
            onExportJUnit={() => downloadTestRunJUnit(selectedReport)}
            onToggleStep={setExpandedStepKey}
          />
        ) : (
          /* ── 用例总览（tsCases）── */
          <>
            <CasesOverview
              selectedSpec={selectedSpec}
              specDetail={specDetail}
              latestRun={latestRun}
              caseStatusById={caseStatusById}
              running={running}
              approver={approver}
              onStop={stop}
              onOpenReport={(runId) => void openReport(runId)}
            />

            <RecentRunsPanel
              runs={runs}
              recentBatch={recentBatch}
              batchLoading={batchLoading}
              onLoadRecentBatch={() => void loadRecentBatch()}
              onOpenReport={(runId) => void openReport(runId)}
            />
          </>
        )}
      </div>

      <TestingFooter
        selectedSpec={selectedSpec}
        specDetail={specDetail}
        selectedReport={selectedReport}
        latestRun={latestRun}
        onExportReport={(report) => downloadTestRunReport(report)}
        onOpenReport={(runId) => void openReport(runId)}
      />
    </section>
  )
}


