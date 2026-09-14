import { useState } from 'react'
import { Sparkles, Zap, KeyRound, LockKeyhole, Plus, Trash2, Eye, EyeOff } from 'lucide-react'
import {
  BUILTIN_PROVIDER_RUNTIME,
  listModelsForProfile,
  providerRequiresApiKey,
  type ProviderProfileDraft,
  type ProviderKind,
} from '@/agent/transport/provider'
import { RUNTIME_POLICY } from '@/config/runtimePolicy'
import { localizedProviderLabel } from '@/i18n/providerLabels'
import type { ProviderDraftHook, SettingsSectionContext } from './types'
import { useT } from '@/i18n'

interface ProviderSectionProps {
  hook: ProviderDraftHook
  context: SettingsSectionContext
  providerLabel_: string
  providerHasKey: boolean
  desktop: boolean
}

const providerOptions = BUILTIN_PROVIDER_RUNTIME.listProviders().filter((descriptor) => (
  descriptor.providerId !== 'demo' || RUNTIME_POLICY.allowDemoProvider
))

export const ProviderSection = ({ hook, context, providerLabel_, providerHasKey, desktop }: ProviderSectionProps) => {
  const { t } = useT()
  const {
    profiles,
    creatingProfile,
    draft,
    apiKey,
    providerRequiresApiKey: needsKey,
    draftIsSaved,
    modelCatalog,
    setDraft,
    setApiKey,
    updateKind,
    selectProfile,
    createProfile,
    deleteProfile,
    saveProvider,
    testProvider,
    deleteProviderKey,
  } = hook
  const { busy, providerMessage, settingsError } = context
  // API Key 的明文核对开关：掩码输入防窥探，粘贴后可临时切明文检查。
  const [showKey, setShowKey] = useState(false)
  const keyStored = providerHasKey && draftIsSaved
  return (
    <section className="settings-section" id="settings-provider" aria-labelledby="settings-provider-title">
      <div className="settings__profile-picker">
        <label>
          {t('settings.provider.profileLabel')}
          <select
            disabled={busy}
            value={creatingProfile ? '__new__' : draft.profileId}
            onChange={(event) => { void selectProfile(event.target.value) }}
          >
            {creatingProfile && <option value="__new__">{t('settings.provider.profileNew')}</option>}
            {profiles.map((profile) => (
              <option key={profile.profileId} value={profile.profileId}>
                {localizedProviderLabel(t, profile.providerId)} · {profile.modelName || profile.modelId}
              </option>
            ))}
          </select>
        </label>
        <div className="settings__profile-actions">
          <button className="settings__button" disabled={busy} onClick={createProfile} type="button">
            <Plus size={13} />
            <span>{t('settings.provider.addProfile')}</span>
          </button>
          <button
            className="settings__button settings__button--danger"
            disabled={busy || (creatingProfile ? profiles.length === 0 : profiles.length <= 1)}
            onClick={() => { void deleteProfile() }}
            type="button"
          >
            <Trash2 size={13} />
            <span>{creatingProfile ? t('settings.provider.cancelAdd') : t('settings.provider.deleteProfile')}</span>
          </button>
        </div>
      </div>
      <header className="settings-card" style={{ background: 'transparent', border: 'none', padding: 0 }}>
        <div className="settings__card-head">
          <span className="settings__card-logo">
            <Sparkles size={16} />
          </span>
          <div className="settings__card-title-block">
            <span className="settings__card-name">{providerLabel_}</span>
            <span className="settings__card-endpoint">{draft.endpoint || t('settings.provider.endpointUnset')}</span>
          </div>
          <span className="settings__state settings__state--connected">
            <span className="settings__state-dot" />
            <span>{providerHasKey ? t('settings.provider.keyReady') : t('settings.provider.keyMissing')}</span>
          </span>
        </div>
      </header>
      <div className="settings-grid settings-grid--split">
        <label>
          {t('settings.provider.apiFormat')}
          <select
            disabled={busy}
            value={draft.providerId}
            onChange={(event) => updateKind(event.target.value as ProviderKind)}
          >
            {providerOptions.map((descriptor) => (
              <option
                disabled={!desktop && descriptor.providerId !== 'demo'}
                key={descriptor.providerId}
                value={descriptor.providerId}
              >
                {localizedProviderLabel(t, descriptor.providerId)}
              </option>
            ))}
          </select>
        </label>
        {draft.providerId !== 'demo' && (
          <label>
            {t('settings.provider.endpoint')}
            <input
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
              spellCheck={false}
              type="url"
              value={draft.endpoint}
            />
          </label>
        )}
      </div>
      {draft.providerId !== 'demo' && (
        <div className="settings-grid settings-grid--split">
          <label>
            {t('settings.provider.modelName')}
            <input
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, modelName: event.target.value })}
              placeholder={t('settings.provider.modelNamePlaceholder')}
              spellCheck={false}
              value={draft.modelName ?? ''}
            />
          </label>
          <label>
            {t('settings.provider.website')}
            <input
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, website: event.target.value })}
              placeholder={t('settings.provider.websitePlaceholder')}
              spellCheck={false}
              type="url"
              value={draft.website ?? ''}
            />
          </label>
        </div>
      )}
      {draft.providerId !== 'demo' && (
        <div className="settings-grid settings-grid--split">
          <label>
            {t('settings.provider.modelId')}
            <input
              disabled={busy}
              list="provider-model-catalog"
              onChange={(event) => {
                const modelId = event.target.value
                const descriptor = modelCatalog.find((model) => model.modelId === modelId)
                setDraft({
                  ...draft,
                  modelId,
                  // 选内置模型时用 catalog 里的模型级值自动填充窗口/token；
                  // 自定义模型（catalog 无匹配）保留用户手填。
                  ...(descriptor ? {
                    contextWindow: descriptor.contextWindow,
                    maxOutputTokens: descriptor.maxOutputTokens,
                  } : {}),
                })
              }}
              placeholder={t('settings.provider.modelIdPlaceholder')}
              spellCheck={false}
              value={draft.modelId ?? ''}
            />
            <datalist id="provider-model-catalog">
              {modelCatalog.map((model) => (
                <option
                  key={`${model.providerId}:${model.modelId}`}
                  value={model.modelId}
                >
                  {model.label}
                </option>
              ))}
            </datalist>
          </label>
          <label>
            {t('settings.provider.apiKey')}
            <div className={`settings__input settings__input--key${keyStored ? ' settings__input--key-stored' : ''}`}>
              <KeyRound size={13} className="settings__input-icon" aria-hidden />
              <input
                autoComplete="off"
                disabled={busy}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  keyStored
                    ? t('settings.provider.keyPlaceholderStored')
                    : needsKey
                      ? t('settings.provider.keyPlaceholderRequired')
                      : t('settings.provider.keyPlaceholderOptional')
                }
                type={showKey ? 'text' : 'password'}
                value={apiKey}
              />
              {keyStored && <span className="settings__key-stored">{t('settings.provider.keyStoredBadge')}</span>}
              <button
                aria-label={showKey ? t('settings.provider.keyHideAria') : t('settings.provider.keyShowAria')}
                aria-pressed={showKey}
                className="settings__input-action"
                disabled={busy}
                onClick={() => setShowKey((current) => !current)}
                title={showKey ? t('settings.provider.keyHideAria') : t('settings.provider.keyShowAria')}
                type="button"
              >
                {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
          </label>
        </div>
      )}
      {draft.providerId !== 'demo' && (
        <div className="settings-grid">
          <label>
            {t('settings.provider.timeout')}
            <input
              disabled={busy}
              max={300}
              min={1}
              onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) * 1000 })}
              type="number"
              value={Math.round(draft.timeoutMs / 1000)}
            />
          </label>
          <label>
            {t('settings.provider.maxOutputTokens')}
            <input
              disabled={busy}
              max={64000}
              min={1}
              onChange={(event) => setDraft({ ...draft, maxOutputTokens: Number(event.target.value) })}
              type="number"
              value={draft.maxOutputTokens}
            />
          </label>
          <label>
            {t('settings.provider.contextWindow')}
            <input
              disabled={busy}
              max={2000000}
              min={8192}
              onChange={(event) => setDraft({ ...draft, contextWindow: Number(event.target.value) })}
              type="number"
              value={draft.contextWindow}
            />
          </label>
        </div>
      )}
      <div className="settings-actions">
        <button
          className="settings__button settings__button--primary"
          disabled={busy}
          onClick={() => void saveProvider(apiKey)}
          type="button"
        >
          {context.providerMessage === 'providerSaving' ? t('settings.provider.saving') : t('settings.provider.saveProfile')}
        </button>
        {draft.providerId !== 'demo' && (
          <button
            className="settings__button"
            disabled={busy || !draftIsSaved}
            onClick={() => void testProvider()}
            type="button"
          >
            <Zap size={13} />
            <span>{t('settings.provider.testConnection')}</span>
          </button>
        )}
        {draft.providerId !== 'demo' && providerHasKey && (
          <button
            className="settings__button settings__button--danger"
            disabled={busy}
            onClick={() => void deleteProviderKey()}
            type="button"
          >
            <KeyRound size={13} />
            <span>{t('settings.provider.deleteKey')}</span>
          </button>
        )}
      </div>
      {providerMessage && <div className="settings-success" role="status">{providerMessage}</div>}
      {settingsError && <div className="settings-error" role="alert">{settingsError}</div>}
      {draft.providerId.startsWith('custom-') && (
        <p className="security-note" role="note">
          <LockKeyhole size={13} aria-hidden />
          <span>{t('settings.provider.customKeyNote')}</span>
        </p>
      )}
      <p className="security-note">
        <LockKeyhole size={13} aria-hidden />
        <span>{t('settings.provider.securityNote')}</span>
      </p>
    </section>
  )
}

export const buildModelCatalog = (draft: ProviderProfileDraft) =>
  listModelsForProfile(draft).map((model) => model.modelId)

export { providerRequiresApiKey }
