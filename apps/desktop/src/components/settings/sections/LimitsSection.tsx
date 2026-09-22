import { LockKeyhole } from 'lucide-react'
import {
  DEFAULT_AGENT_LIMITS_SETTINGS,
  MAX_TOOL_CALLS_LIMIT,
  MAX_TOTAL_TOKENS_LIMIT,
  MAX_TURNS_LIMIT,
  MIN_TOTAL_TOKENS_LIMIT,
  type AgentLimitsSettings,
} from '@/agent/runtime/agentLimitsSettings'
import type { AgentLimitsDraftHook, SettingsSectionContext } from './types'
import { useT } from '@/i18n'

interface LimitsSectionProps {
  hook: AgentLimitsDraftHook
  context: SettingsSectionContext
  isSaved: boolean
}

export const LimitsSection = ({ hook, context, isSaved }: LimitsSectionProps) => {
  const { t } = useT()
  const { draft, setDraft, save, reset } = hook
  const { busy } = context
  return (
    <section className="settings-section" id="settings-limits">
      <div className="section-title">
        <span>{t('settings.limits.title')}</span>
        <span className="section-state">{t('settings.limits.state')}</span>
      </div>
      <div className="settings-grid context-policy-grid">
        <label>
          {t('settings.limits.maxTurns')}
          <input
            disabled={busy}
            max={MAX_TURNS_LIMIT}
            min={1}
            onChange={(event) => setDraft({
              ...draft,
              maxTurns: Number(event.target.value),
            } satisfies AgentLimitsSettings)}
            type="number"
            value={draft.maxTurns}
          />
        </label>
        <label>
          {t('settings.limits.maxToolCalls')}
          <input
            disabled={busy}
            max={MAX_TOOL_CALLS_LIMIT}
            min={1}
            onChange={(event) => setDraft({
              ...draft,
              maxToolCalls: Number(event.target.value),
            })}
            type="number"
            value={draft.maxToolCalls}
          />
        </label>
        <label>
          {t('settings.limits.maxTotalTokens')}
          <input
            disabled={busy}
            max={MAX_TOTAL_TOKENS_LIMIT}
            min={MIN_TOTAL_TOKENS_LIMIT}
            onChange={(event) => setDraft({
              ...draft,
              maxTotalTokens: Number(event.target.value),
            })}
            step={10_000}
            type="number"
            value={draft.maxTotalTokens}
          />
        </label>
      </div>
      <div className="settings-actions">
        <button
          className="primary-button"
          disabled={busy || isSaved}
          onClick={() => void save(draft)}
          type="button"
        >
          {context.busy ? t('settings.limits.saving') : t('settings.limits.save')}
        </button>
        <button
          disabled={busy}
          onClick={() => reset()}
          type="button"
        >
          {t('settings.limits.reset')}
        </button>
      </div>
      <p className="security-note">
        <LockKeyhole size={13} aria-hidden />
        <span>{t('settings.limits.note')}</span>
      </p>
    </section>
  )
}

export const defaultAgentLimitsSettings = DEFAULT_AGENT_LIMITS_SETTINGS
