import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROVIDER_CATALOG,
  getProviderDefinition,
  isProviderId,
} from './providerDefinitions'
import {
  apiFormatForProvider,
  decodeProviderProfile,
  decodeProviderProfileWithMetadata,
  defaultSecretIdForProvider,
  isKnownLegacySecretId,
  isLegacySecretIdCompatibleWithProvider,
  isSecretIdCompatibleWithProvider,
  migrateLegacyProviderConfig,
  normalizeProviderProfile,
  normalizeProviderProfileDraft,
  PROVIDER_PROFILE_SCHEMA_VERSION,
} from './providerProfile'
import type { LegacyProviderConfig } from './providerProfile'

const ANTHROPIC_SECRET = 'provider.generic-anthropic-compatible.api-key'

const anthropicProfile = {
  schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
  profileId: 'profile-1',
  providerId: 'generic-anthropic-compatible' as const,
  apiFormat: 'anthropic-compatible' as const,
  endpoint: 'https://api.anthropic.com/v1/messages',
  modelId: 'claude-3-5-sonnet',
  timeoutMs: 60_000,
  maxOutputTokens: 4_096,
  contextWindow: 128_000,
  capabilities: { toolReferences: true, toolSearch: false },
  secretId: ANTHROPIC_SECRET,
}

describe('normalizeProviderProfileDraft', () => {
  it('normalizes any demo profile to the fixed builtin demo contract', async () => {
    await expect(normalizeProviderProfileDraft({
      schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
      profileId: 'whatever',
      providerId: 'demo',
      apiFormat: 'demo',
      endpoint: 'http://evil.example',
      modelId: 'x',
      timeoutMs: 1,
      maxOutputTokens: 2,
      contextWindow: 3,
      capabilities: { toolReferences: true, toolSearch: true },
    })).resolves.toEqual({
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
    })
  })

  it('rejects unsupported schema versions, provider ids and API format drift', async () => {
    await expect(normalizeProviderProfileDraft({ ...anthropicProfile, schemaVersion: 2 as never }))
      .rejects.toThrow('不支持的 Provider Profile 版本')
    await expect(normalizeProviderProfileDraft({ ...anthropicProfile, providerId: 'unknown' as never }))
      .rejects.toThrow('不支持的 Provider')
    await expect(normalizeProviderProfileDraft({ ...anthropicProfile, apiFormat: 'openai-compatible' }))
      .rejects.toThrow('Provider 身份与 API 格式不匹配')
  })

  it('validates profile id, endpoint, and model id', async () => {
    await expect(normalizeProviderProfileDraft({ ...anthropicProfile, profileId: 'bad id!' }))
      .rejects.toThrow('Provider Profile ID 无效')
    await expect(normalizeProviderProfileDraft({ ...anthropicProfile, endpoint: '' }))
      .rejects.toThrow('Endpoint 不能为空')
    await expect(normalizeProviderProfileDraft({ ...anthropicProfile, endpoint: 'not-a-url' }))
      .rejects.toThrow('Endpoint 不是有效 URL')
    await expect(normalizeProviderProfileDraft({ ...anthropicProfile, endpoint: 'ftp://x' }))
      .rejects.toThrow('仅支持 HTTP 或 HTTPS')
    await expect(normalizeProviderProfileDraft({ ...anthropicProfile, endpoint: 'https://u:p@host/v' }))
      .rejects.toThrow('不能包含用户名或密码')
    await expect(normalizeProviderProfileDraft({ ...anthropicProfile, modelId: '' }))
      .rejects.toThrow('模型 ID 不能为空')
  })

  it('validates the secret id against the provider identity', async () => {
    await expect(normalizeProviderProfileDraft({ ...anthropicProfile, secretId: 'bad secret!' }))
      .rejects.toThrow('Provider Secret ID 无效')
    await expect(normalizeProviderProfileDraft({ ...anthropicProfile, secretId: 'provider.openai-responses.api-key' }))
      .rejects.toThrow('Provider Secret ID 与 Provider 身份不匹配')
  })

  it('clamps numeric fields into the safe bounded range', async () => {
    const normalized = await normalizeProviderProfileDraft({
      ...anthropicProfile,
      timeoutMs: 10_000_000,
      maxOutputTokens: 1,
      contextWindow: 0,
    })
    expect(normalized.timeoutMs).toBe(300_000)
    expect(normalized.maxOutputTokens).toBe(1)
    expect(normalized.contextWindow).toBe(8_192)
  })

  it('gates capabilities behind the provider definition support', async () => {
    // generic-openai-compatible 不支持 toolReferences，即使 profile 声明 true 也被取与为 false。
    const normalized = await normalizeProviderProfileDraft({
      ...anthropicProfile,
      providerId: 'generic-openai-compatible',
      apiFormat: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      secretId: 'provider.openai-compatible.api-key',
      capabilities: { toolReferences: true, toolSearch: true },
    })
    expect(normalized.capabilities).toEqual({ toolReferences: false, toolSearch: false })
  })

  it('keeps the secret id when provided and matches the provider', async () => {
    const normalized = await normalizeProviderProfileDraft(anthropicProfile)
    expect(normalized.secretId).toBe(ANTHROPIC_SECRET)
    await expect(normalizeProviderProfile(anthropicProfile)).resolves.toEqual(normalized)
  })

  it('normalizes an optional modelName display name and trims it', async () => {
    const normalized = await normalizeProviderProfileDraft({
      ...anthropicProfile,
      modelName: '  Claude 助手  ',
    })
    expect(normalized.modelName).toBe('Claude 助手')
    expect(normalized.modelId).toBe('claude-3-5-sonnet')
  })

  it('omits an empty modelName from the normalized profile', async () => {
    const normalized = await normalizeProviderProfileDraft({ ...anthropicProfile, modelName: '  ' })
    expect(normalized.modelName).toBeUndefined()
    await expect(normalizeProviderProfile(anthropicProfile)).resolves.toEqual(normalized)
  })

  it('rejects an overlong modelName', async () => {
    await expect(normalizeProviderProfileDraft({
      ...anthropicProfile,
      modelName: 'x'.repeat(257),
    })).rejects.toThrow('模型名称过长')
  })

  it('normalizes an optional website and trims it', async () => {
    const normalized = await normalizeProviderProfileDraft({
      ...anthropicProfile,
      website: '  https://anthropic.com  ',
    })
    expect(normalized.website).toBe('https://anthropic.com')
  })

  it('omits an empty website from the normalized profile', async () => {
    const normalized = await normalizeProviderProfileDraft({ ...anthropicProfile, website: '  ' })
    expect(normalized.website).toBeUndefined()
  })

  it('rejects an overlong website', async () => {
    await expect(normalizeProviderProfileDraft({
      ...anthropicProfile,
      website: 'x'.repeat(257),
    })).rejects.toThrow('官网地址过长')
  })
})

