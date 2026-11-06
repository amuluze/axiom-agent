import { Square } from 'lucide-react'
import type { TestStepApprover } from '@/agent/testing/approval/testStepApprover'
import type { TestRunStatus, TestRunSummaryRecord } from '@/platform/testRuns'
import type { SpecDetail } from '@/stores/services/testSpecDetail'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import { useT } from '@/i18n'
import { TestStepApprovalPanel } from './TestStepApprovalPanel'
import { SpecCaseTableRow, statusKey } from './testingViewRows'

/**
 * 用例总览（tsCases）：标题 + **一条**运行事实行 + 用例表。
 *
 * 旧版把同一批数字摊成标题副行、三张 KPI 卡与页脚三处；其中「用例数」在两处用的是
 * 不同口径（用例数 vs 步骤数）。现在规模/断言/最近一次只出现一次，最近一次直接链到报告。
 * 运行、固化、授权等副作用由 TestingView 注入；本组件只做展示与回调。
 */

export interface CasesOverviewProps {
  selectedSpec: TestSpecIndexEntry | undefined
  specDetail: SpecDetail | null
  latestRun: TestRunSummaryRecord | null
  caseStatusById: ReadonlyMap<string, TestRunStatus>
  running: boolean
  approver: TestStepApprover
  onStop: () => void
  onOpenReport: (runId: string) => void
}

export const CasesOverview = ({
  selectedSpec,
  specDetail,
  latestRun,
  caseStatusById,
  running,
  approver,
  onStop,
  onOpenReport,
}: CasesOverviewProps) => {
  const { t } = useT()
  if (!selectedSpec) {
    return <div className="testing-view__placeholder">{t('testing.run.selectSpec')}</div>
  }
  const cases = specDetail?.cases.length ?? selectedSpec.caseCount
  const asserts = specDetail?.assertCount
  return (
    <>
      <div className="testing-view__title-row">
        <div className="testing-view__title-text">
          <h1>{selectedSpec.name ?? selectedSpec.path.split('/').at(-1)}</h1>
          <p className="testing-view__fact-line">
            {selectedSpec.valid
              ? t('testing.cases.fact', {
                  cases,
                  ui: specDetail?.uiCaseCount ?? 0,
                  api: specDetail?.apiCaseCount ?? 0,
                  asserts: asserts ?? '—',
                })
              : `${t('testing.index.invalid')}：${selectedSpec.issues[0]?.path ?? ''} ${selectedSpec.issues[0]?.message ?? ''}`}
            {latestRun && (
              <>
                {' · '}
                <button
                  type="button"
                  className="testing-view__link"
                  onClick={() => onOpenReport(latestRun.id)}
                >
                  {t('testing.cases.lastRun', {
                    status: t(statusKey(latestRun.status)),
                    time: new Date(latestRun.startedAt).toLocaleString(),
                  })}
                </button>
              </>
            )}
          </p>
        </div>
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
