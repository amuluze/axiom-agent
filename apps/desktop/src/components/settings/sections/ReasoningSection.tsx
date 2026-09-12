import { LockKeyhole } from 'lucide-react'
import type { ReasoningDraftHook, SettingsSectionContext } from './types'
import type { ReasoningSettings } from '@/agent/runtime/reasoningSettings'
import { reasoningBudgetCeiling } from '@/agent/runtime/reasoningSettings'
import { useT } from '@/i18n'

interface ReasoningSectionProps {
  hook: ReasoningDraftHook
  context: SettingsSectionContext
  isSaved: boolean
}

export const ReasoningSection = ({ hook, context, isSaved }: ReasoningSectionProps) => {
  const { t } = useT()
  const { draft, apiFormat, maxOutputTokens, supportsReasoning, setDraft, save } = hook
  const { busy } = context
  const demoBlocked = apiFormat === 'demo'
  return (
    <section className="settings-section" id="settings-reasoning" aria-labelledby="settings-reasoning-title">
      <div className="section-title">
        <span>{t('settings.reasoning.title')}</span>
        <span className="section-state">
          {draft.level === 'off' ? t('settings.reasoning.levelOff') : t('settings.reasoning.levelState', { level: draft.level, mode: draft.mode })}
        </span>
      </div>
      <div className="settings-grid">
        <label>
          {t('settings.reasoning.levelLabel')}
          <select
            disabled={busy}
            onChange={(event) => setDraft({
              ...draft,
              level: event.target.value as ReasoningSettings['level'],
            })}
            value={draft.level}
          >
            <option value="off">{t('settings.reasoning.level.off')}</option>
            <option value="minimal">{t('settings.reasoning.level.minimal')}</option>
            <option value="low">{t('settings.reasoning.level.low')}</option>
            <option value="medium">{t('settings.reasoning.level.medium')}</option>
            <option value="high">{t('settings.reasoning.level.high')}</option>
            <option value="xhigh">{t('settings.reasoning.level.xhigh')}</option>
            <option value="max">{t('settings.reasoning.level.max')}</option>
          </select>
        </label>
        <label>
          {t('settings.reasoning.modeLabel')}
          <select
            disabled={busy || draft.level === 'off' || apiFormat !== 'anthropic-compatible'}
            onChange={(event) => setDraft({
              ...draft,
              mode: event.target.value as ReasoningSettings['mode'],
            })}
            value={apiFormat === 'openai-compatible' || apiFormat === 'openai-responses'
              ? 'effort'
              : draft.mode}
          >
            <option value="effort">{t('settings.reasoning.mode.effort')}</option>
            {apiFormat === 'anthropic-compatible' && <option value="adaptive">{t('settings.reasoning.mode.adaptive')}</option>}
            {apiFormat === 'anthropic-compatible' && <option value="enabled">{t('settings.reasoning.mode.enabled')}</option>}
          </select>
        </label>
        {apiFormat === 'anthropic-compatible' && draft.mode === 'enabled' && (
          <label>
            {t('settings.reasoning.budgetLabel')}
            <input
              disabled={busy || draft.level === 'off'}
              max={reasoningBudgetCeiling(maxOutputTokens)}
              min={1024}
              onChange={(event) => setDraft({
                ...draft,
                budgetTokens: Number(event.target.value),
              })}
              type="number"
              value={draft.budgetTokens ?? 1024}
            />
          </label>
        )}
      </div>
      <div className="settings-actions">
        <button
          className="primary-button"
          disabled={busy || isSaved || apiFormat === 'demo'}
          onClick={() => void save(draft)}
          type="button"
        >
          {t('settings.reasoning.save')}
        </button>
      </div>
      {demoBlocked && (
        <p className="security-note" role="status">
          <span>{t('settings.reasoning.demoNotice')}</span>
        </p>
      )}
      {!demoBlocked && !supportsReasoning && (
        <p className="security-note" role="status">
          <span>{t('settings.reasoning.unsupportedNotice')}</span>
        </p>
      )}
      <p className="security-note">
        <LockKeyhole size={13} aria-hidden />
        <span>{t('settings.reasoning.note')}</span>
      </p>
    </section>
  )
}
