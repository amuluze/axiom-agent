import type { CSSProperties } from 'react'
import type { ContextPolicySettings } from '@/agent/context/types'
import type { QueueModeSettings } from '@/agent/runtime/queueSettings'
import type { AgentLimitsSettings } from '@/agent/runtime/agentLimitsSettings'
import type { StoredAgentSession, StorageStats } from '@/persistence/types'
import type { ProviderProfile, ProviderProfileDraft } from '@/agent/transport/provider'

export interface ProviderModelDescriptor {
  providerId: string
  modelId: string
  label: string
  /** 模型级上下文窗口（tokens），来自内置 model catalog，选模型时自动填充。 */
  contextWindow: number
  /** 模型级最大输出 token 上限，来自内置 model catalog，选模型时自动填充。 */
  maxOutputTokens: number
  /** 模型是否声明支持推理；未声明的自定义模型为 false（推理设置不会进入请求）。 */
  supportsReasoning: boolean
}

export interface ProviderDraftHook {
  profiles: ProviderProfile[]
  creatingProfile: boolean
  draft: ProviderProfileDraft
  apiKey: string
  providerRequiresApiKey: boolean
  draftIsSaved: boolean
  modelCatalog: ProviderModelDescriptor[]
  setDraft: (draft: ProviderProfileDraft) => void
  setApiKey: (apiKey: string) => void
  updateKind: (kind: ProviderProfileDraft['providerId']) => void
  selectProfile: (profileId: string) => Promise<boolean>
  createProfile: () => void
  deleteProfile: () => Promise<boolean>
  saveProvider: (apiKey: string) => Promise<{ saved: boolean; ready?: boolean }>
  testProvider: () => Promise<boolean>
  deleteProviderKey: () => Promise<boolean>
}

export interface ContextPolicyDraftHook {
  draft: ContextPolicySettings
  contextWindow: number
  maxOutputTokens: number
  save: (settings: ContextPolicySettings) => Promise<boolean>
  setDraft: (settings: ContextPolicySettings) => void
  reset: () => void
}

export interface QueueModesDraftHook {
  draft: QueueModeSettings
  setDraft: (settings: QueueModeSettings) => void
}

export interface AgentLimitsDraftHook {
  draft: AgentLimitsSettings
  save: (settings: AgentLimitsSettings) => boolean
  setDraft: (settings: AgentLimitsSettings) => void
  reset: () => void
}

export interface SessionsHook {
  sessions: StoredAgentSession[]
  activeSessionId: string | null
  storageStats: StorageStats | null
  selectSession: (sessionId: string) => Promise<boolean>
  createSession: () => Promise<boolean>
  renameSession: (sessionId: string, title: string) => Promise<boolean>
  deleteSession: (sessionId: string) => Promise<boolean>
  refreshStorageStats: () => Promise<void>
}

export interface SettingsSectionContext {
  busy: boolean
  providerMessage: string | null
  settingsError: string | null
  style?: CSSProperties
}
