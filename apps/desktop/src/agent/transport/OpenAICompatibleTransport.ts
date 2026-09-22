import { createId } from '@/agent/core/id'
import type {
  ImageContentBlock,
  ModelMessage,
  ModelDoneReason,
  ModelRequest,
  ModelStreamEvent,
  ModelToolDefinition,
  ModelTransport,
  ModelTransportLifecycle,
  JsonValue,
  TokenUsage,
} from '@/agent/core/types'
import {
  assistantContentBlocks,
  toolResultContentBlocks,
  userContentBlocks,
} from '@/agent/core/messages'
import { classifyProviderError } from '@/agent/core/providerError'
import type { ModelHttpRequest, ModelHttpStreamFactory } from './modelHttpContract'
import { getDefaultHttpStream } from './httpStreamBinding'
import { parseServerSentEvents } from './sse'
import { notifyProviderResponse, prepareProviderRequest } from './providerLifecycle'
import { OPENAI_COMPATIBLE_PACKET_SCHEMA, validateProviderPacket } from './providerPacketSchema'

export type { ModelHttpStreamFactory } from './modelHttpContract'

export interface OpenAICompatibleConfig {
  providerId: string
  endpoint: string
  secretId?: string
  timeoutMs?: number
  maxTokens?: number
}

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toOpenAITool = (tool: ModelToolDefinition): JsonRecord => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  },
})

const toOpenAIImageUrl = (block: ImageContentBlock): JsonRecord => ({
  type: 'image_url',
  image_url: {
    url: block.source.type === 'url'
      ? block.source.url
      : `data:${block.source.mediaType};base64,${block.source.data}`,
  },
})

const toOpenAIContent = (
  blocks: ReturnType<typeof userContentBlocks> | ReturnType<typeof toolResultContentBlocks>,
): JsonRecord[] => blocks.map((block) => block.type === 'image'
  ? toOpenAIImageUrl(block)
  : { type: 'text', text: block.text })

const toOpenAIMessage = (message: ModelMessage, targetProvider: string): JsonRecord => {
  if (message.role === 'user') {
    return {
      role: 'user',
      content: message.contentBlocks ? toOpenAIContent(userContentBlocks(message)) : message.content,
    }
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.contentBlocks
        ? toOpenAIContent(toolResultContentBlocks(message))
        : message.content,
    }
  }
  const contentBlocks = assistantContentBlocks(message)
  const sameProvider = !message.provider || message.provider === targetProvider
  const text = contentBlocks.flatMap((block) => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'tool_call' || sameProvider) return []
    return [block.redacted
      ? '<thinking>[redacted]</thinking>'
      : `<thinking>\n${block.thinking}\n</thinking>`]
  }).join('')
  const reasoningContent = contentBlocks
    .flatMap((block) => sameProvider && block.type === 'thinking' && !block.redacted ? [block.thinking] : [])
    .join('')
  const toolCalls = contentBlocks.flatMap((block) => block.type === 'tool_call' ? [block] : [])
  return {
    role: 'assistant',
    content: text || null,
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    ...(toolCalls.length > 0
      ? {
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: call.rawArguments || JSON.stringify(call.arguments),
            },
          })),
        }
      : {}),
  }
}

export const buildOpenAICompatibleBody = (
  request: ModelRequest,
  maxTokens?: number,
): JsonRecord => ({
  model: request.model.model,
  stream: true,
  stream_options: { include_usage: true },
  ...(maxTokens ? { max_tokens: maxTokens } : {}),
  messages: [
    ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
    ...request.messages.map((message) => toOpenAIMessage(message, request.model.provider)),
  ],
  ...(request.tools.length > 0 ? { tools: request.tools.map(toOpenAITool) } : {}),
  ...(request.reasoning ? { reasoning_effort: request.reasoning.level } : {}),
})

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

