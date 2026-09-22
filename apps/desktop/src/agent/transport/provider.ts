import type { ModelRef, ModelTransport } from '@/agent/core/types'
import type { ModelProbeRequest } from './modelHttpContract'
import { BUILTIN_PROVIDER_RUNTIME } from './ProviderRuntime'
import { ProviderSetupRequiredTransport } from './ProviderSetupRequiredTransport'
import {
  decodeProviderProfile,
  decodeProviderProfileWithMetadata,
  decodeProviderProfileRuntime,
  normalizeProviderProfileDraft,
  normalizeProviderProfile,
  normalizeProviderProfileRuntime,
  PROVIDER_PROFILE_SCHEMA_VERSION,
  type LegacyProviderConfig,
  type ProviderId,
  type ProviderProfile,
  type ProviderProfileDraft,
  type ProviderSecretMigration,
} from './providerProfile'

export type {
  LegacyProviderConfig,
  ProviderCapabilities,
  ProviderId,
  ProviderProfile,
  ProviderProfileDraft,
  ProviderSecretMigration,
} from './providerProfile'
export {
  decodeProviderProfile,
  decodeProviderProfileWithMetadata,
  migrateLegacyProviderConfig,
  normalizeProviderProfile,
  normalizeProviderProfileDraft,
  PROVIDER_PROFILE_SCHEMA_VERSION,
} from './providerProfile'
export type {
  ModelCatalogSource,
  ModelDescriptor,
} from './modelCatalog'
export {
  listBuiltinModels,
  listModelsForProfile,
  resolveModelDescriptor,
} from './modelCatalog'
export type {
  ProviderAuthDescriptor,
  ProviderMetadata,
  ProviderSecretMigrationReceipt,
} from './ProviderRuntime'
export { BUILTIN_PROVIDER_RUNTIME } from './ProviderRuntime'

export type ProviderConfig = ProviderProfile
export type ProviderKind = ProviderId

/**
 * 生产模式首次启动、用户尚未配置 Provider 时的默认入口。
 * 使用 generic-anthropic-compatible 的默认 profile：endpoint 取自描述符
 * 默认值，modelId 使用占位值（用户必须填写真实模型）。历史上的 minimax
 * 内置入口已移除，但已持久化的旧 minimax profile 会经 providerProfile.ts
 * 降级为 generic-anthropic-compatible 后正常恢复。
 *
 * 这两个占位 Profile 由描述符数据直接构造（解析已下沉 Rust，宿主可能在模块
 * 初始化阶段尚未绑定），不会发起真实请求——store 在 requiresSetup 时强制走配置流程。
 */
