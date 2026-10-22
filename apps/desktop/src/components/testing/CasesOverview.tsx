import { Square } from 'lucide-react'
import type { SolidifyDraft } from '@/agent/testing/spec/solidify'
import type { TestStepApprover } from '@/agent/testing/approval/testStepApprover'
import type { TestRunStatus, TestRunSummaryRecord } from '@/platform/testRuns'
import type { SpecDetail } from '@/stores/services/testSpecDetail'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import { useT } from '@/i18n'
import { TestStepApprovalPanel } from './TestStepApprovalPanel'
import { SpecCaseTableRow, statusKey } from './testingViewRows'

/**
 * 用例总览（F2 主体）：选中 spec 的标题/KPI/用例表，以及准备阶段的审批与停止入口。
 *
 * 运行、固化、授权等副作用由 TestingView 注入；本组件只做展示与回调。
 */

export interface CasesOverviewProps {
  selectedSpec: TestSpecIndexEntry | undefined
  specDetail: SpecDetail | null
  latestRun: TestRunSummaryRecord | null
  caseStatusById: ReadonlyMap<string, TestRunStatus>
  canRun: boolean
  running: boolean
  approver: TestStepApprover
  solidifyDisabledReason: string | null
  solidifyOpen: boolean
  solidifyDraft: SolidifyDraft | null
  onRun: () => void
  onStop: () => void
  onToggleSolidify: () => void
}

export const CasesOverview = ({
  selectedSpec,
  specDetail,
  latestRun,
  caseStatusById,
  canRun,
  running,
  approver,
  solidifyDisabledReason,
  solidifyOpen,
  solidifyDraft,
  onRun,
  onStop,
  onToggleSolidify,
}: CasesOverviewProps) => {
  const { t } = useT()
  if (!selectedSpec) {
    return <div className="testing-view__placeholder">{t('testing.run.selectSpec')}</div>
  }
  return (
    <>
      <div className="testing-view__title-row">
        <div className="testing-view__title-text">
          <h1>{selectedSpec.name ?? selectedSpec.path.split('/').at(-1)}</h1>
          <p>
            {selectedSpec.path}
            {selectedSpec.valid
              ? ` · ${t('testing.index.specMeta', {
                  cases: selectedSpec.caseCount,
                  ui: selectedSpec.uiStepCount,
                  api: selectedSpec.apiStepCount,
                })}`
              : ` · ${selectedSpec.issues[0]?.path}: ${selectedSpec.issues[0]?.message}`}
            {latestRun ? ` · ${t('testing.cases.lastRunAt', { time: new Date(latestRun.startedAt).toLocaleString() })}` : ''}
          </p>
        </div>
        <button
          type="button"
          className="testing-view__chip testing-view__chip--primary"
          disabled={!canRun}
          onClick={onRun}
        >
          {running ? t('testing.status.running') : t('testing.topbar.replay')}
        </button>
        <button
          type="button"
          className="testing-view__chip"
          disabled={Boolean(solidifyDisabledReason)}
          aria-expanded={solidifyOpen}
          onClick={onToggleSolidify}
        >
          {t('testing.solidify.generate')}
        </button>
      </div>
      {running && (
        <div className="testing-view__preparing">
          <TestStepApprovalPanel approver={approver} />
          <button type="button" className="testing-view__chip" onClick={onStop}>
            <Square size={11} fill="currentColor" aria-hidden />
            {t('testing.run.stop')}
          </button>
        </div>
      )}
      <div className="testing-view__kpis">
        <article className="testing-view__kpi">
          <span>{t('testing.cases.kpiCases')}</span>
          <strong>{specDetail?.cases.length ?? selectedSpec.caseCount}</strong>
          <em className="testing-view__kpi-note">
            {specDetail
              ? t('testing.cases.kpiCasesNote', {
                  ui: specDetail.uiCaseCount,
                  api: specDetail.apiCaseCount,
                  mixed: specDetail.mixedCaseCount,
                })
              : t('testing.index.specMeta', {
                  cases: selectedSpec.caseCount,
                  ui: selectedSpec.uiStepCount,
                  api: selectedSpec.apiStepCount,
                })}
          </em>
        </article>
        <article className="testing-view__kpi">
          <span>{t('testing.cases.kpiLastRun')}</span>
          <strong>{latestRun ? t(statusKey(latestRun.status)) : t('testing.cases.kpiLastRunNone')}</strong>
          {latestRun && (
            <em className={`testing-view__kpi-note${latestRun.status === 'passed' ? '' : ' testing-view__kpi-note--fail'}`}>
              {new Date(latestRun.startedAt).toLocaleString()}
            </em>
          )}
        </article>
        <article className="testing-view__kpi">
          <span>{t('testing.cases.kpiAsserts')}</span>
          <strong>{specDetail?.assertCount ?? '—'}</strong>
          {solidifyDraft && solidifyDraft.issues.length > 0 && (
            <em className="testing-view__kpi-note testing-view__kpi-note--warn">
              {t('testing.solidify.reviewCount', { count: solidifyDraft.issues.length })}
            </em>
          )}
        </article>
      </div>
      {selectedSpec.valid && (
        <section className="testing-view__card">
          <div className="testing-view__card-header">
            <h2>{t('testing.cases.tableCase')}</h2>
            <span>{t('testing.cases.tableVerdict')}</span>
          </div>
          <div className="testing-view__card-divider" />
          {specDetail ? (
            <ul className="testing-view__rows">
              {specDetail.cases.map((testCase) => (
                <SpecCaseTableRow
                  key={testCase.id}
                  row={testCase}
                  status={caseStatusById.get(testCase.id) ?? null}
                />
              ))}
            </ul>
          ) : (
            <p className="testing-view__card-note">{t('testing.cases.detailUnavailable')}</p>
          )}
        </section>
      )}
    </>
  )
}
