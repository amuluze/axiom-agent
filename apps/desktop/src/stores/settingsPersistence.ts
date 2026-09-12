import { isTauriRuntime } from '@/platform/environment'
import type { ProviderApiFormat } from '@/agent/core/types'
import {
  type ContextPolicySettings,
  resolveContextPolicySettings,
} from '@/agent/context/types'
import {
  type QueueModeSettings,
  resolveQueueModeSettings,
} from '@/agent/runtime/queueSettings'
import {
  type ReasoningSettings,
  resolveReasoningSettings,
} from '@/agent/runtime/reasoningSettings'
import { initialProviderFallback } from '@/agent/transport/provider'
import { RUNTIME_POLICY } from '@/config/runtimePolicy'
import { loadProviderSelection } from './services/providerStorage'
import {
  type AgentLimitsSettings,
  resolveAgentLimitsSettings,
} from '@/agent/runtime/agentLimitsSettings'

/**
 * Module-level mutable singletons for runtime settings.
 *
 * Pattern mirrors `services/sessionMetadata.ts`: exports a live binding so any
 * `import { activeXxxSettings } from './settingsPersistence'` in the store
 * observes the latest value, while setter functions are the single entry point
 * for in-memory writes. Setters intentionally do NOT touch localStorage — the
 * store actions retain the original `localStorage.setItem` path so they can
 * surface persistence errors to the UI via `settingsError` and `providerMessage`.
 *
 * Do NOT destructure these at the top of a consumer module — that would
 * freeze the snapshot and break the live binding.
 */

// 模块初始化用同步 fallback 播种（解析已下沉 Rust，无法同步解码持久化存储值）；
// 下方异步重播种按真实持久化 selection 修正，agentStore 在 initialize 中也会经
// normalize 重播种设置（两条路径收敛到同一 Provider bounds）。
const initialProvider = initialProviderFallback(RUNTIME_POLICY.allowDemoProvider)

export let activeContextPolicySettings: ContextPolicySettings = resolveContextPolicySettings(
  isTauriRuntime() ? localStorage.getItem('axiom.context.policy.v1') : null,
  initialProvider.contextWindow,
  initialProvider.maxOutputTokens,
)

export let activeQueueModeSettings: QueueModeSettings = resolveQueueModeSettings(
  isTauriRuntime() ? localStorage.getItem('axiom.queue.mode.v1') : null,
)

export let activeReasoningSettings: ReasoningSettings = resolveReasoningSettings(
  isTauriRuntime() ? localStorage.getItem('axiom.reasoning.v1') : null,
  initialProvider.apiFormat as ProviderApiFormat,
  initialProvider.maxOutputTokens,
)

export let activeAgentLimitsSettings: AgentLimitsSettings = resolveAgentLimitsSettings(
  isTauriRuntime() ? localStorage.getItem('axiom.agent.limits.v1') : null,
)

export const setActiveContextPolicySettings = (next: ContextPolicySettings): void => {
  activeContextPolicySettings = next
}

export const setActiveQueueModeSettings = (next: QueueModeSettings): void => {
  activeQueueModeSettings = next
}

export const setActiveReasoningSettings = (next: ReasoningSettings): void => {
  activeReasoningSettings = next
}

export const setActiveAgentLimitsSettings = (next: AgentLimitsSettings): void => {
  activeAgentLimitsSettings = next
}

// 异步修正：持久化的 Provider selection 经 Rust 权威解析后，按真实 bounds 重播种
// 上下文策略与推理设置（冷启动读取持久化 localStorage 的关键路径）。
void Promise.resolve(loadProviderSelection()).then((selection) => {
  const provider = selection.config
  activeContextPolicySettings = resolveContextPolicySettings(
    isTauriRuntime() ? localStorage.getItem('axiom.context.policy.v1') : null,
    provider.contextWindow,
    provider.maxOutputTokens,
  )
  activeReasoningSettings = resolveReasoningSettings(
    isTauriRuntime() ? localStorage.getItem('axiom.reasoning.v1') : null,
    provider.apiFormat as ProviderApiFormat,
    provider.maxOutputTokens,
  )
}).catch(() => undefined)

/**
 * 统一的设置本地持久化入口：仅 Tauri 运行时写 localStorage（浏览器 dev 模式
 * 静默跳过），写入失败返回错误信息字符串，由调用方决定汇入 settingsError/error。
 * 收口各处重复的 `if (isTauriRuntime()) { try { localStorage.setItem(...) } }` 样板。
 */
export const persistLocalSettings = (key: string, value: unknown): string | null => {
  if (!isTauriRuntime()) return null
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
