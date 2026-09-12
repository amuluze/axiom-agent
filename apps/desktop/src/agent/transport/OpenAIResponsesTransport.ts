import { createId } from '@/agent/core/id'
import {
  assistantContentBlocks,
  toolResultContentBlocks,
  userContentBlocks,
} from '@/agent/core/messages'
import { classifyProviderError } from '@/agent/core/providerError'
import type {
  ImageContentBlock,
  JsonValue,
  ModelDoneReason,
  ModelRequest,
  ModelStreamEvent,
  ModelToolDefinition,
  ModelTransport,
  ModelTransportLifecycle,
  TokenUsage,
} from '@/agent/core/types'
import type { ModelHttpRequest } from './modelHttpContract'
import { getDefaultHttpStream } from './httpStreamBinding'
import type { ModelHttpStreamFactory } from './OpenAICompatibleTransport'
import { notifyProviderResponse, prepareProviderRequest } from './providerLifecycle'
import { parseServerSentEvents } from './sse'
import {
  OPENAI_RESPONSES_PACKET_SCHEMAS,
  validateProviderPacket,
} from './providerPacketSchema'

export interface OpenAIResponsesConfig {
  providerId: string
  endpoint: string
  secretId?: string
  timeoutMs?: number
  maxTokens?: number
  /** Explicit opt-in for Responses tool_search_output/defer_loading. */
  supportsToolSearch?: boolean
}

type JsonRecord = Record<string, unknown>

interface DeferredToolPlacement {
  immediate: ModelToolDefinition[]
  deferred: Map<string, ModelToolDefinition>
}

interface ResponseSlot {
  kind: 'text' | 'thinking' | 'tool'
  contentIndex: number
  toolIndex?: number
  callId?: string
  itemId?: string
  name?: string
  content: string
  arguments: string
  needsSeparator?: boolean
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

const stableId = (value: string): string => {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const toResponseImage = (block: ImageContentBlock): JsonRecord => ({
  type: 'input_image',
  detail: 'auto',
  image_url: block.source.type === 'url'
    ? block.source.url
    : `data:${block.source.mediaType};base64,${block.source.data}`,
})

const parseOpaqueJson = (value: string | undefined): JsonRecord | undefined => {
  if (!value?.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const splitToolCallId = (id: string): { callId: string; itemId?: string } => {
  const separator = id.indexOf('|')
  return separator < 0
    ? { callId: id }
    : { callId: id.slice(0, separator), itemId: id.slice(separator + 1) || undefined }
}

const splitDeferredTools = (request: ModelRequest, enabled: boolean): DeferredToolPlacement => {
  if (!enabled) return { immediate: request.tools, deferred: new Map() }
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
  return {
    immediate: request.tools.filter((tool) => !deferredNames.has(tool.name)),
    deferred: new Map(request.tools.flatMap((tool) => deferredNames.has(tool.name) ? [[tool.name, tool]] : [])),
  }
}

const toResponseTool = (tool: ModelToolDefinition, deferred = false): JsonRecord => ({
  type: 'function',
  name: tool.name,
  description: tool.description,
  parameters: tool.inputSchema,
  strict: false,
  ...(deferred ? { defer_loading: true } : {}),
})

const toResponseMessages = (
  request: ModelRequest,
  deferredTools: Map<string, ModelToolDefinition>,
): JsonRecord[] => {
  const input: JsonRecord[] = []
  const loadedTools = new Set<string>()

  for (const message of request.messages) {
    if (message.role === 'user') {
      input.push({
        role: 'user',
        content: userContentBlocks(message).map((block) => block.type === 'image'
          ? toResponseImage(block)
          : { type: 'input_text', text: block.text }),
      })
      continue
    }
    if (message.role === 'assistant') {
      const sameProvider = !message.provider || message.provider === request.model.provider
      let portableText = ''
      for (const block of assistantContentBlocks(message)) {
        if (block.type === 'thinking') {
          const reasoningItem = sameProvider
            ? parseOpaqueJson(block.thinkingSignature ?? block.signature)
            : undefined
          if (reasoningItem?.type === 'reasoning') input.push(reasoningItem)
          else if (!block.redacted) portableText += `<thinking>\n${block.thinking}\n</thinking>`
          continue
        }
        if (block.type === 'text') {
          portableText += block.text
          continue
        }
        if (portableText) {
          input.push({ role: 'assistant', content: [{ type: 'output_text', text: portableText }] })
          portableText = ''
        }
        const { callId, itemId } = splitToolCallId(block.id)
        input.push({
          type: 'function_call',
          ...(itemId ? { id: itemId } : {}),
          call_id: callId,
          name: block.name,
          arguments: block.rawArguments || JSON.stringify(block.arguments),
          status: 'completed',
        })
      }
      if (portableText) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: portableText }] })
      }
      continue
    }

