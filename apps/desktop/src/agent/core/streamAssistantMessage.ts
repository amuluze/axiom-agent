import { createId } from './id'
import { defaultConvertToModelMessages, hasMeaningfulAssistantContent, toolCallContentBlock } from './messages'
import { activeToolsForContext } from './deferredTools'
import { classifyProviderError } from './providerError'
import { byteLength, truncateToBytes } from './bytes'
import { isAbortError } from './abort'
import { diagnosticForError } from './diagnostics'
import {
  cloneJsonValue,
  snapshotAgentContext,
  snapshotAgentMessages,
  snapshotAssistantMessage,
  snapshotModelRequest,
} from './snapshots'
import { validatedMessages } from './messageValidation'
import type {
  AgentContext,
  AgentEventSink,
  AssistantContentBlock,
  AssistantMessage,
  AssistantMessageEvent,
  ConvertToModelMessages,
  JsonValue,
  ModelRequest,
  ModelTransport,
  ModelTransportLifecycle,
  ResolveModelAuth,
  ToolCall,
  TransformContext,
} from './types'

/** 流式期间累积的部分工具调用（参数尚未拼完）。 */
interface PartialToolCall {
  index: number
  contentIndex: number
  id: string
  name: string
  rawArguments: string
  thoughtSignature?: string
}

