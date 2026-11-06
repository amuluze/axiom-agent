/**
 * 测试视图（AppView 'testing'，从侧栏「测试」进入；侧栏此时切换为测试助手会话列）。
 * 形态按 .pen 设计稿四页对齐：tsCases（用例总览）/ tsRunng（运行中）/
 * tsRprt（运行报告）/ tsEmpt（空态）。
 *
 * 结构（自上而下）：
 * - 顶栏（Shared31）：用例文件标签页 + 运行范围 + 刷新 + 唯一主运行入口
 * - 环境条（eNvBar）：运行环境 / 视口 / 校验状态；仅套件含 UI 步骤时显示目标标签页
 * - 主体按状态切换：用例表 + KPI（默认）｜进度 + 步骤流（运行中）｜KPI + 失败详情 +
 *   断言项表（报告）
 * - 创作/产物核对默认折叠；固化面板保留独立入口
 * - 底栏：文件 · 用例数｜协议版本｜导出报告
 *
 * 用例文件是测试的唯一事实来源：本页负责确定性重放与报告，起草/修改由左侧
 * 助手会话（或固化通道）完成——写 .testspec.json 仍走会话的写工具审批链。
 */
import { useMemo, useState } from 'react'
import {
  AlertCircle,
} from 'lucide-react'
import { createTestStepApprover } from '@/agent/testing/approval/testStepApprover'
import { useT } from '@/i18n'
import { useAgentStore } from '@/stores/agentStore'
import { useBrowserStore } from '@/stores/browserStore'
import { useUiStore } from '@/stores/uiStore'
import { downloadTestRunJUnit, downloadTestRunReport } from '@/stores/services/testReportExport'
import { matchesTestSpecType, type TestSpecTypeFilter } from '@/stores/services/testSpecFilter'
import { TestEnvironmentDialog } from './TestEnvironmentDialog'
import { TestingEmptyState } from './testingViewRows'
import { RunProgress } from './RunProgress'
import { RunReport } from './RunReport'
import { SolidifyPanel } from './SolidifyPanel'
import { TestingEnvironmentBar, TestingTopbar } from './TestingHeader'
import { CasesOverview } from './CasesOverview'
import { TestingSuiteSummary } from './TestingSuiteSummary'
import { AuthoringPanel } from './AuthoringPanel'
import { RecentRunsPanel } from './RecentRunsPanel'
import { useTestingViewData } from './useTestingViewData'
import { useSelectedSpecDetail } from './useSelectedSpecDetail'
import { useTestingReport } from './useTestingReport'
import { TestingFooter } from './TestingFooter'
import { useSolidifyActions } from './useSolidifyActions'
import { useAuthoringActions } from './useAuthoringActions'
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
  const messages = useAgentStore((state) => state.messages)
  const providerReady = useAgentStore((state) => state.providerReady)
  const providerSetupRequired = useAgentStore((state) => state.providerSetupRequired)
  const runtimeLifecycle = useAgentStore((state) => state.runtimeLifecycle)
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

  const {
    feature: authoringFeature,
    setFeature: setAuthoringFeature,
    sending: authoringSending,
    sent: authoringSent,
    canRequest: canRequestAuthoring,
    request: requestAuthoring,
    checking: authoringChecking,
    canCheck: canCheckArtifacts,
    check: authoringCheck,
    checkArtifacts,
  } = useAuthoringActions({
    workspacePath: workspace?.path,
    workspaceReady: Boolean(workspace),
    activeSessionId,
    selectedSpecPath,
    sendToSession,
    setError,
  })

  const {
    runScope,
    setRunScope,
    suiteTargets,
    canRun,
    running,
    activeRun,
    suiteResult,
    suiteProgress,
    batchLoading,
    clock,
    runSelected,
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
  const filteredSpecs = useMemo(
    () => runScope === 'current'
      ? specs
      : specs.filter((spec) => matchesTestSpecType(spec, runScope)),
    [runScope, specs],
  )
  const showBrowserTarget = suiteTargets.some((spec) => spec.uiStepCount > 0)

  const { suiteCoverage, suiteSummary } = useTestingSuiteSummary({
    suiteResult,
    specs,
    filteredSpecs,
  })

  const changeRunScope = (scope: 'current' | TestSpecTypeFilter): void => {
    setRunScope(scope)
    if (scope === 'current') return
    if (selectedSpecPath && specs.some((spec) => spec.path === selectedSpecPath && matchesTestSpecType(spec, scope))) return
    setSelectedSpecPath(specs.find((spec) => spec.valid && matchesTestSpecType(spec, scope))?.path ?? null)
  }

  // G1-6：模型必须就绪（run/steer 与 sendToSession 同口径）且工作区与会话都可用。
  const providerGate = runtimeLifecycle === 'ready' && providerReady && !providerSetupRequired
  const {
    open: solidifyOpen,
    draft: solidifyDraft,
    status: solidifyStatus,
    sourceSessionId: solidifySourceSessionId,
    targetSessionId: solidifyTargetSessionId,
    disabledReason: solidifyDisabledReason,
    generating: solidifyGenerating,
    sending: solidifySending,
    canSolidify,
    canSend: canSendSolidify,
    stepCount: solidifyStepCount,
    toggle: toggleSolidify,
    setSource: setSolidifySourceSessionId,
    setTarget: setSolidifyTargetSessionId,
    generate: generateSolidify,
    send: sendSolidify,
  } = useSolidifyActions({
    activeSessionId,
    sessions: handoffSessions,
    messages,
    workspaceReady: Boolean(workspace),
    providerGate,
    selectSession,
    sendToSession,
    onOpenSession: () => setView('session'),
    setError,
  })

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
        : suiteTargets.length === 0
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
        filteredSpecs={filteredSpecs}
        selectedSpecPath={selectedSpecPath}
        onSelectSpec={setSelectedSpecPath}
        runScope={runScope}
        onRunScopeChange={changeRunScope}
        syncedLabel={syncedLabel}
        loading={loading}
        workspaceReady={Boolean(workspace)}
        onRescan={rescan}
        canRun={canRun}
        runBlockedReason={runBlockedReason}
        onRun={runSelected}
      />

      <TestingEnvironmentBar
        selectedEnvironment={selectedEnvironment}
        showBrowserTarget={showBrowserTarget}
        selectedTabId={selectedTabId}
        onSelectTab={setSelectedTabId}
        tabs={tabs}
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

            {/* 创作只有一条主入口：会话里用 test-authoring 生成用例；固化与产物核对是同一流程的收尾。 */}
            <details className="testing-view__secondary-tools">
              <summary>{t('testing.authoring.section')}</summary>
              <div className="testing-view__secondary-tools-content">
                <AuthoringPanel
                  feature={authoringFeature}
                  onFeatureChange={setAuthoringFeature}
                  sending={authoringSending}
                  sent={authoringSent}
                  canRequest={canRequestAuthoring}
                  onRequest={requestAuthoring}
                  checking={authoringChecking}
                  canCheck={canCheckArtifacts}
                  check={authoringCheck}
                  onCheck={checkArtifacts}
                />

                <SolidifyPanel
                  open={solidifyOpen}
                  draft={solidifyDraft}
                  status={solidifyStatus}
                  sourceSessionId={solidifySourceSessionId}
                  targetSessionId={solidifyTargetSessionId}
                  sessions={handoffSessions}
                  disabledReason={solidifyDisabledReason}
                  generating={solidifyGenerating}
                  sending={solidifySending}
                  canSolidify={canSolidify}
                  canSend={canSendSolidify}
                  stepCount={solidifyStepCount}
                  onToggle={toggleSolidify}
                  onSourceChange={setSolidifySourceSessionId}
                  onTargetChange={setSolidifyTargetSessionId}
                  onGenerate={generateSolidify}
                  onSend={sendSolidify}
                />

                <div className="testing-view__hint-card testing-view__hint-card--warn">
                  <AlertCircle size={13} aria-hidden />
                  <span>{t('testing.cases.approvalHint')}</span>
                </div>
              </div>
            </details>
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


