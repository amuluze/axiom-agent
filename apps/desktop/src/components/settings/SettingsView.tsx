import { lazy, Suspense, useCallback, useEffect } from 'react'
import { useUiStore, type SettingsSection } from '@/stores/uiStore'
import { useAgentStore } from '@/stores/agentStore'
import { Archive, ArrowLeft, AppWindow, BarChart3, Bot, Globe, Plug, RefreshCw, Sparkles, Wrench, Monitor } from 'lucide-react'
import { useT } from '@/i18n'

const SettingsPanel = lazy(async () => {
  const module = await import('@/components/SettingsPanel')
  return { default: module.SettingsPanel }
})

interface NavItem {
  id: SettingsSection
  labelKey: string
  icon: typeof Globe
}

// labelKey 指向语言包 settings.nav.*；渲染时经 t() 取当前语言文案。
const navGroups: Array<{ titleKey: string; items: NavItem[] }> = [
  {
    titleKey: 'settings.nav.group.basic',
    items: [
      { id: 'general', labelKey: 'settings.nav.general', icon: Globe },
      { id: 'models', labelKey: 'settings.nav.models', icon: Plug },
      { id: 'archived', labelKey: 'settings.nav.archived', icon: Archive },
      { id: 'browser', labelKey: 'settings.nav.browser', icon: AppWindow },
      { id: 'computer', labelKey: 'settings.nav.computer', icon: Monitor },
    ],
  },
  {
    titleKey: 'settings.nav.group.agent',
    items: [
      { id: 'skills', labelKey: 'settings.nav.skills', icon: Sparkles },
      { id: 'subagents', labelKey: 'settings.nav.subagents', icon: Bot },
    ],
  },
  {
    titleKey: 'settings.nav.group.version',
    items: [
      { id: 'usage', labelKey: 'settings.nav.usage', icon: BarChart3 },
      { id: 'sessions', labelKey: 'settings.nav.sessions', icon: Wrench },
      { id: 'about', labelKey: 'settings.nav.about', icon: RefreshCw },
    ],
  },
]

const navItems: NavItem[] = navGroups.flatMap((group) => group.items)

export interface SettingsViewProps {
  blocking?: boolean
}

export const SettingsView = ({ blocking = false }: SettingsViewProps) => {
  const { t } = useT()
  const section = useUiStore((state) => state.settingsSection)
  const setSettingsSection = useUiStore((state) => state.setSettingsSection)
  const setView = useUiStore((state) => state.setView)
  const providerSetupRequired = useAgentStore((state) => state.providerSetupRequired)
  const messages = useAgentStore((state) => state.messages)
  const availableUpdate = useUiStore((state) => state.availableUpdate)
  const close = useCallback(() => {
    if (blocking) return
    setView(messages.length > 0 ? 'session' : 'new-task')
  }, [blocking, messages.length, setView])
  useEffect(() => {
    if (providerSetupRequired) setSettingsSection('models')
  }, [providerSetupRequired, setSettingsSection])
  const visibleSection = providerSetupRequired ? 'models' : section
  const current = navItems.find((item) => item.id === visibleSection) ?? navItems[0]!
  return (
    <section className="settings" aria-label={t('settings.nav.title')}>
      <div className="settings__topbar" data-tauri-drag-region>
        <span className="settings__topbar-title">{t('settings.nav.title')}</span>
      </div>
      <div className="settings__layout">
        <nav className="settings__nav" aria-label={t('settings.nav.title')}>
          <button
            type="button"
            className="settings__back"
            onClick={close}
            disabled={blocking}
            aria-label={t('settings.nav.back')}
          >
            <ArrowLeft size={14} />
            <span>{t('settings.nav.back')}</span>
          </button>
          {navGroups.map((group) => (
            <div key={group.titleKey} className="settings__nav-group">
              <div className="settings__nav-group-title">{t(group.titleKey)}</div>
              {group.items.map((item) => {
                const Icon = item.icon
                const active = visibleSection === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`settings__nav-item ${active ? 'settings__nav-item--active' : ''}`}
                    disabled={providerSetupRequired && item.id !== 'models'}
                    onClick={() => setSettingsSection(item.id)}
                  >
                    <Icon size={14} className="settings__nav-item-icon" />
                    <span>{t(item.labelKey)}</span>
                    {item.id === 'about' && availableUpdate && (
                      <span
                        className="settings__nav-badge"
                        aria-label={t('settings.nav.updateAvailable', { version: availableUpdate.version })}
                        title={t('settings.nav.updateAvailable', { version: availableUpdate.version })}
                      />
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
        <div className="settings__content">
          <div className="settings__panel-header">
            <h2 className="settings__panel-title">{t(current.labelKey)}</h2>
            <p className="settings__panel-subtitle">
              {providerSetupRequired
                ? t('settings.nav.subtitle.setupRequired')
                : t('settings.nav.subtitle.default')}
            </p>
          </div>
          <Suspense fallback={<div>{t('settings.nav.loading')}</div>}>
            <SettingsPanel
              open
              inline
              section={visibleSection}
              onClose={close}
            />
          </Suspense>
        </div>
      </div>
    </section>
  )
}
