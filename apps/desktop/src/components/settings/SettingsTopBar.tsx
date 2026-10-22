import { useT } from '@/i18n'
import { useDesignStorePreview } from '@/components/design/ax/previewContext'

export const SettingsTopBar = () => {
  const { t } = useT()
  const preview = useDesignStorePreview()
  return (
    <div className="settings__topbar" data-tauri-drag-region={preview ? undefined : ''}>
      <span className="settings__topbar-title">{t('settings.nav.title')}</span>
    </div>
  )
}
