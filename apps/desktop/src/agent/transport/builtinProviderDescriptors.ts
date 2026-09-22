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
  endpoint: string,
  body: Record<string, unknown>,
): ModelProbeRequest => ({
  providerId: profile.providerId,
  endpoint,
  body: JSON.stringify(body),
  secretId,
  timeoutMs: Math.min(profile.timeoutMs, 30_000),
  // 探针也按模型选 wire：多协议 provider 的探测请求体必须与该模型的协议一致。
  modelId: profile.modelId,
})

/** 生成数据里 provider 可用的三种 wire（不含 demo）。 */
type ProviderWireFormat = GeneratedProviderData['apiFormat']

/**
 * 模型级 wire 解析：多协议网关（如 OpenCode Go）在同一 provider 下按模型分发到不同
 * 协议与端点。未声明 wire 的模型用 provider 默认——目录外的自定义 modelId 也走默认。
 *
 * 注意：这里只决定 **transport 类**（决定请求体构造与 SSE 解析）；最终请求 URL 与
 * apiFormat 由 Rust `resolve_profile` 按同一份生成表权威解析，TS 传的 endpoint 仍是
 * profile 原值（与既有一致）。
 */
const wireFor = (
  data: GeneratedProviderData,
  modelId: string,
): { apiFormat: ProviderWireFormat; endpoint: string } => {
  const model = data.models.find((candidate) => candidate.modelId === modelId)
  return model?.wire
    ? { apiFormat: model.wire.apiFormat, endpoint: model.wire.endpoint }
    : { apiFormat: data.apiFormat, endpoint: data.defaultProfile.endpoint }
}

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

const transportFactoryFor = (
  wire: ProviderWireFormat,
  providerId: string,
): TransportFactory => {
  switch (wire) {
    case 'openai-responses':
      return (profile, secretId) => new OpenAIResponsesTransport({
        providerId,
        endpoint: profile.endpoint,
        secretId,
        timeoutMs: profile.timeoutMs,
        maxTokens: profile.maxOutputTokens,
        supportsToolSearch: profile.capabilities.toolSearch,
      })
    case 'anthropic-compatible':
      return (profile, secretId) => new AnthropicCompatibleTransport({
        providerId,
        endpoint: profile.endpoint,
        secretId,
        timeoutMs: profile.timeoutMs,
        maxTokens: profile.maxOutputTokens,
        supportsToolReferences: profile.capabilities.toolReferences,
      })
    case 'openai-compatible':
      return (profile, secretId) => new OpenAICompatibleTransport({
        providerId,
        endpoint: profile.endpoint,
        secretId,
        timeoutMs: profile.timeoutMs,
        maxTokens: profile.maxOutputTokens,
      })
  }
}

const transportFor = (data: GeneratedProviderData): TransportFactory =>
  (profile, secretId) => transportFactoryFor(
    wireFor(data, profile.modelId).apiFormat,
    data.id,
  )(profile, secretId)

const probeBodyFor = (
  wire: ProviderWireFormat,
  profile: ProviderProfile,
): Record<string, unknown> => {
  switch (wire) {
    case 'openai-responses':
      return {
        model: profile.modelId,
        input: 'Reply with OK.',
        max_output_tokens: 16,
        stream: false,
        store: false,
      }
    case 'anthropic-compatible':
      return {
        model: profile.modelId,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
        stream: false,
      }
    case 'openai-compatible':
      return {
        model: profile.modelId,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
        stream: false,
      }
  }
}

const probeFor = (data: GeneratedProviderData): BuiltinProviderDescriptor['createProbe'] =>
  (profile, secretId) => {
    // endpoint 传 profile 原值（与 stream 路径同口径）：Rust 会按同一个模型规则解析出
    // 该模型协议的真实 URL（含用户的 host 覆盖），探针与真实请求因此走同一端点。
    const { apiFormat } = wireFor(data, profile.modelId)
    return probeRequest(profile, secretId, profile.endpoint, probeBodyFor(apiFormat, profile))
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
    ...(data.website ? { website: data.website } : {}),
    ...(data.inviteUrl ? { inviteUrl: data.inviteUrl } : {}),
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
