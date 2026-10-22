import { RefreshCw, Square } from 'lucide-react'
import type { StepStatusChange } from '@/agent/testing/runner/runTestPlan'
import type { TestStepApprover } from '@/agent/testing/approval/testStepApprover'
import type { TestRunStatus } from '@/platform/testRuns'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import { useT } from '@/i18n'
import { TestStepApprovalPanel } from './TestStepApprovalPanel'
import { StatusIcon, StatusPill, statusKey } from './testingViewRows'
import { durationLabel } from './testingViewData'

/**
 * 运行中视图（F3 切片，tsRunng）：标题、套件进度、步骤流、审批面板与定位提示。
 *
 * 只消费 activeRun/suiteProgress 快照与停止回调；运行生命周期仍由 TestingView 持有。
 */

export interface ActiveRunView {
  id: string
  path: string
  startedAt: number
  status: TestRunStatus
  changes: readonly StepStatusChange[]
}

export const RunProgress = ({
  activeRun,
  activeRunSpec,
  suiteProgress,
  clock,
  approver,
  onStop,
}: {
  activeRun: ActiveRunView
  activeRunSpec: TestSpecIndexEntry | undefined
  suiteProgress: { index: number; total: number; path: string } | null
  clock: number
  approver: TestStepApprover
  onStop: () => void
}) => {
  const { t } = useT()
  const title = `${activeRunSpec?.name ?? activeRun.path} · ${activeRun.id.slice(-6)}`
  return (
    <>
      <div className="testing-view__title-row">
        <div className="testing-view__title-text">
          <h1>{title}</h1>
          <p>
            {activeRun.path}
            {activeRunSpec ? ` · ${t('testing.index.specMeta', {
              cases: activeRunSpec.caseCount,
              ui: activeRunSpec.uiStepCount,
              api: activeRunSpec.apiStepCount,
            })}` : ''}
            {` · ${durationLabel(activeRun.startedAt, clock) ?? ''}`}
          </p>
        </div>
        <StatusPill status={activeRun.status} />
        <button type="button" className="testing-view__chip" onClick={onStop}>
          <Square size={11} fill="currentColor" aria-hidden />
          {t('testing.run.stop')}
        </button>
      </div>
      {suiteProgress && (
        <p className="testing-view__suite-progress" role="status">
          {t('testing.suite.progress', {
            index: suiteProgress.index,
            total: suiteProgress.total,
            path: suiteProgress.path,
          })}
        </p>
      )}
      <div
        className="testing-view__progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={activeRunSpec?.stepCount ?? 0}
        aria-valuenow={activeRun.changes.length}
      >
        <div
          className="testing-view__progress-fill"
          style={{
            width: activeRunSpec && activeRunSpec.stepCount > 0
              ? `${Math.min(100, (activeRun.changes.length / activeRunSpec.stepCount) * 100)}%`
              : '0%',
          }}
        />
      </div>
      <section className="testing-view__card">
        <div className="testing-view__card-header">
          <h2>{t('testing.run.stepsTitle')}</h2>
          <span>{t('testing.run.progress', {
            done: activeRun.changes.length,
            total: activeRunSpec?.stepCount ?? activeRun.changes.length,
          })}</span>
        </div>
        <div className="testing-view__card-divider" />
        {activeRun.changes.length === 0 ? (
          <p className="testing-view__card-note">{t('testing.run.preparing')}</p>
        ) : (
          <ul className="testing-view__rows">
            {activeRun.changes.map((change) => (
              <li key={`${change.caseId}:${change.stepId}`} className="testing-view__row">
                <span className="testing-view__row-icon"><StatusIcon status={change.status} /></span>
                <span className="testing-view__row-main">
                  <strong>{change.stepId}</strong>
                  <span>{change.message ?? t(statusKey(change.status))}</span>
                </span>
                <StatusPill status={change.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <TestStepApprovalPanel approver={approver} />
      <div className="testing-view__hint-card">
        <RefreshCw size={13} aria-hidden />
        <span>{t('testing.run.locatorHint')}</span>
      </div>
    </>
  )
}