describe('legacy provider config migration', () => {
  it('maps every legacy kind onto its current provider identity', async () => {
    const base: Omit<LegacyProviderConfig, 'kind'> = {
      endpoint: 'https://x',
      model: 'm',
      timeoutMs: 30_000,
      maxTokens: 4_096,
      contextWindow: 128_000,
    }
    expect((await migrateLegacyProviderConfig({ ...base, kind: 'demo' })).providerId).toBe('demo')
    expect((await migrateLegacyProviderConfig({ ...base, kind: 'openai-compatible' })).providerId)
      .toBe('generic-openai-compatible')
    expect((await migrateLegacyProviderConfig({ ...base, kind: 'openai-responses' })).providerId).toBe('openai')
    expect((await migrateLegacyProviderConfig({ ...base, kind: 'anthropic-compatible' })).providerId)
      .toBe('generic-anthropic-compatible')
  })

  it('migrates a legacy anthropic secret id to the current namespace', async () => {
    const migrated = await migrateLegacyProviderConfig({
      kind: 'anthropic-compatible',
      endpoint: 'https://api.anthropic.com/v1/messages',
      model: 'claude-3-5-sonnet',
      timeoutMs: 30_000,
      maxTokens: 4_096,
      contextWindow: 128_000,
      secretId: 'provider.anthropic-compatible.api-key',
    })
    expect(migrated.secretId).toBe(ANTHROPIC_SECRET)
  })

  it('rejects an unknown legacy kind', async () => {
    await expect(migrateLegacyProviderConfig({ kind: 'foo' } as unknown as LegacyProviderConfig))
      .rejects.toThrow('不支持的旧版 Provider 协议')
  })
})

