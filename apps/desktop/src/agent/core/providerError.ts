import type { ProviderError, ProviderErrorKind } from './types'

export interface ProviderErrorInput {
  message: string
  code?: string
  type?: string
  status?: number
  /** 发起请求的 provider id，用于给出平台/区域相关的认证提示（如 Kimi 双平台）。 */
  providerId?: string
}

/** 认证失败时按 provider 给出的可操作提示；无匹配时回退到通用文案。 */
const AUTHENTICATION_PROVIDER_HINTS: Readonly<Record<string, string>> = {
  kimi: '认证失败：Kimi 开放平台与 Kimi Coding Plan 的 API Key 相互独立。若你用的是 Coding Plan 订阅，请在「Kimi Coding」配置中填入 Coding Plan Key，而非在「Kimi」中填入开放平台 Key',
  'kimi-coding': '认证失败：请确认填入的是 Kimi Coding Plan 的 Key（api.kimi.com/coding）。开放平台 Key（api.moonshot.cn）在 Coding Plan 端点不通用',
}

const matches = (value: string, patterns: RegExp[]): boolean => patterns.some((pattern) => pattern.test(value))

/**
 * 各错误类别面向用户的友好文案。`message` 保留 provider 原始技术信息，
 * `userMessage` 由展示层优先展示，便于非技术用户理解下一步该做什么。
 */
const KIND_USER_MESSAGE: Record<Exclude<ProviderErrorKind, 'unknown'>, (status?: number) => string> = {
  context_overflow: () => '对话内容超出模型上下文上限，请开启新对话或压缩上下文',
  rate_limit: (status) => status
    ? `请求过于频繁，已自动重试仍被限流（HTTP ${status}），请稍后再试`
    : '请求过于频繁，已自动重试仍被限流，请稍后再试',
  authentication: () => '模型服务认证失败，请检查 API Key 是否正确',
  invalid_request: (status) => status
    ? `请求参数无效（HTTP ${status}），请检查输入后重试`
    : '请求参数无效，请检查输入后重试',
  network: () => '网络连接失败，请检查网络后重试',
  server: (status) => status
    ? `模型服务暂时不可用（HTTP ${status}），已自动重试仍失败，请稍后重试或切换其他模型`
    : '模型服务暂时不可用，已自动重试仍失败，请稍后重试或切换其他模型',
}

export const classifyProviderError = ({
  message,
  code,
  type,
  status,
  providerId,
}: ProviderErrorInput): ProviderError => {
  const inferredStatus = status ?? (() => {
    const matched = message.match(/\bHTTP\s+(\d{3})\b/iu)
    return matched?.[1] ? Number(matched[1]) : undefined
  })()
  const haystack = [message, code, type].filter(Boolean).join(' ')
  let kind: ProviderErrorKind = 'unknown'
  if (matches(haystack, [
    /context window exceeds limit/iu,
    /context[_ ]length[_ ]exceeded/iu,
    /exceeds the context window/iu,
    /maximum context length/iu,
    /prompt is too long/iu,
    /request_too_large/iu,
    /too many tokens/iu,
    /token limit exceeded/iu,
  ])) {
    kind = 'context_overflow'
  } else if (inferredStatus === 429 || matches(haystack, [/rate[_ ]limit/iu, /too many requests/iu, /throttl/iu, /overload/iu])) {
    kind = 'rate_limit'
  } else if (inferredStatus === 401 || inferredStatus === 403 || matches(haystack, [/unauthori[sz]ed/iu, /invalid.*api.*key/iu, /authentication/iu])) {
    kind = 'authentication'
  } else if (typeof inferredStatus === 'number' && inferredStatus >= 500) {
    kind = 'server'
  } else if (typeof inferredStatus === 'number' && inferredStatus >= 400) {
    kind = 'invalid_request'
  } else if (matches(haystack, [/network/iu, /fetch failed/iu, /connection/iu, /timed? out/iu, /timeout/iu])) {
    kind = 'network'
  }
  const userMessage = kind === 'unknown'
    ? undefined
    : kind === 'authentication' && providerId && AUTHENTICATION_PROVIDER_HINTS[providerId]
      ? AUTHENTICATION_PROVIDER_HINTS[providerId]
      : KIND_USER_MESSAGE[kind](inferredStatus)
  return {
    kind,
    message,
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
    ...(inferredStatus === undefined ? {} : { status: inferredStatus }),
    retryable: kind === 'rate_limit' || kind === 'network' || kind === 'server',
    ...(userMessage ? { userMessage } : {}),
  }
}
