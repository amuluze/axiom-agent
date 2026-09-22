import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROVIDER_RUNTIME,
  createProviderProbeRequest,
  createProviderTransport,
  decodeProviderProfile,
  decodeProviderProfileWithMetadata,
  DEFAULT_PROVIDER_CONFIG,
  defaultProviderProfile,
  DEMO_PROVIDER_CONFIG,
  listModelsForProfile,
  normalizeProviderConfig,
  providerRequiresApiKey,
  resolvePromptModelName,
  resolveProviderModel,
  resolveInitialProviderSelection,
  resolveSessionProviderConfig,
  secretIdForProvider,
  type LegacyProviderConfig,
  type ProviderConfig,
} from './provider'
import { OpenAIResponsesTransport } from './OpenAIResponsesTransport'
import { OpenAICompatibleTransport } from './OpenAICompatibleTransport'
import { AnthropicCompatibleTransport } from './AnthropicCompatibleTransport'

const OPENAI_RESPONSES_CONFIG: ProviderConfig = {
  schemaVersion: 4,
  profileId: 'test.openai-responses',
  providerId: 'openai',
  apiFormat: 'openai-responses',
  endpoint: 'https://api.openai.com/v1/responses',
  modelId: 'gpt-5',
  timeoutMs: 60_000,
  maxOutputTokens: 16_384,
  contextWindow: 400_000,
  capabilities: { toolReferences: false, toolSearch: true },
}

// 一个 generic-anthropic-compatible Profile，替代历史上作为 fixture 使用的
// 内置 minimax 入口（已移除）。endpoint/modelId 取 minimax 旧值，便于在
// legacy 降级断言里复用同一条迁移路径。
const ANTHROPIC_COMPATIBLE_CONFIG: ProviderConfig = {
  schemaVersion: 4,
  profileId: 'test.anthropic',
  providerId: 'generic-anthropic-compatible',
  apiFormat: 'anthropic-compatible',
  endpoint: 'https://api.anthropic.com/v1/messages',
  modelId: 'claude-test',
  timeoutMs: 60_000,
  maxOutputTokens: 4_096,
  contextWindow: 128_000,
  capabilities: { toolReferences: false, toolSearch: false },
  secretId: 'provider.generic-anthropic-compatible.api-key',
}

