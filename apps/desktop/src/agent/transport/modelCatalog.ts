import type { ModelRef } from '@/agent/core/types'
import type { ProviderId, ProviderProfile, ProviderProfileDraft } from './providerProfile'
import { getProviderDefinition, listProviderDefinitions } from './providerDefinitions'

export type ModelCatalogSource = 'builtin' | 'profile-compatibility'

/** 能力结论的两种可观测语义（Domain 不变量 1：判定只有这两种）。 */
export type ImageInputCapability = 'text' | 'image'

export interface ModelDescriptor {
  providerId: ProviderId
  modelId: string
  label: string
  contextWindow: number
  maxOutputTokens: number
  input: ModelRef['input']
  supportsReasoning: boolean
  source: ModelCatalogSource
}

export const listBuiltinModels = (providerId?: ProviderId): ModelDescriptor[] =>
  listProviderDefinitions()
    .filter((definition) => providerId === undefined || definition.providerId === providerId)
    .flatMap((definition) => definition.models.map((model) => ({
      ...structuredClone(model),
      input: model.input.slice(),
      providerId: definition.providerId,
      source: 'builtin' as const,
    })))

/**
 * 单一能力判定入口（Domain 不变量 1/2/3）：显式声明优先且单向覆盖目录标注，
 * 未声明（`catalog`）时目录内取目录标注、目录外一律仅文本（fail-safe——能力
 * 未知不得被解释为支持图片），demo 恒为仅文本（其 profile 归一化会丢弃用户
 * 字段，声明无处存放）。所有消费点（请求组装的图片降级、工具产图、附加图片）
 * 都只读本函数的结果，不得就地重新推断。
 */
export const resolveImageInputCapability = (
  profile: Pick<ProviderProfile, 'providerId' | 'imageInput'> & { modelId?: string },
): ImageInputCapability => {
  if (profile.providerId === 'demo') return 'text'
  if (profile.imageInput === 'text') return 'text'
  if (profile.imageInput === 'image') return 'image'
  const builtin = getProviderDefinition(profile.providerId).models.find((model) => (
    model.modelId === profile.modelId
  ))
  return builtin?.input.includes('image') ? 'image' : 'text'
}

/**
 * 判定结果 → ModelRef.input 的模态数组（Domain 不变量 1：恒有值，不再是三态
 * undefined）。恒有值是「不抛错、改为降级」的前置条件：input 恒有值后请求侧
 * 必定进入 stripUnsupportedImages 分支，能力未知不再被解释为「放行图片」。
 */
export const imageInputModalities = (profile: ProviderProfile): NonNullable<ModelRef['input']> =>
  resolveImageInputCapability(profile) === 'image' ? ['text', 'image'] : ['text']

/** 判定依据（设置页可解释性，Domain 结果约束）：声明 / 目录 / 目录外默认。 */
export type ImageInputBasis = 'declaration' | 'catalog' | 'catalog-missing'

/**
 * 判定结果 + 依据（设置页展示用）。结论仍只出自 resolveImageInputCapability——
 * 本函数只补充「为什么」，不做第二次推断。
 */
export const describeImageInputCapability = (
  profile: Pick<ProviderProfile, 'providerId' | 'imageInput'> & { modelId?: string },
): { capability: ImageInputCapability; basis: ImageInputBasis } => {
  const capability = resolveImageInputCapability(profile)
  if (profile.imageInput === 'text' || profile.imageInput === 'image') {
    return { capability, basis: 'declaration' }
  }
  // demo 的归一化固定契约不携带声明、也不在任何目录内：依据同目录外默认
  // （结论恒为仅文本，与此分类一致）。
  const inCatalog = profile.providerId !== 'demo' && getProviderDefinition(profile.providerId)
    .models.some((model) => model.modelId === profile.modelId)
  return { capability, basis: inCatalog ? 'catalog' : 'catalog-missing' }
}

export const resolveModelDescriptor = (profile: ProviderProfile): ModelDescriptor => {
  const builtin = getProviderDefinition(profile.providerId).models.find((model) => (
    model.modelId === profile.modelId
  ))
  if (builtin) {
    return {
      ...structuredClone(builtin),
      providerId: profile.providerId,
      input: builtin.input.slice(),
      contextWindow: profile.contextWindow,
      maxOutputTokens: profile.maxOutputTokens,
      source: 'builtin',
    }
  }
  return {
    providerId: profile.providerId,
    modelId: profile.modelId,
    label: profile.modelId,
    contextWindow: profile.contextWindow,
    maxOutputTokens: profile.maxOutputTokens,
    // 目录外模型：按 Domain 不变量 2 判定为仅文本（不再返回 undefined），
    // 与 ProviderRegistry.resolveModel 走同一判定入口。
    input: imageInputModalities(profile),
    supportsReasoning: false,
    source: 'profile-compatibility',
  }
}

export const listModelsForProfile = (profile: ProviderProfileDraft): ModelDescriptor[] => {
  const models = listBuiltinModels(profile.providerId)
  if (profile.modelId && !models.some((model) => model.modelId === profile.modelId)) {
    models.push(resolveModelDescriptor({ ...profile, modelId: profile.modelId }))
  }
  return models
}