describe('decodeProviderProfileWithMetadata', () => {
  it('passes through schema v4 profiles without persistence migration', async () => {
    const decoded = await decodeProviderProfileWithMetadata(anthropicProfile)
    expect(decoded.requiresPersistenceMigration).toBe(false)
    expect(decoded.secretMigration).toBeUndefined()
    expect(decoded.profile.providerId).toBe('generic-anthropic-compatible')
    await expect(decodeProviderProfile(anthropicProfile)).resolves.toEqual(decoded.profile)
  })

  it('marks schema v3 profiles for persistence migration without secret migration', async () => {
    // v3 文档已持有当前 secret namespace：只重写版本号，不产生 secret 迁移。
    const value = { ...anthropicProfile, schemaVersion: 3 }
    const decoded = await decodeProviderProfileWithMetadata(value)
    expect(decoded.requiresPersistenceMigration).toBe(true)
    expect(decoded.secretMigration).toBeUndefined()
    expect(decoded.profile.schemaVersion).toBe(PROVIDER_PROFILE_SCHEMA_VERSION)
    await expect(decodeProviderProfile(value)).resolves.toEqual(decoded.profile)
  })

  it('preserves optional modelName and website when decoding a persisted profile', async () => {
    const value = { ...anthropicProfile, modelName: 'Claude 助手', website: 'https://anthropic.com' }
    const decoded = await decodeProviderProfileWithMetadata(value)
    expect(decoded.requiresPersistenceMigration).toBe(false)
    expect(decoded.profile.modelName).toBe('Claude 助手')
    expect(decoded.profile.website).toBe('https://anthropic.com')
    await expect(decodeProviderProfile(value)).resolves.toEqual(decoded.profile)
  })

  it('rejects persisted profiles with an unknown field', async () => {
    await expect(decodeProviderProfileWithMetadata({
      ...anthropicProfile,
      modelName: 'Claude 助手',
      surprise: true,
    })).rejects.toThrow('包含未知字段')
  })

  it('marks schema v2 profiles for migration and derives the secret migration', async () => {
    const decoded = await decodeProviderProfileWithMetadata({
      ...anthropicProfile,
      schemaVersion: 2,
      secretId: 'provider.anthropic-compatible.api-key',
    })
    expect(decoded.requiresPersistenceMigration).toBe(true)
    expect(decoded.secretMigration).toEqual({
      sourceSecretId: 'provider.anthropic-compatible.api-key',
      targetSecretId: ANTHROPIC_SECRET,
    })
  })

  it('rejects values that are not a provider profile shape', async () => {
    await expect(decodeProviderProfileWithMetadata(null)).rejects.toThrow('Provider Profile 格式无效')
    await expect(decodeProviderProfileWithMetadata({})).rejects.toThrow('Provider Profile 格式无效')
    await expect(decodeProviderProfileWithMetadata({ schemaVersion: 99 })).rejects.toThrow('Provider Profile 格式无效')
  })
})

describe('provider catalog and secret helpers', () => {
  it('resolves builtin providers by id and rejects unknown ids', () => {
    expect(isProviderId('demo')).toBe(true)
    expect(isProviderId('orcarouter')).toBe(true)
    expect(isProviderId('nope')).toBe(false)
    expect(getProviderDefinition('demo').label).toBe('离线 Demo')
    expect(BUILTIN_PROVIDER_CATALOG.list().length).toBe(14)
    expect(() => BUILTIN_PROVIDER_CATALOG.get('nope' as never)).toThrow('Provider 未定义')
  })

  it('exposes api format and default secret id helpers', () => {
    expect(apiFormatForProvider('demo')).toBe('demo')
    expect(defaultSecretIdForProvider('demo')).toBeUndefined()
    expect(defaultSecretIdForProvider('openai')).toBe('provider.openai-responses.api-key')
  })

  it('checks secret id compatibility including legacy namespaces', async () => {
    await expect(isSecretIdCompatibleWithProvider('generic-anthropic-compatible', ANTHROPIC_SECRET)).resolves.toBe(true)
    await expect(isSecretIdCompatibleWithProvider('generic-anthropic-compatible', `${ANTHROPIC_SECRET}.suffix`)).resolves.toBe(true)
    await expect(isSecretIdCompatibleWithProvider('generic-anthropic-compatible', 'provider.minimax.api-key')).resolves.toBe(false)
    await expect(isLegacySecretIdCompatibleWithProvider('generic-anthropic-compatible', 'provider.anthropic-compatible.api-key')).resolves.toBe(true)
    await expect(isKnownLegacySecretId('provider.minimax.api-key')).resolves.toBe(true)
    await expect(isKnownLegacySecretId(ANTHROPIC_SECRET)).resolves.toBe(false)
  })
})
