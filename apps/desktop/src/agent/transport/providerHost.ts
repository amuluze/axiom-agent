/**
 * Provider 传输运行时宿主接缝（纯接口，无 Tauri/platform 依赖）。
 *
 * agent/transport 通过本接缝消费三类宿主能力——模型 HTTP 流/探针、Keychain 密钥、
 * Provider Profile 解析（Rust 侧权威）。`platform/providerHost.ts` 提供桌面实现并在
 * 应用启动时由 `agentStore` 绑定；未绑定时回退到 reference 解析器与 fail-closed 的
 * 密钥/网络桩（浏览器 demo 模式），与 `platform/secrets.ts` 的 `requireTauri` 语义一致。
 */
import type { ModelHttpStreamFactory, ModelProbeFunction } from './modelHttpContract'
import { referenceProviderProfileParser, type ProviderProfileParser } from './providerProfile'

export interface SecretStore {
  save(key: string, value: string): Promise<void>
  has(key: string): Promise<boolean>
  migrate(sourceKey: string, targetKey: string): Promise<boolean>
  delete(key: string): Promise<void>
}

export interface ProviderHost {
  httpStream: ModelHttpStreamFactory
  probe: ModelProbeFunction
  secrets: SecretStore
  parser: ProviderProfileParser
}

let currentHost: ProviderHost | undefined

export const bindProviderHost = (host: ProviderHost): void => {
  currentHost = host
}

const desktopOnlySecrets = (): SecretStore => ({
  save: () => Promise.reject(new Error('安全密钥存储仅在 Axiom 桌面应用中可用')),
  has: () => Promise.reject(new Error('安全密钥存储仅在 Axiom 桌面应用中可用')),
  migrate: () => Promise.reject(new Error('安全密钥存储仅在 Axiom 桌面应用中可用')),
  delete: () => Promise.reject(new Error('安全密钥存储仅在 Axiom 桌面应用中可用')),
})

/** 未绑定时默认宿主：解析用 reference 实现；密钥/网络 fail-closed（浏览器 demo 不触达）。 */
const defaultHost = (): ProviderHost => ({
  parser: referenceProviderProfileParser,
  secrets: desktopOnlySecrets(),
  httpStream: () => {
    throw new Error('真实模型连接仅在 Axiom 桌面应用中可用')
  },
  probe: () => Promise.reject(new Error('Provider 连通性验证仅在 Axiom 桌面应用中可用')),
})

export const getProviderHost = (): ProviderHost => currentHost ?? defaultHost()
