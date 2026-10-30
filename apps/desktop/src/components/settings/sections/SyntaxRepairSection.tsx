import { LockKeyhole } from 'lucide-react'
import { useT } from '@/i18n'
import { localizedProviderLabel } from '@/i18n/providerLabels'
import type { SettingsSectionContext, SyntaxRepairHook } from './types'

interface SyntaxRepairSectionProps {
  hook: SyntaxRepairHook
  context: SettingsSectionContext
}

export const SyntaxRepairSection = ({ hook, context }: SyntaxRepairSectionProps) => {
  const { t } = useT()
  const selectedProfileId = hook.profiles.some(
    (profile) => profile.profileId === hook.settings.profileId,
  ) ? hook.settings.profileId ?? '' : ''

  return (
    <section className="settings-section" id="settings-syntax-repair">
      <div className="section-title">
        <span>{t('settings.syntaxRepair.title')}</span>
        <span className="section-state">{t('settings.syntaxRepair.state')}</span>
      </div>
      <div className="settings-grid">
        <label>
          {t('settings.syntaxRepair.profile')}
          <select
            disabled={context.busy}
            onChange={(event) => hook.save({ profileId: event.target.value || null })}
            value={selectedProfileId}
          >
            <option value="">{t('settings.syntaxRepair.current')}</option>
            {hook.profiles.map((profile) => (
              <option key={profile.profileId} value={profile.profileId}>
                {localizedProviderLabel(t, profile.providerId)} · {profile.modelName || profile.modelId}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="security-note">
        <LockKeyhole size={13} aria-hidden />
        <span>{t('settings.syntaxRepair.note')}</span>
      </p>
    </section>
  )
}
