import type { ModelRef } from '@/agent/core/types'
import type { ProviderId, ProviderProfile, ProviderProfileDraft } from './providerProfile'
import { getProviderDefinition, listProviderDefinitions } from './providerDefinitions'

export type ModelCatalogSource = 'builtin' | 'profile-compatibility'

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
    // 能力未知 → input 省略，与 ProviderRegistry.resolveModel 的目录外语义一致。
    input: undefined,
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
