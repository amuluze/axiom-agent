import { createId } from '@/agent/core/id'
import type {
  CacheControl,
  ImageContentBlock,
  JsonValue,
  ModelMessage,
  ModelRef,
  ModelDoneReason,
  ModelRequest,
  ModelStreamEvent,
  ModelToolDefinition,
  ModelTransport,
  ModelTransportLifecycle,
  TokenUsage,
} from '@/agent/core/types'
import {
  assistantContentBlocks,
  toolResultContentBlocks,
  userContentBlocks,
} from '@/agent/core/messages'
import { classifyProviderError } from '@/agent/core/providerError'
import type { ModelHttpRequest } from './modelHttpContract'
import { getDefaultHttpStream } from './httpStreamBinding'
import type { ModelHttpStreamFactory } from './OpenAICompatibleTransport'
import { parseServerSentEvents } from './sse'
import { notifyProviderResponse, prepareProviderRequest } from './providerLifecycle'
import {
  ANTHROPIC_PACKET_SCHEMAS,
  validateProviderPacket,
} from './providerPacketSchema'

export interface AnthropicCompatibleConfig {
  providerId: string
  endpoint: string
  secretId?: string
  timeoutMs?: number
  maxTokens?: number
  /** Explicit opt-in for Anthropic defer_loading/tool_reference protocol support. */
  supportsToolReferences?: boolean
}

type JsonRecord = Record<string, unknown>
type AnthropicRole = 'user' | 'assistant'

interface AnthropicMessage {
  role: AnthropicRole
  content: JsonRecord[]
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const anthropicMessagesEndpoint = (endpoint: string): string => {
  const url = new URL(endpoint)
  const path = url.pathname.replace(/\/+$/u, '')
  url.pathname = path.endsWith('/messages')
    ? path
    : path.endsWith('/v1') ? `${path}/messages` : `${path}/v1/messages`
  return url.toString()
}

const toAnthropicTool = (tool: ModelToolDefinition, deferLoading = false): JsonRecord => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.inputSchema,
  ...(deferLoading ? { defer_loading: true } : {}),
})

const toAnthropicCacheControl = (cacheControl: CacheControl | undefined): JsonRecord | undefined =>
  cacheControl ? {
    type: cacheControl.type,
    ...(cacheControl.ttl ? { ttl: cacheControl.ttl } : {}),
  } : undefined

const toAnthropicImage = (block: ImageContentBlock): JsonRecord => ({
  type: 'image',
  source: block.source.type === 'base64'
    ? { type: 'base64', media_type: block.source.mediaType, data: block.source.data }
    : { type: 'url', url: block.source.url },
  ...(block.cacheControl ? { cache_control: toAnthropicCacheControl(block.cacheControl) } : {}),
})

const messageBlocks = (
  message: ModelMessage,
  targetModel: ModelRef,
  deferredToolNames: ReadonlySet<string>,
  loadedToolNames: Set<string>,
): { role: AnthropicRole; blocks: JsonRecord[] } => {
  if (message.role === 'user') {
    return {
      role: 'user',
      blocks: userContentBlocks(message).map((block) => block.type === 'image'
        ? toAnthropicImage(block)
        : {
            type: 'text',
            text: block.text,
            ...(block.cacheControl ? { cache_control: toAnthropicCacheControl(block.cacheControl) } : {}),
          }),
    }
  }
  if (message.role === 'tool') {
    const ordinaryContent = message.contentBlocks
      ? toolResultContentBlocks(message).map((block) => block.type === 'image'
          ? toAnthropicImage(block)
          : {
              type: 'text',
              text: block.text,
              ...(block.cacheControl ? { cache_control: toAnthropicCacheControl(block.cacheControl) } : {}),
            })
      : message.content
    const references = message.isError ? [] : (message.addedToolNames ?? []).flatMap((name) => {
      if (!deferredToolNames.has(name) || loadedToolNames.has(name)) return []
      loadedToolNames.add(name)
      return [{ type: 'tool_reference', tool_name: name }]
    })
    const siblingContent = references.length === 0
      ? []
      : typeof ordinaryContent === 'string'
        ? ordinaryContent ? [{ type: 'text', text: ordinaryContent }] : []
        : ordinaryContent
    return {
      role: 'user',
      blocks: [{
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: references.length > 0 ? references : ordinaryContent,
        is_error: message.isError,
      }, ...siblingContent],
    }
  }
  const blocks: JsonRecord[] = []
  const sameProvider = !message.provider || message.provider === targetModel.provider
  for (const block of assistantContentBlocks(message)) {
    if (block.type === 'thinking') {
      if (!sameProvider) {
        blocks.push({
          type: 'text',
          text: block.redacted
            ? '<thinking>[redacted]</thinking>'
            : `<thinking>\n${block.thinking}\n</thinking>`,
        })
      } else {
        blocks.push(block.redacted
          ? { type: 'redacted_thinking', data: block.thinkingSignature ?? block.signature ?? '' }
          : {
              type: 'thinking',
              thinking: block.thinking,
              ...(block.thinkingSignature ?? block.signature
                ? { signature: block.thinkingSignature ?? block.signature }
                : {}),
            })
      }
    } else if (block.type === 'text') {
      blocks.push({
        type: 'text',
        text: block.text,
        ...(block.cacheControl ? { cache_control: toAnthropicCacheControl(block.cacheControl) } : {}),
      })
    } else {
      blocks.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: isRecord(block.arguments) ? block.arguments : {},
      })
    }
  }
  return { role: 'assistant', blocks }
}

