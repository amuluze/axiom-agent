import { RUNTIME_POLICY } from '@/config/runtimePolicy'
import {
  initialProviderFallback,
  type ProviderProfile,
  type ProviderProfileDraft,
} from '@/agent/transport/provider'
import {
  deleteProviderKey as deleteProviderKeyAction,
  deleteProviderProfile as deleteProviderProfileAction,
  saveProvider as saveProviderAction,
  switchProviderProfile as switchProviderProfileAction,
  testProvider as testProviderAction,
} from '../providerActions'
import type { AgentGet, AgentSet, StoreRuntimeDeps } from '../sessionActions'
import type { ProviderSaveResult } from '../agentStateTypes'

// Provider selection 的模块级 fallback：同步播种（浏览器 demo 与首启等
// 未持久化 selection 时），真实 selection 由 initialize() 异步加载覆盖。
// settingsPersistence 也持有同源 initialProvider（用于设置默认值），这里
// 的副本只服务 store 的初始状态。
export const initialProvider = initialProviderFallback(RUNTIME_POLICY.allowDemoProvider)
export const initialProviderProfiles: ProviderProfile[] = [structuredClone(initialProvider)]

/**
 * Provider 切片：当前 provider、profile 列表与保存/切换/测试等动作。
 * 方法全部转发到 providerActions 的显式 action 函数。
 */
export interface AgentProviderSlice {
  provider: ProviderProfile
  providerProfiles: ProviderProfile[]
  providerReady: boolean
  providerSetupRequired: boolean
  providerSaving: boolean
  providerTesting: boolean
  providerHasKey: boolean
  providerMessage: string | null
  saveProvider: (config: ProviderProfileDraft, apiKey?: string) => Promise<ProviderSaveResult>
  switchProviderProfile: (profileId: string) => Promise<boolean>
  deleteProviderProfile: (profileId: string) => Promise<boolean>
  testProvider: () => Promise<boolean>
  deleteProviderKey: () => Promise<boolean>
}

export const createAgentProviderSlice = (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
): AgentProviderSlice => ({
  provider: initialProvider,
  providerProfiles: initialProviderProfiles,
  providerReady: false,
  providerSetupRequired: !RUNTIME_POLICY.allowDemoProvider,
  providerSaving: false,
  providerTesting: false,
  providerHasKey: false,
  providerMessage: null,
  saveProvider: (draft, apiKey) => saveProviderAction(set, get, deps, draft, apiKey),
  switchProviderProfile: (profileId) => switchProviderProfileAction(set, get, deps, profileId),
  deleteProviderProfile: (profileId) => deleteProviderProfileAction(set, get, deps, profileId),
  testProvider: () => testProviderAction(set, get, deps),
  deleteProviderKey: () => deleteProviderKeyAction(set, get, deps),
})
