import type {
  JsonValue,
  ModelRequest,
  ModelTransportLifecycle,
  ProviderApiFormat,
} from '@/agent/core/types'

const MAX_PROVIDER_PAYLOAD_BYTES = 2 * 1024 * 1024
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 300_000

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

const normalizeTimeout = (value: number | undefined, fallback: number | undefined): number | undefined => {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) throw new Error('Provider Hook 返回了无效 timeoutMs')
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)))
}

const normalizePayload = (payload: JsonValue): { payload: JsonValue; body: string } => {
  let body: string
  try {
    body = JSON.stringify(payload)
  } catch {
    throw new Error('Provider Payload Hook 返回了不可序列化的 JSON')
  }
  if (body === undefined) throw new Error('Provider Payload Hook 返回了无效 JSON')
  if (byteLength(body) > MAX_PROVIDER_PAYLOAD_BYTES) {
    throw new Error('Provider Payload Hook 返回的请求体超过 2 MiB 安全上限')
  }
  return { payload: JSON.parse(body) as JsonValue, body }
}

const assertProtocolIdentity = (payload: JsonValue, request: ModelRequest): void => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Provider Payload Hook 必须返回 JSON 对象')
  }
  if (payload.model !== request.model.model) {
    throw new Error('Provider Payload Hook 不能修改模型身份')
  }
  if (payload.stream !== true) {
    throw new Error('Provider Payload Hook 不能关闭流式响应')
  }
}

export interface PrepareProviderRequestOptions {
  request: ModelRequest
  apiFormat: ProviderApiFormat
  endpoint: string
  timeoutMs?: number
  payload: JsonValue
  lifecycle?: ModelTransportLifecycle
  signal: AbortSignal
}

export interface PreparedProviderRequest {
  body: string
  timeoutMs?: number
}

export const prepareProviderRequest = async ({
  request,
  apiFormat,
  endpoint,
  timeoutMs,
  payload,
  lifecycle,
  signal,
}: PrepareProviderRequestOptions): Promise<PreparedProviderRequest> => {
  const identity = {
    sessionId: request.sessionId,
    runId: request.runId,
    model: structuredClone(request.model),
    apiFormat,
    endpoint,
    signal,
  }
  const requestResult = await lifecycle?.beforeRequest?.({ ...identity, timeoutMs })
  const effectiveTimeoutMs = normalizeTimeout(requestResult?.timeoutMs, timeoutMs)
  const initial = normalizePayload(payload)
  assertProtocolIdentity(initial.payload, request)
  const payloadResult = await lifecycle?.beforePayload?.({
    ...identity,
    timeoutMs: effectiveTimeoutMs,
    payload: structuredClone(initial.payload),
  })
  const prepared = normalizePayload(payloadResult?.payload ?? initial.payload)
  assertProtocolIdentity(prepared.payload, request)
  return { body: prepared.body, timeoutMs: effectiveTimeoutMs }
}

export const notifyProviderResponse = async (
  lifecycle: ModelTransportLifecycle | undefined,
  request: ModelRequest,
  apiFormat: ProviderApiFormat,
  endpoint: string,
  status: number,
  signal: AbortSignal,
): Promise<void> => lifecycle?.afterResponse?.({
  sessionId: request.sessionId,
  runId: request.runId,
  model: structuredClone(request.model),
  apiFormat,
  endpoint,
  status,
  signal,
})
