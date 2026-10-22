import { ChevronRight } from 'lucide-react'
import type { TestRunSummaryRecord } from '@/platform/testRuns'
import { useT } from '@/i18n'
import { StatusIcon, StatusPill } from './testingViewRows'

/**
 * 历史运行列表（报告入口）：紧凑行式，点击打开持久化报告。
 */

export const RecentRunsPanel = ({
  runs,
  onOpenReport,
}: {
  runs: readonly TestRunSummaryRecord[]
  onOpenReport: (runId: string) => void
}) => {
  const { t } = useT()
  return (
    <section className="testing-view__card" aria-labelledby="testing-runs-title">
      <div className="testing-view__card-header">
        <h2 id="testing-runs-title">{t('testing.index.recentRuns')}</h2>
        <span>{runs.length}</span>
      </div>
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
    </section>
  )
}
