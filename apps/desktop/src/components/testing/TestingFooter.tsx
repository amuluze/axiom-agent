import { Download } from 'lucide-react'
import { TEST_SPEC_VERSION } from '@/agent/testing/spec/types'
import type { TestRunDetailRecord, TestRunSummaryRecord } from '@/platform/testRuns'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import type { SpecDetail } from '@/stores/services/testSpecDetail'
import { useT } from '@/i18n'

/**
 * 测试页底栏：文件 · 用例数、协议版本与报告导出。
 */

export interface TestingFooterProps {
  selectedSpec: TestSpecIndexEntry | undefined
  specDetail: SpecDetail | null
  selectedReport: TestRunDetailRecord | null
  latestRun: TestRunSummaryRecord | null
  onExportReport: (report: TestRunDetailRecord) => void
  onOpenReport: (runId: string) => void
}

export const TestingFooter = ({
  selectedSpec,
  specDetail,
  selectedReport,
  latestRun,
  onExportReport,
  onOpenReport,
}: TestingFooterProps) => {
  const { t } = useT()
  return (
    <div className="testing-view__footer">
      {/* 用例数已在标题事实行：页脚只留「这是哪个文件」这一条唯一信息。 */}
      {selectedSpec && (
        <span className="testing-view__footer-item testing-view__footer-path">{selectedSpec.path}</span>
      )}
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
    </div>
  )
}
