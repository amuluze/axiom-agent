import type { AgentHarness } from '@/agent/runtime/AgentHarness'
import type { AgentRunEndReason, JsonValue } from '@/agent/core/types'
import type { ProviderProfile } from '@/agent/transport/provider'

/**
 * 单个正在执行的工具调用（tool_execution_start/update 驱动）：
 * start 时只有 toolName，update 时携带进度 content 与结构化 details
 * （如 Explore 的 { toolCalls: N }）。
 */
export interface ActiveToolInfo {
  toolName: string
  content: string
  details?: JsonValue
}

/**
 * Per-session UI projection snapshot. The store derives `activeTools`,
 * `endReason`, `error`, and `compactionRunning` from this
 * structure (the AgentHarness remains the source of truth; this is a
 * read-optimized cache updated by the event reducer in `handleSessionEvent`).
 */
export interface RuntimeProjection {
  activeTools: Record<string, ActiveToolInfo>
  endReason: AgentRunEndReason | null
  error: string | null
  compactionRunning: boolean
}

interface RuntimeProviderState {
  config: ProviderProfile
  configuredKey: boolean
}

/** 缓存的运行时会话上界：超限时逐出最久未用的非运行中会话（含完整消息历史的
 * AgentHarness 是主要内存占用，避免长期运行单调增长）。 */
const MAX_CACHED_RUNTIME_SESSIONS = 8

const runtimeSessions = new Map<string, AgentHarness>()
const runtimeProviders = new Map<string, RuntimeProviderState>()
const runtimeProjections = new Map<string, RuntimeProjection>()
// 每个会话的 basePrompt source 镜像：harness 的 prepareNextTurn hook（工具准则回流）
// 需要按会话读取自己的 basePrompt。模块级 activeSessionBasePrompt 会被其他会话的
// 激活/刷新覆盖，后台会话 hook 若读它会把前台会话的授权上下文写进自己 systemPrompt
// （不同工作目录会话串台）。与 projection/provider 一样随 dropRuntimeCachesForSession
// 统一清理，LRU 逐出时自动释放。
const runtimeBasePrompts = new Map<string, string>()
// LRU 访问序：id → 单调递增访问计数。get/set 即刷新，溢出时逐出最小计数者。
let runtimeAccessCounter = 0
const runtimeAccessOrder = new Map<string, number>()

// 运行时缓存丢弃（LRU 逐出 / 删会话）的监听：由 agentStore 装配时注册，用于
// 同步清理 workspaceActions 的 sessionWorkspacePaths 等模块级映射——本模块不能
// 直接 import 它（workspaceActions 已依赖 runtimeCaches，会形成环）。
let runtimeEvictionListener: ((id: string) => void) | undefined

export const setRuntimeEvictionListener = (listener: (id: string) => void): void => {
  runtimeEvictionListener = listener
}

const touchRuntime = (id: string): void => {
  runtimeAccessCounter += 1
  runtimeAccessOrder.set(id, runtimeAccessCounter)
}

const evictIfOverflow = (): void => {
  while (runtimeSessions.size > MAX_CACHED_RUNTIME_SESSIONS) {
    let evictId: string | undefined
    let oldest = Number.POSITIVE_INFINITY
    for (const [id, access] of runtimeAccessOrder) {
      const harness = runtimeSessions.get(id)
      if (!harness || harness.isRunning) continue
      if (access < oldest) {
        oldest = access
        evictId = id
      }
    }
    // 超限但全部非空闲会话都在运行中：不能安全逐出，停止本次收敛
    if (!evictId) return
    runtimeAccessOrder.delete(evictId)
    const removed = dropRuntimeCachesForSession(evictId)
    const disposable = removed as { dispose?: () => Promise<void> | void } | undefined
    const disposeResult = disposable?.dispose?.()
    if (disposeResult) void Promise.resolve(disposeResult).catch(() => undefined)
  }
}

export const getRuntimeSession = (id: string): AgentHarness | undefined => {
  const harness = runtimeSessions.get(id)
  if (harness) touchRuntime(id)
  return harness
}

export const setRuntimeSession = (id: string, harness: AgentHarness): void => {
  runtimeSessions.set(id, harness)
  touchRuntime(id)
  evictIfOverflow()
}

export const getRuntimeProvider = (id: string): RuntimeProviderState | undefined =>
  runtimeProviders.get(id)

export const setRuntimeProvider = (id: string, config: ProviderProfile, configuredKey: boolean): void => {
  runtimeProviders.set(id, { config: structuredClone(config), configuredKey })
}

export const getRuntimeProjection = (id: string): RuntimeProjection | undefined =>
  runtimeProjections.get(id)

export const setRuntimeProjection = (id: string, projection: RuntimeProjection): void => {
  runtimeProjections.set(id, projection)
}

export const getRuntimeBasePrompt = (id: string): string | undefined =>
  runtimeBasePrompts.get(id)

export const setRuntimeBasePrompt = (id: string, basePrompt: string): void => {
  runtimeBasePrompts.set(id, basePrompt)
}

/**
 * Whether any runtime other than `currentSessionId` is currently running.
 * Used by `send`'s failure recovery path to detect concurrent runtimes.
 */
export const hasOtherRunningRuntime = (currentSessionId: string): boolean => {
  for (const [candidateId, candidate] of runtimeSessions) {
    if (candidateId !== currentSessionId && candidate.isRunning) return true
  }
  return false
}

/**
 * Atomic removal of the four per-session caches. Returns the removed
 * AgentHarness so callers can dispose it without holding a separate reference.
 * 丢弃即通知逐出监听（幂等）：sessionWorkspacePaths 等模块级映射依赖 agentStore
 * 注册的回调保持与缓存生命周期同步，被丢弃的会话条目在此一并清理。
 */
export const dropRuntimeCachesForSession = (id: string): AgentHarness | undefined => {
  const removed = runtimeSessions.get(id)
  runtimeSessions.delete(id)
  runtimeProviders.delete(id)
  runtimeProjections.delete(id)
  runtimeBasePrompts.delete(id)
  runtimeAccessOrder.delete(id)
  runtimeEvictionListener?.(id)
  return removed
}
