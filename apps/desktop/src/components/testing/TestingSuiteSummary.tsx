import { coverageVerdict, type TestCoverage } from '@/stores/services/testCoverage'
import { useT } from '@/i18n'
import { StatusPill } from './testingViewRows'
import type { SuiteSummary } from './testingViewData'

/**
 * 测试页批次状态条（F3 展示切片）：只表达**本次套件运行**的覆盖与摘要。
 *
 * 「最近批次」入口归运行历史卡（`RecentRunsPanel`）——它是历史数据，不是当前状态；
 * 两处都常驻就会让首屏出现两条互相复述的批次信息。
 */

export const TestingSuiteSummary = ({
  suiteSummary,
  suiteCoverage,
}: {
  suiteSummary: SuiteSummary | null
  suiteCoverage: TestCoverage | null
}) => {
  const { t } = useT()
  if (!suiteSummary) return null
  return (
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
  )
}
