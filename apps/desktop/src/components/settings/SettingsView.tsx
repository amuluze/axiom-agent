import { lazy, Suspense, useCallback, useEffect } from 'react'
import { useUiStore } from '@/stores/uiStore'
import { useAgentStore } from '@/stores/agentStore'
import { SettingsNavigation, settingsNavItems } from './SettingsNavigation'
import { SettingsTopBar } from './SettingsTopBar'
import { useT } from '@/i18n'

const SettingsPanel = lazy(async () => {
  const module = await import('@/components/SettingsPanel')
  return { default: module.SettingsPanel }
})

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
  const current = settingsNavItems.find((item) => item.id === visibleSection) ?? settingsNavItems[0]!
  return (
    <section className="settings" aria-label={t('settings.nav.title')}>
      <SettingsTopBar />
      <div className="settings__layout">
        <SettingsNavigation section={visibleSection} onSelect={setSettingsSection} onClose={close} blocking={blocking} providerSetupRequired={providerSetupRequired} updateVersion={availableUpdate?.version} />
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