describe('Provider Registry 与 Profile', () => {
  it('keeps the builtin Provider set and host-owned Runtime boundaries explicit', () => {
    expect(BUILTIN_PROVIDER_RUNTIME.mode).toBe('builtin-only')
    expect(BUILTIN_PROVIDER_RUNTIME.transportOwnership).toBe('host')
    expect(BUILTIN_PROVIDER_RUNTIME.listProviders().map((provider) => provider.providerId))
      .toEqual([
        'demo',
        'generic-openai-compatible',
        'custom-openai-compatible',
        'openai',
        'generic-anthropic-compatible',
        'custom-anthropic-compatible',
        'zhipu-glm',
        'deepseek',
        'minimax-chat',
        'ollama',
        'gemini',
        'kimi',
        'kimi-coding',
        'orcarouter',
      'opencode-go',
      ])
  })

  it('restores each Session Provider profile independently from the global fallback', async () => {
    const profileA = {
      ...ANTHROPIC_COMPATIBLE_CONFIG,
      endpoint: 'https://provider-a.example/v1/messages',
      modelId: 'stored-a',
    }
    const profileB = {
      ...OPENAI_RESPONSES_CONFIG,
      endpoint: 'https://provider-b.example/v1/responses',
      modelId: 'stored-b',
    }
    const restoredA = await resolveSessionProviderConfig({
      providerConfig: profileA,
      modelProvider: 'generic-anthropic-compatible',
      modelId: 'runtime-a',
    }, profileB, false)
    const restoredB = await resolveSessionProviderConfig({
      providerConfig: profileB,
      modelProvider: 'openai',
      modelId: 'runtime-b',
    }, profileA, false)

    expect(restoredA).toMatchObject({
      providerId: 'generic-anthropic-compatible',
      apiFormat: 'anthropic-compatible',
      endpoint: 'https://provider-a.example/v1/messages',
      modelId: 'runtime-a',
    })
    expect(restoredB).toMatchObject({
      providerId: 'openai',
      apiFormat: 'openai-responses',
      endpoint: 'https://provider-b.example/v1/responses',
      modelId: 'runtime-b',
    })
    expect(createProviderTransport(restoredA, true).transport.constructor.name)
      .toBe('AnthropicCompatibleTransport')
    expect(createProviderTransport(restoredB, true).transport.constructor.name)
      .toBe('OpenAIResponsesTransport')
    expect(await resolveSessionProviderConfig({
      providerConfig: DEMO_PROVIDER_CONFIG,
      modelProvider: 'axiom',
      modelId: 'demo-v1',
    }, profileA, false)).toEqual(await normalizeProviderConfig(profileA))
  })

  it('uses Demo without setup in development and a generic-anthropic-compatible default in production', async () => {
    expect(await resolveInitialProviderSelection(null, true)).toEqual({
      config: DEMO_PROVIDER_CONFIG,
      requiresSetup: false,
      requiresPersistenceMigration: false,
    })
    expect(await resolveInitialProviderSelection(null, false)).toEqual({
      config: DEFAULT_PROVIDER_CONFIG,
      requiresSetup: true,
      requiresPersistenceMigration: false,
    })
  })

  it('derives required authentication from the Provider descriptor', () => {
    expect(providerRequiresApiKey('openai')).toBe(true)
    expect(providerRequiresApiKey('generic-openai-compatible')).toBe(false)
    expect(providerRequiresApiKey('generic-anthropic-compatible')).toBe(false)
  })

  it('does not restore a previously persisted Demo in production', async () => {
    expect(await resolveInitialProviderSelection(JSON.stringify(DEMO_PROVIDER_CONFIG), false)).toEqual({
      config: DEFAULT_PROVIDER_CONFIG,
      requiresSetup: true,
      requiresPersistenceMigration: false,
    })
  })

  it('restores a valid V4 Provider without requiring setup', async () => {
    expect(await resolveInitialProviderSelection(JSON.stringify(ANTHROPIC_COMPATIBLE_CONFIG), false)).toEqual({
      config: ANTHROPIC_COMPATIBLE_CONFIG,
      requiresSetup: false,
      requiresPersistenceMigration: false,
    })
  })

  it('migrates legacy Provider JSON deterministically', async () => {
    const legacy: LegacyProviderConfig = {
      kind: 'anthropic-compatible',
      endpoint: ANTHROPIC_COMPATIBLE_CONFIG.endpoint,
      model: 'claude-test',
      timeoutMs: 60_000,
      maxTokens: 4_096,
      contextWindow: 128_000,
    }
    expect(await normalizeProviderConfig(legacy)).toMatchObject({
      schemaVersion: 4,
      providerId: 'generic-anthropic-compatible',
      apiFormat: 'anthropic-compatible',
      modelId: 'claude-test',
      capabilities: { toolReferences: false, toolSearch: false },
    })
    expect(await resolveInitialProviderSelection(JSON.stringify(legacy), false)).toMatchObject({
      requiresSetup: false,
      requiresPersistenceMigration: true,
    })
  })

  it('retains only Provider-scoped versioned Secret IDs', async () => {
    const secretId = 'provider.openai-responses.api-key.123e4567-e89b-12d3-a456-426614174000'
    const normalized = await normalizeProviderConfig({ ...OPENAI_RESPONSES_CONFIG, secretId })
    expect(normalized.secretId).toBe(secretId)
    expect(createProviderProbeRequest(normalized, true).secretId).toBe(secretId)
    await expect(normalizeProviderConfig({
      ...OPENAI_RESPONSES_CONFIG,
      secretId: 'provider.anthropic-compatible.api-key.other',
    })).rejects.toThrow('Secret ID')
  })

  it('migrates V2 Anthropic profiles into Provider-scoped V3 namespaces', async () => {
    expect(secretIdForProvider('generic-anthropic-compatible'))
      .toBe('provider.generic-anthropic-compatible.api-key')

    const { secretId: _secretId, ...currentWithoutSecret } = ANTHROPIC_COMPATIBLE_CONFIG
    const legacyV2 = { ...currentWithoutSecret, schemaVersion: 2, secretId: 'provider.anthropic-compatible.api-key' }
    const decoded = await decodeProviderProfileWithMetadata(legacyV2)
    expect(decoded).toMatchObject({
      profile: {
        schemaVersion: 4,
        secretId: 'provider.generic-anthropic-compatible.api-key',
      },
      requiresPersistenceMigration: true,
    })
    expect(decoded.secretMigration).toEqual({
      sourceSecretId: 'provider.anthropic-compatible.api-key',
      targetSecretId: 'provider.generic-anthropic-compatible.api-key',
    })
    expect(await decodeProviderProfile(currentWithoutSecret)).toMatchObject({
      schemaVersion: 4,
      secretId: 'provider.generic-anthropic-compatible.api-key',
    })
    expect(await resolveSessionProviderConfig({
      providerConfig: legacyV2,
      modelProvider: 'generic-anthropic-compatible',
      modelId: 'claude-test',
    }, OPENAI_RESPONSES_CONFIG, false)).toMatchObject({
      schemaVersion: 4,
      secretId: 'provider.generic-anthropic-compatible.api-key',
    })
    expect((await normalizeProviderConfig({
      ...defaultProviderProfile('generic-anthropic-compatible'),
      modelId: 'claude-test',
    })).secretId).toBe('provider.generic-anthropic-compatible.api-key')
    await expect(decodeProviderProfile({
      ...ANTHROPIC_COMPATIBLE_CONFIG,
      secretId: 'provider.openai-responses.api-key',
    })).rejects.toThrow('Secret ID')
  })

  it('downgrades persisted minimax Profiles to generic-anthropic-compatible while preserving endpoint and model', async () => {
    // 历史上曾以内置 minimax 入口持久化的 v2/v3 Profile，在内置 minimax
    // provider 被移除后必须向前兼容：providerId 降级为
    // generic-anthropic-compatible，但 endpoint 与 modelId 原样保留，用户
    // 无需重新配置即可继续使用。比较基于原始字符串，因为类型层面
    // ProviderId 已不含 'minimax'，但历史持久化数据仍可能出现。
    const persistedMinimaxV3 = {
      schemaVersion: 3,
      profileId: 'builtin.minimax',
      providerId: 'minimax',
      apiFormat: 'anthropic-compatible',
      endpoint: 'https://api.minimaxi.com/anthropic/v1/messages',
      modelId: 'MiniMax-M3',
      timeoutMs: 60_000,
      maxOutputTokens: 4_096,
      contextWindow: 128_000,
      capabilities: { toolReferences: false, toolSearch: false },
    } as Record<string, unknown>
    expect(await decodeProviderProfile(persistedMinimaxV3)).toMatchObject({
      schemaVersion: 4,
      providerId: 'generic-anthropic-compatible',
      apiFormat: 'anthropic-compatible',
      endpoint: 'https://api.minimaxi.com/anthropic/v1/messages',
      modelId: 'MiniMax-M3',
      secretId: 'provider.generic-anthropic-compatible.api-key',
    })
    expect(await resolveInitialProviderSelection(
      JSON.stringify(persistedMinimaxV3),
      false,
    )).toMatchObject({
      requiresSetup: false,
      requiresPersistenceMigration: true,
      config: {
        providerId: 'generic-anthropic-compatible',
        endpoint: 'https://api.minimaxi.com/anthropic/v1/messages',
        modelId: 'MiniMax-M3',
      },
    })

    const legacyMinimaxKind = {
      kind: 'anthropic-compatible',
      endpoint: 'https://api.minimaxi.com/anthropic/v1/messages',
      model: 'MiniMax-M3',
      timeoutMs: 60_000,
      maxTokens: 4_096,
      contextWindow: 128_000,
    } satisfies LegacyProviderConfig
    expect(await normalizeProviderConfig(legacyMinimaxKind)).toMatchObject({
      providerId: 'generic-anthropic-compatible',
      endpoint: 'https://api.minimaxi.com/anthropic/v1/messages',
      modelId: 'MiniMax-M3',
    })
  })

  it('marks persisted V2 selection for a V3 localStorage projection', async () => {
    const legacyV2 = {
      ...ANTHROPIC_COMPATIBLE_CONFIG,
      schemaVersion: 2,
      secretId: 'provider.anthropic-compatible.api-key.versioned',
    }

    expect(await resolveInitialProviderSelection(JSON.stringify(legacyV2), false)).toMatchObject({
      config: {
        schemaVersion: 4,
        secretId: 'provider.generic-anthropic-compatible.api-key.versioned',
      },
      requiresSetup: false,
      requiresPersistenceMigration: true,
      secretMigration: {
        sourceSecretId: 'provider.anthropic-compatible.api-key.versioned',
        targetSecretId: 'provider.generic-anthropic-compatible.api-key.versioned',
      },
    })
    expect((await decodeProviderProfileWithMetadata(ANTHROPIC_COMPATIBLE_CONFIG)).secretMigration)
      .toBeUndefined()
  })

  it('exposes immutable Provider metadata without runtime factories', () => {
    const registered = BUILTIN_PROVIDER_RUNTIME.getProvider('openai')
        expect(registered.defaultProfile.endpoint).toBe('https://api.openai.com/v1/responses')
    expect('createTransport' in registered).toBe(false)
    expect('createProbe' in registered).toBe(false)
    expect(Reflect.set(registered, 'transportVersion', 'changed')).toBe(false)
    expect(Reflect.set(registered.auth, 'defaultSecretId', 'provider.changed.api-key')).toBe(false)
    expect(Reflect.set(registered.defaultProfile, 'endpoint', 'https://changed.example')).toBe(false)
    expect(BUILTIN_PROVIDER_RUNTIME.getProvider('openai').transportVersion).toBe('10')
  })

  it('scopes capabilities to the registered API format', async () => {
    expect((await normalizeProviderConfig({
      ...ANTHROPIC_COMPATIBLE_CONFIG,
      capabilities: { toolReferences: true, toolSearch: true },
    })).capabilities).toEqual({ toolReferences: true, toolSearch: false })
    expect((await normalizeProviderConfig({
      ...OPENAI_RESPONSES_CONFIG,
      capabilities: { toolReferences: true, toolSearch: true },
    })).capabilities).toEqual({ toolReferences: false, toolSearch: true })
  })

  it('rejects malformed or unknown persisted Profiles', async () => {
    for (const value of ['{broken', JSON.stringify({ ...OPENAI_RESPONSES_CONFIG, providerId: 'unknown' })]) {
      expect(await resolveInitialProviderSelection(value, false)).toEqual({
        config: DEFAULT_PROVIDER_CONFIG,
        requiresSetup: true,
        requiresPersistenceMigration: false,
      })
    }
  })

  it('fails closed for malformed V4 fields instead of normalizing persisted data', async () => {
    const { capabilities: _capabilities, ...missingCapabilities } = OPENAI_RESPONSES_CONFIG
    for (const value of [
      missingCapabilities,
      { ...OPENAI_RESPONSES_CONFIG, timeoutMs: '60000' },
      { ...OPENAI_RESPONSES_CONFIG, maxOutputTokens: Number.NaN },
      { ...OPENAI_RESPONSES_CONFIG, capabilities: { toolReferences: false } },
      { ...OPENAI_RESPONSES_CONFIG, endpoint: ` ${OPENAI_RESPONSES_CONFIG.endpoint}` },
      { ...OPENAI_RESPONSES_CONFIG, capabilities: { toolReferences: true, toolSearch: true } },
      { ...OPENAI_RESPONSES_CONFIG, unexpected: true },
      { ...DEMO_PROVIDER_CONFIG, timeoutMs: DEMO_PROVIDER_CONFIG.timeoutMs + 1 },
    ]) {
      await expect(decodeProviderProfile(value)).rejects.toThrow()
    }
  })

  it('creates transport and probe through the Provider descriptor', () => {
    const { transport, model } = createProviderTransport(OPENAI_RESPONSES_CONFIG, true)
    expect(transport).toBeInstanceOf(OpenAIResponsesTransport)
    expect(model).toMatchObject({ provider: 'openai', model: 'gpt-5' })
    expect(BUILTIN_PROVIDER_RUNTIME.getProvider('openai')).toMatchObject({
      apiFormat: 'openai-responses',
      transportVersion: '10',
    })

    const probe = createProviderProbeRequest(OPENAI_RESPONSES_CONFIG, true)
    expect(probe).toMatchObject({
      providerId: 'openai',
      secretId: 'provider.openai-responses.api-key',
    })
    expect(JSON.parse(probe.body)).toEqual({
      model: 'gpt-5',
      input: 'Reply with OK.',
      max_output_tokens: 16,
      stream: false,
      store: false,
    })
  })

  it('passes the raw Anthropic endpoint to Rust for /v1/messages path completion', async () => {
    // Path 补全下沉到 Rust 侧 provider_profiles::resolve_profile（见 Rust 单测
    // anthropic_path_completion_*）。TS 侧只传原始 endpoint 作为覆盖项。
    const profile = await normalizeProviderConfig({
      ...defaultProviderProfile('generic-anthropic-compatible'),
      endpoint: 'https://open.bigmodel.cn/api/anthropic',
      modelId: 'GLM-5.1',
    })

    const probe = createProviderProbeRequest(profile, true)
    expect(probe.providerId).toBe('generic-anthropic-compatible')
    expect(probe.endpoint).toBe('https://open.bigmodel.cn/api/anthropic')
  })

  it('routes multi-protocol providers to the transport that matches the selected model wire', async () => {
    // OpenCode Go 是一个订阅三种 wire：chat completions / responses / messages。
    // transport 类决定请求体构造与 SSE 解析，必须按模型（而非 provider）选择。
    const go = await normalizeProviderConfig({
      ...defaultProviderProfile('opencode-go'),
      modelId: 'glm-5.3',
    })
    expect(go.apiFormat).toBe('openai-compatible')
    expect(createProviderTransport(go, true).transport).toBeInstanceOf(OpenAICompatibleTransport)

    const messages = await normalizeProviderConfig({ ...go, modelId: 'minimax-m3' })
    expect(createProviderTransport(messages, true).transport)
      .toBeInstanceOf(AnthropicCompatibleTransport)

    const responses = await normalizeProviderConfig({ ...go, modelId: 'grok-4.6' })
    expect(createProviderTransport(responses, true).transport)
      .toBeInstanceOf(OpenAIResponsesTransport)

    // 目录外的自定义 modelId 回落 provider 默认协议（chat）。
    const unknown = await normalizeProviderConfig({ ...go, modelId: 'some-new-model' })
    expect(createProviderTransport(unknown, true).transport)
      .toBeInstanceOf(OpenAICompatibleTransport)
  })

  it('builds probes with the wire-specific body shape for multi-protocol providers', async () => {
    const go = await normalizeProviderConfig({
      ...defaultProviderProfile('opencode-go'),
      modelId: 'minimax-m3',
    })
    const probe = createProviderProbeRequest(go, true)
    // 探针端点仍传 profile 原值（与 stream 同口径，由 Rust 按模型解析真实 URL），
    // 请求体则必须与该模型的协议一致（messages 形状）。
    expect(probe.endpoint).toBe('https://opencode.ai/zen/go/v1/chat/completions')
    expect(probe.modelId).toBe('minimax-m3')
    expect(JSON.parse(probe.body)).toEqual({
      model: 'minimax-m3',
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 1,
      stream: false,
    })

    const responsesProbe = createProviderProbeRequest(
      await normalizeProviderConfig({ ...go, modelId: 'grok-4.6' }),
      true,
    )
    expect(JSON.parse(responsesProbe.body)).toMatchObject({
      model: 'grok-4.6',
      max_output_tokens: 16,
      store: false,
    })
  })

  it('exposes the official site and invite link for subscription providers', () => {
    // 展示字段（UI-only）：设置页据此把官方入口与新用户优惠链接呈现给用户。
    expect(BUILTIN_PROVIDER_RUNTIME.getProvider('opencode-go')).toMatchObject({
      website: 'https://opencode.ai/go',
      inviteUrl: 'https://opencode.ai/go?ref=QQ1BKKXRTV',
    })
    // 未声明的 provider 不带这两个字段（UI 不渲染提示块）。
    expect(BUILTIN_PROVIDER_RUNTIME.getProvider('openai').website).toBeUndefined()
    expect(BUILTIN_PROVIDER_RUNTIME.getProvider('openai').inviteUrl).toBeUndefined()
    // 切换 provider 时草稿的「官网地址」展示字段预填 provider 官网（用户可改）。
    expect(defaultProviderProfile('opencode-go').website).toBe('https://opencode.ai/go')
    expect(defaultProviderProfile('openai').website).toBeUndefined()
  })

  it('requires an API key for the OpenCode Go subscription provider', () => {
    expect(providerRequiresApiKey('opencode-go')).toBe(true)
    expect(secretIdForProvider('opencode-go')).toBe('provider.opencode-go.api-key')
  })

  it('enforces required authentication only when creating executable Provider clients', async () => {
    expect(resolveProviderModel(OPENAI_RESPONSES_CONFIG)).toMatchObject({
      provider: 'openai',
      model: 'gpt-5',
    })
    expect(() => createProviderTransport(OPENAI_RESPONSES_CONFIG, false))
      .toThrow('缺少必需的 API Key')
    expect(() => createProviderProbeRequest(OPENAI_RESPONSES_CONFIG, false))
      .toThrow('缺少必需的 API Key')

    const optional = await normalizeProviderConfig({
      ...defaultProviderProfile('generic-openai-compatible'),
      modelId: 'local-model',
      endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
    })
    expect(() => createProviderTransport(optional, false)).not.toThrow()
    expect(() => createProviderProbeRequest(optional, false)).not.toThrow()
  })

  it('keeps the configured model as a compatibility catalog entry', () => {
    // 兼容条目能力未知 → input 省略（与 ProviderRegistry.resolveModel 目录外语义一致）。
    expect(listModelsForProfile(OPENAI_RESPONSES_CONFIG)).toContainEqual(expect.objectContaining({
      providerId: 'openai',
      modelId: 'gpt-5',
      source: 'profile-compatibility',
      input: undefined,
      supportsReasoning: false,
    }))
    expect(listModelsForProfile(ANTHROPIC_COMPATIBLE_CONFIG)).toContainEqual(expect.objectContaining({
      modelId: 'claude-test',
      source: 'profile-compatibility',
    }))
  })

  it('normalizes non-finite runtime limits before persistence', async () => {
    expect(await normalizeProviderConfig({
      ...ANTHROPIC_COMPATIBLE_CONFIG,
      timeoutMs: Number.NaN,
      maxOutputTokens: Number.NaN,
      contextWindow: Number.NaN,
    })).toMatchObject({ timeoutMs: 60_000, maxOutputTokens: 4_096, contextWindow: 128_000 })
  })
})

describe('resolvePromptModelName（提示词模型身份显示名回退）', () => {
  it('prefers an explicit modelName over the builtin label', () => {
    const profile = { ...defaultProviderProfile('deepseek'), modelName: '我的主力模型' }
    expect(resolvePromptModelName(profile)).toBe('我的主力模型')
  })

  it('falls back to the builtin catalog label for the configured modelId', () => {
    expect(resolvePromptModelName(defaultProviderProfile('deepseek'))).toBe('DeepSeek Flash')
    expect(resolvePromptModelName(defaultProviderProfile('minimax-chat'))).toBe('MiniMax abab6.5s')
  })

  it('returns undefined for a custom modelId outside the builtin catalog', () => {
    const profile = {
      ...defaultProviderProfile('generic-anthropic-compatible'),
      modelId: 'claude-3-5-sonnet',
    }
    expect(resolvePromptModelName(profile)).toBeUndefined()
  })

  it('keeps the demo provider identity-free', () => {
    expect(resolvePromptModelName(DEMO_PROVIDER_CONFIG)).toBeUndefined()
  })
})
