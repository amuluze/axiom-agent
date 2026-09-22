import type {
  AgentLimitsDraftHook,
  ContextPolicyDraftHook,
  ProviderDraftHook,
  QueueModesDraftHook,
  SessionsHook,
} from './types'
import {
  DEFAULT_CONTEXT_POLICY_SETTINGS,
  type ContextPolicySettings,
} from '@/agent/context/types'
import type { QueueModeSettings } from '@/agent/runtime/queueSettings'
import { DEFAULT_AGENT_LIMITS_SETTINGS, type AgentLimitsSettings } from '@/agent/runtime/agentLimitsSettings'
import type { ProviderProfileDraft } from '@/agent/transport/provider'
import { TEST_ANTHROPIC_PROFILE } from '@/agent/transport/__fixtures__/testAnthropicProfile'

const noopAsync = async (): Promise<void> => undefined
const noopBoolAsync = async (): Promise<boolean> => true
const noopBool = (): boolean => true
const noopSetter = () => undefined

export const baseProviderDraft: ProviderProfileDraft = {
  ...TEST_ANTHROPIC_PROFILE,
  modelId: 'claude-test',
}

const baseContextPolicy: ContextPolicySettings = {
  ...DEFAULT_CONTEXT_POLICY_SETTINGS,
}

const baseQueueModes: QueueModeSettings = {
  steering: 'one-at-a-time',
  followUp: 'one-at-a-time',
  autoDrain: true,
}

const baseAgentLimits: AgentLimitsSettings = {
  ...DEFAULT_AGENT_LIMITS_SETTINGS,
}

export const stubContext = {
  busy: false,
  providerMessage: null,
  settingsError: null,
  style: undefined,
}

export const buildProviderHook = (overrides: Partial<ProviderDraftHook> = {}): ProviderDraftHook => ({
  profiles: overrides.profiles ?? [TEST_ANTHROPIC_PROFILE],
  creatingProfile: overrides.creatingProfile ?? false,
  draft: overrides.draft ?? baseProviderDraft,
  apiKey: overrides.apiKey ?? '',
  providerRequiresApiKey: overrides.providerRequiresApiKey ?? true,
  draftIsSaved: overrides.draftIsSaved ?? true,
  modelCatalog: overrides.modelCatalog ?? [
    {
      providerId: 'generic-anthropic-compatible',
      modelId: 'claude-test',
      label: 'Claude Test',
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      supportsReasoning: true,
    },
  ],
  setDraft: overrides.setDraft ?? noopSetter,
  setApiKey: overrides.setApiKey ?? noopSetter,
  updateKind: overrides.updateKind ?? noopSetter,
  selectProfile: overrides.selectProfile ?? noopBoolAsync,
  createProfile: overrides.createProfile ?? noopSetter,
  deleteProfile: overrides.deleteProfile ?? noopBoolAsync,
  saveProvider: overrides.saveProvider ?? (async (_apiKey: string) => ({ saved: true, ready: true })),
  testProvider: overrides.testProvider ?? noopBoolAsync,
  deleteProviderKey: overrides.deleteProviderKey ?? noopBoolAsync,
})

export const buildContextPolicyHook = (overrides: Partial<ContextPolicyDraftHook> = {}): ContextPolicyDraftHook => ({
  draft: overrides.draft ?? baseContextPolicy,
  contextWindow: overrides.contextWindow ?? 200_000,
  maxOutputTokens: overrides.maxOutputTokens ?? 4096,
  save: overrides.save ?? noopBoolAsync,
  setDraft: overrides.setDraft ?? noopSetter,
  reset: overrides.reset ?? noopSetter,
})

export const buildQueueModesHook = (overrides: Partial<QueueModesDraftHook> = {}): QueueModesDraftHook => ({
  draft: overrides.draft ?? baseQueueModes,
  setDraft: overrides.setDraft ?? noopSetter,
})

export const buildAgentLimitsHook = (overrides: Partial<AgentLimitsDraftHook> = {}): AgentLimitsDraftHook => ({
  draft: overrides.draft ?? baseAgentLimits,
  save: overrides.save ?? noopBool,
  setDraft: overrides.setDraft ?? noopSetter,
  reset: overrides.reset ?? noopSetter,
})

export const buildSessionsHook = (overrides: Partial<SessionsHook> = {}): SessionsHook => ({
  sessions: overrides.sessions ?? [],
  activeSessionId: overrides.activeSessionId ?? null,
  storageStats: overrides.storageStats ?? null,
  selectSession: overrides.selectSession ?? noopBoolAsync,
  createSession: overrides.createSession ?? noopBoolAsync,
  renameSession: overrides.renameSession ?? noopBoolAsync,
  deleteSession: overrides.deleteSession ?? noopBoolAsync,
  refreshStorageStats: overrides.refreshStorageStats ?? noopAsync,
})