const toAnthropicMessages = (
  messages: ModelMessage[],
  targetModel: ModelRef,
  deferredToolNames: ReadonlySet<string>,
): AnthropicMessage[] => {
  const output: AnthropicMessage[] = []
  const loadedToolNames = new Set<string>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    let converted: { role: AnthropicRole; blocks: JsonRecord[] }
    if (message.role === 'tool') {
      const toolResults: JsonRecord[] = []
      const siblingContent: JsonRecord[] = []
      let toolIndex = index
      while (toolIndex < messages.length && messages[toolIndex]?.role === 'tool') {
        const blocks = messageBlocks(
          messages[toolIndex]!,
          targetModel,
          deferredToolNames,
          loadedToolNames,
        ).blocks
        const [toolResult, ...siblings] = blocks
        if (toolResult) toolResults.push(toolResult)
        siblingContent.push(...siblings)
        toolIndex += 1
      }
      index = toolIndex - 1
      converted = { role: 'user', blocks: [...toolResults, ...siblingContent] }
    } else {
      converted = messageBlocks(message, targetModel, deferredToolNames, loadedToolNames)
    }
    const previous = output[output.length - 1]
    if (previous?.role === converted.role) {
      previous.content.push(...converted.blocks)
    } else {
      output.push({ role: converted.role, content: converted.blocks })
    }
  }
  return output
}

const splitDeferredTools = (
  request: ModelRequest,
  enabled: boolean,
): { immediate: ModelToolDefinition[]; deferred: ModelToolDefinition[] } => {
  if (!enabled) return { immediate: request.tools, deferred: [] }
  const usedNames = new Set<string>()
  const deferredNames = new Set<string>()
  for (const message of request.messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) usedNames.add(call.name)
    } else if (message.role === 'tool' && !message.isError) {
      for (const name of message.addedToolNames ?? []) {
        if (!usedNames.has(name)) deferredNames.add(name)
      }
    }
  }
  const immediate = request.tools.filter((tool) => !deferredNames.has(tool.name))
  const deferred = request.tools.filter((tool) => deferredNames.has(tool.name))
  // Anthropic rejects a request whose complete tool set is deferred.
  return immediate.length === 0 && deferred.length > 0
    ? { immediate: deferred, deferred: [] }
    : { immediate, deferred }
}

const reasoningFields = (request: ModelRequest, maxTokens: number): JsonRecord => {
  const reasoning = request.reasoning
  if (!reasoning) return {}
  if (reasoning.mode === 'adaptive') {
    return {
      thinking: { type: 'adaptive' },
      output_config: { effort: reasoning.level },
    }
  }
  if (reasoning.mode === 'effort') return { output_config: { effort: reasoning.level } }
  if (maxTokens <= 1_024) {
    throw new Error('Anthropic-compatible thinking 需要 maxTokens 大于 1024')
  }
  const defaultBudgets: Record<typeof reasoning.level, number> = {
    minimal: 1_024,
    low: 2_048,
    medium: 4_096,
    high: 8_192,
    xhigh: 16_384,
    max: 32_768,
  }
  return {
    thinking: {
      type: 'enabled',
      budget_tokens: Math.min(reasoning.budgetTokens ?? defaultBudgets[reasoning.level], maxTokens - 1),
    },
  }
}

export const buildAnthropicCompatibleBody = (
  request: ModelRequest,
  maxTokens = 4096,
  supportsToolReferences = false,
): JsonRecord => {
  const placement = splitDeferredTools(request, supportsToolReferences)
  const deferredNames = new Set(placement.deferred.map((tool) => tool.name))
  return {
    model: request.model.model,
    max_tokens: maxTokens,
    stream: true,
    ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
    messages: toAnthropicMessages(request.messages, request.model, deferredNames),
    ...(request.tools.length > 0
      ? {
          tools: [
            ...placement.immediate.map((tool) => toAnthropicTool(tool)),
            ...placement.deferred.map((tool) => toAnthropicTool(tool, true)),
          ],
        }
      : {}),
    ...reasoningFields(request, maxTokens),
  }
}

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

