import type {
  AgentMessage,
  AssistantMessageDiagnostic,
  AssistantContentBlock,
  CacheControl,
  ImageContentBlock,
  JsonValue,
  TokenUsage,
  ToolResultContentBlock,
  UserContentBlock,
} from '@/agent/core/types'
import { normalizeAssistantMessage } from '@/agent/core/messages'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

const isArtifactReference = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  const contentHash = typeof value.contentHash === 'string' ? value.contentHash : ''
  return typeof value.id === 'string'
    && value.id === `sha256:${contentHash}`
    && ['text', 'json', 'image'].includes(String(value.kind))
    && typeof value.mediaType === 'string'
    && typeof value.relativePath === 'string'
    && value.relativePath === `artifacts/sha256/${contentHash.slice(0, 2)}/${contentHash}`
    && /^[0-9a-f]{64}$/u.test(contentHash)
    && typeof value.sizeBytes === 'number'
    && Number.isSafeInteger(value.sizeBytes)
    && value.sizeBytes >= 0
    && typeof value.createdAt === 'number'
}

const isCacheControl = (value: unknown): value is CacheControl => isRecord(value)
  && value.type === 'ephemeral'
  && (value.ttl === undefined || value.ttl === '5m' || value.ttl === '1h')

const hasValidCacheControl = (value: Record<string, unknown>): boolean =>
  value.cacheControl === undefined || isCacheControl(value.cacheControl)

const isTextContentBlock = (value: unknown): boolean => isRecord(value)
  && value.type === 'text'
  && typeof value.text === 'string'
  && (value.textSignature === undefined || typeof value.textSignature === 'string')
  && hasValidCacheControl(value)

const isImageContentBlock = (value: unknown): value is ImageContentBlock => {
  if (!isRecord(value) || value.type !== 'image' || !isRecord(value.source) || !hasValidCacheControl(value)) {
    return false
  }
  if (value.source.type === 'base64') {
    return typeof value.source.mediaType === 'string'
      && typeof value.source.data === 'string'
  }
  return value.source.type === 'url' && typeof value.source.url === 'string'
}

const isThinkingContentBlock = (value: unknown): boolean => isRecord(value)
  && value.type === 'thinking'
  && typeof value.thinking === 'string'
  && (value.thinkingSignature === undefined || typeof value.thinkingSignature === 'string')
  && (value.signature === undefined || typeof value.signature === 'string')
  && (value.redacted === undefined || typeof value.redacted === 'boolean')

const isToolCall = (value: unknown): boolean => isRecord(value)
  && typeof value.id === 'string'
  && typeof value.name === 'string'
  && typeof value.rawArguments === 'string'
  && isJsonValue(value.arguments)
  && (value.argumentError === undefined || typeof value.argumentError === 'string')
  && (value.thoughtSignature === undefined || typeof value.thoughtSignature === 'string')

const isToolCallContentBlock = (value: unknown): boolean => isRecord(value)
  && value.type === 'tool_call'
  && isToolCall(value)

const isUserContentBlock = (value: unknown): value is UserContentBlock =>
  isTextContentBlock(value) || isImageContentBlock(value)

const isAssistantContentBlock = (value: unknown): value is AssistantContentBlock =>
  isTextContentBlock(value) || isThinkingContentBlock(value) || isToolCallContentBlock(value)

const isToolResultContentBlock = (value: unknown): value is ToolResultContentBlock =>
  isTextContentBlock(value) || isImageContentBlock(value)

const isContentBlocks = <T>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
): value is T[] => Array.isArray(value) && value.every(predicate)

const isUniqueStringArray = (value: unknown): value is string[] => Array.isArray(value)
  && value.every((entry) => typeof entry === 'string' && entry.length > 0)
  && new Set(value).size === value.length

const isTokenUsage = (value: unknown): value is TokenUsage => {
  if (!isRecord(value)) return false
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0) return false
  }
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'cacheWrite1hTokens', 'reasoningTokens'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0)) {
      return false
    }
  }
  if (value.cost !== undefined) {
    if (!isRecord(value.cost)) return false
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
      if (typeof value.cost[key] !== 'number' || !Number.isFinite(value.cost[key]) || value.cost[key] < 0) {
        return false
      }
    }
  }
  return true
}

const isDiagnosticError = (value: unknown): boolean => isRecord(value)
  && typeof value.message === 'string'
  && (value.name === undefined || typeof value.name === 'string')
  && (value.stack === undefined || typeof value.stack === 'string')
  && (value.code === undefined || typeof value.code === 'string' || typeof value.code === 'number')

