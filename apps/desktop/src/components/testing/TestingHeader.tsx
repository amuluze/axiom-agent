import { AppWindow, ChevronDown, FileCode, RefreshCw } from 'lucide-react'
import { isPrivateOrLocalHost } from '@/agent/testing/environment/environmentFile'
import type { BrowserTabInfo } from '@/platform/browserSession'
import type { TestEnvironmentRecord } from '@/platform/testEnvironments'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import { useT } from '@/i18n'
import { WindowActions } from '@/components/session/WindowActions'

/**
 * 测试页顶栏与环境条（F6 切片）。
 *
 * 只消费当前选择与回调；扫描、运行、环境面板的副作用仍由 TestingView 持有。
 */

export interface TestingTopbarProps {
  syncedLabel: string | null
  loading: boolean
  workspaceReady: boolean
  onRescan: () => void
  canRun: boolean
  /** 主运行入口不可用的具体原因；可用时为 null。 */
  runBlockedReason: string | null
  onRun: () => void
  /** 主按钮重放的目标文件（用于 title，避免「重放」被误解为整批）。 */
  replayTarget: string | null
  showRunAll: boolean
  runAllCount: number
  canRunAll: boolean
  runAllBlockedReason: string | null
  onRunAll: () => void
}

export const TestingTopbar = ({
  syncedLabel,
  loading,
  workspaceReady,
  onRescan,
  canRun,
  runBlockedReason,
  onRun,
  replayTarget,
  showRunAll,
  runAllCount,
  canRunAll,
  runAllBlockedReason,
  onRunAll,
}: TestingTopbarProps) => {
  const { t } = useT()
  return (
    <div className="testing-view__topbar">
      {/* 顶栏不再有运行范围选择：主按钮只重放环境条选中的文件；整批执行是显式的第二动作。 */}
      <div className="testing-view__topbar-actions">
        {syncedLabel && <span className="testing-view__synced">{t('testing.topbar.syncedAt', { time: syncedLabel })}</span>}
        <button type="button" className="testing-view__chip" disabled={loading || !workspaceReady} onClick={onRescan}>
          <RefreshCw size={12} className={loading ? 'testing-view__spin' : undefined} aria-hidden />
          {loading ? t('testing.index.scanning') : t('testing.index.rescan')}
        </button>
        {!canRun && runBlockedReason && (
          <span className="testing-view__run-blocked">{runBlockedReason}</span>
        )}
        {showRunAll && (
          <button
            type="button"
            className="testing-view__chip"
            disabled={!canRunAll}
            title={runAllBlockedReason ?? t('testing.topbar.runAllHint', { count: runAllCount })}
            onClick={onRunAll}
          >
            {t('testing.topbar.runAll')}
          </button>
        )}
        <button
          type="button"
          className="testing-view__chip testing-view__chip--primary"
          disabled={!canRun}
          title={runBlockedReason ?? (replayTarget ? t('testing.topbar.replayHint', { path: replayTarget }) : undefined)}
          onClick={onRun}
        >
          {t('testing.topbar.replay')}
        </button>
        {/* 运行时面板（右栏）的收起/展开入口常驻视图右上角（与 SessionHeader /
            NewTaskView 同一约定）：环境条能打开右栏，本页若没有这个入口，
            右栏打开后就无处收起。 */}
        <WindowActions />
      </div>
    </div>
  )
}

export interface TestingEnvironmentBarProps {
  selectedEnvironment: TestEnvironmentRecord | undefined
  showBrowserTarget: boolean
  selectedTabId: string | null
  onSelectTab: (tabId: string | null) => void
  tabs: readonly BrowserTabInfo[]
  specs: readonly TestSpecIndexEntry[]
  selectedSpecPath: string | null
  onSelectSpec: (path: string) => void
  selectedSpec: TestSpecIndexEntry | undefined
  specIssueCount: number
  onOpenEnvironment: () => void
  onOpenBrowser: () => void
}

/** 环境条只展示环境自身的运行事实（本地/远程、证书、受信）；配置在弹窗里。 */
const hostOf = (value: string | null): string | null => {
  if (value === null) return null
  try {
    return new URL(value).hostname
  } catch {
    return null
  }
}

const isPrivateOrLocal = (value: string | null): boolean => {
  const host = hostOf(value)
  return host !== null && isPrivateOrLocalHost(host)
}

