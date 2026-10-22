import type { JSX } from 'react'
import { ChevronRight, Download, RotateCcw, Send } from 'lucide-react'
import { describeEnvironmentFacts } from '@/agent/testing/environment/envFacts'
import type { RepairRoundSummary } from '@/stores/services/testRepairRounds'
import type { TestRunDetailRecord } from '@/platform/testRuns'
import { isFailureOrigin } from '@/agent/testing/runner/runState'
import { useT } from '@/i18n'
import { ArtifactPreview } from '@/components/ArtifactPreview'
import { StatusIcon, StatusPill, statusKey } from './testingViewRows'
import {
  computeReportKpis,
  detailValue,
  durationLabel,
  findReportFailure,
  stepDetails,
} from './testingViewData'

/**
 * 运行报告视图（F4 切片，tsRprt）：KPI、失败详情/归因、断言项表、证据与导出。
 *
 * 报告数据与修复轮次由 TestingView 装入；本组件只做投影与交互回调。
 */

export interface RunReportProps {
  report: TestRunDetailRecord
  specName?: string
  repairRounds: RepairRoundSummary | null
  handoffSessionId: string | null
  handoffSessions: readonly { id: string; title: string }[]
  handoffSending: boolean
  canRerun: boolean
  expandedStepKey: string | null
  onHandoffSessionChange: (sessionId: string | null) => void
  onHandoff: () => void
  onRerun: () => void
  onBack: () => void
  onExport: () => void
  onExportJUnit: () => void
  onToggleStep: (key: string | null) => void
}

