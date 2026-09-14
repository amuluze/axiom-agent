import type { ModelRef, ModelTransport, ProviderApiFormat } from '@/agent/core/types'
import type { ModelProbeRequest } from './modelHttpContract'
import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  type BuiltinProviderDescriptor,
} from './builtinProviderDescriptors'
import type {
  ProviderAuthDefinition,
  ProviderCapabilities,
} from './providerDefinitions'
import {
  isSecretIdCompatibleWithProviderRuntime,
  normalizeProviderProfileRuntime,
  PROVIDER_PROFILE_SCHEMA_VERSION,
  type ProviderId,
  type ProviderProfile,
  type ProviderProfileDraft,
} from './providerProfile'

export type ProviderAuthDescriptor = ProviderAuthDefinition

export interface ProviderMetadata {
  readonly providerId: ProviderId
  readonly label: string
  readonly apiFormat: ProviderApiFormat
  readonly transportVersion: string
  readonly auth: ProviderAuthDescriptor
  readonly supportedCapabilities: Readonly<ProviderCapabilities>
  readonly defaultProfile: ProviderProfileDraft
}

type ProviderRuntimeDescriptor = Omit<BuiltinProviderDescriptor, 'defaultProfile'> & {
  readonly defaultProfile: ProviderProfile
}

const providerRegistryConstruction = Symbol('ProviderRegistryConstruction')

export class ProviderRegistry {
  static readonly builtin = new ProviderRegistry(
    providerRegistryConstruction,
    BUILTIN_PROVIDER_DESCRIPTORS,
  )
  readonly mode = 'builtin-only' as const
  private readonly descriptors = new Map<ProviderId, ProviderRuntimeDescriptor>()
  private readonly metadata = new Map<ProviderId, ProviderMetadata>()

  private constructor(
    construction: typeof providerRegistryConstruction,
    values: readonly BuiltinProviderDescriptor[],
  ) {
    if (construction !== providerRegistryConstruction) {
      throw new Error('Provider Registry 只能由宿主构造')
    }
    for (const descriptor of values) {
      if (this.descriptors.has(descriptor.providerId)) {
        throw new Error(`Provider Registry 包含重复项：${descriptor.providerId}`)
      }
      const defaultProfile: ProviderProfile = {
        schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
        providerId: descriptor.providerId,
        apiFormat: descriptor.apiFormat,
        ...structuredClone(descriptor.defaultProfile),
      }
      Object.freeze(defaultProfile.capabilities)
      Object.freeze(defaultProfile)
      const auth = descriptor.auth.kind === 'api-key'
        ? Object.freeze({ ...descriptor.auth })
        : Object.freeze({ ...descriptor.auth })
      const supportedCapabilities = Object.freeze({ ...descriptor.supportedCapabilities })
      const registered = Object.freeze({
        ...descriptor,
        auth,
        supportedCapabilities,
        defaultProfile,
      })
      this.descriptors.set(descriptor.providerId, registered)
      this.metadata.set(descriptor.providerId, Object.freeze({
        providerId: registered.providerId,
        label: registered.label,
        apiFormat: registered.apiFormat,
        transportVersion: registered.transportVersion,
        auth: registered.auth,
        supportedCapabilities: registered.supportedCapabilities,
        defaultProfile: registered.defaultProfile,
      }))
    }
  }

  list(): ProviderMetadata[] {
    return [...this.metadata.values()].map((metadata) => ({
      ...metadata,
      auth: structuredClone(metadata.auth),
      supportedCapabilities: { ...metadata.supportedCapabilities },
      defaultProfile: structuredClone(metadata.defaultProfile),
    }))
  }

  get(providerId: ProviderId): ProviderMetadata {
    const metadata = this.metadata.get(providerId)
    if (!metadata) throw new Error(`Provider 未注册：${providerId}`)
    return metadata
  }

  normalize(profile: ProviderProfile): ProviderProfile {
    const normalized = normalizeProviderProfileRuntime(profile)
    const descriptor = this.getRuntimeDescriptor(normalized.providerId)
    if (descriptor.apiFormat !== normalized.apiFormat) {
      throw new Error('Provider Registry 检测到协议身份漂移')
    }
    if (normalized.secretId
      && !isSecretIdCompatibleWithProviderRuntime(normalized.providerId, normalized.secretId)) {
      throw new Error('Provider Secret ID 与 Provider 身份不匹配')
    }
    return normalized
  }

