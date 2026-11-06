import { AlertCircle, AppWindow, ChevronDown, RefreshCw } from 'lucide-react'
import { isPrivateOrLocalHost } from '@/agent/testing/environment/environmentFile'
import type { BrowserTabInfo } from '@/platform/browserSession'
import type { TestEnvironmentRecord } from '@/platform/testEnvironments'
import type { TestSpecIndexEntry } from '@/stores/services/testSpecIndex'
import type { TestSpecTypeFilter } from '@/stores/services/testSpecFilter'
import { useT } from '@/i18n'

/**
 * 测试页顶栏与环境条（F6 切片）。
 *
 * 只消费当前筛选/选择与回调；扫描、运行、环境面板的副作用仍由 TestingView 持有。
 */

export interface TestingTopbarProps {
  filteredSpecs: readonly TestSpecIndexEntry[]
  selectedSpecPath: string | null
  onSelectSpec: (path: string) => void
  runScope: 'current' | TestSpecTypeFilter
  onRunScopeChange: (scope: 'current' | TestSpecTypeFilter) => void
  syncedLabel: string | null
  loading: boolean
  workspaceReady: boolean
  onRescan: () => void
  canRun: boolean
  /** 主运行入口不可用的具体原因；可用时为 null。 */
  runBlockedReason: string | null
  onRun: () => void
}

export const TestingTopbar = ({
  filteredSpecs,
  selectedSpecPath,
  onSelectSpec,
  runScope,
  onRunScopeChange,
  syncedLabel,
  loading,
  workspaceReady,
  onRescan,
  canRun,
  runBlockedReason,
  onRun,
}: TestingTopbarProps) => {
  const { t } = useT()
  return (
    <div className="testing-view__topbar">
      <div className="testing-view__tabs" role="tablist" aria-label={t('testing.topbar.tabsAria')}>
        {filteredSpecs.map((spec) => {
          const active = spec.path === selectedSpecPath
          return (
            <button
              key={spec.path}
              type="button"
              role="tab"
              aria-selected={active}
              title={spec.valid ? spec.path : `${spec.path} · ${spec.issues[0]?.message ?? ''}`}
              className={`testing-view__tab${active ? ' is-active' : ''}${spec.valid ? '' : ' is-invalid'}`}
              onClick={() => onSelectSpec(spec.path)}
            >
              {!spec.valid && <AlertCircle size={11} aria-hidden />}
              {spec.path.split('/').at(-1) ?? spec.path}
            </button>
          )
        })}
        {filteredSpecs.length === 0 && (
          <span className="testing-view__tabs-empty">{t('testing.index.noMatchingSpecs')}</span>
        )}
      </div>
      <div className="testing-view__topbar-actions">
        <label className="testing-view__filter">
          <span className="testing-view__visually-hidden">{t('testing.suite.scope')}</span>
          <select
            aria-label={t('testing.suite.scope')}
            value={runScope}
            onChange={(event) => onRunScopeChange(event.target.value as 'current' | TestSpecTypeFilter)}
          >
            <option value="current">{t('testing.suite.scopeCurrent')}</option>
            <option value="all">{t('testing.index.typeAll')}</option>
            <option value="ui">{t('testing.index.typeUi')}</option>
            <option value="api">{t('testing.index.typeApi')}</option>
            <option value="mixed">{t('testing.index.typeMixed')}</option>
          </select>
        </label>
        {syncedLabel && <span className="testing-view__synced">{t('testing.topbar.syncedAt', { time: syncedLabel })}</span>}
        <button type="button" className="testing-view__chip" disabled={loading || !workspaceReady} onClick={onRescan}>
          <RefreshCw size={12} className={loading ? 'testing-view__spin' : undefined} aria-hidden />
          {loading ? t('testing.index.scanning') : t('testing.index.rescan')}
        </button>
        {!canRun && runBlockedReason && (
          <span className="testing-view__run-blocked">{runBlockedReason}</span>
        )}
        <button
          type="button"
          className="testing-view__chip testing-view__chip--primary"
          disabled={!canRun}
          title={runBlockedReason ?? undefined}
          onClick={onRun}
        >
          {t('testing.topbar.replay')}
        </button>
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