export const RunReport = ({
  report,
  specName,
  repairRounds,
  handoffSessionId,
  handoffSessions,
  handoffSending,
  canRerun,
  expandedStepKey,
  onHandoffSessionChange,
  onHandoff,
  onRerun,
  onBack,
  onExport,
  onExportJUnit,
  onToggleStep,
}: RunReportProps) => {
  const { t } = useT()
  const kpis = computeReportKpis(report)
  const environmentFactsLine = describeEnvironmentFacts(report.summary.envFactsJson)
  const failure = findReportFailure(report)
  const title = `${specName ?? report.summary.specPath} · ${report.summary.id.slice(-6)}`
  return (
    <>
      <div className="testing-view__title-row">
        <div className="testing-view__title-text">
          <h1 aria-label={t('testing.report.title')}>{title}</h1>
          <p>
            {report.summary.specPath}
            {` · ${new Date(report.summary.startedAt).toLocaleString()}`}
          </p>
        </div>
        <StatusPill status={report.summary.status} />
        <button type="button" className="testing-view__chip" onClick={onExport}>
          <Download size={12} aria-hidden />
          {t('testing.report.export')}
        </button>
        <button type="button" className="testing-view__chip" onClick={onExportJUnit}>
          <Download size={12} aria-hidden />
          {t('testing.report.exportJUnit')}
        </button>
        <button type="button" className="testing-view__chip" disabled={!canRerun} onClick={onRerun}>
          <RotateCcw size={12} aria-hidden />
          {t('testing.topbar.replay')}
        </button>
      </div>
      {environmentFactsLine && (
        <p className="testing-view__env-facts">{environmentFactsLine}</p>
      )}
      {kpis && (
        <div className="testing-view__kpis testing-view__kpis--six">
          <article className="testing-view__kpi">
            <span>{t('testing.status.passed')}</span>
            <strong>{kpis.passed}</strong>
          </article>
          <article className="testing-view__kpi">
            <span>{t('testing.status.failed')}</span>
            <strong>{kpis.failed}</strong>
            <em className="testing-view__kpi-note testing-view__kpi-note--fail">{t('testing.report.firstVerdict')}</em>
          </article>
          <article className="testing-view__kpi">
            <span>{t('testing.status.error')}</span>
            <strong>{kpis.error}</strong>
          </article>
          <article className="testing-view__kpi">
            <span>{t('testing.status.rejected')}</span>
            <strong>{kpis.rejected}</strong>
          </article>
          <article className="testing-view__kpi">
            <span>{t('testing.status.skipped')}</span>
            <strong>{kpis.skipped}</strong>
          </article>
          <article className="testing-view__kpi">
            <span>{t('testing.report.kpiDuration')}</span>
            <strong>{kpis.duration ?? '—'}</strong>
          </article>
        </div>
      )}
      {failure && (() => {
        const details = stepDetails(failure.step?.detailsJson ?? null)
        const origin = isFailureOrigin(failure.testCase.failureOrigin)
          ? failure.testCase.failureOrigin
          : null
        return (
          <section className="testing-view__card">
            <div className="testing-view__card-header">
              <h2>{t('testing.report.failureTitle', { name: failure.testCase.caseName })}</h2>
              <StatusPill status={failure.testCase.status} />
            </div>
            <div className="testing-view__card-divider" />
            <div className="testing-view__failure-grid">
              <div>
                <span>{t('testing.report.expected')}</span>
                <strong>{details.expected !== undefined
                  ? detailValue(details.expected)
                  : failure.testCase.failureKind ?? t(statusKey(failure.testCase.status))}</strong>
              </div>
              <div>
                <span>{t('testing.report.actual')}</span>
                <strong className="testing-view__failure-actual">
                  {details.message ?? (details.actual !== undefined ? detailValue(details.actual) : '—')}
                </strong>
              </div>
              <div>
                <span>{t('testing.report.failureEvidence')}</span>
                {failure.step?.evidenceArtifact
                  ? <ArtifactPreview artifact={failure.step.evidenceArtifact} />
                  : <strong>{failure.step?.evidenceContentHash
                    ? t('testing.report.evidence', { hash: failure.step.evidenceContentHash.slice(0, 12) })
                    : '—'}</strong>}
              </div>
              <div>
                <span>{t('testing.report.origin')}</span>
                <strong data-testid="test-report-origin">
                  {origin === null ? '—' : t(`testing.origin.${origin}`)}
                </strong>
              </div>
              <div>
                <span>{t('testing.report.repairRoundLabel')}</span>
                <strong data-testid="test-report-repair-round">
                  {repairRounds === null || repairRounds.rounds <= 1
                    ? '—'
                    : t('testing.report.repairRound', { count: repairRounds.rounds })}
                </strong>
              </div>
            </div>
            <div className="testing-view__handoff">
              <span className="testing-view__hint-card testing-view__hint-card--inline">
                {repairRounds?.needsHuman === true
                  ? t('testing.report.failureHintEscalated', { count: repairRounds.rounds })
                  : origin === 'environment'
                    ? t('testing.report.failureHintEnvironment')
                    : t('testing.report.failureHint')}
              </span>
              <label>
                <span className="testing-view__visually-hidden">{t('testing.report.handoffTarget')}</span>
                <select
                  aria-label={t('testing.report.handoffTarget')}
                  value={handoffSessionId ?? ''}
                  onChange={(event) => onHandoffSessionChange(event.target.value || null)}
                >
                  <option value="">{t('testing.report.handoffNoSession')}</option>
                  {handoffSessions.map((session) => (
                    <option key={session.id} value={session.id}>{session.title}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="testing-view__chip testing-view__chip--primary"
                disabled={!handoffSessionId || handoffSending}
                onClick={onHandoff}
              >
                <Send size={12} aria-hidden />
                {handoffSending ? t('testing.report.handoffSending') : t('testing.report.handoff')}
              </button>
            </div>
          </section>
        )
      })()}
      <section className="testing-view__card">
        <div className="testing-view__card-header">
          <h2>{t('testing.report.assertTable')}</h2>
          <span>{report.cases.reduce((total, testCase) => total + Math.max(testCase.steps.length, 1), 0)}</span>
        </div>
        <div className="testing-view__card-divider" />
        <ul className="testing-view__rows">
          {report.cases.flatMap((testCase): JSX.Element[] => {
            if (testCase.steps.length === 0) {
              return [(
                <li key={testCase.id} className="testing-view__row">
                  <span className="testing-view__row-icon"><StatusIcon status={testCase.status} /></span>
                  <span className="testing-view__row-main">
                    <strong>{testCase.caseName}</strong>
                    <span>{t(statusKey(testCase.status))}</span>
                  </span>
                  <StatusPill status={testCase.status} />
                  <span className="testing-view__row-duration">
                    {durationLabel(testCase.startedAt, testCase.finishedAt) ?? '—'}
                  </span>
                </li>
              )]
            }
            return testCase.steps.flatMap((step): JSX.Element[] => {
              const key = `${testCase.id}:${step.id}`
              const details = stepDetails(step.detailsJson)
              const expanded = expandedStepKey === key
              return [
                <li key={key} className="testing-view__row testing-view__row--report">
                  <span className="testing-view__row-icon"><StatusIcon status={step.status} /></span>
                  <span className="testing-view__row-main">
                    <strong>{testCase.caseName}</strong>
                    <span>{step.action} · {step.stepId}{details.name ? ` · ${details.name}` : ''}{details.message ? ` · ${details.message}` : ''}</span>
                  </span>
                  <StatusPill status={step.status} />
                  <span className="testing-view__row-duration">
                    {durationLabel(step.startedAt, step.finishedAt) ?? '—'}
                  </span>
                  <button
                    type="button"
                    className="testing-view__row-expand"
                    aria-expanded={expanded}
                    aria-label={t('testing.report.expandStep')}
                    onClick={() => onToggleStep(expanded ? null : key)}
                  >
                    <ChevronRight size={14} className={expanded ? 'is-open' : undefined} aria-hidden />
                  </button>
                  {step.evidenceArtifact && (
                    <div className="testing-view__row-evidence">
                      <ArtifactPreview artifact={step.evidenceArtifact} />
                    </div>
                  )}
                </li>,
                ...(expanded ? [(
                  <li key={`${key}-details`} className="testing-view__row-details">
                    {(details.expected !== undefined || details.actual !== undefined) && (
                      <dl>
                        {details.expected !== undefined && (
                          <><dt>{t('testing.report.expected')}</dt><dd>{detailValue(details.expected)}</dd></>
                        )}
                        {details.actual !== undefined && (
                          <><dt>{t('testing.report.actual')}</dt><dd>{detailValue(details.actual)}</dd></>
                        )}
                      </dl>
                    )}
                    {step.evidenceContentHash && (
                      <span className="testing-view__card-note">
                        {t('testing.report.evidence', { hash: step.evidenceContentHash.slice(0, 12) })}
                      </span>
                    )}
                    {details.expected === undefined && details.actual === undefined
                      && !step.evidenceArtifact && !step.evidenceContentHash && (
                      <span className="testing-view__card-note">{t('testing.report.noDetails')}</span>
                    )}
                  </li>
                )] : []),
              ]
            })
          })}
        </ul>
      </section>
      <button type="button" className="testing-view__back-to-spec" onClick={onBack}>
        {t('testing.report.backToSpec')}
      </button>
    </>
  )
}
