import { Download } from 'lucide-react'
import { TEST_SPEC_VERSION } from '@/agent/testing/spec/types'
import type { TestRunDetailRecord, TestRunSummaryRecord } from '@/platform/testRuns'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import type { SpecDetail } from '@/stores/services/testSpecDetail'
import { useT } from '@/i18n'

/**
 * 测试页底栏（F2/展示切片）：文件 · 用例数、主题、版本、导出报告、校验用例。
 */

export interface TestingFooterProps {
  selectedSpec: TestSpecIndexEntry | undefined
  specDetail: SpecDetail | null
  theme: string
  selectedReport: TestRunDetailRecord | null
  latestRun: TestRunSummaryRecord | null
  workspaceReady: boolean
  onExportReport: (report: TestRunDetailRecord) => void
  onOpenReport: (runId: string) => void
  onValidate: () => void
}

export const TestingFooter = ({
  selectedSpec,
  specDetail,
  theme,
  selectedReport,
  latestRun,
  workspaceReady,
  onExportReport,
  onOpenReport,
  onValidate,
}: TestingFooterProps) => {
  const { t } = useT()
  return (
    <div className="testing-view__footer">
      {selectedSpec && (
        <span className="testing-view__footer-item">
          {t('testing.footer.specMeta', {
            path: selectedSpec.path.split('/').at(-1) ?? selectedSpec.path,
            cases: selectedSpec.caseCount,
          })}
        </span>
      )}
      <span className="testing-view__footer-item">{theme}</span>
      <span className="testing-view__footer-item">v{selectedSpec && specDetail ? specDetail.version : TEST_SPEC_VERSION}</span>
      <span className="testing-view__footer-spacer" />
      <button
        type="button"
        className="testing-view__chip"
        disabled={!selectedReport && !latestRun}
        onClick={() => {
          if (selectedReport) onExportReport(selectedReport)
          else if (latestRun) onOpenReport(latestRun.id)
        }}
      >
        <Download size={12} aria-hidden />
        {t('testing.footer.export')}
      </button>
      <button type="button" className="testing-view__chip" disabled={!workspaceReady} onClick={onValidate}>
        {t('testing.footer.validate')}
      </button>
    </div>
  )
}
