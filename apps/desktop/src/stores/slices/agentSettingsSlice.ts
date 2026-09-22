import type { ContextPolicySettings } from '@/agent/context/types'
import type { ReasoningSettings } from '@/agent/runtime/reasoningSettings'
import type { AgentLimitsSettings } from '@/agent/runtime/agentLimitsSettings'
import type { QueueModeSettings } from '@/agent/runtime/queueSettings'
import {
  activeAgentLimitsSettings,
  activeContextPolicySettings,
  activeQueueModeSettings,
  activeReasoningSettings,
} from '../settingsPersistence'
import {
  saveAgentLimits as saveAgentLimitsAction,
  saveContextPolicy as saveContextPolicyAction,
  saveQueueAutoDrain as saveQueueAutoDrainAction,
  saveQueueModes as saveQueueModesAction,
  saveReasoningSettings as saveReasoningSettingsAction,
  type AgentGet,
  type AgentSet,
  type StoreRuntimeDeps,
} from '../sessionActions'

/**
 * 设置切片：队列模式 / 上下文策略 / 推理 / 限额等本地持久化设置。
 * 方法全部转发到 sessionActions 的显式 action 函数。
 */
export interface AgentSettingsSlice {
  queueModeSettings: QueueModeSettings
  contextPolicySettings: ContextPolicySettings
  reasoningSettings: ReasoningSettings
  agentLimitsSettings: AgentLimitsSettings
  saveQueueModes: (settings: QueueModeSettings) => boolean
  /** 切换队列自动出队（允许运行中即时切换）。 */
  saveQueueAutoDrain: (enabled: boolean) => boolean
  saveAgentLimits: (settings: AgentLimitsSettings) => boolean
  saveContextPolicy: (settings: ContextPolicySettings) => Promise<boolean>
  saveReasoningSettings: (settings: ReasoningSettings) => Promise<boolean>
}

export const createAgentSettingsSlice = (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
): AgentSettingsSlice => ({
  queueModeSettings: activeQueueModeSettings,
  contextPolicySettings: activeContextPolicySettings,
  reasoningSettings: activeReasoningSettings,
  agentLimitsSettings: activeAgentLimitsSettings,
  saveQueueModes: (settings) => saveQueueModesAction(set, get, deps, settings),
  saveQueueAutoDrain: (enabled) => saveQueueAutoDrainAction(set, get, deps, enabled),
  saveAgentLimits: (settings) => saveAgentLimitsAction(set, get, deps, settings),
  saveContextPolicy: (settings) => saveContextPolicyAction(set, get, deps, settings),
  saveReasoningSettings: (settings) => saveReasoningSettingsAction(set, get, deps, settings),
})
