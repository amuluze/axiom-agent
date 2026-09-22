import { LockKeyhole } from 'lucide-react'
import type { QueueModesDraftHook, SettingsSectionContext } from './types'
import { useT } from '@/i18n'

interface QueueModesSectionProps {
  hook: QueueModesDraftHook
  context: SettingsSectionContext
  isSaved: boolean
  onSave: () => void
}

export const QueueModesSection = ({ hook, context, isSaved, onSave }: QueueModesSectionProps) => {
  const { t } = useT()
  const { draft, setDraft } = hook
  const { busy } = context
  return (
    <section className="settings-section" id="settings-queue-modes">
      <div className="section-title">
        <span>{t('settings.queue.title')}</span>
        <span className="section-state">{t('settings.queue.state')}</span>
      </div>
      <div className="settings-grid queue-mode-grid">
        <label>
          {t('settings.queue.steering')}
          <select
            disabled={busy}
            onChange={(event) => setDraft({
              ...draft,
              steering: event.target.value as typeof draft.steering,
            })}
            value={draft.steering}
          >
            <option value="one-at-a-time">{t('settings.queue.oneAtATime')}</option>
            <option value="all">{t('settings.queue.steeringAll')}</option>
          </select>
        </label>
        <label>
          {t('settings.queue.followUp')}
          <select
            disabled={busy}
            onChange={(event) => setDraft({
              ...draft,
              followUp: event.target.value as typeof draft.followUp,
            })}
            value={draft.followUp}
          >
            <option value="one-at-a-time">{t('settings.queue.oneAtATime')}</option>
            <option value="all">{t('settings.queue.followUpAll')}</option>
          </select>
        </label>
        <label>
          {t('settings.queue.autoDrain')}
          <select
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, autoDrain: event.target.value === 'on' })}
            value={draft.autoDrain ? 'on' : 'off'}
          >
            <option value="on">{t('settings.queue.autoDrainOn')}</option>
            <option value="off">{t('settings.queue.autoDrainOff')}</option>
          </select>
        </label>
      </div>
      <p className="security-note">
        <LockKeyhole size={13} aria-hidden />
        <span>{t('settings.queue.autoDrainHint')}</span>
      </p>
      <div className="settings-actions">
        <button
          className="primary-button"
          disabled={busy || isSaved}
          onClick={onSave}
          type="button"
        >
          {t('settings.queue.save')}
        </button>
      </div>
      <p className="security-note">
        <LockKeyhole size={13} aria-hidden />
        <span>{t('settings.queue.note')}</span>
      </p>
    </section>
  )
}
