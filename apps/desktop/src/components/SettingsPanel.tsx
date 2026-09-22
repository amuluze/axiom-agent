import {
  defaultProviderProfile,
  listModelsForProfile,
  providerRequiresApiKey,
  type ProviderProfileDraft,
  type ProviderKind,
} from '@/agent/transport/provider'
import {
  createContextPolicy,
  DEFAULT_CONTEXT_POLICY_SETTINGS,
  normalizeContextPolicySettings,
  type ContextPolicySettings,
} from '@/agent/context/types'
import { flattenSessionTree } from '@/agent/session/tree'
import type { QueueModeSettings } from '@/agent/runtime/queueSettings'
import { isTauriRuntime } from '@/platform/environment'
import { useAgentStore } from '@/stores/agentStore'
import type { SettingsSection } from '@/stores/uiStore'
import { useT } from '@/i18n'
import { localizedProviderLabel } from '@/i18n/providerLabels'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import {
  shouldCloseProviderSetup,
  submitProviderSettings,
} from '@/components/settings/settingsUtils'
import { ProviderSection } from '@/components/settings/sections/ProviderSection'
import { ContextPolicySection } from '@/components/settings/sections/ContextPolicySection'
import { QueueModesSection } from '@/components/settings/sections/QueueModesSection'
import { LimitsSection } from '@/components/settings/sections/LimitsSection'
import {
  DEFAULT_AGENT_LIMITS_SETTINGS,
  normalizeAgentLimitsSettings,
  type AgentLimitsSettings,
} from '@/agent/runtime/agentLimitsSettings'
import { SessionsSection } from '@/components/settings/sections/SessionsSection'
import { GeneralSection } from '@/components/settings/sections/GeneralSection'
import { AboutSection } from '@/components/settings/sections/AboutSection'
import { BrowserSection } from '@/components/settings/sections/BrowserSection'
import { ComputerSection } from '@/components/settings/sections/ComputerSection'
import { UsageSection } from '@/components/settings/sections/UsageSection'
import { ArchivedSection } from '@/components/settings/sections/ArchivedSection'
import { SkillsSection } from '@/components/settings/sections/SkillsSection'
import { SubAgentsSection } from '@/components/settings/sections/SubAgentsSection'
import type {
  AgentLimitsDraftHook,
  ContextPolicyDraftHook,
  ProviderDraftHook,
  QueueModesDraftHook,
  SessionsHook,
  SettingsSectionContext,
} from '@/components/settings/sections/types'

interface SettingsPanelProps {
  open: boolean
  onClose: () => void
  inline?: boolean
  section?: SettingsSection
}

export { shouldCloseProviderSetup, submitProviderSettings }

