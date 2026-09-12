import type { ModelRef, ProviderApiFormat } from '@/agent/core/types'
import { BUILTIN_PROVIDER_DESCRIPTORS } from './builtinProviderDescriptors'
import type { PROVIDER_IDS } from './generatedProviderData'

export type ProviderId = 'demo' | (typeof PROVIDER_IDS)[number]

export interface ProviderCapabilities {
  toolReferences: boolean
  toolSearch: boolean
}

export type ProviderAuthDefinition =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'api-key'
      readonly defaultSecretId: string
      readonly required: boolean
    }

export interface ProviderModelDefinition {
  readonly modelId: string
  readonly label: string
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly input: readonly NonNullable<ModelRef['input']>[number][]
  readonly supportsReasoning: boolean
}

export interface ProviderDefinition {
  readonly providerId: ProviderId
  readonly label: string
  readonly apiFormat: ProviderApiFormat
  readonly transportVersion: string
  readonly auth: ProviderAuthDefinition
  readonly supportedCapabilities: Readonly<ProviderCapabilities>
  readonly defaultProfile: {
    readonly profileId: string
    readonly endpoint: string
    readonly modelId: string
    readonly timeoutMs: number
    readonly maxOutputTokens: number
    readonly contextWindow: number
    readonly capabilities: Readonly<ProviderCapabilities>
  }
  readonly models: readonly ProviderModelDefinition[]
}

const freezeDefinition = (definition: ProviderDefinition): ProviderDefinition => {
  const auth = definition.auth.kind === 'api-key'
    ? Object.freeze({ ...definition.auth })
    : Object.freeze({ ...definition.auth })
  const defaultProfile = Object.freeze({
    ...definition.defaultProfile,
    capabilities: Object.freeze({ ...definition.defaultProfile.capabilities }),
  })
  const models = Object.freeze(definition.models.map((model) => Object.freeze({
    ...model,
    input: Object.freeze(model.input.slice()),
  })))
  return Object.freeze({
    ...definition,
    auth,
    supportedCapabilities: Object.freeze({ ...definition.supportedCapabilities }),
    defaultProfile,
    models,
  })
}

const DEFINITIONS: readonly ProviderDefinition[] = Object.freeze(
  BUILTIN_PROVIDER_DESCRIPTORS.map((descriptor) => freezeDefinition({
    providerId: descriptor.providerId,
    label: descriptor.label,
    apiFormat: descriptor.apiFormat,
    transportVersion: descriptor.transportVersion,
    auth: descriptor.auth,
    supportedCapabilities: descriptor.supportedCapabilities,
    defaultProfile: descriptor.defaultProfile,
    models: descriptor.models,
  })),
)

export class ProviderCatalog {
  readonly mode = 'builtin-only' as const
  private readonly definitions: ReadonlyMap<ProviderId, ProviderDefinition>

  constructor(definitions: readonly ProviderDefinition[]) {
    const entries = definitions.map((definition) => [
      definition.providerId,
      freezeDefinition(structuredClone(definition)),
    ] as const)
    if (new Set(entries.map(([providerId]) => providerId)).size !== entries.length) {
      throw new Error('Provider Catalog 包含重复项')
    }
    this.definitions = new Map(entries)
  }

  has(providerId: string): providerId is ProviderId {
    return this.definitions.has(providerId as ProviderId)
  }

  get(providerId: ProviderId): ProviderDefinition {
    const definition = this.definitions.get(providerId)
    if (!definition) throw new Error(`Provider 未定义：${providerId}`)
    return definition
  }

  list(): ProviderDefinition[] {
    return [...this.definitions.values()].map((definition) => structuredClone(definition))
  }
}

export const BUILTIN_PROVIDER_CATALOG = new ProviderCatalog(DEFINITIONS)

export const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === 'string' && BUILTIN_PROVIDER_CATALOG.has(value)

export const getProviderDefinition = (providerId: ProviderId): ProviderDefinition =>
  BUILTIN_PROVIDER_CATALOG.get(providerId)

export const listProviderDefinitions = (): ProviderDefinition[] =>
  BUILTIN_PROVIDER_CATALOG.list()