const isAssistantDiagnostic = (value: unknown): value is AssistantMessageDiagnostic => isRecord(value)
  && typeof value.type === 'string'
  && typeof value.timestamp === 'number'
  && Number.isFinite(value.timestamp)
  && (value.error === undefined || isDiagnosticError(value.error))
  && (value.details === undefined || (isRecord(value.details) && isJsonValue(value.details)))

const isProviderError = (value: unknown): boolean => isRecord(value)
  && [
    'context_overflow',
    'rate_limit',
    'authentication',
    'invalid_request',
    'network',
    'server',
    'unknown',
  ].includes(String(value.kind))
  && typeof value.message === 'string'
  && typeof value.retryable === 'boolean'
  && (value.code === undefined || typeof value.code === 'string')
  && (value.type === undefined || typeof value.type === 'string')
  && (value.status === undefined || typeof value.status === 'number')

export const isAgentMessage = (value: unknown): value is AgentMessage => {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.createdAt !== 'number') {
    return false
  }
  if (value.role === 'user') {
    return typeof value.content === 'string'
      && (value.contentBlocks === undefined || isContentBlocks(value.contentBlocks, isUserContentBlock))
  }
  if (value.role === 'custom') {
    return typeof value.customType === 'string'
      && typeof value.content === 'string'
      && (value.data === undefined || isJsonValue(value.data))
  }
  if (value.role === 'tool') {
    return typeof value.toolCallId === 'string'
      && typeof value.toolName === 'string'
      && typeof value.content === 'string'
      && typeof value.isError === 'boolean'
      && (value.contentBlocks === undefined || isContentBlocks(value.contentBlocks, isToolResultContentBlock))
      && (value.details === undefined || isJsonValue(value.details))
      && (value.artifact === undefined || isArtifactReference(value.artifact))
      && (value.artifactError === undefined || typeof value.artifactError === 'string')
      && (value.addedToolNames === undefined || isUniqueStringArray(value.addedToolNames))
      && !(value.isError === true && Array.isArray(value.addedToolNames) && value.addedToolNames.length > 0)
  }
  if (value.role !== 'assistant' || typeof value.content !== 'string' || !Array.isArray(value.toolCalls)) {
    return false
  }
  const validStopReason = ['stop', 'tool_use', 'length', 'error', 'aborted'].includes(String(value.stopReason))
  return validStopReason
    && (value.contentBlocks === undefined || isContentBlocks(value.contentBlocks, isAssistantContentBlock))
    && (value.usage === undefined || isTokenUsage(value.usage))
    && (value.providerError === undefined || isProviderError(value.providerError))
    && (value.provider === undefined || typeof value.provider === 'string')
    && (value.model === undefined || typeof value.model === 'string')
    && (value.responseId === undefined || typeof value.responseId === 'string')
    && (value.responseModel === undefined || typeof value.responseModel === 'string')
    && (value.errorMessage === undefined || typeof value.errorMessage === 'string')
    && (value.excludeFromModelContext === undefined || typeof value.excludeFromModelContext === 'boolean')
    && (value.diagnostics === undefined
      || (Array.isArray(value.diagnostics) && value.diagnostics.every(isAssistantDiagnostic)))
    && value.toolCalls.every(isToolCall)
}

const normalizeAgentMessage = (message: AgentMessage): AgentMessage => message.role === 'assistant'
  ? normalizeAssistantMessage(message)
  : message

/**
 * 消息 codec 显式版本标记。编码在消息 JSON 顶层写入 codecVersion，
 * decode 校验版本、剥离标记后再结构校验。Rust 侧只读取 content_json
 * 的顶层 id/role/createdAt/content 字段，多余字段不构成破坏；
 * 旧库中的无版本 legacy 消息仍按原格式兼容解码。
 */
const MESSAGE_CODEC_VERSION = 1

export const encodeAgentMessage = (message: AgentMessage): string => JSON.stringify({
  codecVersion: MESSAGE_CODEC_VERSION,
  ...normalizeAgentMessage(message),
})

export const decodeAgentMessage = (encoded: string): AgentMessage => {
  let parsed: unknown
  try {
    parsed = JSON.parse(encoded)
  } catch {
    throw new Error('SQLite 中存在无法解析的 Agent 消息')
  }
  if (!isRecord(parsed)) throw new Error('SQLite 中存在格式无效的 Agent 消息')
  if (parsed.codecVersion !== undefined) {
    if (parsed.codecVersion !== MESSAGE_CODEC_VERSION) {
      throw new Error(`SQLite 中存在不支持的 Agent 消息 codec 版本：${String(parsed.codecVersion)}`)
    }
    const { codecVersion: _codecVersion, ...message } = parsed
    parsed = message
  }
  if (!isAgentMessage(parsed)) throw new Error('SQLite 中存在格式无效的 Agent 消息')
  return normalizeAgentMessage(parsed)
}
