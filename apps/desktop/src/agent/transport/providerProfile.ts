import type { ProviderApiFormat } from '@/agent/core/types'
import {
  getProviderDefinition,
  isProviderId,
  type ProviderCapabilities,
  type ProviderId,
} from './providerDefinitions'
import { PROVIDER_CONSTANTS, PROVIDER_DATA } from './generatedProviderData'
import { getProviderHost } from './providerHost'

export type { ProviderCapabilities, ProviderId } from './providerDefinitions'

const PREVIOUS_PROVIDER_PROFILE_SCHEMA_VERSION = 3 as const
export const PROVIDER_PROFILE_SCHEMA_VERSION = 4 as const
// v2 是最后一个使用 legacy secret 前缀的版本：只有 v2 文档需要 secretId
// 迁移（legacy 前缀 → 当前 namespace）；v3 起文档已持有当前 namespace。
const SECRET_MIGRATION_SCHEMA_VERSION = 2 as const

export interface ProviderProfile {
  schemaVersion: typeof PROVIDER_PROFILE_SCHEMA_VERSION
  profileId: string
  providerId: ProviderId
  apiFormat: ProviderApiFormat
  endpoint: string
  modelId: string
  modelName?: string
  website?: string
  timeoutMs: number
  maxOutputTokens: number
  contextWindow: number
  capabilities: ProviderCapabilities
  secretId?: string
}

export interface ProviderProfileDraft extends Omit<ProviderProfile, 'modelId'> {
  modelId?: string
}

export interface LegacyProviderConfig {
  kind: 'demo' | 'openai-compatible' | 'openai-responses' | 'anthropic-compatible'
  endpoint: string
  model: string
  timeoutMs: number
  maxTokens: number
  contextWindow: number
  supportsToolReferences?: boolean
  supportsToolSearch?: boolean
  secretId?: string
}

const LEGACY_KINDS = new Set<LegacyProviderConfig['kind']>([
  'demo',
  'openai-compatible',
  'openai-responses',
  'anthropic-compatible',
])

const LEGACY_SECRET_IDS_BY_PROVIDER: Partial<Record<ProviderId, readonly string[]>> =
  Object.fromEntries(
    PROVIDER_DATA
      .filter((provider) => provider.legacySecretIdPrefixes.length > 0)
      .map((provider) => [provider.id, provider.legacySecretIdPrefixes]),
  )

const legacySecretIds = (providerId: ProviderId): readonly string[] =>
  LEGACY_SECRET_IDS_BY_PROVIDER[providerId] ?? []

const isLegacySecretIdCompatibleWithProviderImpl = (
  providerId: ProviderId,
  secretId: string,
): boolean => legacySecretIds(providerId).some((base) => (
  secretId === base || secretId.startsWith(`${base}.`)
))

const isKnownLegacySecretIdImpl = (secretId: string): boolean =>
  Object.keys(LEGACY_SECRET_IDS_BY_PROVIDER).some((providerId) => (
    isLegacySecretIdCompatibleWithProviderImpl(providerId as ProviderId, secretId)
  ))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const assertExactFields = (value: Record<string, unknown>, allowed: string[], label: string): void => {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new Error(`${label} 包含未知字段：${unexpected.join(', ')}`)
}

const boundedInteger = (value: number, fallback: number, minimum: number, maximum: number): number => {
  const normalized = Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(maximum, Math.max(minimum, normalized))
}

const legacyProviderId = (config: LegacyProviderConfig): ProviderId => {
  if (config.kind === 'demo') return 'demo'
  if (config.kind === 'openai-compatible') return 'generic-openai-compatible'
  if (config.kind === 'openai-responses') return 'openai'
  // 旧版 minimax 内置入口已移除。曾持久化为 minimax 的旧会话（无论经
  // legacy kind 还是 schema v2/v3 的 providerId）统一降级为
  // generic-anthropic-compatible：endpoint 与 modelId 原样保留，用户无需
  // 重新配置即可继续使用，仅在身份层面脱钩内置 minimax provider。
  return 'generic-anthropic-compatible'
}

const currentSecretIds = (providerId: ProviderId): string[] => {
  const { auth } = getProviderDefinition(providerId)
  if (auth.kind === 'none') return []
  return [auth.defaultSecretId]
}

const isSecretIdCompatibleWithProviderImpl = (providerId: ProviderId, secretId: string): boolean =>
  currentSecretIds(providerId).some((base) => (
    secretId === base || secretId.startsWith(`${base}.`)
  ))

