import { BUILTIN_PROVIDER_REGISTRY, type ProviderRegistry } from './ProviderRegistry'
import { getProviderHost, type SecretStore } from './providerHost'
import {
  isLegacySecretIdCompatibleWithProvider,
  isKnownLegacySecretId,
  type ProviderProfile,
  type ProviderSecretMigration,
} from './providerProfile'

export interface ProviderAuthStatus {
  configured: boolean
  ready: boolean
  required: boolean
}

const providerSecretMigrationReceipt = Symbol('ProviderSecretMigrationReceipt')

export interface ProviderSecretMigrationReceipt {
  readonly sourceSecretId: string
  readonly targetSecretId: string
  readonly [providerSecretMigrationReceipt]: true
}

export class ProviderCredentialRuntime {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly injectedSecrets?: SecretStore,
  ) {}

  private get secrets(): SecretStore {
    return this.injectedSecrets ?? getProviderHost().secrets
  }

  async status(profile: ProviderProfile): Promise<ProviderAuthStatus> {
    const normalized = await this.registry.normalize(profile)
    const descriptor = this.registry.get(normalized.providerId)
    if (descriptor.auth.kind === 'none') {
      return { configured: false, ready: true, required: false }
    }
    const configured = await this.secrets.has(await this.registry.secretId(normalized))
    return {
      configured,
      ready: configured || !descriptor.auth.required,
      required: descriptor.auth.required,
    }
  }

  async save(profile: ProviderProfile, value: string): Promise<void> {
    const secretId = await this.registry.secretId(profile)
    await this.secrets.save(secretId, value)
    // 端点绑定已下沉到 Rust 侧 provider_profiles::resolve_profile（stream/probe 时强校验），
    // 不再需要前端主动登记 origin。
  }

  async delete(profile: ProviderProfile): Promise<void> {
    await this.secrets.delete(await this.registry.secretId(profile))
  }
}

class ProviderCredentialMigrationRuntime {
  private readonly authorizedReceipts = new WeakSet<ProviderSecretMigrationReceipt>()

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly injectedSecrets?: SecretStore,
  ) {}

  private get secrets(): SecretStore {
    return this.injectedSecrets ?? getProviderHost().secrets
  }

  async migrate(
    profile: ProviderProfile,
    migration: ProviderSecretMigration,
  ): Promise<ProviderSecretMigrationReceipt | null> {
    const targetSecretId = await this.registry.secretId(profile)
    if (migration.targetSecretId !== targetSecretId) {
      throw new Error('Provider Secret migration 目标与 Provider 身份不匹配')
    }
    if (!(await isLegacySecretIdCompatibleWithProvider(profile.providerId, migration.sourceSecretId))) {
      throw new Error('Provider Secret migration 来源不在授权的 legacy namespace')
    }
    const migrated = await this.secrets.migrate(migration.sourceSecretId, targetSecretId)
    if (!migrated) return null
    const receipt: ProviderSecretMigrationReceipt = Object.freeze({
      sourceSecretId: migration.sourceSecretId,
      targetSecretId,
      [providerSecretMigrationReceipt]: true as const,
    })
    this.authorizedReceipts.add(receipt)
    return receipt
  }

  async retireSource(receipt: ProviderSecretMigrationReceipt): Promise<void> {
    if (!this.authorizedReceipts.has(receipt)) {
      throw new Error('Provider Secret migration 来源未获删除授权')
    }
    if (await this.secrets.has(receipt.sourceSecretId)) {
      await this.secrets.delete(receipt.sourceSecretId)
    }
    this.authorizedReceipts.delete(receipt)
  }

  async retireLegacySource(sourceSecretId: string): Promise<void> {
    if (!(await isKnownLegacySecretId(sourceSecretId))) {
      throw new Error('Provider Secret cleanup 来源不在授权的 legacy namespace')
    }
    if (await this.secrets.has(sourceSecretId)) await this.secrets.delete(sourceSecretId)
  }
}

export const BUILTIN_PROVIDER_CREDENTIAL_MIGRATIONS = new ProviderCredentialMigrationRuntime(
  BUILTIN_PROVIDER_REGISTRY,
)