const parseUsage = (value: unknown): TokenUsage | undefined => {
  if (!isRecord(value)) return undefined
  const inputTokens = typeof value.prompt_tokens === 'number' ? value.prompt_tokens : 0
  const outputTokens = typeof value.completion_tokens === 'number' ? value.completion_tokens : 0
  const totalTokens = typeof value.total_tokens === 'number'
    ? value.total_tokens
    : inputTokens + outputTokens
  const promptDetails = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : {}
  const completionDetails = isRecord(value.completion_tokens_details) ? value.completion_tokens_details : {}
  const cacheReadTokens = typeof promptDetails.cached_tokens === 'number' ? promptDetails.cached_tokens : 0
  const reasoningTokens = typeof completionDetails.reasoning_tokens === 'number'
    ? completionDetails.reasoning_tokens
    : 0
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(reasoningTokens ? { reasoningTokens } : {}),
  }
}

const mapStopReason = (reason: unknown): ModelDoneReason => {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use'
  if (reason === 'length') return 'length'
  return 'stop'
}

const remoteError = (packet: JsonRecord, status: number | undefined, providerId: string) => {
  if (!isRecord(packet.error)) return undefined
  const message = typeof packet.error.message === 'string' ? packet.error.message : 'Provider 返回了未知错误'
  return classifyProviderError({
    message,
    code: typeof packet.error.code === 'string' ? packet.error.code : undefined,
    type: typeof packet.error.type === 'string' ? packet.error.type : undefined,
    status,
    providerId,
  })
}

export class OpenAICompatibleTransport implements ModelTransport {
  constructor(
    private readonly config: OpenAICompatibleConfig,
    private readonly httpStream: ModelHttpStreamFactory = getDefaultHttpStream(),
  ) {}

