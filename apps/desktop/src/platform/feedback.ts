import { invoke } from '@tauri-apps/api/core'

/**
 * 反馈上报的平台封装：命令名以字面量出现在 `invoke` 调用中，供
 * `tauri-capability-audit` 做 handler ↔ capability ↔ 前端三向漂移审计。
 * 端点与 HMAC 签名密钥都由 Rust `feedback.rs` 持有（编译期内置），本层只
 * 做表单四项的类型化转发——WebView 永远接触不到接入密钥。
 */

export type FeedbackKind = 'feature' | 'bug'

export interface FeedbackSubmission {
  kind: FeedbackKind
  title: string
  description: string
  contact: string
}

/** Pusher 采集端点响应：deduped 时无 ref（同一次提交的重试命中幂等去重）。 */
export interface FeedbackSubmitResponse {
  ok: boolean
  ref: string | null
  deduped: boolean
}

export const submitFeedback = (request: FeedbackSubmission): Promise<FeedbackSubmitResponse> =>
  invoke<FeedbackSubmitResponse>('submit_feedback', { request })
