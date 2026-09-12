import { LockKeyhole } from 'lucide-react'
import {
  DEFAULT_CONTEXT_POLICY_SETTINGS,
  MAX_REQUEST_BYTE_THRESHOLD,
  MIN_REQUEST_BYTE_THRESHOLD,
  type ContextPolicySettings,
} from '@/agent/context/types'
import type { ContextPolicyDraftHook, SettingsSectionContext } from './types'
import { useT } from '@/i18n'

interface ContextPolicySectionProps {
  hook: ContextPolicyDraftHook
  context: SettingsSectionContext
  isSaved: boolean
  effectiveContextTokens: number
  effectiveKeepRecentTokens: number
  effectiveByteBufferBytes: number
}

export const ContextPolicySection = ({
  hook,
  context,
  isSaved,
  effectiveContextTokens,
  effectiveKeepRecentTokens,
  effectiveByteBufferBytes,
}: ContextPolicySectionProps) => {
  const { t } = useT()
  const { draft, contextWindow, maxOutputTokens, setDraft, save, reset } = hook
  const { busy } = context
  const reserveMax = Math.min(65_536, Math.max(1_024, contextWindow - 4_096))
  return (
    <section className="settings-section" id="settings-context-policy">
      <div className="section-title">
        <span>{t('settings.context.title')}</span>
        <span className="section-state">{t('settings.context.hardLimit')}</span>
      </div>
      <div className="settings-grid context-policy-grid">
        <label>
          {t('settings.context.reserveTokens')}
          <input
            disabled={busy}
            max={reserveMax}
            min={Math.min(reserveMax, Math.max(1_024, maxOutputTokens))}
            onChange={(event) => setDraft({
              ...draft,
              reserveTokens: Number(event.target.value),
            } satisfies ContextPolicySettings)}
            type="number"
            value={draft.reserveTokens}
          />
        </label>
        <label>
          {t('settings.context.keepRecent')}
          <input
            disabled={busy}
            max={Math.min(200_000, Math.max(2_048, contextWindow - reserveMax))}
            min={2_048}
            onChange={(event) => setDraft({
              ...draft,
              keepRecentTokens: Number(event.target.value),
            })}
            type="number"
            value={draft.keepRecentTokens}
          />
        </label>
        <label>
          {t('settings.context.byteThreshold')}
          <input
            disabled={busy}
            max={MAX_REQUEST_BYTE_THRESHOLD / 1024}
            min={MIN_REQUEST_BYTE_THRESHOLD / 1024}
            onChange={(event) => setDraft({
              ...draft,
              requestByteThreshold: Number(event.target.value) * 1024,
            })}
            step={64}
            type="number"
            value={Math.round(draft.requestByteThreshold / 1024)}
          />
        </label>
      </div>
      <div className="context-policy-summary">
        <span>{t('settings.context.tokenSoftThreshold', { tokens: effectiveContextTokens })}</span>
        <span>{t('settings.context.keepRecentTarget', { tokens: effectiveKeepRecentTokens })}</span>
        <span>{t('settings.context.byteBuffer', { kib: (effectiveByteBufferBytes / 1024).toFixed(1) })}</span>
      </div>
      <div className="settings-actions">
        <button
          className="primary-button"
          disabled={busy || isSaved}
          onClick={() => void save(draft)}
          type="button"
        >
          {context.busy ? t('settings.context.saving') : t('settings.context.save')}
        </button>
        <button
          disabled={busy}
          onClick={() => reset()}
          type="button"
        >
          {t('settings.context.reset')}
        </button>
      </div>
      <p className="security-note">
        <LockKeyhole size={13} aria-hidden />
        <span>{t('settings.context.note')}</span>
      </p>
    </section>
  )
}

export const defaultContextPolicySettings = DEFAULT_CONTEXT_POLICY_SETTINGS