/** 解析工具调用的原始参数串，区分有效 JSON 与解析错误。 */
const parseToolArguments = (
  rawArguments: string,
): Pick<ToolCall, 'arguments' | 'argumentError'> => {
  const normalized = rawArguments.trim() || '{}'
  try {
    return { arguments: JSON.parse(normalized) as JsonValue }
  } catch (error) {
    return {
      arguments: null,
      argumentError: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 把流式累积的 PartialToolCall 投影为完整的 ToolCall 快照。 */
const snapshotToolCall = (partial: PartialToolCall): ToolCall => ({
  id: partial.id,
  name: partial.name,
  rawArguments: partial.rawArguments,
  ...(partial.thoughtSignature ? { thoughtSignature: partial.thoughtSignature } : {}),
  ...parseToolArguments(partial.rawArguments),
})

/**
 * 从基线消息 + 流式累积的 partialToolCalls / partialContentBlocks 构造稠密的
 * AssistantMessage 快照。contentBlocks 按 contentIndex 升序排列，tool call 同时
 * 作为 contentBlock 与 toolCalls 数组的成员。
 *
 * 输出顺序与 streamingDraft.applyStreamingEvent 的重放结果保持一致（见
 * streamingDraft.ts 顶部注释）。
 */
const snapshotAssistant = (
  base: Omit<AssistantMessage, 'toolCalls' | 'contentBlocks'>,
  partialToolCalls: Map<number, PartialToolCall>,
  partialContentBlocks: Map<number, AssistantContentBlock>,
): AssistantMessage => {
  const orderedToolCalls = Array.from(partialToolCalls.values())
    .sort((left, right) => left.contentIndex - right.contentIndex)
  const orderedBlocks = [
    ...Array.from(partialContentBlocks.entries()),
    ...orderedToolCalls.map((partial) => [
      partial.contentIndex,
      toolCallContentBlock(snapshotToolCall(partial)),
    ] as const),
  ]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => ({ ...block }))
  const textBlocks = orderedBlocks.filter((block): block is Extract<AssistantContentBlock, { type: 'text' }> =>
    block.type === 'text')
  // 按 contentIndex 重排后的 flat content 投影：text_delta 若乱序到达，逐增量
  // 拼接的 base.content 会与 contentBlocks 顺序分歧，这里以有序块为准重算。
  return {
    ...base,
    ...(orderedBlocks.length > 0 ? { contentBlocks: orderedBlocks } : {}),
    ...(textBlocks.length > 0 ? { content: textBlocks.map((block) => block.text).join('') } : {}),
    toolCalls: orderedToolCalls.map(snapshotToolCall),
  }
}

/**
 * 流式推进一轮 assistant 消息：消费 transport 的事件流，累积文本/thinking/工具调用，
 * 应用字节预算截断，处理 abort 与错误终态，剥离取消后悬空的工具调用。
 *
 * 闭包状态全部局限在函数体内，不逃逸；移动本函数不会改变隔离语义，只要保持参数顺序。
 */
export const streamAssistantMessage = async (
  context: AgentContext,
  runId: string,
  transport: ModelTransport,
  signal: AbortSignal,
  emit: AgentEventSink,
  maxMessageBytes: number,
  transformContext?: TransformContext,
  convertToModelMessages?: ConvertToModelMessages,
  resolveModelAuth?: ResolveModelAuth,
  prepareModelRequest?: (
    request: ModelRequest,
    signal: AbortSignal,
    transport: ModelTransport,
  ) => Promise<ModelRequest>,
  onModelRequest?: (request: ModelRequest, signal: AbortSignal) => void | Promise<void>,
  onModelResponse?: (
    message: AssistantMessage,
    request: ModelRequest,
    signal: AbortSignal,
  ) => void | Promise<void>,
  providerLifecycle?: ModelTransportLifecycle,
  systemPromptOverride?: string,
): Promise<AssistantMessage> => {
  const providerRequestId = createId('provider-request')
  const partialToolCalls = new Map<number, PartialToolCall>()
  const partialContentBlocks = new Map<number, AssistantContentBlock>()
  let base: Omit<AssistantMessage, 'toolCalls' | 'contentBlocks'> = {
    id: createId('message'),
    role: 'assistant',
    content: '',
    stopReason: 'stop',
    provider: context.model.provider,
    model: context.model.model,
    createdAt: Date.now(),
  }
  let contentTruncated = false
  let streamedBytes = 0
  // thinking signature 是 opaque provider 元数据（OpenAIResponses 为整个 reasoning item
  // 的 JSON 序列化），不占可见内容预算，否则长 CoT + 大 signature 会把后续完整工具
  // 参数挤掉而误 fail。独立小上限防异常 provider 无限增长。
  let signatureBytes = 0
  const MAX_THINKING_SIGNATURE_BYTES = 64 * 1024
  let doneSeen = false
  let sentRequest: ModelRequest | undefined
  const startedTextIndexes = new Set<number>()
  const endedTextIndexes = new Set<number>()

  const emitAssistantUpdate = async (
    update: 'text' | 'thinking' | 'tool_call',
    event: AssistantMessageEvent,
    delta?: string,
  ): Promise<void> => {
    // 只 emit 增量：消费端（store streamingDraft / session.currentStreamingMessage）
    // 从 message_start 基线按 contentIndex 重放，不再携带整条消息快照。
    await emit({
      type: 'message_update',
      runId,
      messageId: base.id,
      update,
      ...(delta !== undefined ? { delta } : {}),
      assistantMessageEvent: event,
    })
  }

  const ensureTextStarted = async (contentIndex: number): Promise<void> => {
    if (startedTextIndexes.has(contentIndex)) return
    startedTextIndexes.add(contentIndex)
    if (partialContentBlocks.get(contentIndex)?.type !== 'text') {
      partialContentBlocks.set(contentIndex, { type: 'text', text: '' })
    }
    await emitAssistantUpdate('text', { type: 'text_start', contentIndex })
  }

  const endText = async (contentIndex: number): Promise<void> => {
    if (!startedTextIndexes.has(contentIndex) || endedTextIndexes.has(contentIndex)) return
    endedTextIndexes.add(contentIndex)
    const block = partialContentBlocks.get(contentIndex)
    await emitAssistantUpdate('text', {
      type: 'text_end',
      contentIndex,
      content: block?.type === 'text' ? block.text : '',
    })
  }

  const endOpenText = async (): Promise<void> => {
    for (const contentIndex of startedTextIndexes) await endText(contentIndex)
  }

  const boundedDelta = (delta: string): string => {
    if (contentTruncated || !delta) return ''
    const remaining = Math.max(0, maxMessageBytes - streamedBytes)
    if (byteLength(delta) <= remaining) {
      streamedBytes += byteLength(delta)
      return delta
    }
    contentTruncated = true
    const accepted = truncateToBytes(delta, remaining, '')
    streamedBytes += byteLength(accepted)
    base = { ...base, stopReason: 'length' }
    return accepted
  }

  // signature 独立预算：不消费可见内容字节，截断不置 contentTruncated/stopReason。
  const boundedSignatureDelta = (delta: string): string => {
    if (!delta) return ''
    const remaining = Math.max(0, MAX_THINKING_SIGNATURE_BYTES - signatureBytes)
    if (byteLength(delta) <= remaining) {
      signatureBytes += byteLength(delta)
      return delta
    }
    const accepted = truncateToBytes(delta, remaining, '')
    signatureBytes += byteLength(accepted)
    return accepted
  }

  await emit({
    type: 'message_start',
    runId,
    message: snapshotAssistant(base, partialToolCalls, partialContentBlocks),
  })

  try {
    const transformedMessages = transformContext
      ? await transformContext(snapshotAgentMessages(context.messages), signal, snapshotAgentContext(context), runId)
      : snapshotAgentMessages(context.messages)
    const validatedContextMessages = validatedMessages(transformedMessages, 'context Hook messages')
    const modelMessages = await (convertToModelMessages ?? defaultConvertToModelMessages)(
      validatedContextMessages,
      signal,
    )
    const hasImages = modelMessages.some((message) =>
      (message.role === 'user' || message.role === 'tool')
      && message.contentBlocks?.some((block) => block.type === 'image'))
    if (hasImages && context.model.input && !context.model.input.includes('image')) {
      throw new Error(`模型 ${context.model.provider}/${context.model.model} 不支持图片输入`)
    }
    if (context.reasoning && context.model.supportsReasoning === false) {
      throw new Error(`模型 ${context.model.provider}/${context.model.model} 不支持 thinking/reasoning`)
    }
    let request: ModelRequest = {
      sessionId: context.sessionId,
      runId,
      systemPrompt: systemPromptOverride ?? context.systemPrompt,
      model: structuredClone(context.model),
      messages: modelMessages,
      tools: activeToolsForContext(context).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: cloneJsonValue(tool.inputSchema),
      })),
      reasoning: context.reasoning ? structuredClone(context.reasoning) : undefined,
      maxOutputTokens: context.model.maxOutputTokens,
      auth: await resolveModelAuth?.(structuredClone(context.model), signal),
    }
    if (prepareModelRequest) {
      const requestMessages = request.messages
      request = await prepareModelRequest(request, signal, transport)
      if (request.messages !== requestMessages) {
        context.messages = snapshotAgentMessages(request.messages)
      }
    }
    sentRequest = snapshotModelRequest(request)
    await emit({
      type: 'provider_request_start',
      requestId: providerRequestId,
      runId,
      assistantMessageId: base.id,
      modelProvider: request.model.provider,
      modelId: request.model.model,
      messageCount: request.messages.length,
      toolCount: request.tools.length,
    })
    await onModelRequest?.(snapshotModelRequest(request), signal)

    for await (const event of transport.stream(request, signal, providerLifecycle)) {
      if (signal.aborted) break

      switch (event.type) {
        case 'start':
          base = {
            ...base,
            ...(event.responseId ? { responseId: event.responseId } : {}),
            ...(event.responseModel ? { responseModel: event.responseModel } : {}),
          }
          break

        case 'text_delta': {
          const contentIndex = event.contentIndex ?? 0
          await ensureTextStarted(contentIndex)
          const delta = boundedDelta(event.delta)
          if (delta) {
            const current = partialContentBlocks.get(contentIndex)
            partialContentBlocks.set(contentIndex, {
              type: 'text',
              text: `${current?.type === 'text' ? current.text : ''}${delta}`,
              textSignature: event.textSignature
                ?? (current?.type === 'text' ? current.textSignature : undefined),
            })
            base = { ...base, content: `${base.content}${delta}` }
          }
          await emitAssistantUpdate('text', { type: 'text_delta', contentIndex, delta }, delta)
          break
        }

        case 'thinking_start':
          {
            await endOpenText()
            const thinkingSignature = event.thinkingSignature ?? event.signature
          partialContentBlocks.set(event.contentIndex, {
            type: 'thinking',
            thinking: '',
            thinkingSignature: thinkingSignature
              ? boundedSignatureDelta(thinkingSignature)
              : undefined,
            signature: thinkingSignature,
            redacted: event.redacted,
          })
          await emitAssistantUpdate('thinking', {
            type: 'thinking_start',
            contentIndex: event.contentIndex,
          })
          break
          }

        case 'thinking_delta': {
          const delta = boundedDelta(event.delta)
          const current = partialContentBlocks.get(event.contentIndex)
          partialContentBlocks.set(event.contentIndex, {
            type: 'thinking',
            thinking: `${current?.type === 'thinking' ? current.thinking : ''}${delta}`,
            thinkingSignature: current?.type === 'thinking'
              ? current.thinkingSignature ?? current.signature
              : undefined,
            signature: current?.type === 'thinking'
              ? current.thinkingSignature ?? current.signature
              : undefined,
            redacted: current?.type === 'thinking' ? current.redacted : undefined,
          })
          await emitAssistantUpdate('thinking', {
            type: 'thinking_delta',
            contentIndex: event.contentIndex,
            delta,
          }, delta)
          break
        }

        case 'thinking_signature_delta': {
          const delta = boundedSignatureDelta(event.delta)
          const current = partialContentBlocks.get(event.contentIndex)
          partialContentBlocks.set(event.contentIndex, {
            type: 'thinking',
            thinking: current?.type === 'thinking' ? current.thinking : '',
            thinkingSignature: `${current?.type === 'thinking'
              ? current.thinkingSignature ?? current.signature ?? ''
              : ''}${delta}`,
            signature: `${current?.type === 'thinking'
              ? current.thinkingSignature ?? current.signature ?? ''
              : ''}${delta}`,
            redacted: current?.type === 'thinking' ? current.redacted : undefined,
          })
          await emitAssistantUpdate('thinking', {
            type: 'thinking_signature_delta',
            contentIndex: event.contentIndex,
            delta,
          }, delta)
          break
        }

        case 'thinking_end': {
          const current = partialContentBlocks.get(event.contentIndex)
          await emitAssistantUpdate('thinking', {
            type: 'thinking_end',
            contentIndex: event.contentIndex,
            content: current?.type === 'thinking' ? current.thinking : '',
          })
          break
        }

        case 'tool_call_start': {
          await endOpenText()
          const occupied = new Set([
            ...partialContentBlocks.keys(),
            ...Array.from(partialToolCalls.values(), (call) => call.contentIndex),
          ])
          let contentIndex = event.contentIndex ?? event.index
          // Provider 显式下发与既有 block 冲突的 contentIndex 时也必须 remap，
          // 否则 snapshotAssistant / streamingDraft 会用同 index 覆盖前一工具块。
          if (occupied.has(contentIndex)) {
            contentIndex = Math.max(-1, ...occupied) + 1
          }
          const startedCall = {
            index: event.index,
            contentIndex,
            id: event.id || createId('tool-call'),
            name: boundedDelta(event.name),
            rawArguments: '',
            thoughtSignature: event.thoughtSignature,
          }
          partialToolCalls.set(event.index, startedCall)
          await emitAssistantUpdate('tool_call', {
            type: 'toolcall_start',
            contentIndex,
            id: startedCall.id,
            name: startedCall.name,
          })
          break
        }

        case 'tool_call_delta': {
          const current = partialToolCalls.get(event.index) ?? {
            index: event.index,
            contentIndex: Math.max(
              -1,
              ...partialContentBlocks.keys(),
              ...Array.from(partialToolCalls.values(), (call) => call.contentIndex),
            ) + 1,
            id: createId('tool-call'),
            name: '',
            rawArguments: '',
          }
          const nameDelta = boundedDelta(event.nameDelta ?? '')
          const argumentsDelta = boundedDelta(event.argumentsDelta)
          // 兼容部分 provider 在非首 chunk 重复携带完整工具名：与当前已拼接 name
          // 相同时跳过，避免拼出 "bashbash"；真正的分片补全（'read_' + 'file'）不受影响。
          const effectiveNameDelta = nameDelta && nameDelta !== current.name ? nameDelta : ''
          partialToolCalls.set(event.index, {
            ...current,
            name: `${current.name}${effectiveNameDelta}`,
            rawArguments: `${current.rawArguments}${argumentsDelta}`,
          })
          await emitAssistantUpdate('tool_call', {
            type: 'toolcall_delta',
            contentIndex: current.contentIndex,
            delta: argumentsDelta,
          }, argumentsDelta)
          break
        }

        case 'tool_call_end': {
          const current = partialToolCalls.get(event.index)
          const partial = snapshotAssistant(base, partialToolCalls, partialContentBlocks)
          const toolCall = partial.toolCalls.find((call) => call.id === current?.id)
          if (current && toolCall) {
            await emitAssistantUpdate('tool_call', {
              type: 'toolcall_end',
              contentIndex: current.contentIndex,
              toolCall,
            })
          }
          break
        }

        case 'diagnostic':
          base = {
            ...base,
            diagnostics: [...(base.diagnostics ?? []), event.diagnostic],
          }
          break

        case 'done':
          await endOpenText()
          doneSeen = true
          base = {
            ...base,
            stopReason: contentTruncated ? 'length' : event.stopReason,
            usage: event.usage,
          }
          break

        case 'error':
          await endOpenText()
          doneSeen = true
          base = {
            ...base,
            stopReason: 'error',
            errorMessage: event.error?.message ?? event.message,
            providerError: event.error ?? classifyProviderError({ message: event.message }),
            diagnostics: [
              ...(base.diagnostics ?? []),
              {
                type: 'provider-error',
                timestamp: Date.now(),
                error: {
                  message: event.error?.message ?? event.message,
                  code: event.error?.code,
                },
                details: {
                  kind: event.error?.kind ?? 'unknown',
                  retryable: event.error?.retryable ?? false,
                  ...(event.error?.status !== undefined ? { status: event.error.status } : {}),
                },
              },
            ],
          }
          break
      }

      if (event.type === 'error') break
    }

    if (signal.aborted) {
      base = { ...base, stopReason: 'aborted', errorMessage: 'Agent 运行已取消' }
    } else if (!doneSeen && base.stopReason !== 'length') {
      base = { ...base, stopReason: 'error', errorMessage: '模型流在结束事件前关闭' }
    }
  } catch (error) {
    const aborted = signal.aborted || isAbortError(error)
    base = {
      ...base,
      stopReason: aborted ? 'aborted' : 'error',
      errorMessage: aborted
        ? 'Agent 运行已取消'
        : error instanceof Error
          ? error.message
          : String(error),
      ...(!aborted
        ? {
            providerError: classifyProviderError({
              message: error instanceof Error ? error.message : String(error),
            }),
            diagnostics: [...(base.diagnostics ?? []), diagnosticForError('model-stream-error', error)],
          }
        : {}),
    }
  }

  await endOpenText()

  let message = snapshotAssistant(base, partialToolCalls, partialContentBlocks)
  if (message.toolCalls.length > 0 && message.stopReason === 'stop') {
    message = { ...message, stopReason: 'tool_use' }
  }
  if (sentRequest) {
    try {
      await onModelResponse?.(
        snapshotAssistantMessage(message),
        snapshotModelRequest(sentRequest),
        signal,
      )
    } catch (error) {
      message = {
        ...message,
        stopReason: 'error',
        errorMessage: `模型响应观察器失败：${error instanceof Error ? error.message : String(error)}`,
        diagnostics: [
          ...(message.diagnostics ?? []),
          diagnosticForError('model-response-hook-error', error),
        ],
      }
    }
  }
  // 取消/错误终态下，部分工具调用不会被执行，也不会有对应的 tool_result。
  // 若不剥离，会作为"有 tool_call 无 tool_result"的悬空调用进入后续模型上下文，
  // 大多数 Provider 会拒绝此类历史消息（或污染上下文）。
  if (message.stopReason === 'aborted' || message.stopReason === 'error') {
    if (message.toolCalls.length > 0) {
      const danglingIds = new Set(message.toolCalls.map((call) => call.id))
      message = {
        ...message,
        toolCalls: [],
        ...(message.contentBlocks?.length
          ? {
              contentBlocks: message.contentBlocks.filter(
                (block) => block.type !== 'tool_call' || !danglingIds.has(block.id),
              ),
            }
          : {}),
      }
    }
  }
  // 凡无可见文本（content/text 块）且无工具调用的空 assistant 消息一律排除出模型上下文，
  // 避免向 Provider 发送空的 assistant 轮次——Anthropic-compatible 会对空 assistant 返回 400。
  // 覆盖范围不限于 error/aborted 终态：成功终态的空流、全部 token 预算被截断的空响应、
  // 以及仅含 thinking 块的空响应（thinking 块在 Provider 历史中常被剥离，剥离后 content 为空）
  // 同样会泄漏空消息，必须一并排除。
  if (!hasMeaningfulAssistantContent(message)) {
    message = { ...message, excludeFromModelContext: true }
  }
  if (sentRequest) {
    await emit({
      type: 'provider_response_received',
      requestId: providerRequestId,
      runId,
      assistantMessageId: message.id,
      message,
    })
  }
  await emit({ type: 'message_end', runId, message })
  return message
}
