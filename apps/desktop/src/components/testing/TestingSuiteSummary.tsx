import type { TestBatchSummaryRecord } from '@/platform/testRuns'
import { coverageVerdict } from '@/stores/services/testCoverage'
import { useT } from '@/i18n'
import { StatusPill } from './testingViewRows'
import type { computeSuiteCoverage, computeSuiteSummary } from './testingViewData'

/**
 * 测试页批次状态条（F3 展示切片）：
 * - 刷新后按 batch_id 回读最近批次；
 * - 套件运行的覆盖/摘要与未通过文件点名。
 */

export const TestingSuiteSummary = ({
  recentBatch,
  showRecentBatch,
  batchLoading,
  onLoadRecentBatch,
  suiteSummary,
  suiteCoverage,
}: {
  recentBatch: TestBatchSummaryRecord | null
  showRecentBatch: boolean
  batchLoading: boolean
  onLoadRecentBatch: () => void
  suiteSummary: ReturnType<typeof computeSuiteSummary>
  suiteCoverage: ReturnType<typeof computeSuiteCoverage>
}) => {
  const { t } = useT()
  return (
    <>
      {showRecentBatch && recentBatch && (
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

      {suiteSummary && (
        <div className="testing-view__suite-summary" role="status">
          <span>
            {t('testing.suite.summary', {
              count: suiteSummary.total,
              passed: suiteSummary.passed,
              failed: suiteSummary.failed,
              other: suiteSummary.other,
            })}
          </span>
          {suiteCoverage && (() => {
            const verdict = coverageVerdict(suiteCoverage)
            // 覆盖只统计"测试点"；批次里还有 hook/未追溯用例的失败时，不能把整轮称作全绿。
            const runClean = suiteSummary.failed === 0 && suiteSummary.other === 0
            const displayedVerdict = verdict === 'passed' && !runClean ? 'not-passed' : verdict
            return (
              <>
                <span className="testing-view__suite-coverage" data-testid="testing-coverage">
                  {t('testing.suite.coverage', {
                    designed: suiteCoverage.designed,
                    executed: suiteCoverage.executed,
                    passed: suiteCoverage.passed,
                    notRun: suiteCoverage.notRun,
                    invalid: suiteCoverage.invalidFiles,
                    notApplicable: suiteCoverage.notApplicable,
                  })}
                </span>
                {/* 全 skipped 绝不能说成「通过」：结论只看分母非零且全绿。 */}
                <span className="testing-view__suite-verdict" data-testid="testing-coverage-verdict">
                  {displayedVerdict === 'passed'
                    ? t('testing.suite.coveragePassed')
                    : displayedVerdict === 'empty'
                      ? t('testing.suite.coverageEmpty')
                      : t('testing.suite.coverageNotPassed')}
                </span>
              </>
            )
          })()}
          {suiteSummary.problems.map((entry) => (
            <span key={entry.path} className="testing-view__suite-problem">
              <StatusPill status={entry.status} />
              <code>{entry.path}</code>
              {entry.reason === undefined ? '' : ` ${entry.reason}`}
            </span>
          ))}
        </div>
      )}
    </>
  )
}
