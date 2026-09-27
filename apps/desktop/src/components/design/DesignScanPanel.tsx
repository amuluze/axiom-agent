/**
 * 设计画布的「扫描验证」面板（docs/design-canvas.md 扫描验证节）：
 * 逐页「结构检查 + 离屏渲染 + 空白检测」的报告面。运行状态由宿主
 * （`useDesignScan`，画布层）持有——画布叠加层（扫描光束 / 状态描边）与面板
 * 消费同一份状态，扫描时画布逐页点亮。渲染与像素统计经 `designRenderHost`
 * 接缝发生在 WebView；无渲染环境时只出结构检查并在报告里显式标注。
 * 面板自身不展示缩略图——画布就是视觉面，点击问题页直接聚焦过去。
 */
import { useT } from '@/i18n'
import type { DesignScanIssue, DesignScanPageVerdict } from '@/agent/design/designScan'
import type { DesignScanState } from './useDesignScan'
const STATUS_RANK: Record<DesignScanPageVerdict['status'], number> = { fail: 0, warn: 1, ok: 2 }

export interface DesignScanPanelProps {
  scan: DesignScanState
  onClose: () => void
  onFocusPage: (pageId: string) => void
}

const DesignScanPanel = ({ scan, onClose, onFocusPage }: DesignScanPanelProps) => {
  const { t } = useT()
  const { running, progress, report } = scan
  // 进度显示「正在扫第 n 页」：onProgress 在每页完成后计数，在途页是 done+1。
  const current = Math.min(progress.done + 1, progress.total)

  const sorted = report
    ? [...report.pages].sort((left, right) =>
      STATUS_RANK[left.status] - STATUS_RANK[right.status] || left.index - right.index)
    : []

  return (
    <div className="design-scan" data-testid="design-scan-panel">
      <div className="design-scan__head">
        <span className="design-scan__title">{t('app.design.scan.title')}</span>
        {running && (
          <span className="design-scan__progress">
            {t('app.design.scan.progress', { done: current, total: progress.total })}
          </span>
        )}
        {report && (
          <span className="design-scan__summary">
            <span className="design-scan__count is-fail">{t('app.design.scan.failCount', { count: report.summary.fail })}</span>
            <span className="design-scan__count is-warn">{t('app.design.scan.warnCount', { count: report.summary.warn })}</span>
            <span className="design-scan__count is-ok">{t('app.design.scan.okCount', { count: report.summary.ok })}</span>
          </span>
        )}
        <span className="design-scan__head-spacer" />
        <button type="button" disabled={running} onClick={() => void scan.run()}>
          {t('app.design.scan.rerun')}
        </button>
        <button type="button" onClick={onClose}>{t('app.design.scan.close')}</button>
      </div>
      {!report && !running && (
        <p className="design-scan__status">{t('app.design.scan.idle')}</p>
      )}
      {running && report === null && (
        <div className="design-scan__bar" aria-hidden="true">
          <div
            className="design-scan__bar-fill"
            style={{ width: progress.total > 0 ? `${(current / progress.total) * 100}%` : '0%' }}
          />
        </div>
      )}
      {report && report.rendered === false && (
        <p className="design-scan__status is-warn">{t('app.design.scan.noRenderer')}</p>
      )}
      {report && report.documentIssues.length > 0 && (
        <ul className="design-scan__doc-issues">
          {report.documentIssues.map((issue, index) => (
            <IssueLine key={`${issue.check}:${index}`} issue={issue} />
          ))}
        </ul>
      )}
      {report && (
        <ul className="design-scan__pages">
          {sorted.map((page) => (
            <li key={page.id}>
              <button
                type="button"
                className={`design-scan__page is-${page.status}`}
                onClick={() => onFocusPage(page.id)}
                title={t('app.design.scan.focusHint')}
              >
                <span className="design-scan__page-dot" aria-hidden="true" />
                <span className="design-scan__page-index">{page.index}</span>
                <span className="design-scan__page-name">{page.name}</span>
                <span className="design-scan__page-issues">
                  {page.issues.length > 0
                    ? `${page.issues[0]!.message}${page.issues.length > 1 ? t('app.design.scan.moreIssues', { count: page.issues.length - 1 }) : ''}`
                    : t('app.design.scan.okLabel')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const IssueLine = ({ issue }: { issue: DesignScanIssue }) => (
  <li className={`design-scan__issue is-${issue.level}`}>{issue.message}</li>
)

export default DesignScanPanel
