import type {
  AgentLimitsDraftHook,
  ContextPolicyDraftHook,
  ProviderDraftHook,
  QueueModesDraftHook,
  ReasoningDraftHook,
  SessionsHook,
} from './types'
import {
  DEFAULT_CONTEXT_POLICY_SETTINGS,
  type ContextPolicySettings,
} from '@/agent/context/types'
import type { QueueModeSettings } from '@/agent/runtime/queueSettings'
import type { ReasoningSettings } from '@/agent/runtime/reasoningSettings'
import { DEFAULT_AGENT_LIMITS_SETTINGS, type AgentLimitsSettings } from '@/agent/runtime/agentLimitsSettings'
import {
  defaultProviderProfile,
  PROVIDER_PROFILE_SCHEMA_VERSION,
  type ProviderProfile,
  type ProviderProfileDraft,
} from '@/agent/transport/provider'

const noopAsync = async (): Promise<void> => undefined
const noopBoolAsync = async (): Promise<boolean> => true
const noopBool = (): boolean => true
const noopSetter = () => undefined

// 测试用 generic-anthropic-compatible profile（内置 MiniMax 入口已移除）。
// 直接构造已规范化形态（解析已下沉 Rust，测试不走异步解析）。
export const TEST_ANTHROPIC_PROFILE: ProviderProfile = {
  ...defaultProviderProfile('generic-anthropic-compatible'),
  schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
  profileId: 'test.anthropic',
  endpoint: 'https://api.anthropic.com/v1/messages',
  modelId: 'claude-test',
  secretId: 'provider.generic-anthropic-compatible.api-key',
}

const baseProviderDraft: ProviderProfileDraft = {
  ...TEST_ANTHROPIC_PROFILE,
  modelId: 'claude-test',
}

const baseContextPolicy: ContextPolicySettings = {
  ...DEFAULT_CONTEXT_POLICY_SETTINGS,
}

const baseReasoning: ReasoningSettings = {
  level: 'medium',
  mode: 'effort',
  budgetTokens: 4_096,
}

const baseQueueModes: QueueModeSettings = {
  steering: 'one-at-a-time',
  followUp: 'one-at-a-time',
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

export const buildReasoningHook = (overrides: Partial<ReasoningDraftHook> = {}): ReasoningDraftHook => ({
  draft: overrides.draft ?? baseReasoning,
  apiFormat: overrides.apiFormat ?? 'anthropic-compatible',
  maxOutputTokens: overrides.maxOutputTokens ?? 8_192,
  supportsReasoning: overrides.supportsReasoning ?? true,
  save: overrides.save ?? noopBoolAsync,
  setDraft: overrides.setDraft ?? noopSetter,
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