    const resultBlocks = toolResultContentBlocks(message)
    const output = resultBlocks.some((block) => block.type === 'image')
      ? resultBlocks.map((block) => block.type === 'image'
          ? toResponseImage(block)
          : { type: 'input_text', text: block.text })
      : resultBlocks.map((block) => block.type === 'text' ? block.text : '').filter(Boolean).join('\n')
    input.push({
      type: 'function_call_output',
      call_id: splitToolCallId(message.toolCallId).callId,
      output: Array.isArray(output) ? output : output || '(no tool output)',
    })

    const newlyLoaded = (message.addedToolNames ?? []).flatMap((name) => {
      const tool = deferredTools.get(name)
      if (!tool || loadedTools.has(name)) return []
      loadedTools.add(name)
      return [tool]
    })
    if (newlyLoaded.length > 0) {
      const names = newlyLoaded.map((tool) => tool.name)
      const callId = `axiom_tool_load_${stableId(`${message.toolCallId}:${names.join(',')}`)}`
      input.push({
        type: 'tool_search_call',
        call_id: callId,
        execution: 'client',
        status: 'completed',
        arguments: { query: names.join(' '), limit: names.length },
      })
      input.push({
        type: 'tool_search_output',
        call_id: callId,
        execution: 'client',
        status: 'completed',
        tools: newlyLoaded.map((tool) => toResponseTool(tool, true)),
      })
    }
  }
  return input
}

export const buildOpenAIResponsesBody = (
  request: ModelRequest,
  maxTokens?: number,
  supportsToolSearch = false,
): JsonRecord => {
  const placement = splitDeferredTools(request, supportsToolSearch)
  return {
    model: request.model.model,
    stream: true,
    store: false,
    ...(request.systemPrompt ? { instructions: request.systemPrompt } : {}),
    input: toResponseMessages(request, placement.deferred),
    ...(maxTokens ? { max_output_tokens: Math.max(16, maxTokens) } : {}),
    ...(placement.immediate.length > 0
      ? { tools: placement.immediate.map((tool) => toResponseTool(tool)) }
      : {}),
    ...(request.reasoning
      ? {
          reasoning: { effort: request.reasoning.level, summary: 'auto' },
          include: ['reasoning.encrypted_content'],
        }
      : {}),
  }
}

const parseUsage = (value: unknown): TokenUsage | undefined => {
  if (!isRecord(value)) return undefined
  const inputTokens = typeof value.input_tokens === 'number' ? value.input_tokens : 0
  const outputTokens = typeof value.output_tokens === 'number' ? value.output_tokens : 0
  const totalTokens = typeof value.total_tokens === 'number'
    ? value.total_tokens
    : inputTokens + outputTokens
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : {}
  const outputDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : {}
  const cacheReadTokens = typeof inputDetails.cached_tokens === 'number' ? inputDetails.cached_tokens : 0
  const reasoningTokens = typeof outputDetails.reasoning_tokens === 'number' ? outputDetails.reasoning_tokens : 0
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(reasoningTokens ? { reasoningTokens } : {}),
  }
}

const responseError = (packet: JsonRecord, status: number | undefined, providerId: string) => {
  const raw = isRecord(packet.error)
    ? packet.error
    : isRecord(packet.response) && isRecord(packet.response.error) ? packet.response.error : undefined
  if (!raw) return undefined
  const message = typeof raw.message === 'string' ? raw.message : 'OpenAI Responses 返回了未知错误'
  return classifyProviderError({
    message,
    code: typeof raw.code === 'string' ? raw.code : undefined,
    type: typeof raw.type === 'string' ? raw.type : undefined,
    status,
    providerId,
  })
}

const responseItem = (packet: JsonRecord): JsonRecord => isRecord(packet.item) ? packet.item : {}

const responseMessageText = (item: JsonRecord): string => Array.isArray(item.content)
  ? item.content.flatMap((content) => {
      if (!isRecord(content)) return []
      if (content.type === 'output_text' && typeof content.text === 'string') return [content.text]
      if (content.type === 'refusal' && typeof content.refusal === 'string') return [content.refusal]
      return []
    }).join('')
  : ''

