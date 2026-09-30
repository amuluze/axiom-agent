import { describe, expect, it } from 'vitest'
import { imageInputModalities, resolveImageInputCapability } from './modelCatalog'
import {
  decodeProviderProfile,
  PROVIDER_PROFILE_SCHEMA_VERSION,
  type ProviderProfile,
} from './providerProfile'

const profile = (overrides: Partial<ProviderProfile> & Pick<ProviderProfile, 'providerId' | 'modelId'>) => ({
  schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
  profileId: 'test.profile',
  apiFormat: 'openai-compatible',
  endpoint: 'https://example.com/v1/chat/completions',
  timeoutMs: 60_000,
  maxOutputTokens: 4_096,
  contextWindow: 128_000,
  capabilities: { toolReferences: false, toolSearch: false },
  ...overrides,
}) as ProviderProfile

describe('resolveImageInputCapability：单一能力判定入口', () => {
  it('目录内多模态模型取目录标注（支持图片）', () => {
    const model = profile({ providerId: 'zhipu-glm', modelId: 'glm-5.3-flash' })
    expect(resolveImageInputCapability(model)).toBe('image')
    expect(imageInputModalities(model)).toEqual(['text', 'image'])
  })

  it('目录内纯文本模型取目录标注（仅文本）', () => {
    const model = profile({ providerId: 'minimax-chat', modelId: 'minimax-text-01' })
    expect(resolveImageInputCapability(model)).toBe('text')
    expect(imageInputModalities(model)).toEqual(['text'])
  })

  // Domain 不变量 2：能力未知不得被解释为支持图片（fail-safe）。
  it('目录外模型一律判定为仅文本（不省略 input）', () => {
    const model = profile({ providerId: 'zhipu-glm', modelId: 'custom-finetuned-9000' })
    expect(resolveImageInputCapability(model)).toBe('text')
    expect(imageInputModalities(model)).toEqual(['text'])
  })

  it('demo 恒为仅文本（其 profile 归一化会丢弃用户字段，声明无处存放）', () => {
    const demo = profile({
      providerId: 'demo',
      modelId: 'demo-v1',
      apiFormat: 'demo',
      endpoint: '',
    })
    expect(resolveImageInputCapability(demo)).toBe('text')
    expect(imageInputModalities(demo)).toEqual(['text'])
  })

  it('同一 profile 的判定与模态数组互为一致（不出现两处结论）', () => {
    const cases = [
      profile({ providerId: 'zhipu-glm', modelId: 'glm-5.3-flash' }),
      profile({ providerId: 'minimax-chat', modelId: 'minimax-text-01' }),
      profile({ providerId: 'zhipu-glm', modelId: 'custom-finetuned-9000' }),
    ]
    for (const model of cases) {
      const capability = resolveImageInputCapability(model)
      expect(imageInputModalities(model).includes('image')).toBe(capability === 'image')
    }
  })
})

// Domain 不变量 3：显式声明单向覆盖目录标注（两个方向都要成立）。
describe('显式声明覆盖目录标注', () => {
  it('目录外模型声明「支持图片」后判定为支持图片，改回「仅文本」后仅文本', () => {
    const declared = (imageInput: 'catalog' | 'text' | 'image') => profile({
      providerId: 'zhipu-glm',
      modelId: 'custom-finetuned-9000',
      imageInput,
    })
    expect(resolveImageInputCapability(declared('catalog'))).toBe('text')
    expect(resolveImageInputCapability(declared('image'))).toBe('image')
    expect(imageInputModalities(declared('image'))).toEqual(['text', 'image'])
    expect(resolveImageInputCapability(declared('text'))).toBe('text')
  })

  it('目录内多模态模型显式声明「仅文本」后判定为仅文本', () => {
    const model = profile({
      providerId: 'zhipu-glm',
      modelId: 'glm-5.3-flash',
      imageInput: 'text',
    })
    expect(resolveImageInputCapability(model)).toBe('text')
  })

  it('目录内纯文本模型显式声明「支持图片」后判定为支持图片', () => {
    const model = profile({
      providerId: 'minimax-chat',
      modelId: 'minimax-text-01',
      imageInput: 'image',
    })
    expect(resolveImageInputCapability(model)).toBe('image')
  })

  it('声明经 profile 文档解码后生效（判定读的是落库值而非 UI 内存态）', async () => {
    const decoded = await decodeProviderProfile({
      schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
      profileId: 'work.glm',
      providerId: 'zhipu-glm',
      apiFormat: 'openai-compatible',
      endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
      modelId: 'custom-finetuned-9000',
      timeoutMs: 60_000,
      maxOutputTokens: 4_096,
      contextWindow: 128_000,
      capabilities: { toolReferences: false, toolSearch: false },
      imageInput: 'image',
    })
    expect(decoded.imageInput).toBe('image')
    expect(resolveImageInputCapability(decoded)).toBe('image')
  })

  it('demo 即使携带声明也恒为仅文本（归一化固定契约丢弃用户字段）', () => {
    const demo = profile({
      providerId: 'demo',
      modelId: 'demo-v1',
      apiFormat: 'demo',
      endpoint: '',
      imageInput: 'image',
    })
    expect(resolveImageInputCapability(demo)).toBe('text')
  })
})

// 验收 14：判定以 profile 为粒度，无跨会话共享的单值缓存。
describe('多 profile 与跨会话判定独立', () => {
  it('两个 profile 的声明互不影响（反复判定不串档）', () => {
    const textOnly = profile({ providerId: 'zhipu-glm', modelId: 'glm-5.3-flash', imageInput: 'text' })
    const withImage = profile({
      providerId: 'zhipu-glm',
      modelId: 'custom-finetuned-9000',
      imageInput: 'image',
    })
    for (const round of [1, 2]) {
      expect(resolveImageInputCapability(textOnly), `round=${round}`).toBe('text')
      expect(resolveImageInputCapability(withImage), `round=${round}`).toBe('image')
    }
  })

  it('同一模型仅改声明即翻转结论（无隐藏缓存）', () => {
    const base = { providerId: 'zhipu-glm' as const, modelId: 'glm-5.3-flash' }
    expect(resolveImageInputCapability(profile({ ...base, imageInput: 'catalog' }))).toBe('image')
    expect(resolveImageInputCapability(profile({ ...base, imageInput: 'text' }))).toBe('text')
    expect(resolveImageInputCapability(profile({ ...base, imageInput: 'catalog' }))).toBe('image')
  })
})