export const DEMO_PROVIDER_CONFIG: ProviderProfile = {
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

const defaultDescriptor = BUILTIN_PROVIDER_RUNTIME.getProvider('generic-anthropic-compatible')
export const DEFAULT_PROVIDER_CONFIG: ProviderProfile = {
  ...structuredClone(defaultDescriptor.defaultProfile),
  // 默认 profile 的 modelId 为空，但占位 Profile 必须可被 resolveProviderModel /
  // createProviderTransport 解析，因此填入占位模型 ID（用户配置时会覆盖）。
  modelId: 'placeholder',
  secretId: defaultDescriptor.auth.kind === 'api-key'
    ? defaultDescriptor.auth.defaultSecretId
    : undefined,
} as ProviderProfile

export interface InitialProviderSelection {
  config: ProviderProfile
  requiresSetup: boolean
  requiresPersistenceMigration: boolean
  secretMigration?: ProviderSecretMigration
}

export interface StoredProviderProfile {
  providerConfig: unknown | null
  modelProvider: string
  modelId: string
}

export const providerLabel = (providerId: ProviderId): string =>
  BUILTIN_PROVIDER_RUNTIME.getProvider(providerId).label

export const defaultProviderProfile = (providerId: ProviderId): ProviderProfileDraft => {
  const descriptor = BUILTIN_PROVIDER_RUNTIME.getProvider(providerId)
  const profile = structuredClone(descriptor.defaultProfile)
  // provider 声明了官网时预填 profile 的展示字段（用户可改）：该字段是纯展示的
  // 「官网/文档地址」，让它带上 provider 自己的官网比留空更有意义。
  return descriptor.website ? { ...profile, website: descriptor.website } : profile
}

export const secretIdForProvider = (providerId: Exclude<ProviderId, 'demo'>): string => {
  const { auth } = BUILTIN_PROVIDER_RUNTIME.getProvider(providerId)
  if (auth.kind === 'none') throw new Error('Provider 没有默认 Secret ID')
  return auth.defaultSecretId
}

export const providerRequiresApiKey = (providerId: ProviderId): boolean => {
  const { auth } = BUILTIN_PROVIDER_RUNTIME.getProvider(providerId)
  return auth.kind === 'api-key' && auth.required
}

type ProviderProfileInput = ProviderProfile | ProviderProfileDraft | LegacyProviderConfig

// 持久化/保存边界的异步权威解析（Rust `decode_provider_profile` /
// `normalize_provider_profile_draft`），供草稿保存与持久化文档解码使用。
const normalizedProfile = async (profile: ProviderProfileInput): Promise<ProviderProfile> => (
  'kind' in profile
    ? decodeProviderProfile(profile)
    : normalizeProviderProfileDraft(profile)
)

// 运行时同步规范化（reference 实现；profile 已在持久化边界经 Rust 解析）。
const normalizedProfileSync = (profile: ProviderProfileInput): ProviderProfile => (
  'kind' in profile
    ? decodeProviderProfileRuntime(profile)
    : normalizeProviderProfileRuntime(profile)
)

export const secretIdForProviderConfig = async (profile: ProviderProfileInput): Promise<string> =>
  BUILTIN_PROVIDER_RUNTIME.secretId(await normalizedProfile(profile))

export const normalizeProviderConfig = async (profile: ProviderProfileInput): Promise<ProviderProfile> =>
  BUILTIN_PROVIDER_RUNTIME.normalize(await normalizedProfile(profile))

export const resolveProviderModel = (profile: ProviderProfileInput): ModelRef =>
  BUILTIN_PROVIDER_RUNTIME.resolveModel(normalizedProfileSync(profile))

/**
 * 解析会话提示词的模型身份显示名：优先用 profile.modelName，为空时回退到内置
 * model catalog 中当前 modelId 的 label（如 deepseek-v4-flash → 「DeepSeek V4
 * Flash」）。demo 与 model catalog 之外的自定义 modelId 保持无身份行。
 *
 * 必要性：系统提示词的 `# 角色` 段只在 modelName 非空时注入模型身份行。内置
 * provider 的 profile 默认没有 modelName，模型被问「当前使用的模型配置是什么」
 * 时只能靠训练先验与历史消息猜测，切到 MiniMax 后仍会误报 DeepSeek。此函数让
 * 会话提示词如实告知模型自身身份。
 */
export const resolvePromptModelName = (profile: ProviderProfileInput): string | undefined => {
  const normalized = normalizedProfileSync(profile)
  const custom = normalized.modelName?.trim()
  if (custom) return custom
  return BUILTIN_PROVIDER_RUNTIME.resolveModelLabel(normalized)
}

export const createProviderSetupRequiredTransport = (providerId: ProviderId): ModelTransport =>
  new ProviderSetupRequiredTransport(providerLabel(providerId))

/** 无持久化配置时的同步 fallback Provider（用于模块初始化播种；解析已下沉 Rust，无法同步解码存储值）。 */
export const initialProviderFallback = (allowDemoProvider: boolean): ProviderProfile =>
  structuredClone(allowDemoProvider ? DEMO_PROVIDER_CONFIG : DEFAULT_PROVIDER_CONFIG)

export const resolveInitialProviderSelection = async (
  storedValue: string | null,
  allowDemoProvider: boolean,
): Promise<InitialProviderSelection> => {
  const fallback = (): InitialProviderSelection => ({
    config: initialProviderFallback(allowDemoProvider),
    requiresSetup: !allowDemoProvider,
    requiresPersistenceMigration: false,
  })

  if (!storedValue) return fallback()
  try {
    const decoded = await decodeProviderProfileWithMetadata(JSON.parse(storedValue) as unknown)
    const profile = decoded.profile
    if (profile.providerId === 'demo' && !allowDemoProvider) return fallback()
    return {
      config: profile,
      requiresSetup: false,
      requiresPersistenceMigration: decoded.requiresPersistenceMigration,
      ...(decoded.secretMigration ? { secretMigration: decoded.secretMigration } : {}),
    }
  } catch {
    return fallback()
  }
}

export const resolveSessionProviderConfig = async (
  stored: StoredProviderProfile,
  fallback: ProviderProfile,
  allowDemoProvider: boolean,
): Promise<ProviderProfile> => {
  if (!stored.providerConfig) return normalizeProviderProfile(fallback)
  const profile = await decodeProviderProfile(stored.providerConfig)
  if (profile.providerId === 'demo' && !allowDemoProvider) return normalizeProviderProfile(fallback)
  if (profile.providerId === 'demo') return profile
  const compatibleStoredProvider = stored.modelProvider === profile.providerId
    || stored.modelProvider === profile.apiFormat
  if (!compatibleStoredProvider) return profile
  return normalizeProviderProfile({ ...profile, modelId: stored.modelId })
}

export const createProviderTransport = (
  profile: ProviderProfileInput,
  hasKey: boolean,
): { transport: ModelTransport; model: ModelRef } =>
  BUILTIN_PROVIDER_RUNTIME.createTransport(normalizedProfileSync(profile), hasKey)

export const createProviderProbeRequest = (
  profile: ProviderProfileInput,
  hasKey: boolean,
): ModelProbeRequest => BUILTIN_PROVIDER_RUNTIME.createProbe(
  normalizedProfileSync(profile),
  hasKey,
)
