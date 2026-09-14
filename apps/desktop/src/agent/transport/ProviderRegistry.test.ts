import { describe, expect, it } from 'vitest'
import { BUILTIN_PROVIDER_REGISTRY } from './ProviderRegistry'
import { PROVIDER_PROFILE_SCHEMA_VERSION } from './providerProfile'

const baseProfile = {
  schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
  profileId: 'profile-1',
  timeoutMs: 60_000,
  maxOutputTokens: 4_096,
  contextWindow: 128_000,
  capabilities: { toolReferences: true, toolSearch: false },
}

const anthropicProfile = {
  ...baseProfile,
  providerId: 'generic-anthropic-compatible' as const,
  apiFormat: 'anthropic-compatible' as const,
  endpoint: 'https://api.anthropic.com/v1/messages',
  modelId: 'claude-3-5-sonnet',
  secretId: 'provider.generic-anthropic-compatible.api-key',
}

const openaiProfile = {
  ...baseProfile,
  providerId: 'openai' as const,
  apiFormat: 'openai-responses' as const,
  endpoint: 'https://api.openai.com/v1/responses',
  modelId: 'gpt-5-mini',
  secretId: 'provider.openai-responses.api-key',
  capabilities: { toolReferences: false, toolSearch: true },
}

describe('ProviderRegistry (builtin)', () => {
  it('lists and resolves every builtin provider', () => {
    expect(BUILTIN_PROVIDER_REGISTRY.list().map((provider) => provider.providerId).sort())
      .toEqual([
        'custom-anthropic-compatible',
        'custom-openai-compatible',
        'deepseek',
        'demo',
        'gemini',
        'generic-anthropic-compatible',
        'generic-openai-compatible',
        'kimi',
        'kimi-coding',
        'minimax-chat',
        'ollama',
        'openai',
        'orcarouter',
        'zhipu-glm',
      ])
    expect(BUILTIN_PROVIDER_REGISTRY.get('demo').label).toBe('离线 Demo')
    expect(BUILTIN_PROVIDER_REGISTRY.get('orcarouter').label).toBe('OrcaRouter')
    expect(() => BUILTIN_PROVIDER_REGISTRY.get('unknown' as never)).toThrow('Provider 未注册')
  })

  it('normalizes profiles (drift/mismatch are rejected earlier at the profile layer)', () => {
    expect(BUILTIN_PROVIDER_REGISTRY.normalize(anthropicProfile).providerId)
      .toBe('generic-anthropic-compatible')
    // registry 层的协议身份漂移与 secret 不匹配检查是防御性兜底；
    // normalizeProviderProfile 已在更早的 profile 层拦截这两种情况。
    expect(() => BUILTIN_PROVIDER_REGISTRY.normalize({ ...anthropicProfile, apiFormat: 'demo' }))
      .toThrow()
    expect(() => BUILTIN_PROVIDER_REGISTRY.normalize({
      ...anthropicProfile,
      secretId: 'provider.openai-responses.api-key',
    })).toThrow()
  })

  it('resolves model metadata from the builtin model catalog', () => {
    const demoModel = BUILTIN_PROVIDER_REGISTRY.resolveModel({
      ...anthropicProfile,
      providerId: 'demo',
      apiFormat: 'demo',
      endpoint: '',
      modelId: 'demo-v1',
    })
    expect(demoModel).toMatchObject({ provider: 'axiom', model: 'demo-v1' })
    expect(demoModel.input).toEqual(['text'])
    expect(demoModel.supportsReasoning).toBe(false)
  })

  it('resolveModel 优先使用模型目录的 contextWindow（非 provider 默认值）', () => {
    // profile 声明 1_000_000（zhipu-glm provider 默认），但 glm-4.6 目录值为 200_000。
    // 修复前：返回 profile 值 1_000_000；修复后：返回目录值 200_000。
    const zhipuProfile = {
      ...baseProfile,
      providerId: 'zhipu-glm' as const,
      apiFormat: 'openai-compatible' as const,
      endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
      modelId: 'glm-4.6',
      secretId: 'provider.zhipu-glm.api-key',
      contextWindow: 1_000_000,
    }
    const model = BUILTIN_PROVIDER_REGISTRY.resolveModel(zhipuProfile)
    expect(model.contextWindow).toBe(200_000)
  })

  it('resolveModel 对目录外自定义模型回退 profile contextWindow', () => {
    const customProfile = {
      ...baseProfile,
      providerId: 'zhipu-glm' as const,
      apiFormat: 'openai-compatible' as const,
      endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
      modelId: 'custom-finetuned',
      secretId: 'provider.zhipu-glm.api-key',
      contextWindow: 64_000,
    }
    const model = BUILTIN_PROVIDER_REGISTRY.resolveModel(customProfile)
    // 不在目录中 → builtin 为 undefined → 回退 profile 值
    expect(model.contextWindow).toBe(64_000)
  })

  it('resolveModel 对目录外模型省略 input（能力未知，不触发图片硬闸）', () => {
    const customProfile = {
      ...baseProfile,
      providerId: 'zhipu-glm' as const,
      apiFormat: 'openai-compatible' as const,
      endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
      modelId: 'custom-finetuned',
      secretId: 'provider.zhipu-glm.api-key',
      contextWindow: 64_000,
    }
    const model = BUILTIN_PROVIDER_REGISTRY.resolveModel(customProfile)
    expect(model.input).toBeUndefined()
  })

  it('resolveModel 对目录内多模态模型标注 image 输入', () => {
    const glmFlashProfile = {
      ...baseProfile,
      providerId: 'zhipu-glm' as const,
      apiFormat: 'openai-compatible' as const,
      endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
      modelId: 'glm-5.3-flash',
      secretId: 'provider.zhipu-glm.api-key',
    }
    const model = BUILTIN_PROVIDER_REGISTRY.resolveModel(glmFlashProfile)
    expect(model.input).toEqual(['text', 'image'])
    expect(model.supportsReasoning).toBe(true)
  })

  it('creates a transport only when a required API key is present', () => {
    // openai（auth.required=true）缺 key 必须失败；anthropic（required=false）可无 key 创建。
    expect(() => BUILTIN_PROVIDER_REGISTRY.createTransport(openaiProfile, false))
      .toThrow('缺少必需的 API Key')

    const openai = BUILTIN_PROVIDER_REGISTRY.createTransport(openaiProfile, true)
    expect(openai.model.model).toBe('gpt-5-mini')

    const anthropic = BUILTIN_PROVIDER_REGISTRY.createTransport(anthropicProfile, false)
    expect(anthropic.model.provider).toBe('generic-anthropic-compatible')
  })

  it('creates probes and normalizes anthropic endpoint URLs', () => {
    expect(() => BUILTIN_PROVIDER_REGISTRY.createProbe(
      { ...anthropicProfile, providerId: 'demo', apiFormat: 'demo', endpoint: '' },
      false,
    )).toThrow('离线 Demo 不需要连通性验证')

    expect(() => BUILTIN_PROVIDER_REGISTRY.createProbe(openaiProfile, false))
      .toThrow('缺少必需的 API Key')

    const probe = BUILTIN_PROVIDER_REGISTRY.createProbe(openaiProfile, true)
    expect(probe).toMatchObject({ providerId: 'openai', secretId: 'provider.openai-responses.api-key' })
  })

  it('resolves secret ids with the default fallback and rejects demo', () => {
    expect(BUILTIN_PROVIDER_REGISTRY.secretId({ ...anthropicProfile, secretId: undefined }))
      .toBe('provider.generic-anthropic-compatible.api-key')
    expect(BUILTIN_PROVIDER_REGISTRY.secretId(openaiProfile))
      .toBe('provider.openai-responses.api-key')
    expect(() => BUILTIN_PROVIDER_REGISTRY.secretId({
      ...anthropicProfile, providerId: 'demo', apiFormat: 'demo', endpoint: '',
    })).toThrow('离线 Demo 没有 Secret ID')
  })
})
