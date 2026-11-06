import { ChevronRight } from 'lucide-react'
import type { TestBatchSummaryRecord, TestRunSummaryRecord } from '@/platform/testRuns'
import { useT } from '@/i18n'
import { StatusIcon, StatusPill } from './testingViewRows'

/**
 * 运行历史（报告入口）：最近批次入口常驻卡头，具体运行列表默认收起。
 *
 * 用例页的首屏应当只回答「有哪些用例、跑成什么样」；历史运行是二次信息，
 * 展开成本不应由它决定。
 */

export const RecentRunsPanel = ({
  runs,
  recentBatch,
  batchLoading,
  onLoadRecentBatch,
  onOpenReport,
}: {
  runs: readonly TestRunSummaryRecord[]
  recentBatch: TestBatchSummaryRecord | null
  batchLoading: boolean
  onLoadRecentBatch: () => void
  onOpenReport: (runId: string) => void
}) => {
  const { t } = useT()
  return (
    <section className="testing-view__card" aria-labelledby="testing-runs-title">
      <div className="testing-view__card-header">
        <h2 id="testing-runs-title">{t('testing.index.recentRuns')}</h2>
        <span>{runs.length}</span>
      </div>
      {recentBatch && (
        <div className="testing-view__suite-summary" role="status">
          <span>{t('testing.batch.latest', { count: recentBatch.runs.length })}</span>
          <button
            type="button"
            className="testing-view__chip"
            disabled={batchLoading}
            onClick={onLoadRecentBatch}
          >
            {batchLoading ? t('testing.batch.loading') : t('testing.batch.open')}
          </button>
          {recentBatch.truncated && (
            <span className="testing-view__suite-problem">{t('testing.batch.truncated')}</span>
          )}
        </div>
      )}
      <details className="testing-view__runs">
        <summary>{t('testing.index.runsExpand', { count: runs.length })}</summary>
        <div className="testing-view__card-divider" />
        {runs.length === 0 ? (
          <p className="testing-view__card-note">{t('testing.index.noRuns')}</p>
        ) : (
          <ul className="testing-view__rows">
            {runs.map((run) => (
              <li key={run.id} className="testing-view__row">
                <button type="button" className="testing-view__row-button" onClick={() => onOpenReport(run.id)}>
                  <span className="testing-view__row-icon"><StatusIcon status={run.status} /></span>
                  <span className="testing-view__row-main">
                    <strong>{run.specPath}</strong>
                    <span>{new Date(run.startedAt).toLocaleString()}</span>
                  </span>
                  <StatusPill status={run.status} />
                  <ChevronRight size={14} className="testing-view__row-chevron" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  )
}