export const TestingEnvironmentBar = ({
  selectedEnvironment,
  showBrowserTarget,
  selectedTabId,
  onSelectTab,
  tabs,
  specs,
  selectedSpecPath,
  onSelectSpec,
  selectedSpec,
  specIssueCount,
  onOpenEnvironment,
  onOpenBrowser,
}: TestingEnvironmentBarProps) => {
  const { t } = useT()
  const local = isPrivateOrLocal(selectedEnvironment?.webBaseUrl ?? null)
    || isPrivateOrLocal(selectedEnvironment?.apiBaseUrl ?? null)
  return (
    <div className="testing-view__envbar">
      <button
        type="button"
        className="testing-view__envbar-item testing-view__envbar-button"
        title={t('testing.envbar.configure')}
        onClick={onOpenEnvironment}
      >
        <span
          className={`testing-view__envbar-dot${selectedEnvironment ? ' is-on' : ''}`}
          aria-hidden="true"
        />
        {t('testing.environment.title')} · {selectedEnvironment?.name ?? t('testing.environment.none')}
        <ChevronDown size={12} aria-hidden="true" className="testing-view__envbar-chevron" />
      </button>
      {selectedEnvironment && (
        <>
          <span className="testing-view__envbar-item testing-view__envbar-badge">
            {t(local ? 'testing.envbar.local' : 'testing.envbar.remote')}
          </span>
          {selectedEnvironment.tlsTrust === 'insecure' && (
            <span className="testing-view__envbar-item testing-view__envbar-badge testing-view__envbar-bad">
              {t('testing.envbar.insecure')}
            </span>
          )}
          {selectedEnvironment.approvalMode === 'trusted' && (
            <span className="testing-view__envbar-item testing-view__envbar-badge testing-view__envbar-bad">
              {t('testing.envbar.trusted')}
            </span>
          )}
        </>
      )}
      {showBrowserTarget && (
        <label className="testing-view__envbar-item testing-view__envbar-control">
          <span className="testing-view__visually-hidden">{t('testing.run.tab')}</span>
          <AppWindow size={12} aria-hidden="true" className="testing-view__envbar-control-icon" />
          <select
            aria-label={t('testing.run.tab')}
            value={selectedTabId ?? ''}
            onChange={(event) => onSelectTab(event.target.value || null)}
          >
            <option value="">{t('testing.run.selectTab')}</option>
            {tabs.map((tab) => <option key={tab.tabId} value={tab.tabId}>{tab.title || tab.url}</option>)}
          </select>
        </label>
      )}
      {/* 用例文件选择：与 Browser Tab 并列的环境条控件。同时决定**重放目标**与下方展示；
          「运行全部」覆盖整批文件。切换即重渲染下方用例视图。 */}
      <label className="testing-view__envbar-item testing-view__envbar-control">
        <span className="testing-view__visually-hidden">{t('testing.run.spec')}</span>
        <FileCode size={12} aria-hidden="true" className="testing-view__envbar-control-icon" />
        <select
          aria-label={t('testing.run.spec')}
          value={selectedSpecPath ?? ''}
          onChange={(event) => onSelectSpec(event.target.value)}
        >
          {specs.length === 0 && (
            <option value="">{t('testing.index.noMatchingSpecs')}</option>
          )}
          {specs.length > 0 && !specs.some((spec) => spec.path === selectedSpecPath) && (
            <option value="">{t('testing.run.selectSpec')}</option>
          )}
          {specs.map((spec) => {
            const name = spec.path.split('/').at(-1) ?? spec.path
            return (
              <option key={spec.path} value={spec.path} title={spec.path}>
                {spec.valid ? name : `${name} · ${t('testing.index.invalid')}`}
              </option>
            )
          })}
        </select>
      </label>
      {selectedEnvironment?.viewportWidth && selectedEnvironment?.viewportHeight && (
        <span className="testing-view__envbar-item">
          {t('testing.envbar.viewport', {
            width: selectedEnvironment.viewportWidth,
            height: selectedEnvironment.viewportHeight,
          })}
        </span>
      )}
      <span className="testing-view__envbar-spacer" />
      {/* 这是**用例文件**的校验结论，不是环境结论：旧标签「校验通过」紧贴环境名，误导成环境可用。 */}
      {selectedSpec && (
        specIssueCount === 0 && selectedSpec.valid
          ? <span className="testing-view__envbar-item testing-view__envbar-ok">{t('testing.envbar.fileValid')}</span>
          : <span className="testing-view__envbar-item testing-view__envbar-bad">
              {t('testing.envbar.fileIssues', { count: Math.max(specIssueCount, 1) })}
            </span>
      )}
      {tabs.length === 0 && showBrowserTarget && (
        <button type="button" className="testing-view__chip" onClick={onOpenBrowser}>
          {t('testing.run.openBrowser')}
        </button>
      )}
    </div>
  )
}
