/**
 * 模型 HTTP 传输契约（纯类型，无 Tauri/platform 依赖）。
 *
 * agent/transport 层只消费本模块定义的请求/探针形状；实际发起网络请求的实现
 * 由宿主（`platform/modelHttp.ts`）提供并经 `ProviderHost` 注入，保持 agent 层
 * 与 Tauri 解耦。WebView 只传 `providerId` + 可选 `endpoint` 覆盖，最终 URL 与
 * apiFormat 由 Rust 侧 `provider_profiles::resolve_profile` 强边界解析。
 */

export interface ModelHttpResponseMetadata {
  status: number
}

export type ModelHttpResponseObserver = (
  metadata: ModelHttpResponseMetadata,
) => void | Promise<void>

export interface ModelHttpRequest {
  requestId: string
  providerId: string
  endpoint?: string
  body: string
  secretId?: string
  timeoutMs?: number
}

export interface ModelProbeRequest {
  providerId: string
  endpoint?: string
  body: string
  secretId?: string
  timeoutMs?: number
}

export interface ModelProbeResult {
  ok: boolean
  status?: number
  message: string
}

export type ModelHttpStreamFactory = (
  request: ModelHttpRequest,
  signal: AbortSignal,
  onResponse?: ModelHttpResponseObserver,
) => AsyncIterable<Uint8Array>

export type ModelProbeFunction = (request: ModelProbeRequest) => Promise<ModelProbeResult>