export const SettingsPanel = ({ open, onClose, inline = false, section }: SettingsPanelProps) => {
  const { t } = useT()
  const provider = useAgentStore((state) => state.provider)
  const providerProfiles = useAgentStore((state) => state.providerProfiles)
  const running = useAgentStore((state) => state.running)
  const providerSaving = useAgentStore((state) => state.providerSaving)
  const providerTesting = useAgentStore((state) => state.providerTesting)
  const providerHasKey = useAgentStore((state) => state.providerHasKey)
  const providerSetupRequired = useAgentStore((state) => state.providerSetupRequired)
  const providerMessage = useAgentStore((state) => state.providerMessage)
  const settingsError = useAgentStore((state) => state.settingsError)
  const initializationError = useAgentStore((state) => state.initializationError)
  const runtimeLifecycle = useAgentStore((state) => state.runtimeLifecycle)
  const sessions = useAgentStore((state) => state.sessions)
  const activeSessionId = useAgentStore((state) => state.activeSessionId)
  const sessionBusy = useAgentStore((state) => state.sessionBusy)
  const recoveredRuns = useAgentStore((state) => state.recoveredRuns)
  const storageStats = useAgentStore((state) => state.storageStats)
  const contextPolicySettings = useAgentStore((state) => state.contextPolicySettings)
  const queueModeSettings = useAgentStore((state) => state.queueModeSettings)
  const agentLimitsSettings = useAgentStore((state) => state.agentLimitsSettings)
  const contextPolicySaving = useAgentStore((state) => state.contextPolicySaving)
  const authorizedWorkspace = useAgentStore((state) => state.authorizedWorkspace)
  const saveProvider = useAgentStore((state) => state.saveProvider)
  const switchProviderProfile = useAgentStore((state) => state.switchProviderProfile)
  const deleteProviderProfile = useAgentStore((state) => state.deleteProviderProfile)
  const testProvider = useAgentStore((state) => state.testProvider)
  const deleteProviderKey = useAgentStore((state) => state.deleteProviderKey)
  const createNewSession = useAgentStore((state) => state.createNewSession)
  const addWorkspace = useAgentStore((state) => state.addWorkspace)
  const selectSession = useAgentStore((state) => state.selectSession)
  const deleteSession = useAgentStore((state) => state.deleteSession)
  const renameSession = useAgentStore((state) => state.renameSession)
  const refreshStorageStats = useAgentStore((state) => state.refreshStorageStats)
  const saveContextPolicy = useAgentStore((state) => state.saveContextPolicy)
  const saveQueueModes = useAgentStore((state) => state.saveQueueModes)
  const saveAgentLimits = useAgentStore((state) => state.saveAgentLimits)
  const retryInitialize = useAgentStore((state) => state.retryInitialize)

  const [draft, setDraft] = useState<ProviderProfileDraft>(provider)
  const [contextDraft, setContextDraft] = useState<ContextPolicySettings>(contextPolicySettings)
  const [queueModeDraft, setQueueModeDraft] = useState<QueueModeSettings>(queueModeSettings)
  const [agentLimitsDraft, setAgentLimitsDraft] = useState<AgentLimitsSettings>(agentLimitsSettings)
  const [apiKey, setApiKey] = useState('')
  const [creatingProviderProfile, setCreatingProviderProfile] = useState(providerProfiles.length === 0)
  const panelRef = useRef<HTMLElement | null>(null)

  const desktop = isTauriRuntime()
  const sessionTree = useMemo(() => flattenSessionTree(sessions), [sessions])
  const modelCatalog = useMemo(() => listModelsForProfile(draft), [draft])
  const titleById = useMemo(
    () => new Map(sessions.map((stored) => [stored.id, stored.title])),
    [sessions],
  )
  const effectiveContextPolicy = useMemo(
    () => createContextPolicy(provider.contextWindow, contextDraft, provider.maxOutputTokens),
    [contextDraft, provider.contextWindow, provider.maxOutputTokens],
  )

  useEffect(() => {
    if (open) {
      setDraft(provider)
      setContextDraft(contextPolicySettings)
      setQueueModeDraft(queueModeSettings)
      setAgentLimitsDraft(agentLimitsSettings)
      setApiKey('')
      setCreatingProviderProfile(providerProfiles.length === 0)
      void Promise.all([
        refreshStorageStats(),
      ])
    }
  }, [
    agentLimitsSettings,
    contextPolicySettings,
    open,
    provider,
    queueModeSettings,
    refreshStorageStats,
  ])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled])')
        ?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  if (!open) return null

  const updateKind = (kind: ProviderKind) => {
    setDraft({ ...defaultProviderProfile(kind), profileId: draft.profileId })
    setApiKey('')
  }

  const submit = async () => {
    const result = await submitProviderSettings({
      draft,
      apiKey,
      setupRequired: providerSetupRequired,
      save: saveProvider,
      clearApiKey: () => setApiKey(''),
      close: onClose,
    })
    return result
  }

  const busy = runtimeLifecycle !== 'ready'
    || running
    || providerSaving
    || providerTesting
    || contextPolicySaving
    || sessionBusy

  const draftIsSaved = !creatingProviderProfile
    && JSON.stringify(draft) === JSON.stringify(provider)
  const draftRequiresApiKey = providerRequiresApiKey(draft.providerId)
  const contextDraftIsSaved = JSON.stringify(
    normalizeContextPolicySettings(contextDraft, provider.contextWindow, provider.maxOutputTokens),
  ) === JSON.stringify(contextPolicySettings)
  const queueModeDraftIsSaved = JSON.stringify(queueModeDraft) === JSON.stringify(queueModeSettings)
  const agentLimitsDraftIsSaved = JSON.stringify(
    normalizeAgentLimitsSettings(agentLimitsDraft),
  ) === JSON.stringify(agentLimitsSettings)

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !providerSetupRequired) {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab' || !panelRef.current) return
    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.getClientRects().length > 0)
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  const sectionContext: SettingsSectionContext = {
    busy,
    providerMessage: providerSaving ? 'providerSaving' : providerMessage,
    settingsError,
    style: undefined,
  }

  const providerHook: ProviderDraftHook = {
    profiles: providerProfiles,
    creatingProfile: creatingProviderProfile,
    draft,
    apiKey,
    providerRequiresApiKey: draftRequiresApiKey,
    draftIsSaved,
    modelCatalog,
    setDraft,
    setApiKey,
    updateKind,
    selectProfile: async (profileId) => {
      if (profileId === provider.profileId) {
        setDraft(provider)
        setCreatingProviderProfile(false)
        return true
      }
      const switched = await switchProviderProfile(profileId)
      if (switched) {
        setDraft(useAgentStore.getState().provider)
        setCreatingProviderProfile(false)
        setApiKey('')
      }
      return switched
    },
    createProfile: () => {
      const kind = provider.providerId === 'demo' ? 'generic-anthropic-compatible' : provider.providerId
      setDraft({
        ...defaultProviderProfile(kind),
        profileId: `profile.${crypto.randomUUID()}`,
      })
      setApiKey('')
      setCreatingProviderProfile(true)
    },
    deleteProfile: async () => {
      if (creatingProviderProfile) {
        setDraft(provider)
        setApiKey('')
        setCreatingProviderProfile(false)
        return true
      }
      const deleted = await deleteProviderProfile(draft.profileId)
      if (deleted) {
        setDraft(useAgentStore.getState().provider)
        setApiKey('')
      }
      return deleted
    },
    saveProvider: async (key) => {
      const result = await saveProvider(draft, key)
      if (result.saved) {
        setApiKey('')
        setCreatingProviderProfile(false)
      }
      return result
    },
    testProvider,
    deleteProviderKey,
  }

  const contextPolicyHook: ContextPolicyDraftHook = {
    draft: contextDraft,
    contextWindow: provider.contextWindow,
    maxOutputTokens: provider.maxOutputTokens,
    save: async (settings) => saveContextPolicy(settings),
    setDraft: setContextDraft,
    reset: () => setContextDraft(normalizeContextPolicySettings(
      DEFAULT_CONTEXT_POLICY_SETTINGS,
      provider.contextWindow,
      provider.maxOutputTokens,
    )),
  }

  const queueModesHook: QueueModesDraftHook = {
    draft: queueModeDraft,
    setDraft: setQueueModeDraft,
  }

  const agentLimitsHook: AgentLimitsDraftHook = {
    draft: agentLimitsDraft,
    save: (settings) => saveAgentLimits(settings),
    setDraft: setAgentLimitsDraft,
    reset: () => setAgentLimitsDraft({ ...DEFAULT_AGENT_LIMITS_SETTINGS }),
  }

  const sessionsHook: SessionsHook = {
    sessions,
    activeSessionId,
    storageStats,
    selectSession,
    createSession: () => authorizedWorkspace
      ? createNewSession(authorizedWorkspace.path)
      : addWorkspace(),
    renameSession,
    deleteSession,
    refreshStorageStats,
  }

  const visibleSection = section
  const showSection = (target: SettingsSection): boolean => !visibleSection || visibleSection === target

  const inner = (
    <>
      {!inline && (
        <header className="settings-header">
          <div>
            <div className="eyebrow">{providerSetupRequired ? t('settings.panel.eyebrow.setup') : t('settings.panel.eyebrow.desktop')}</div>
            <h2>{providerSetupRequired ? t('settings.panel.title.setup') : t('settings.panel.title.desktop')}</h2>
          </div>
          {!providerSetupRequired && (
            <button aria-label={t('settings.panel.close')} className="icon-button" onClick={onClose}>×</button>
          )}
        </header>
      )}
      <div className="settings-form">
        {providerSetupRequired && showSection('models') && (
          <div className="setup-notice">
            {t('settings.panel.setupNotice')}
          </div>
        )}
        {showSection('models') && (
          <>
            <ProviderSection
              hook={providerHook}
              context={sectionContext}
              providerLabel_={localizedProviderLabel(t, draft.providerId)}
              providerHasKey={!creatingProviderProfile && draft.profileId === provider.profileId && providerHasKey}
              desktop={desktop}
            />
            <ContextPolicySection
              hook={contextPolicyHook}
              context={sectionContext}
              isSaved={contextDraftIsSaved}
              effectiveContextTokens={effectiveContextPolicy.contextWindow - effectiveContextPolicy.reserveTokens}
              effectiveKeepRecentTokens={effectiveContextPolicy.keepRecentTokens}
              effectiveByteBufferBytes={effectiveContextPolicy.hardRequestByteLimit - effectiveContextPolicy.requestByteThreshold}
            />
            <QueueModesSection
              hook={queueModesHook}
              context={sectionContext}
              isSaved={queueModeDraftIsSaved}
              onSave={() => saveQueueModes(queueModeDraft)}
            />
            <LimitsSection
              hook={agentLimitsHook}
              context={sectionContext}
              isSaved={agentLimitsDraftIsSaved}
            />
          </>
        )}
        {showSection('sessions') && (
          <SessionsSection
            hook={sessionsHook}
            context={sectionContext}
            tree={sessionTree}
            titleById={titleById}
            storageStats={storageStats}
            recoveredRuns={recoveredRuns}
            desktop={desktop}
          />
        )}
        {showSection('archived') && <ArchivedSection />}
        {showSection('usage') && <UsageSection />}
        {showSection('skills') && <SkillsSection />}
        {showSection('subagents') && <SubAgentsSection />}
        {showSection('general') && (
          <GeneralSection />
        )}
        {showSection('about') && (
          <AboutSection />
        )}
        {showSection('browser') && (
          <BrowserSection />
        )}
        {showSection('computer') && (
          <ComputerSection />
        )}
        {visibleSection && visibleSection !== 'models' && providerMessage && (
          <div className="settings-success" role="status">{providerMessage}</div>
        )}
        {settingsError && (
          <div className="settings-error" role="alert">
            <span>{settingsError}</span>
            {initializationError && (
              <button disabled={busy} onClick={() => void retryInitialize()} type="button">
                {t('settings.panel.retryInit')}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )

  // Suppress unused symbol: submit is kept as the canonical entry point for tests.
  void submit

  if (inline) {
    return (
      <section
        aria-label={t('settings.panel.aria')}
        onKeyDown={handleDialogKeyDown}
        ref={panelRef as React.RefObject<HTMLElement>}
      >
        {inner}
      </section>
    )
  }

  return (
    <div
      className="settings-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!providerSetupRequired) onClose()
      }}
    >
      <aside
        aria-modal="true"
        className="settings-panel"
        onKeyDown={handleDialogKeyDown}
        role="dialog"
        ref={panelRef as React.RefObject<HTMLElement>}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {inner}
      </aside>
    </div>
  )
}
