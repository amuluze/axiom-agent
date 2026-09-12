import type { ModelTransport } from '@/agent/core/types'
import type { ModelProbeRequest } from './modelHttpContract'
import { AnthropicCompatibleTransport } from './AnthropicCompatibleTransport'
import { DemoModelTransport } from './DemoModelTransport'
import { OpenAICompatibleTransport } from './OpenAICompatibleTransport'
import { OpenAIResponsesTransport } from './OpenAIResponsesTransport'
import {
  PROVIDER_CONSTANTS,
  PROVIDER_DATA,
  type GeneratedProviderData,
} from './generatedProviderData'
import type { ProviderDefinition } from './providerDefinitions'
import type { ProviderId, ProviderProfile } from './providerProfile'

type TransportFactory = (
  profile: ProviderProfile,
  secretId?: string,
) => ModelTransport

export interface BuiltinProviderDescriptor extends ProviderDefinition {
  readonly createTransport: TransportFactory
  readonly createProbe?: (profile: ProviderProfile, secretId?: string) => ModelProbeRequest
}

const probeRequest = (
  profile: ProviderProfile,
  secretId: string | undefined,
  body: Record<string, unknown>,
): ModelProbeRequest => ({
  providerId: profile.providerId,
  endpoint: profile.endpoint,
  body: JSON.stringify(body),
  secretId,
  timeoutMs: Math.min(profile.timeoutMs, 30_000),
})

const freezeDescriptor = (descriptor: BuiltinProviderDescriptor): BuiltinProviderDescriptor => {
  const auth = Object.freeze({ ...descriptor.auth })
  const defaultProfile = Object.freeze({
    ...descriptor.defaultProfile,
    capabilities: Object.freeze({ ...descriptor.defaultProfile.capabilities }),
  })
  const models = Object.freeze(descriptor.models.map((model) => Object.freeze({
    ...model,
    input: Object.freeze(model.input.slice()),
  })))
  return Object.freeze({
    ...descriptor,
    auth,
    supportedCapabilities: Object.freeze({ ...descriptor.supportedCapabilities }),
    defaultProfile,
    models,
  })
}

const transportFor = (data: GeneratedProviderData): TransportFactory => {
  switch (data.apiFormat) {
    case 'openai-responses':
      return (profile, secretId) => new OpenAIResponsesTransport({
        providerId: data.id,
        endpoint: profile.endpoint,
        secretId,
        timeoutMs: profile.timeoutMs,
        maxTokens: profile.maxOutputTokens,
        supportsToolSearch: profile.capabilities.toolSearch,
      })
    case 'anthropic-compatible':
      return (profile, secretId) => new AnthropicCompatibleTransport({
        providerId: data.id,
        endpoint: profile.endpoint,
        secretId,
        timeoutMs: profile.timeoutMs,
        maxTokens: profile.maxOutputTokens,
        supportsToolReferences: profile.capabilities.toolReferences,
      })
    case 'openai-compatible':
      return (profile, secretId) => new OpenAICompatibleTransport({
        providerId: data.id,
        endpoint: profile.endpoint,
        secretId,
        timeoutMs: profile.timeoutMs,
        maxTokens: profile.maxOutputTokens,
      })
  }
}

const probeFor = (data: GeneratedProviderData): BuiltinProviderDescriptor['createProbe'] => {
  switch (data.apiFormat) {
    case 'openai-responses':
      return (profile, secretId) => probeRequest(profile, secretId, {
        model: profile.modelId,
        input: 'Reply with OK.',
        max_output_tokens: 16,
        stream: false,
        store: false,
      })
    case 'anthropic-compatible':
      return (profile, secretId) => probeRequest(profile, secretId, {
        model: profile.modelId,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
        stream: false,
      })
    case 'openai-compatible':
      return (profile, secretId) => probeRequest(profile, secretId, {
        model: profile.modelId,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
        stream: false,
      })
  }
}

const descriptorFromData = (data: GeneratedProviderData): BuiltinProviderDescriptor =>
  freezeDescriptor({
    providerId: data.id as ProviderId,
    label: data.label,
    apiFormat: data.apiFormat,
    transportVersion: data.transportVersion,
    auth: data.auth,
    supportedCapabilities: { ...data.supportedCapabilities },
    defaultProfile: {
      ...data.defaultProfile,
      capabilities: { ...data.defaultProfile.capabilities },
    },
    models: data.models.map((model) => ({
      modelId: model.modelId,
      label: model.label,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      input: [...model.input],
      supportsReasoning: model.supportsReasoning,
    })),
    createTransport: transportFor(data),
    createProbe: probeFor(data),
  })

const demoDescriptor: BuiltinProviderDescriptor = freezeDescriptor({
  providerId: 'demo',
  label: '离线 Demo',
  apiFormat: 'demo',
  transportVersion: '3',
  auth: { kind: 'none' },
  supportedCapabilities: { toolReferences: false, toolSearch: false },
  defaultProfile: {
    profileId: 'builtin.demo',
    endpoint: '',
    modelId: 'demo-v1',
    timeoutMs: PROVIDER_CONSTANTS.timeoutDefaultMs,
    maxOutputTokens: PROVIDER_CONSTANTS.maxOutputDefault,
    contextWindow: PROVIDER_CONSTANTS.contextDefault,
    capabilities: { toolReferences: false, toolSearch: false },
  },
  models: [{
    modelId: 'demo-v1',
    label: 'Axiom Demo',
    contextWindow: PROVIDER_CONSTANTS.contextDefault,
    maxOutputTokens: PROVIDER_CONSTANTS.maxOutputDefault,
    input: ['text'],
    supportsReasoning: false,
  }],
  createTransport: () => new DemoModelTransport(),
})

export const BUILTIN_PROVIDER_DESCRIPTORS: readonly BuiltinProviderDescriptor[] = Object.freeze([
  demoDescriptor,
  ...PROVIDER_DATA.map(descriptorFromData),
])