  requestByteLength = (request: ModelRequest): number => byteLength(JSON.stringify(
    buildOpenAICompatibleBody(request, request.maxOutputTokens ?? this.config.maxTokens),
  ))

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
    lifecycle?: ModelTransportLifecycle,
  ): AsyncIterable<ModelStreamEvent> {
    const prepared = await prepareProviderRequest({
      request,
      apiFormat: 'openai-compatible',
      endpoint: this.config.endpoint,
      timeoutMs: this.config.timeoutMs,
      payload: buildOpenAICompatibleBody(
        request,
        request.maxOutputTokens ?? this.config.maxTokens,
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
      // 取请求期的模型 id（而非构造期快照）：多协议 provider 据此选 wire，且切模型后不会失配。
      modelId: request.model.model,
      sessionId: request.sessionId,
    }
    const startedTools = new Set<number>()
    const thinkingContentIndexes = new Set<number>()
    let lastHttpStatus: number | undefined
    let activeTextContentIndex: number | undefined
    let activeThinkingContentIndex: number | undefined
    let nextContentIndex = 0
    let lastContentKind: 'text' | 'thinking' | 'tool' | undefined
    let started = false
    let stopReason: ModelDoneReason = 'stop'
    let usage: TokenUsage | undefined
    let doneMarkerSeen = false
    let finishReasonSeen = false

    try {
    for await (const frame of parseServerSentEvents(this.httpStream(
      rawRequest,
      signal,
      ({ status }) => {
        lastHttpStatus = status
        return notifyProviderResponse(
          lifecycle,
          request,
          'openai-compatible',
          this.config.endpoint,
          status,
          signal,
        )
      },
    ))) {
      if (frame.data.trim() === '[DONE]') {
        doneMarkerSeen = true
        break
      }
      let packet: unknown
      try {
        packet = JSON.parse(frame.data)
      } catch {
        throw new Error('OpenAI-compatible Provider 返回了无效 SSE JSON')
      }
      if (!isRecord(packet)) continue
      // 包级 schema 校验：唯一收紧点是 tool_calls[].index 必须为数字——工具调用是执行面，
      // index 缺失时既有实现会静默丢弃整条工具调用（见 providerPacketSchema.ts）。
      validateProviderPacket(
        this.config.providerId,
        'chat.completion.chunk',
        packet,
        OPENAI_COMPATIBLE_PACKET_SCHEMA,
      )
      const error = remoteError(packet, lastHttpStatus, this.config.providerId)
      if (error) {
        yield { type: 'error', message: error.message, error }
        return
      }
      if (!started) {
        yield {
          type: 'start',
          ...(typeof packet.id === 'string' ? { responseId: packet.id } : {}),
          ...(typeof packet.model === 'string' ? { responseModel: packet.model } : {}),
        }
        started = true
      }
      usage = parseUsage(packet.usage) ?? usage

      const choices = Array.isArray(packet.choices) ? packet.choices : []
      for (const rawChoice of choices) {
        if (!isRecord(rawChoice)) continue
        if (rawChoice.finish_reason != null) {
          finishReasonSeen = true
          stopReason = mapStopReason(rawChoice.finish_reason)
        }
        if (!isRecord(rawChoice.delta)) continue
        const delta = rawChoice.delta
        if (typeof delta.content === 'string' && delta.content) {
          if (lastContentKind !== 'text') activeTextContentIndex = nextContentIndex++
          lastContentKind = 'text'
          yield {
            type: 'text_delta',
            contentIndex: activeTextContentIndex,
            delta: delta.content,
            ...(typeof delta.text_signature === 'string'
              ? { textSignature: delta.text_signature }
              : typeof delta.content_signature === 'string'
                ? { textSignature: delta.content_signature }
                : {}),
          }
        }
        const thinkingDelta = typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string' ? delta.reasoning : undefined
        if (thinkingDelta) {
          if (lastContentKind !== 'thinking') {
            activeThinkingContentIndex = nextContentIndex++
            thinkingContentIndexes.add(activeThinkingContentIndex)
            yield {
              type: 'thinking_start',
              contentIndex: activeThinkingContentIndex,
              ...(typeof delta.reasoning_signature === 'string'
                ? { thinkingSignature: delta.reasoning_signature }
                : {}),
            }
          }
          lastContentKind = 'thinking'
          yield { type: 'thinking_delta', contentIndex: activeThinkingContentIndex!, delta: thinkingDelta }
        }
        const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
        for (const rawToolCall of toolCalls) {
          if (!isRecord(rawToolCall) || typeof rawToolCall.index !== 'number') continue
          const index = rawToolCall.index
          const fn = isRecord(rawToolCall.function) ? rawToolCall.function : {}
          const id = typeof rawToolCall.id === 'string'
            ? rawToolCall.id
            : `${request.runId}-tool-${index}`
          const name = typeof fn.name === 'string' ? fn.name : ''
          if (!startedTools.has(index)) {
            const contentIndex = nextContentIndex++
            yield {
              type: 'tool_call_start',
              index,
              contentIndex,
              id,
              name,
              ...(typeof rawToolCall.thought_signature === 'string'
                ? { thoughtSignature: rawToolCall.thought_signature }
                : {}),
            }
            startedTools.add(index)
          } else if (name) {
            // name 可能是跨 chunk 分片到达（如 'read_' + 'file'）；OpenAI 流式下
            // 它也可能是完整重复值。runAgentLoop 对与已拼接 name 相同的重复去重。
            yield { type: 'tool_call_delta', index, argumentsDelta: '', nameDelta: name }
          }
          if (typeof fn.arguments === 'string' && fn.arguments) {
            yield { type: 'tool_call_delta', index, argumentsDelta: fn.arguments }
          }
          lastContentKind = 'tool'
        }
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

    if (!started) {
      // 空 200 响应：以前会产出 done{stop}，现在显式报错，避免空回答被当作完成。
      const error = classifyProviderError({
        message: 'OpenAI-compatible Provider 返回了空响应（无任何流式事件）',
      })
      yield { type: 'error', message: error.message, error }
      return
    }
    if (!doneMarkerSeen && !finishReasonSeen) {
      // 流在 [DONE] 或 finish_reason 之前关闭：截断的响应不能以干净 stop 落盘。
      // 按 network 分类（可重试）：截断是传输层瞬时故障（网关掐断、端点不合规），
      // 显式 kind 跳过模式推断；自动重试由 isSafeAutoRetryFailure 的安全门槛把关。
      const error = classifyProviderError({
        message: 'OpenAI-compatible Provider 流在结束标记（[DONE] 或 finish_reason）前中断，响应不完整',
        kind: 'network',
      })
      yield { type: 'error', message: error.message, error }
      return
    }
    for (const contentIndex of thinkingContentIndexes) yield { type: 'thinking_end', contentIndex }
    for (const index of startedTools) yield { type: 'tool_call_end', index }
    yield { type: 'done', stopReason, usage }
  }
}