const responseReasoningText = (item: JsonRecord): string => Array.isArray(item.summary)
  ? item.summary.flatMap((summary) => isRecord(summary) && typeof summary.text === 'string'
      ? [summary.text]
      : []).join('\n\n')
  : ''

// 返回应补发的差额；`undefined` 表示增量与最终值不一致（provider 归一化、
// reasoning 混流、兼容端点双计等）。调用方以最终值为准、放弃补差额并 emit
// diagnostic 暴露偏差——不再 throw 把可恢复的流式差异升级为整轮失败。
const remainingDelta = (current: string, finalValue: string): string | undefined => {
  if (!finalValue || finalValue === current) return ''
  if (finalValue.startsWith(current)) return finalValue.slice(current.length)
  return undefined
}

const driftDiagnostic = (label: string): ModelStreamEvent => ({
  type: 'diagnostic',
  diagnostic: {
    type: 'openai-responses-delta-drift',
    timestamp: Date.now(),
    details: { label },
  },
})

export class OpenAIResponsesTransport implements ModelTransport {
  constructor(
    private readonly config: OpenAIResponsesConfig,
    private readonly httpStream: ModelHttpStreamFactory = getDefaultHttpStream(),
  ) {}

  requestByteLength = (request: ModelRequest): number => byteLength(JSON.stringify(
    buildOpenAIResponsesBody(
      request,
      request.maxOutputTokens ?? this.config.maxTokens,
      this.config.supportsToolSearch,
    ),
  ))

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
    lifecycle?: ModelTransportLifecycle,
  ): AsyncIterable<ModelStreamEvent> {
    const prepared = await prepareProviderRequest({
      request,
      apiFormat: 'openai-responses',
      endpoint: this.config.endpoint,
      timeoutMs: this.config.timeoutMs,
      payload: buildOpenAIResponsesBody(
        request,
        request.maxOutputTokens ?? this.config.maxTokens,
        this.config.supportsToolSearch,
      ) as unknown as JsonValue,
      lifecycle,
      signal,
    })
    const rawRequest: ModelHttpRequest = {
      requestId: createId('model-http'),
      providerId: this.config.providerId,
      endpoint: this.config.endpoint,
      body: prepared.body,
      secretId: request.auth?.secretId ?? this.config.secretId,
      timeoutMs: prepared.timeoutMs,
    }
    const slots = new Map<number, ResponseSlot>()
    const endedThinking = new Set<number>()
    const endedTools = new Set<number>()
    let nextContentIndex = 0
    let nextToolIndex = 0
    let lastHttpStatus: number | undefined
    let started = false
    let terminal = false
    let hasToolCall = false
    let stopReason: ModelDoneReason = 'stop'
    let usage: TokenUsage | undefined

    const ensureStarted = function* (packet: JsonRecord): Generator<ModelStreamEvent> {
      if (started) return
      const response = isRecord(packet.response) ? packet.response : {}
      yield {
        type: 'start',
        ...(typeof response.id === 'string' ? { responseId: response.id } : {}),
        ...(typeof response.model === 'string' ? { responseModel: response.model } : {}),
      }
      started = true
    }

    const createSlot = (outputIndex: number, item: JsonRecord): ModelStreamEvent[] => {
      if (slots.has(outputIndex)) return []
      if (item.type === 'reasoning') {
        const slot: ResponseSlot = {
          kind: 'thinking',
          contentIndex: nextContentIndex++,
          content: '',
          arguments: '',
        }
        slots.set(outputIndex, slot)
        return [{ type: 'thinking_start', contentIndex: slot.contentIndex }]
      }
      if (item.type === 'message') {
        slots.set(outputIndex, {
          kind: 'text',
          contentIndex: nextContentIndex++,
          content: '',
          arguments: '',
        })
        return []
      }
      if (item.type === 'function_call') {
        const toolIndex = nextToolIndex++
        const callId = typeof item.call_id === 'string' ? item.call_id : `${request.runId}-call-${toolIndex}`
        const itemId = typeof item.id === 'string' ? item.id : undefined
        const name = typeof item.name === 'string' ? item.name : ''
        const argumentsValue = typeof item.arguments === 'string' ? item.arguments : ''
        const slot: ResponseSlot = {
          kind: 'tool',
          contentIndex: nextContentIndex++,
          toolIndex,
          callId,
          itemId,
          name,
          content: '',
          arguments: argumentsValue,
        }
        slots.set(outputIndex, slot)
        hasToolCall = true
        return [{
          type: 'tool_call_start',
          index: toolIndex,
          contentIndex: slot.contentIndex,
          id: itemId ? `${callId}|${itemId}` : callId,
          name,
        }, ...(argumentsValue
          ? [{ type: 'tool_call_delta' as const, index: toolIndex, argumentsDelta: argumentsValue }]
          : [])]
      }
      return []
    }

    try {
    for await (const frame of parseServerSentEvents(this.httpStream(
      rawRequest,
      signal,
      ({ status }) => {
        lastHttpStatus = status
        return notifyProviderResponse(
          lifecycle,
          request,
          'openai-responses',
          this.config.endpoint,
          status,
          signal,
        )
      },
    ))) {
      if (frame.data.trim() === '[DONE]') continue
      let packet: unknown
      try {
        packet = JSON.parse(frame.data)
      } catch {
        throw new Error('OpenAI Responses 返回了无效 SSE JSON')
      }
      if (!isRecord(packet) || typeof packet.type !== 'string') continue
      // 包级 schema 校验：`output_index` 等关键字段缺失不再默认成 0（会折叠 slot 污染状态），
      // 而是显式报错（被下方 catch 转为 error 事件）。
      const packetSchema = OPENAI_RESPONSES_PACKET_SCHEMAS[packet.type]
      if (packetSchema) validateProviderPacket(this.config.providerId, packet.type, packet, packetSchema)
      yield* ensureStarted(packet)

      const error = responseError(packet, lastHttpStatus, this.config.providerId)
      if (packet.type === 'error' || packet.type === 'response.failed') {
        const classified = error ?? classifyProviderError({ message: 'OpenAI Responses 请求失败', status: lastHttpStatus })
        yield { type: 'error', message: classified.message, error: classified }
        return
      }

      const outputIndex = typeof packet.output_index === 'number' ? packet.output_index : 0
      if (packet.type === 'response.output_item.added') {
        for (const event of createSlot(outputIndex, responseItem(packet))) yield event
        continue
      }
      if (packet.type === 'response.output_text.delta' || packet.type === 'response.refusal.delta') {
        if (!slots.has(outputIndex)) createSlot(outputIndex, { type: 'message' })
        const slot = slots.get(outputIndex)
        if (slot?.kind === 'text' && typeof packet.delta === 'string') {
          slot.content += packet.delta
          yield { type: 'text_delta', contentIndex: slot.contentIndex, delta: packet.delta }
        }
        continue
      }
      if (packet.type === 'response.reasoning_summary_text.delta') {
        if (!slots.has(outputIndex)) {
          for (const event of createSlot(outputIndex, { type: 'reasoning' })) yield event
        }
        const slot = slots.get(outputIndex)
        if (slot?.kind === 'thinking' && typeof packet.delta === 'string') {
          if (slot.needsSeparator) {
            slot.content += '\n\n'
            slot.needsSeparator = false
            yield { type: 'thinking_delta', contentIndex: slot.contentIndex, delta: '\n\n' }
          }
          slot.content += packet.delta
          yield { type: 'thinking_delta', contentIndex: slot.contentIndex, delta: packet.delta }
        }
        continue
      }
      if (packet.type === 'response.reasoning_text.delta') {
        // CoT 全文与 summary 不同源：混入同一 thinking slot 会在 done 校验处
        // 产生确定性 mismatch（summary 只覆盖自身而非 CoT+summary）。
        // summary:'auto' 下 thinking 以 summary 为准，CoT 由 output_item.done
        // 的 item.summary 兜底，不逐块累加。
        continue
      }
      if (packet.type === 'response.reasoning_summary_part.done') {
        const slot = slots.get(outputIndex)
        if (slot?.kind === 'thinking' && slot.content) slot.needsSeparator = true
        continue
      }
      if (packet.type === 'response.output_text.done' || packet.type === 'response.refusal.done') {
        const slot = slots.get(outputIndex)
        const finalText = packet.type === 'response.refusal.done' ? packet.refusal : packet.text
        if (slot?.kind === 'text' && typeof finalText === 'string') {
          const delta = remainingDelta(slot.content, finalText)
          if (delta === undefined) yield driftDiagnostic('文本')
          else if (delta) yield { type: 'text_delta', contentIndex: slot.contentIndex, delta }
          slot.content = finalText
        }
        continue
      }
      if (packet.type === 'response.reasoning_summary_text.done') {
        const slot = slots.get(outputIndex)
        if (slot?.kind === 'thinking' && typeof packet.text === 'string') {
          const delta = remainingDelta(slot.content, packet.text)
          if (delta === undefined) yield driftDiagnostic('Reasoning')
          else if (delta) yield { type: 'thinking_delta', contentIndex: slot.contentIndex, delta }
          slot.content = packet.text
          slot.needsSeparator = false
        }
        continue
      }
      if (packet.type === 'response.reasoning_text.done') {
        // CoT 不参与 thinking slot 收尾，与 reasoning_text.delta 的忽略保持一致。
        continue
      }
      if (packet.type === 'response.function_call_arguments.delta') {
        const slot = slots.get(outputIndex)
        if (slot?.kind === 'tool' && slot.toolIndex !== undefined && typeof packet.delta === 'string') {
          slot.arguments += packet.delta
          yield { type: 'tool_call_delta', index: slot.toolIndex, argumentsDelta: packet.delta }
        }
        continue
      }
      if (packet.type === 'response.function_call_arguments.done') {
        const slot = slots.get(outputIndex)
        if (slot?.kind === 'tool' && slot.toolIndex !== undefined && typeof packet.arguments === 'string') {
          const delta = remainingDelta(slot.arguments, packet.arguments)
          if (delta === undefined) yield driftDiagnostic('工具参数')
          else if (delta) yield { type: 'tool_call_delta', index: slot.toolIndex, argumentsDelta: delta }
          slot.arguments = packet.arguments
        }
        continue
      }
      if (packet.type === 'response.output_item.done') {
        const item = responseItem(packet)
        for (const event of createSlot(outputIndex, item)) yield event
        const slot = slots.get(outputIndex)
        if (slot?.kind === 'thinking' && !endedThinking.has(outputIndex)) {
          const finalThinking = responseReasoningText(item)
          const delta = remainingDelta(slot.content, finalThinking)
          if (delta === undefined) yield driftDiagnostic('Reasoning')
          else if (delta) yield { type: 'thinking_delta', contentIndex: slot.contentIndex, delta }
          slot.content = finalThinking || slot.content
          const signature = JSON.stringify(item)
          yield { type: 'thinking_signature_delta', contentIndex: slot.contentIndex, delta: signature }
          yield { type: 'thinking_end', contentIndex: slot.contentIndex }
          endedThinking.add(outputIndex)
        } else if (slot?.kind === 'text') {
          const finalText = responseMessageText(item)
          const delta = remainingDelta(slot.content, finalText)
          if (delta === undefined) yield driftDiagnostic('文本')
          else if (delta) yield { type: 'text_delta', contentIndex: slot.contentIndex, delta }
          slot.content = finalText || slot.content
        } else if (slot?.kind === 'tool' && slot.toolIndex !== undefined && !endedTools.has(outputIndex)) {
          const finalArguments = typeof item.arguments === 'string' ? item.arguments : slot.arguments
          const delta = remainingDelta(slot.arguments, finalArguments)
          if (delta === undefined) yield driftDiagnostic('工具参数')
          else if (delta) yield { type: 'tool_call_delta', index: slot.toolIndex, argumentsDelta: delta }
          slot.arguments = finalArguments
          yield { type: 'tool_call_end', index: slot.toolIndex }
          endedTools.add(outputIndex)
        }
        continue
      }
      if (packet.type === 'response.completed' || packet.type === 'response.incomplete') {
        const response = isRecord(packet.response) ? packet.response : {}
        terminal = true
        usage = parseUsage(response.usage)
        stopReason = packet.type === 'response.incomplete' || response.status === 'incomplete' ? 'length' : 'stop'
        if (hasToolCall && stopReason === 'stop') stopReason = 'tool_use'
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

    if (!started) yield { type: 'start' }
    for (const [outputIndex, slot] of slots) {
      if (slot.kind === 'thinking' && !endedThinking.has(outputIndex)) {
        yield { type: 'thinking_end', contentIndex: slot.contentIndex }
      }
      if (slot.kind === 'tool' && slot.toolIndex !== undefined && !endedTools.has(outputIndex)) {
        yield { type: 'tool_call_end', index: slot.toolIndex }
      }
    }
    if (!terminal) {
      const error = classifyProviderError({ message: 'OpenAI Responses 流在终态事件前结束' })
      yield { type: 'error', message: error.message, error }
      return
    }
    yield { type: 'done', stopReason, usage }
  }
}
