import { coverageVerdict, type TestCoverage } from '@/stores/services/testCoverage'
import { useT, type TFunction } from '@/i18n'
import { StatusPill } from './testingViewRows'
import type { SuiteSummary } from './testingViewData'

/**
 * 测试页批次状态条（F3 展示切片）：只表达**本次套件运行**的覆盖与摘要。
 *
 * 布局对三类信息各给一行/一列，而不是把它们都塞进一行 flex-wrap：
 * - 头部：结论胶囊 + 文件计数 + 测试点覆盖（零项不显示，避免「失败 0 · 不适用 0」噪声）；
 * - 正文：未通过文件逐条成行（状态 | 路径 | 原因），原因为空时不留占位。
 *
 * 「最近批次」入口归运行历史卡（`RecentRunsPanel`）——它是历史数据，不是当前状态；
 * 两处都常驻就会让首屏出现两条互相复述的批次信息。
 */

interface CoverageSegment {
  key: string
  text: string
  tone?: 'warn' | 'muted'
}

const coverageSegments = (coverage: TestCoverage, t: TFunction): CoverageSegment[] => {
  const segments: CoverageSegment[] = []
  if (coverage.designed > 0) {
    segments.push({
      key: 'ratio',
      text: t('testing.suite.coverageRatio', {
        passed: coverage.passed,
        designed: coverage.designed,
      }),
    })
    const failed = coverage.executed - coverage.passed
    if (failed > 0) {
      segments.push({ key: 'failed', text: t('testing.suite.coverageFailed', { count: failed }) })
    }
    if (coverage.notRun > 0) {
      segments.push({ key: 'notRun', text: t('testing.suite.coverageNotRun', { count: coverage.notRun }) })
    }
  }
  if (coverage.invalidFiles > 0) {
    segments.push({
      key: 'invalid',
      text: t('testing.suite.coverageInvalid', { count: coverage.invalidFiles }),
      tone: 'warn',
    })
  }
  if (coverage.notApplicable > 0) {
    segments.push({
      key: 'notApplicable',
      text: t('testing.suite.coverageNotApplicable', { count: coverage.notApplicable }),
      tone: 'muted',
    })
  }
  return segments
}

export const TestingSuiteSummary = ({
  suiteSummary,
  suiteCoverage,
}: {
  suiteSummary: SuiteSummary | null
  suiteCoverage: TestCoverage | null
}) => {
  const { t } = useT()
  // 批次被前置门拦下时 entries 为空：错误由视图的 alert 负责，别在这里渲染一行「0 个文件」。
  if (!suiteSummary || suiteSummary.total === 0) return null

  const coverageState = suiteCoverage ? coverageVerdict(suiteCoverage) : null
  // 覆盖只统计"测试点"；批次里还有 hook/未追溯用例的失败时，不能把整轮称作全绿。
  const runClean = suiteSummary.failed === 0 && suiteSummary.other === 0
  const displayedVerdict = coverageState === 'passed' && !runClean ? 'not-passed' : coverageState
  const verdictLabel = displayedVerdict === 'passed'
    ? t('testing.suite.coveragePassed')
    : displayedVerdict === 'empty'
      ? t('testing.suite.coverageEmpty')
      : t('testing.suite.coverageNotPassed')
  // 全 skipped 绝不能说成「通过」：结论只看分母非零且全绿。
  const verdictHint = displayedVerdict === 'passed'
    ? t('testing.suite.coveragePassedHint')
    : displayedVerdict === 'empty'
      ? t('testing.suite.coverageEmptyHint')
      : coverageState === 'passed'
        ? t('testing.suite.coverageRunNotCleanHint')
        : t('testing.suite.coverageNotPassedHint')
  const segments = suiteCoverage ? coverageSegments(suiteCoverage, t) : []

  return (
    <div className="testing-view__suite-summary" role="status" data-testid="testing-suite-summary">
      <div className="testing-view__suite-head">
        <span
          className={`testing-view__suite-verdict testing-view__suite-verdict--${
            displayedVerdict === 'passed' ? 'pass' : displayedVerdict === 'empty' ? 'idle' : 'warn'
          }`}
          data-testid="testing-coverage-verdict"
          title={verdictHint}
        >
          {verdictLabel}
        </span>
        <span className="testing-view__suite-batch" title={t('testing.suite.summaryHint')}>
          {t('testing.suite.summary', {
            count: suiteSummary.total,
            passed: suiteSummary.passed,
            failed: suiteSummary.failed,
            other: suiteSummary.other,
          })}
        </span>
        {segments.length > 0 && (
          <span className="testing-view__suite-coverage" data-testid="testing-coverage">
            {segments.map((segment, index) => (
              <span
                key={segment.key}
                className={segment.tone
                  ? `testing-view__suite-coverage-part testing-view__suite-coverage-part--${segment.tone}`
                  : 'testing-view__suite-coverage-part'}
              >
                {index > 0 && <span className="testing-view__suite-sep" aria-hidden="true">·</span>}
                {segment.text}
              </span>
            ))}
          </span>
        )}
      </div>
      {suiteSummary.problems.length > 0 && (
        <ul className="testing-view__suite-problems">
          {suiteSummary.problems.map((entry) => (
            <li key={entry.path} className="testing-view__suite-problem">
              <StatusPill status={entry.status} />
              <code className="testing-view__suite-problem-path">{entry.path}</code>
              {entry.reason !== undefined && (
                <span className="testing-view__suite-problem-reason">{entry.reason}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
