import type { ModelProbeRequest } from './modelHttpContract'
import type { ModelRef, ModelTransport } from '@/agent/core/types'
import {
  BUILTIN_PROVIDER_REGISTRY,
  type ProviderMetadata,
  type ProviderRegistry,
} from './ProviderRegistry'
import { ProviderCredentialRuntime } from './ProviderCredentialRuntime'
import type { ProviderId, ProviderProfile } from './providerProfile'

export type { ProviderAuthDescriptor, ProviderMetadata } from './ProviderRegistry'
export type { ProviderSecretMigrationReceipt } from './ProviderCredentialRuntime'

const providerRuntimeConstruction = Symbol('ProviderRuntimeConstruction')

export class ProviderRuntime {
  static readonly builtin = new ProviderRuntime(
    providerRuntimeConstruction,
    BUILTIN_PROVIDER_REGISTRY,
  )
  readonly mode = 'builtin-only' as const
  readonly transportOwnership = 'host' as const
  readonly credentials: ProviderCredentialRuntime

  private constructor(
    construction: typeof providerRuntimeConstruction,
    private readonly registry: ProviderRegistry,
  ) {
    if (construction !== providerRuntimeConstruction) {
      throw new Error('Provider Runtime 只能由宿主构造')
    }
    this.credentials = new ProviderCredentialRuntime(registry)
  }

  listProviders(): ProviderMetadata[] {
    return this.registry.list()
  }

  getProvider(providerId: ProviderId): ProviderMetadata {
    return this.registry.get(providerId)
  }

  createTransport(profile: ProviderProfile, configured: boolean): {
    transport: ModelTransport
    model: ModelRef
  } {
    return this.registry.createTransport(profile, configured)
  }

  createProbe(profile: ProviderProfile, configured: boolean): ModelProbeRequest {
    return this.registry.createProbe(profile, configured)
  }

  normalize(profile: ProviderProfile): ProviderProfile {
    return this.registry.normalize(profile)
  }

  resolveModel(profile: ProviderProfile): ModelRef {
    return this.registry.resolveModel(profile)
  }

  resolveModelLabel(profile: ProviderProfile): string | undefined {
    return this.registry.resolveModelLabel(profile)
  }

  secretId(profile: ProviderProfile): string {
    return this.registry.secretId(profile)
  }
}

export const BUILTIN_PROVIDER_RUNTIME = ProviderRuntime.builtin
