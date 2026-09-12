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
  bindDefaultHttpStream(modelHttpByteStream)
  return {
    httpStream: modelHttpByteStream,
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
