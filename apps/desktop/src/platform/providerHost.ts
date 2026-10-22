import type { ProviderHost } from '@/agent/transport/providerHost'
import { bindDefaultHttpStream } from '@/agent/transport/httpStreamBinding'
import {
  modelHttpByteStream,
  probeModelHttp,
} from '@/platform/modelHttp'
import { createRustProviderProfileParser } from '@/platform/providerProfile'
import {
  deleteSecret,
  hasSecret,
  migrateSecret,
  saveSecret,
} from '@/platform/secrets'

/** 桌面宿主实现：模型 HTTP 流/探针、Keychain 密钥、Rust 权威 Profile 解析。 */
export const createDesktopProviderHost = (): ProviderHost => {
  // 传输层默认流经 httpStreamBinding 注入（避免 transport → providerHost 循环依赖）。
  // 发送清单在真正 invoke 之前从最终请求体生成，因此与上线报文一致。
  const httpStream = async function* (
    request: Parameters<typeof modelHttpByteStream>[0],
    signal: AbortSignal,
    onResponse?: Parameters<typeof modelHttpByteStream>[2],
  ): ReturnType<typeof modelHttpByteStream> {
    yield* modelHttpByteStream(request, signal, onResponse)
  }
  bindDefaultHttpStream(httpStream)
  return {
    httpStream,
    probe: probeModelHttp,
    secrets: {
      save: saveSecret,
      has: hasSecret,
      migrate: migrateSecret,
      delete: deleteSecret,
    },
    parser: createRustProviderProfileParser(),
  }
}
