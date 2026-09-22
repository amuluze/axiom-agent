/**
 * 模型 HTTP 传输契约（纯类型，无 Tauri/platform 依赖）。
 *
 * agent/transport 层只消费本模块定义的请求/探针形状；实际发起网络请求的实现
 * 由宿主（`platform/modelHttp.ts`）提供并经 `ProviderHost` 注入，保持 agent 层
 * 与 Tauri 解耦。WebView 只传 `providerId` + 可选 `endpoint` 覆盖 + `modelId`，
 * 最终 URL 与 apiFormat 由 Rust 侧 `provider_profiles::resolve_profile` 强边界解析。
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
  /**
   * 本次请求使用的模型：多协议 provider（模型级 wire，如 OpenCode Go 的
   * chat / responses / messages）据此选择协议与端点。仅作查表键——最终 URL 与
   * apiFormat 仍由 Rust 权威解析，未知模型回落 provider 默认协议。
   */
  modelId?: string
  /** 会话身份：仅用于 provider 声明的会话头（如 `x-opencode-session`）按会话归因。 */
  sessionId?: string
}

export interface ModelProbeRequest {
  providerId: string
  endpoint?: string
  body: string
  secretId?: string
  timeoutMs?: number
  modelId?: string
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
