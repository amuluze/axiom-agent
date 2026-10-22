import { AlertCircle, RefreshCw } from 'lucide-react'
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
  specTypeFilter: TestSpecTypeFilter
  onSpecTypeFilterChange: (filter: TestSpecTypeFilter) => void
  runScope: 'current' | TestSpecTypeFilter
  onRunScopeChange: (scope: 'current' | TestSpecTypeFilter) => void
  syncedLabel: string | null
  loading: boolean
  workspaceReady: boolean
  onRescan: () => void
  canRun: boolean
  onRun: () => void
}

export const TestingTopbar = ({
  filteredSpecs,
  selectedSpecPath,
  onSelectSpec,
  specTypeFilter,
  onSpecTypeFilterChange,
  runScope,
  onRunScopeChange,
  syncedLabel,
  loading,
  workspaceReady,
  onRescan,
  canRun,
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
              {spec.path}
            </button>
          )
        })}
        {filteredSpecs.length === 0 && (
          <span className="testing-view__tabs-empty">{t('testing.index.noMatchingSpecs')}</span>
        )}
      </div>
      <div className="testing-view__topbar-actions">
        <label className="testing-view__filter">
          <span className="testing-view__visually-hidden">{t('testing.index.typeFilter')}</span>
          <select
            aria-label={t('testing.index.typeFilter')}
            value={specTypeFilter}
            onChange={(event) => onSpecTypeFilterChange(event.target.value as TestSpecTypeFilter)}
          >
            <option value="all">{t('testing.index.typeAll')}</option>
            <option value="ui">{t('testing.index.typeUi')}</option>
            <option value="api">{t('testing.index.typeApi')}</option>
            <option value="mixed">{t('testing.index.typeMixed')}</option>
          </select>
        </label>
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
        <button
          type="button"
          className="testing-view__chip"
          disabled={!canRun}
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
  selectedTab: BrowserTabInfo | undefined
  selectedTabId: string | null
  onSelectTab: (tabId: string | null) => void
  tabs: readonly BrowserTabInfo[]
  selectedSpec: TestSpecIndexEntry | undefined
  specIssueCount: number
  envPanelOpen: boolean
  onToggleEnvPanel: () => void
  onOpenBrowser: () => void
}

export const TestingEnvironmentBar = ({
  selectedEnvironment,
  selectedTab,
  selectedTabId,
  onSelectTab,
  tabs,
  selectedSpec,
  specIssueCount,
  envPanelOpen,
  onToggleEnvPanel,
  onOpenBrowser,
}: TestingEnvironmentBarProps) => {
  const { t } = useT()
  return (
    <div className="testing-view__envbar">
      <button
        type="button"
        className="testing-view__envbar-item testing-view__envbar-button"
        aria-expanded={envPanelOpen}
        onClick={onToggleEnvPanel}
      >
        {t('testing.environment.title')} · {selectedEnvironment?.name ?? t('testing.environment.none')}
      </button>
      <label className="testing-view__envbar-item">
        <span className="testing-view__visually-hidden">{t('testing.run.tab')}</span>
        <select
          aria-label={t('testing.run.tab')}
          value={selectedTabId ?? ''}
          onChange={(event) => onSelectTab(event.target.value || null)}
        >
          <option value="">{t('testing.run.selectTab')}</option>
          {tabs.map((tab) => <option key={tab.tabId} value={tab.tabId}>{tab.title || tab.url}</option>)}
        </select>
      </label>
      {selectedTab && (
        <span className="testing-view__envbar-item">{t('testing.envbar.tab', { url: selectedTab.url })}</span>
      )}
      {selectedEnvironment?.viewportWidth && selectedEnvironment?.viewportHeight && (
        <span className="testing-view__envbar-item">
          {t('testing.envbar.viewport', {
            width: selectedEnvironment.viewportWidth,
            height: selectedEnvironment.viewportHeight,
          })}
        </span>
      )}
      {selectedSpec && (
        specIssueCount === 0 && selectedSpec.valid
          ? <span className="testing-view__envbar-item testing-view__envbar-ok">{t('testing.index.valid')}</span>
          : <span className="testing-view__envbar-item testing-view__envbar-bad">
              {t('testing.envbar.issues', { count: Math.max(specIssueCount, 1) })}
            </span>
      )}
      {tabs.length === 0 && selectedSpec && selectedSpec.uiStepCount > 0 && (
        <button type="button" className="testing-view__chip" onClick={onOpenBrowser}>
          {t('testing.run.openBrowser')}
        </button>
      )}
    </div>
  )
}
