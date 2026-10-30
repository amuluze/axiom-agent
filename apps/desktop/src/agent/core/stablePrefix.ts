import { activeToolsForContext } from './deferredTools'
import { cloneJsonValue } from './snapshots'
import { splitSystemPromptLayout } from './systemPromptLayout'
import type {
  AgentContext,
  AgentTool,
  JsonValue,
  ModelRequestStablePrefix,
  ModelToolDefinition,
  ModelTransport,
} from './types'

interface StablePrefixEntry {
  baseSystemPrompt: string
  modelKey: string
  toolKey: string
  transport: ModelTransport
  tools: ModelToolDefinition[]
  fingerprint: string
  systemPromptBytes: number
  toolSchemaBytes: number
}

export interface ResolvedStablePrefix {
  tools: ModelToolDefinition[]
  diagnostics: ModelRequestStablePrefix
}

const textEncoder = new TextEncoder()

const byteLength = (value: string): number => textEncoder.encode(value).byteLength

const canonicalize = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, canonicalize(nested)]),
    )
  }
  return value
}

const digest = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest('SHA-256', textEncoder.encode(value))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const freezeJson = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    for (const nested of value) freezeJson(nested)
  } else if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeJson(nested)
  }
  return Object.freeze(value) as JsonValue
}

const freezeToolDefinitions = (tools: AgentTool[]): ModelToolDefinition[] => Object.freeze(
  tools.map((tool) => Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: freezeJson(cloneJsonValue(tool.inputSchema)) as Record<string, JsonValue>,
  })),
) as ModelToolDefinition[]

const modelKey = (context: AgentContext): string =>
  `${context.model.provider}\u0000${context.model.model}`

const toolKey = (tools: AgentTool[]): string =>
  tools.map((tool) => `${tool.name}\u0000${tool.runtimeVersion}`).join('\u0001')

export const stablePrefixInputsEqual = (
  left: AgentContext,
  right: AgentContext,
  leftTransport: ModelTransport,
  rightTransport: ModelTransport,
): boolean => splitSystemPromptLayout(left.systemPrompt).stablePrefix
    === splitSystemPromptLayout(right.systemPrompt).stablePrefix
  && modelKey(left) === modelKey(right)
  && toolKey(activeToolsForContext(left)) === toolKey(activeToolsForContext(right))
  && leftTransport === rightTransport

export class ModelRequestStablePrefixCache {
  private entry?: StablePrefixEntry
  private revision = 0

  invalidate(): void {
    this.entry = undefined
  }

  async resolve(
    context: AgentContext,
    transport: ModelTransport,
    baseSystemPrompt: string,
    effectiveSystemPrompt: string,
  ): Promise<ResolvedStablePrefix> {
    const stableSystemPrompt = splitSystemPromptLayout(baseSystemPrompt).stablePrefix
    const activeTools = activeToolsForContext(context)
    const nextModelKey = modelKey(context)
    const nextToolKey = toolKey(activeTools)
    let entry = this.entry
    if (
      !entry
      || entry.baseSystemPrompt !== stableSystemPrompt
      || entry.modelKey !== nextModelKey
      || entry.toolKey !== nextToolKey
      || entry.transport !== transport
    ) {
      const tools = freezeToolDefinitions(activeTools)
      const canonicalTools = JSON.stringify(canonicalize(tools as unknown as JsonValue))
      const canonicalPrefix = JSON.stringify({
        model: nextModelKey,
        systemPrompt: stableSystemPrompt,
        tools: JSON.parse(canonicalTools) as JsonValue,
      })
      this.revision += 1
      entry = {
        baseSystemPrompt: stableSystemPrompt,
        modelKey: nextModelKey,
        toolKey: nextToolKey,
        transport,
        tools,
        fingerprint: await digest(canonicalPrefix),
        systemPromptBytes: byteLength(stableSystemPrompt),
        toolSchemaBytes: byteLength(canonicalTools),
      }
      this.entry = entry
    }
    const suffix = effectiveSystemPrompt.startsWith(stableSystemPrompt)
      ? effectiveSystemPrompt.slice(stableSystemPrompt.length)
      : effectiveSystemPrompt
    return {
      tools: entry.tools,
      diagnostics: {
        fingerprint: entry.fingerprint,
        revision: this.revision,
        systemPromptBytes: entry.systemPromptBytes,
        toolSchemaBytes: entry.toolSchemaBytes,
        dynamicSuffixBytes: byteLength(suffix),
      },
    }
  }
}