  resolveModel(profile: ProviderProfile): ModelRef {
    const normalized = this.normalize(profile)
    const descriptor = this.getRuntimeDescriptor(normalized.providerId)
    const builtin = descriptor.models.find((model) => model.modelId === normalized.modelId)
    return {
      provider: normalized.providerId === 'demo' ? 'axiom' : normalized.providerId,
      model: normalized.modelId,
      // 优先使用模型目录中的准确 contextWindow（providers.json 每模型独立标注）。
      // profile.contextWindow 默认为 provider 级值（多为 128K），对 phi4(16K)/gemini(1M)
      // 等模型不准确；自定义模型（不在目录中）回退 profile 值。
      contextWindow: builtin?.contextWindow ?? normalized.contextWindow,
      maxOutputTokens: normalized.maxOutputTokens,
      // 目录内模型按目录标注；目录外模型能力未知 → input 省略（不硬编码 ['text']）：
      // streamAssistantMessage 的图片硬闸只在 input 已声明且缺 image 时拦截，省略即
      // 不误伤多模态自定义模型；工具侧 modelAcceptsImage 对未知 input 仍默认 false，
      // 截图降级保持保守。
      input: builtin?.input.slice(),
      supportsReasoning: builtin?.supportsReasoning ?? false,
    }
  }

  /**
   * 返回当前 modelId 在内置 model catalog 中的显示名 label；demo 或 catalog 之外
   * 的自定义 modelId 返回 undefined。供提示词模型身份行在 profile.modelName 为空时
   * 回退默认显示名（见 provider.ts resolvePromptModelName）。
   */
  resolveModelLabel(profile: ProviderProfile): string | undefined {
    const normalized = this.normalize(profile)
    if (normalized.providerId === 'demo') return undefined
    const descriptor = this.getRuntimeDescriptor(normalized.providerId)
    return descriptor.models.find((model) => model.modelId === normalized.modelId)?.label
  }

  createTransport(profile: ProviderProfile, hasKey: boolean): {
    transport: ModelTransport
    model: ModelRef
  } {
    const normalized = this.normalize(profile)
    const descriptor = this.getRuntimeDescriptor(normalized.providerId)
    this.assertAuthentication(descriptor, hasKey)
    const secretId = hasKey ? this.secretId(normalized) : undefined
    return {
      transport: descriptor.createTransport(normalized, secretId),
      model: this.resolveModel(normalized),
    }
  }

  createProbe(profile: ProviderProfile, hasKey: boolean): ModelProbeRequest {
    const normalized = this.normalize(profile)
    const descriptor = this.getRuntimeDescriptor(normalized.providerId)
    if (!descriptor.createProbe) throw new Error('离线 Demo 不需要连通性验证')
    this.assertAuthentication(descriptor, hasKey)
    // Anthropic 的 /v1/messages path 补全下沉到 Rust 侧 provider_profiles::resolve_profile。
    return descriptor.createProbe(
      normalized,
      hasKey ? this.secretId(normalized) : undefined,
    )
  }

  secretId(profile: ProviderProfile): string {
    const normalized = this.normalize(profile)
    const descriptor = this.get(normalized.providerId)
    if (descriptor.auth.kind === 'none') {
      throw new Error('离线 Demo 没有 Secret ID')
    }
    const secretId = normalized.secretId ?? descriptor.auth.defaultSecretId
    if (!isSecretIdCompatibleWithProviderRuntime(normalized.providerId, secretId)) {
      throw new Error('Provider Secret ID 与 Provider 身份不匹配')
    }
    return secretId
  }

  private getRuntimeDescriptor(providerId: ProviderId): ProviderRuntimeDescriptor {
    const descriptor = this.descriptors.get(providerId)
    if (!descriptor) throw new Error(`Provider 未注册：${providerId}`)
    return descriptor
  }

  private assertAuthentication(descriptor: ProviderMetadata, hasKey: boolean): void {
    if (descriptor.auth.kind === 'api-key' && descriptor.auth.required && !hasKey) {
      throw new Error(`${descriptor.label} 缺少必需的 API Key`)
    }
  }

}

export const BUILTIN_PROVIDER_REGISTRY = ProviderRegistry.builtin
