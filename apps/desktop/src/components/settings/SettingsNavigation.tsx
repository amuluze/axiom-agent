import {
  Archive,
  ArrowLeft,
  AppWindow,
  BarChart3,
  Bot,
  Globe,
  Plug,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import type { SettingsSection } from '@/stores/uiStore'
import { useT } from '@/i18n'

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
      { id: 'browser', labelKey: 'settings.nav.browser', icon: AppWindow },
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
      { id: 'archived', labelKey: 'settings.nav.archived', icon: Archive },
      { id: 'about', labelKey: 'settings.nav.about', icon: RefreshCw },
    ],
  },
]

export const settingsNavItems: NavItem[] = navGroups.flatMap((group) => group.items)

export const SettingsNavigation = ({
  section,
  onSelect,
  onClose,
  blocking = false,
  providerSetupRequired = false,
  updateVersion,
}: {
  section: SettingsSection
  onSelect: (section: SettingsSection) => void
  onClose: () => void
  blocking?: boolean
  providerSetupRequired?: boolean
  updateVersion?: string
}) => {
  const { t } = useT()
  return (
    <nav className="settings__nav" aria-label={t('settings.nav.title')}>
      <button
        type="button"
        className="settings__back"
        onClick={onClose}
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
            const active = section === item.id
            return (
              <button
                key={item.id}
                type="button"
                className={`settings__nav-item ${active ? 'settings__nav-item--active' : ''}`}
                disabled={providerSetupRequired && item.id !== 'models'}
                onClick={() => onSelect(item.id)}
              >
                <Icon size={14} className="settings__nav-item-icon" />
                <span>{t(item.labelKey)}</span>
                {item.id === 'about' && updateVersion && (
                  <span
                    className="settings__nav-badge"
                    role="status"
                    aria-label={t('settings.nav.updateAvailable', {
                      version: updateVersion,
                    })}
                    title={t('settings.nav.updateAvailable', {
                      version: updateVersion,
                    })}
                  />
                )}
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