const migrateSecretIdImpl = (providerId: ProviderId, value: string | undefined): string | undefined => {
  const auth = getProviderDefinition(providerId).auth
  if (auth.kind === 'none') return undefined
  const secretId = value ?? auth.defaultSecretId
  for (const legacySecretId of legacySecretIds(providerId)) {
    if (secretId === legacySecretId) return auth.defaultSecretId
    if (secretId.startsWith(`${legacySecretId}.`)) {
      return `${auth.defaultSecretId}${secretId.slice(legacySecretId.length)}`
    }
  }
  return secretId
}

const normalizeSecretIdImpl = (
  providerId: ProviderId,
  value: string | undefined,
): string | undefined => {
  if (providerId === 'demo') return undefined
  const auth = getProviderDefinition(providerId).auth
  if (auth.kind === 'none') return undefined
  const secretId = value?.trim() || auth.defaultSecretId
  if (!secretId || secretId.length > PROVIDER_CONSTANTS.identifierMaxBytes || !/^[A-Za-z0-9._-]+$/.test(secretId)) {
    throw new Error('Provider Secret ID 无效')
  }
  if (!isSecretIdCompatibleWithProviderImpl(providerId, secretId)) {
    throw new Error('Provider Secret ID 与 Provider 身份不匹配')
  }
  return secretId
}

const migrateLegacyProviderConfigImpl = (config: LegacyProviderConfig): ProviderProfile => {
  if (!LEGACY_KINDS.has(config.kind)) throw new Error('不支持的旧版 Provider 协议')
  const providerId = legacyProviderId(config)
  const definition = getProviderDefinition(providerId)
  return normalizeProviderProfileDraftImpl({
    schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
    profileId: `migrated.${providerId}`,
    providerId,
    apiFormat: definition.apiFormat,
    endpoint: config.endpoint,
    modelId: config.model,
    timeoutMs: config.timeoutMs,
    maxOutputTokens: config.maxTokens,
    contextWindow: config.contextWindow,
    capabilities: {
      toolReferences: config.supportsToolReferences === true,
      toolSearch: config.supportsToolSearch === true,
    },
    ...(config.secretId ? { secretId: migrateSecretIdImpl(providerId, config.secretId) } : {}),
  })
}

const normalizeProviderProfileDraftImpl = (profile: ProviderProfileDraft): ProviderProfile => {
  if (profile?.schemaVersion !== PROVIDER_PROFILE_SCHEMA_VERSION) {
    throw new Error('不支持的 Provider Profile 版本')
  }
  if (!isProviderId(profile.providerId)) throw new Error('不支持的 Provider')
  const definition = getProviderDefinition(profile.providerId)
  if (profile.apiFormat !== definition.apiFormat) {
    throw new Error('Provider 身份与 API 格式不匹配')
  }
  const profileId = profile.profileId.trim()
  if (!profileId || profileId.length > PROVIDER_CONSTANTS.identifierMaxBytes || !/^[A-Za-z0-9._-]+$/.test(profileId)) {
    throw new Error('Provider Profile ID 无效')
  }
  if (profile.providerId === 'demo') {
    return {
      schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
      profileId: 'builtin.demo',
      providerId: 'demo',
      apiFormat: 'demo',
      endpoint: '',
      modelId: 'demo-v1',
      timeoutMs: 60_000,
      maxOutputTokens: 4_096,
      contextWindow: 128_000,
      capabilities: { toolReferences: false, toolSearch: false },
    }
  }
  const endpoint = profile.endpoint.trim()
  const modelId = profile.modelId?.trim() ?? ''
  const modelName = profile.modelName?.trim() ?? ''
  const website = profile.website?.trim() ?? ''
  if (!endpoint) throw new Error('模型 Endpoint 不能为空')
  if (endpoint.length > PROVIDER_CONSTANTS.endpointMaxBytes) throw new Error('模型 Endpoint 过长')
  if (!modelId) throw new Error('模型 ID 不能为空')
  if (modelId.length > PROVIDER_CONSTANTS.modelIdMaxBytes) throw new Error('模型 ID 过长')
  if (modelName.length > PROVIDER_CONSTANTS.modelIdMaxBytes) throw new Error('模型名称过长')
  // website 是纯展示字段（Provider 官网/文档地址）：运行时不 dereference，
  // 与 modelName 同待遇（trim、空省略、256 字节上限），不做 URL 格式校验——
  // 一旦校验，将来收紧会让含旧值文档的 decode fail-closed。
  if (website.length > PROVIDER_CONSTANTS.modelIdMaxBytes) throw new Error('官网地址过长')
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error('模型 Endpoint 不是有效 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('模型 Endpoint 仅支持 HTTP 或 HTTPS')
  }
  if (url.username || url.password) throw new Error('模型 Endpoint 不能包含用户名或密码')
  const secretId = normalizeSecretIdImpl(profile.providerId, profile.secretId)
  return {
    schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
    profileId,
    providerId: profile.providerId,
    apiFormat: profile.apiFormat,
    endpoint,
    modelId,
    timeoutMs: boundedInteger(
      profile.timeoutMs,
      PROVIDER_CONSTANTS.timeoutDefaultMs,
      PROVIDER_CONSTANTS.timeoutMinMs,
      PROVIDER_CONSTANTS.timeoutMaxMs,
    ),
    maxOutputTokens: boundedInteger(
      profile.maxOutputTokens,
      PROVIDER_CONSTANTS.maxOutputDefault,
      PROVIDER_CONSTANTS.maxOutputMin,
      PROVIDER_CONSTANTS.maxOutputMax,
    ),
    contextWindow: boundedInteger(
      profile.contextWindow,
      PROVIDER_CONSTANTS.contextDefault,
      PROVIDER_CONSTANTS.contextMin,
      PROVIDER_CONSTANTS.contextMax,
    ),
    capabilities: {
      toolReferences: definition.supportedCapabilities.toolReferences
        && profile.capabilities?.toolReferences === true,
      toolSearch: definition.supportedCapabilities.toolSearch
        && profile.capabilities?.toolSearch === true,
    },
    ...(secretId ? { secretId } : {}),
    ...(modelName ? { modelName } : {}),
    ...(website ? { website } : {}),
  }
}

