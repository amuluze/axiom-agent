import { buildSendManifest, type SendManifest } from '@/agent/context/sendManifest'
import type { ModelHttpRequest } from '@/agent/transport/modelHttpContract'

/**
 * 发送清单投递口：平台在真实发送前算出清单，经这里交给宿主（store）投影到 UI。
 * 平台层不依赖 stores，因此由消费方（agentStore）注册 sink；未注册时仅丢弃。
 */
type SendManifestSink = (manifest: SendManifest) => void

let sink: SendManifestSink | undefined

export const setSendManifestSink = (next: SendManifestSink | undefined): void => {
  sink = next
}

/** 从实际发送的请求体生成清单并投递（解析失败也会给出字节数）。 */
export const publishSendManifest = (
  request: ModelHttpRequest,
  runtime: Partial<Pick<SendManifest, 'retryCount' | 'credentialScan'>> = {},
): void => {
  if (!sink) return
  sink({
    ...buildSendManifest({
      requestId: request.requestId,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      providerId: request.providerId,
      body: request.body,
    }),
    ...runtime,
  })
}
