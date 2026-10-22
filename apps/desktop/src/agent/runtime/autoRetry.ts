/**
 * 自动重试策略（自 AgentSession 抽出的纯策略层）。
 *
 * 覆盖三件事：把用户配置归一为可执行参数、退避等待（响应 abort）、以及
 * 「哪些失败允许自动重试」的安全门槛。不含会话状态，AgentSession 单向消费。
 */
import type { AgentMessage, AssistantMessage } from '@/agent/core/types'

export interface AgentAutoRetryOptions {
  enabled?: boolean
  /** Number of automatic retries after the original failed request. */
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

export interface ResolvedAutoRetryOptions {
  enabled: boolean
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_AUTO_RETRY: ResolvedAutoRetryOptions = {
  enabled: true,
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
}

export const resolveAutoRetryOptions = (
  options?: AgentAutoRetryOptions,
): ResolvedAutoRetryOptions => {
  const resolved = { ...DEFAULT_AUTO_RETRY, ...options }
  if (!Number.isInteger(resolved.maxRetries) || resolved.maxRetries < 0) {
    throw new Error('autoRetry.maxRetries 必须是非负整数')
  }
  if (!Number.isFinite(resolved.baseDelayMs) || resolved.baseDelayMs < 0) {
    throw new Error('autoRetry.baseDelayMs 必须是非负数')
  }
  if (!Number.isFinite(resolved.maxDelayMs) || resolved.maxDelayMs < resolved.baseDelayMs) {
    throw new Error('autoRetry.maxDelayMs 不能小于 baseDelayMs')
  }
  return resolved
}

export const waitForRetryDelay = (delayMs: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  if (delayMs === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, delayMs)
    const abort = (): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

export const isSafeAutoRetryFailure = (
  message: AgentMessage | undefined,
): message is AssistantMessage =>
  message?.role === 'assistant'
  && message.stopReason === 'error'
  && message.providerError?.retryable === true
  // rate_limit 不再触发前端二次自动重试：Rust model_http 已对 429 退避重试最多 5 次，
  // 幸存 429 应直接呈现给用户，避免再向已限流的 provider 追加请求。
  && message.providerError?.kind !== 'rate_limit'
  && message.excludeFromModelContext === true
  && message.toolCalls.length === 0
  && message.content.length === 0
  && !message.contentBlocks?.some((block) => block.type === 'thinking')