const strictInteger = (value: unknown, minimum: number, maximum: number, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} 无效`)
  }
  return Number(value)
}

const decodeProviderProfileFieldsImpl = (
  value: Record<string, unknown>,
  version: 2 | 3 | 4,
): ProviderProfile => {
  assertExactFields(value, [
    'schemaVersion',
    'profileId',
    'providerId',
    'apiFormat',
    'endpoint',
    'modelId',
    'modelName',
    'website',
    'timeoutMs',
    'maxOutputTokens',
    'contextWindow',
    'capabilities',
    'secretId',
  ], `Provider Profile v${version}`)
  if (typeof value.profileId !== 'string'
    || typeof value.providerId !== 'string'
    || typeof value.apiFormat !== 'string'
    || typeof value.endpoint !== 'string'
    || typeof value.modelId !== 'string'
    || (value.modelName !== undefined && typeof value.modelName !== 'string')
    || (value.website !== undefined && typeof value.website !== 'string')
    || !isRecord(value.capabilities)
    || (value.secretId !== undefined && typeof value.secretId !== 'string')) {
    throw new Error(`Provider Profile v${version} 字段格式无效`)
  }
  const capabilities = value.capabilities
  if (typeof capabilities.toolReferences !== 'boolean'
    || typeof capabilities.toolSearch !== 'boolean') {
    throw new Error(`Provider Profile v${version} 字段格式无效`)
  }
  assertExactFields(capabilities, ['toolReferences', 'toolSearch'], 'Provider capabilities')
  const rawProviderId = value.providerId
  // 已移除的内置 minimax provider 向前兼容：曾持久化为 providerId='minimax'
  // 的 v2/v3 profile 统一降级为 generic-anthropic-compatible。endpoint 与
  // modelId 原样保留，用户无需重新配置即可继续使用。比较基于原始字符串，
  // 因为类型层面 ProviderId 已不含 'minimax'，但历史持久化数据仍可能出现。
  const migratedProviderId = rawProviderId === 'minimax'
    ? 'generic-anthropic-compatible'
    : rawProviderId
  const providerId = migratedProviderId as ProviderId
  const definition = isProviderId(migratedProviderId)
    ? getProviderDefinition(providerId)
    : undefined
  const migratedSecretId = definition
    ? version === SECRET_MIGRATION_SCHEMA_VERSION
      ? migrateSecretIdImpl(providerId, value.secretId as string | undefined)
      : value.secretId ?? (definition.auth.kind === 'api-key'
        ? definition.auth.defaultSecretId
        : undefined)
    : value.secretId as string | undefined
  const timeoutMs = strictInteger(
    value.timeoutMs,
    PROVIDER_CONSTANTS.timeoutMinMs,
    PROVIDER_CONSTANTS.timeoutMaxMs,
    'Provider timeoutMs',
  )
  const maxOutputTokens = strictInteger(
    value.maxOutputTokens,
    PROVIDER_CONSTANTS.maxOutputMin,
    PROVIDER_CONSTANTS.maxOutputMax,
    'Provider maxOutputTokens',
  )
  const contextWindow = strictInteger(
    value.contextWindow,
    PROVIDER_CONSTANTS.contextMin,
    PROVIDER_CONSTANTS.contextMax,
    'Provider contextWindow',
  )
  const normalized = normalizeProviderProfileDraftImpl({
    schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
    profileId: value.profileId,
    providerId,
    apiFormat: value.apiFormat as ProviderApiFormat,
    endpoint: value.endpoint,
    modelId: value.modelId,
    ...(value.modelName !== undefined ? { modelName: value.modelName } : {}),
    ...(value.website !== undefined ? { website: value.website } : {}),
    timeoutMs,
    maxOutputTokens,
    contextWindow,
    capabilities: {
      toolReferences: capabilities.toolReferences,
      toolSearch: capabilities.toolSearch,
    },
    ...(migratedSecretId !== undefined ? { secretId: migratedSecretId } : {}),
  })
  if (normalized.profileId !== value.profileId
    || normalized.endpoint !== value.endpoint
    || normalized.modelId !== value.modelId
    || normalized.modelName !== (value.modelName || undefined)
    || normalized.website !== (value.website || undefined)
    || normalized.timeoutMs !== timeoutMs
    || normalized.maxOutputTokens !== maxOutputTokens
    || normalized.contextWindow !== contextWindow
    || normalized.secretId !== migratedSecretId
    || normalized.capabilities.toolReferences !== capabilities.toolReferences
    || normalized.capabilities.toolSearch !== capabilities.toolSearch) {
    throw new Error(`Provider Profile v${version} 不是规范化数据`)
  }
  return normalized
}

export interface DecodedProviderProfile {
  profile: ProviderProfile
  requiresPersistenceMigration: boolean
  secretMigration?: ProviderSecretMigration
}

export interface ProviderSecretMigration {
  sourceSecretId: string
  targetSecretId: string
}

const providerSecretMigration = (
  value: Record<string, unknown>,
  profile: ProviderProfile,
): ProviderSecretMigration | undefined => {
  const auth = getProviderDefinition(profile.providerId).auth
  const legacyIds = legacySecretIds(profile.providerId)
  if (auth.kind === 'none' || !profile.secretId || legacyIds.length === 0) return undefined
  const storedSecretId = typeof value.secretId === 'string'
    ? value.secretId
    : legacyIds[0]
  const sourceSecretId = legacyIds.find((legacySecretId) => (
    storedSecretId === legacySecretId || storedSecretId.startsWith(`${legacySecretId}.`)
  ))
  if (!sourceSecretId) return undefined
  const suffix = storedSecretId.slice(sourceSecretId.length)
  return {
    sourceSecretId: `${sourceSecretId}${suffix}`,
    targetSecretId: profile.secretId,
  }
}

const decodeProviderProfileWithMetadataImpl = (value: unknown): DecodedProviderProfile => {
  if (!isRecord(value)) throw new Error('Provider Profile 格式无效')
  if (value.schemaVersion === PROVIDER_PROFILE_SCHEMA_VERSION) {
    return {
      profile: decodeProviderProfileFieldsImpl(value, PROVIDER_PROFILE_SCHEMA_VERSION),
      requiresPersistenceMigration: false,
    }
  }
  if (value.schemaVersion === PREVIOUS_PROVIDER_PROFILE_SCHEMA_VERSION) {
    // v3 起文档已持有当前 secret namespace：只需重写版本号，无 secret 迁移。
    const profile = decodeProviderProfileFieldsImpl(value, PREVIOUS_PROVIDER_PROFILE_SCHEMA_VERSION)
    return {
      profile,
      requiresPersistenceMigration: true,
    }
  }
  if (value.schemaVersion === SECRET_MIGRATION_SCHEMA_VERSION) {
    const profile = decodeProviderProfileFieldsImpl(value, SECRET_MIGRATION_SCHEMA_VERSION)
    const secretMigration = providerSecretMigration(value, profile)
    return {
      profile,
      requiresPersistenceMigration: true,
      ...(secretMigration ? { secretMigration } : {}),
    }
  }
  if (typeof value.kind === 'string' && LEGACY_KINDS.has(value.kind as LegacyProviderConfig['kind'])) {
    const profile = migrateLegacyProviderConfigImpl(value as unknown as LegacyProviderConfig)
    const secretMigration = providerSecretMigration(value, profile)
    return {
      profile,
      requiresPersistenceMigration: true,
      ...(secretMigration ? { secretMigration } : {}),
    }
  }
  throw new Error('Provider Profile 格式无效')
}

const decodeProviderProfileImpl = (value: unknown): ProviderProfile => {
  return decodeProviderProfileWithMetadataImpl(value).profile
}

/** Provider Profile 解析器抽象：生产环境由 Rust 侧 `provider_profiles` 权威解析。 */
export interface ProviderProfileParser {
  decodeWithMetadata(value: unknown): Promise<DecodedProviderProfile>
  decode(value: unknown): Promise<ProviderProfile>
  normalizeDraft(draft: ProviderProfileDraft): Promise<ProviderProfile>
  migrateLegacyConfig(config: LegacyProviderConfig): Promise<ProviderProfile>
  isSecretIdCompatibleWithProvider(providerId: ProviderId, secretId: string): Promise<boolean>
  isLegacySecretIdCompatibleWithProvider(providerId: ProviderId, secretId: string): Promise<boolean>
  isKnownLegacySecretId(secretId: string): Promise<boolean>
}

/**
 * 纯 TS reference 解析实现（与 Rust 侧逐字对齐），用作未绑定宿主时的默认解析器，
 * 供离线测试与浏览器 demo 使用。生产路径（宿主已绑定）一律走 Rust 权威解析。
 */
export const referenceProviderProfileParser: ProviderProfileParser = {
  decodeWithMetadata: async (value) => decodeProviderProfileWithMetadataImpl(value),
  decode: async (value) => decodeProviderProfileImpl(value),
  normalizeDraft: async (draft) => normalizeProviderProfileDraftImpl(draft),
  migrateLegacyConfig: async (config) => migrateLegacyProviderConfigImpl(config),
  isSecretIdCompatibleWithProvider: async (providerId, secretId) =>
    isSecretIdCompatibleWithProviderImpl(providerId, secretId),
  isLegacySecretIdCompatibleWithProvider: async (providerId, secretId) =>
    isLegacySecretIdCompatibleWithProviderImpl(providerId, secretId),
  isKnownLegacySecretId: async (secretId) => isKnownLegacySecretIdImpl(secretId),
}

// ---- 运行时幂等规范化（reference 实现）----
//
// ProviderRegistry / harness 构造等同步路径使用：profile 已在持久化边界（providerStorage /
// SqliteSessionRepository）经 Rust `decode_provider_profile` 权威解析并规范化，此处是对
// 已规范化数据的幂等重校验（与 Rust 侧逐字对齐）。安全相关的端点/密钥门禁始终在 Rust
// （model_http::resolve_profile / secrets::save_secret）。

export const normalizeProviderProfileRuntime = normalizeProviderProfileDraftImpl

export const isSecretIdCompatibleWithProviderRuntime = isSecretIdCompatibleWithProviderImpl

export const decodeProviderProfileRuntime = (value: unknown): ProviderProfile =>
  decodeProviderProfileWithMetadataImpl(value).profile

// ---- host-backed public API：生产环境经 ProviderHost 委托 Rust 权威解析 ----

const parser = (): ProviderProfileParser => getProviderHost().parser

export const migrateLegacyProviderConfig = (config: LegacyProviderConfig): Promise<ProviderProfile> =>
  parser().migrateLegacyConfig(config)

export const normalizeProviderProfileDraft = (
  draft: ProviderProfileDraft,
): Promise<ProviderProfile> => parser().normalizeDraft(draft)

export const normalizeProviderProfile = (profile: ProviderProfile): Promise<ProviderProfile> =>
  parser().normalizeDraft(profile)

export const decodeProviderProfileWithMetadata = (
  value: unknown,
): Promise<DecodedProviderProfile> => parser().decodeWithMetadata(value)

export const decodeProviderProfile = (value: unknown): Promise<ProviderProfile> =>
  parser().decode(value)

export const isSecretIdCompatibleWithProvider = (
  providerId: ProviderId,
  secretId: string,
): Promise<boolean> => parser().isSecretIdCompatibleWithProvider(providerId, secretId)

export const isLegacySecretIdCompatibleWithProvider = (
  providerId: ProviderId,
  secretId: string,
): Promise<boolean> => parser().isLegacySecretIdCompatibleWithProvider(providerId, secretId)

export const isKnownLegacySecretId = (secretId: string): Promise<boolean> =>
  parser().isKnownLegacySecretId(secretId)

export const apiFormatForProvider = (providerId: ProviderId): ProviderApiFormat =>
  getProviderDefinition(providerId).apiFormat

export const defaultSecretIdForProvider = (providerId: ProviderId): string | undefined => {
  const { auth } = getProviderDefinition(providerId)
  return auth.kind === 'api-key' ? auth.defaultSecretId : undefined
}