const mapStopReason = (reason: unknown): ModelDoneReason => {
  if (reason === 'tool_use') return 'tool_use'
  if (reason === 'max_tokens') return 'length'
  return 'stop'
}

const parseNumber = (value: unknown): number => typeof value === 'number' ? value : 0

const parseUsage = (
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  cacheWrite1hTokens: number,
): TokenUsage | undefined => {
  const input = inputTokens
  const output = outputTokens
  if (!input && !output && !cacheReadTokens && !cacheWriteTokens && !cacheWrite1hTokens) return undefined
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens ? { cacheWriteTokens } : {}),
    ...(cacheWrite1hTokens ? { cacheWrite1hTokens } : {}),
  }
}

export class AnthropicCompatibleTransport implements ModelTransport {
  constructor(
    private readonly config: AnthropicCompatibleConfig,
    private readonly httpStream: ModelHttpStreamFactory = getDefaultHttpStream(),
  ) {}

  requestByteLength = (request: ModelRequest): number => byteLength(JSON.stringify(
    buildAnthropicCompatibleBody(
      request,
      request.maxOutputTokens ?? this.config.maxTokens,
      this.config.supportsToolReferences,
    ),
  ))

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
    lifecycle?: ModelTransportLifecycle,
  ): AsyncIterable<ModelStreamEvent> {
    // Path 补全（/v1/messages）下沉到 Rust 侧 provider_profiles::resolve_profile；
    // 此处的 endpoint 用于 Provider Hook 身份与 Rust endpoint 覆盖项，保持用户配置原值。
    const endpoint = this.config.endpoint
    const prepared = await prepareProviderRequest({
      request,
      apiFormat: 'anthropic-compatible',
      endpoint,
      timeoutMs: this.config.timeoutMs,
      payload: buildAnthropicCompatibleBody(
        request,
        request.maxOutputTokens ?? this.config.maxTokens,
        this.config.supportsToolReferences,
      ) as unknown as JsonValue,
      lifecycle,
      signal,
    })
    const rawRequest: ModelHttpRequest = {
      requestId: createId('model-http'),
      providerId: this.config.providerId,
      endpoint,
      body: prepared.body,
      secretId: request.auth?.secretId ?? this.config.secretId,
      timeoutMs: prepared.timeoutMs,
    }
    const toolIndexes = new Set<number>()
    const thinkingIndexes = new Set<number>()
    let started = false
    let stopReason: ModelDoneReason = 'stop'
    let lastHttpStatus: number | undefined
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let cacheWrite1hTokens = 0
    let protocolEventSeen = false
    let messageStopSeen = false

    try {
    for await (const frame of parseServerSentEvents(this.httpStream(
      rawRequest,
      signal,
      ({ status }) => {
        lastHttpStatus = status
        return notifyProviderResponse(
          lifecycle,
          request,
          'anthropic-compatible',
          endpoint,
          status,
          signal,
        )
      },
    ))) {
      let packet: unknown
      try {
        packet = JSON.parse(frame.data)
      } catch {
        throw new Error('Anthropic-compatible Provider 返回了无效 SSE JSON')
      }
      if (!isRecord(packet) || typeof packet.type !== 'string') continue
      // 包级 schema 校验：协议关键字段形状漂移立即显式报错（被下方 catch 转为 error 事件），
      // 不再静默跳过整包或丢失文本/工具参数（见 providerPacketSchema.ts）。
      const packetSchema = ANTHROPIC_PACKET_SCHEMAS[packet.type]
      if (packetSchema) validateProviderPacket(this.config.providerId, packet.type, packet, packetSchema)
      if (packet.type !== 'ping') protocolEventSeen = true

      if (packet.type === 'error') {
        const payload = isRecord(packet.error) ? packet.error : {}
        const message = typeof payload.message === 'string'
          ? payload.message
          : 'Anthropic-compatible Provider 返回了未知错误'
        const error = classifyProviderError({
          message,
          code: typeof payload.code === 'string' ? payload.code : undefined,
          type: typeof payload.type === 'string' ? payload.type : undefined,
          status: lastHttpStatus,
          providerId: this.config.providerId,
        })
        yield { type: 'error', message, error }
        return
      }

      if (packet.type === 'message_stop') {
        // message_stop 是 Anthropic 流的终止标记；缺失即视为被截断。
        messageStopSeen = true
        continue
      }

      if (packet.type === 'message_start') {
        const message = isRecord(packet.message) ? packet.message : {}
        const usage = isRecord(message.usage) ? message.usage : {}
        inputTokens = parseNumber(usage.input_tokens)
        cacheReadTokens = parseNumber(usage.cache_read_input_tokens)
        cacheWriteTokens = parseNumber(usage.cache_creation_input_tokens)
        const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : {}
        cacheWrite1hTokens = parseNumber(cacheCreation.ephemeral_1h_input_tokens)
        yield {
          type: 'start',
          ...(typeof message.id === 'string' ? { responseId: message.id } : {}),
          ...(typeof message.model === 'string' ? { responseModel: message.model } : {}),
        }
        started = true
        continue
      }

      if (!started) {
        yield { type: 'start' }
        started = true
      }

      if (packet.type === 'content_block_start' && typeof packet.index === 'number') {
        const block = isRecord(packet.content_block) ? packet.content_block : {}
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          yield { type: 'text_delta', contentIndex: packet.index, delta: block.text }
        }
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          const redacted = block.type === 'redacted_thinking'
          thinkingIndexes.add(packet.index)
          yield {
            type: 'thinking_start',
            contentIndex: packet.index,
            thinkingSignature: typeof block.signature === 'string'
              ? block.signature
              : typeof block.data === 'string' ? block.data : undefined,
            redacted,
          }
          if (!redacted && typeof block.thinking === 'string' && block.thinking) {
            yield { type: 'thinking_delta', contentIndex: packet.index, delta: block.thinking }
          }
        }
        if (block.type === 'tool_use') {
          const index = packet.index
          const id = typeof block.id === 'string' ? block.id : `${request.runId}-tool-${index}`
          const name = typeof block.name === 'string' ? block.name : ''
          toolIndexes.add(index)
          yield { type: 'tool_call_start', index, contentIndex: index, id, name }
          if (isRecord(block.input) && Object.keys(block.input).length > 0) {
            yield {
              type: 'tool_call_delta',
              index,
              argumentsDelta: JSON.stringify(block.input as JsonValue),
            }
          }
        }
        continue
      }

      if (packet.type === 'content_block_delta' && typeof packet.index === 'number') {
        const delta = isRecord(packet.delta) ? packet.delta : {}
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text_delta', contentIndex: packet.index, delta: delta.text }
        }
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          yield { type: 'thinking_delta', contentIndex: packet.index, delta: delta.thinking }
        }
        if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          yield { type: 'thinking_signature_delta', contentIndex: packet.index, delta: delta.signature }
        }
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          yield {
            type: 'tool_call_delta',
            index: packet.index,
            argumentsDelta: delta.partial_json,
          }
        }
        continue
      }

      if (packet.type === 'content_block_stop' && typeof packet.index === 'number') {
        if (toolIndexes.has(packet.index)) yield { type: 'tool_call_end', index: packet.index }
        if (thinkingIndexes.has(packet.index)) yield { type: 'thinking_end', contentIndex: packet.index }
        continue
      }

      if (packet.type === 'message_delta') {
        const delta = isRecord(packet.delta) ? packet.delta : {}
        const usage = isRecord(packet.usage) ? packet.usage : {}
        if (delta.stop_reason != null) stopReason = mapStopReason(delta.stop_reason)
        inputTokens = parseNumber(usage.input_tokens) || inputTokens
        outputTokens = parseNumber(usage.output_tokens) || outputTokens
        cacheReadTokens = parseNumber(usage.cache_read_input_tokens) || cacheReadTokens
        cacheWriteTokens = parseNumber(usage.cache_creation_input_tokens) || cacheWriteTokens
        const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : {}
        cacheWrite1hTokens = parseNumber(cacheCreation.ephemeral_1h_input_tokens) || cacheWrite1hTokens
      }
    }
    } catch (error) {
      // HTTP 级错误（非 2xx 等）由 Rust 以 status 事件 + error 事件透传，此处不再
      // 裸 throw，改为按事件契约产出 {type:'error'}，带上真实 lastHttpStatus。
      if (signal.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      const classified = classifyProviderError({ message, status: lastHttpStatus, providerId: this.config.providerId })
      yield { type: 'error', message: classified.message, error: classified }
      return
    }

    if (!protocolEventSeen) {
      throw new Error('Anthropic-compatible Provider 返回了空响应或非 SSE 响应')
    }
    if (started && !messageStopSeen) {
      // 已收到 message_start 但流在 message_stop 前关闭：截断的响应不能
      // 以干净 stop 落盘。发出 error 事件让循环以 stopReason 'error' 结束。
      const error = classifyProviderError({
        message: 'Anthropic-compatible Provider 流在 message_stop 前中断，响应不完整',
      })
      yield { type: 'error', message: error.message, error }
      return
    }
    if (!started) yield { type: 'start' }
    const usage = parseUsage(
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheWrite1hTokens,
    )
    yield { type: 'done', stopReason, usage }
  }
}
