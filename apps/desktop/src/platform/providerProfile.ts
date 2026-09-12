import { invoke } from '@tauri-apps/api/core'
import type {
  DecodedProviderProfile,
  LegacyProviderConfig,
  ProviderProfile,
  ProviderProfileDraft,
  ProviderProfileParser,
  ProviderSecretMigration,
  ProviderId,
} from '@/agent/transport/providerProfile'
import { isTauriRuntime } from './environment'

const requireTauri = (): void => {
  if (!isTauriRuntime()) throw new Error('Provider Profile 解析仅在 Axiom 桌面应用中可用')
}

interface ProfileDecodeResult {
  profile: ProviderProfile
  requiresPersistenceMigration: boolean
  secretMigration?: ProviderSecretMigration
}

/**
 * Rust 侧强边界解析器（`provider_profiles.rs` 权威源）。
 *
 * 浏览器/离线测试模式 fail-closed 抛错（与 `platform/secrets.ts` 的 `requireTauri`
 * 语义一致）；agent 层在宿主未绑定时经 `providerHost.ts` 回退到 reference 解析器。
 */
const rustProviderProfileParser: ProviderProfileParser = {
  decodeWithMetadata: async (value: unknown): Promise<DecodedProviderProfile> => {
    requireTauri()
    return invoke<ProfileDecodeResult>('decode_provider_profile', { raw: value })
  },
  decode: async (value: unknown): Promise<ProviderProfile> => {
    const decoded = await rustProviderProfileParser.decodeWithMetadata(value)
    return decoded.profile
  },
  normalizeDraft: async (draft: ProviderProfileDraft): Promise<ProviderProfile> => {
    requireTauri()
    return invoke<ProviderProfile>('normalize_provider_profile_draft', { draft })
  },
  migrateLegacyConfig: async (config: LegacyProviderConfig): Promise<ProviderProfile> => {
    const decoded = await rustProviderProfileParser.decodeWithMetadata(config)
    return decoded.profile
  },
  isSecretIdCompatibleWithProvider: async (
    providerId: ProviderId,
    secretId: string,
  ): Promise<boolean> => {
    requireTauri()
    return invoke<boolean>('is_provider_secret_compatible', { providerId, secretId })
  },
  isLegacySecretIdCompatibleWithProvider: async (
    providerId: ProviderId,
    secretId: string,
  ): Promise<boolean> => {
    requireTauri()
    return invoke<boolean>('is_legacy_provider_secret_compatible', { providerId, secretId })
  },
  isKnownLegacySecretId: async (secretId: string): Promise<boolean> => {
    requireTauri()
    return invoke<boolean>('is_known_legacy_provider_secret', { secretId })
  },
}

export const createRustProviderProfileParser = (): ProviderProfileParser =>
  rustProviderProfileParser
