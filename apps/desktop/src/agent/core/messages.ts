import { createId } from './id'
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  ModelMessage,
  TextContentBlock,
  ToolCall,
  ToolCallContentBlock,
  ToolResultContentBlock,
  ToolResultMessage,
  UserContentBlock,
  UserMessage,
} from './types'

export const BRANCH_SUMMARY_CUSTOM_TYPE = 'branch-summary'
export const ASSISTANT_CONTINUE_CUSTOM_TYPE = 'assistant-continue'
export const TURN_ABORTED_CUSTOM_TYPE = 'turn-aborted'

const textProjection = (blocks: Array<TextContentBlock | { type: string }>): string =>
  blocks.flatMap((block) => block.type === 'text' ? [(block as TextContentBlock).text] : []).join('')

const cloneUserBlock = (block: UserContentBlock): UserContentBlock => block.type === 'image'
  ? { ...block, source: { ...block.source } }
  : { ...block }

const cloneToolResultBlock = (block: ToolResultContentBlock): ToolResultContentBlock => block.type === 'image'
  ? { ...block, source: { ...block.source } }
  : { ...block }

const cloneJsonValue = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const cloneToolCall = (call: ToolCall): ToolCall => ({
  ...call,
  arguments: cloneJsonValue(call.arguments),
})

export const toolCallContentBlock = (call: ToolCall): ToolCallContentBlock => ({
  type: 'tool_call',
  ...cloneToolCall(call),
})

const cloneAssistantBlock = (block: AssistantContentBlock): AssistantContentBlock => {
  if (block.type === 'tool_call') {
    const { type: _type, ...call } = block
    return toolCallContentBlock(call)
  }
  if (block.type === 'thinking') {
    const { signature, ...rest } = block
    return {
      ...rest,
      ...(block.thinkingSignature ?? signature
        ? { thinkingSignature: block.thinkingSignature ?? signature }
        : {}),
    }
  }
  return { ...block }
}

export const userContentBlocks = (message: UserMessage): UserContentBlock[] =>
  message.contentBlocks?.map(cloneUserBlock)
  ?? [{ type: 'text', text: message.content }]

export const assistantContentBlocks = (
  message: Pick<AssistantMessage, 'content' | 'contentBlocks' | 'toolCalls'>,
): AssistantContentBlock[] => {
  const blocks = message.contentBlocks?.map(cloneAssistantBlock)
    ?? (message.content ? [{ type: 'text' as const, text: message.content }] : [])
  const includedToolCallIds = new Set(blocks.flatMap((block) =>
    block.type === 'tool_call' ? [block.id] : []))
  for (const call of message.toolCalls) {
    if (!includedToolCallIds.has(call.id)) blocks.push(toolCallContentBlock(call))
  }
  return blocks
}

export const assistantToolCalls = (
  message: Pick<AssistantMessage, 'content' | 'contentBlocks' | 'toolCalls'>,
): ToolCall[] => {
  const ordered = assistantContentBlocks(message)
    .flatMap((block) => {
      if (block.type !== 'tool_call') return []
      const { type: _type, ...call } = block
      return [cloneToolCall(call)]
    })
  return ordered.length > 0 ? ordered : message.toolCalls.map(cloneToolCall)
}

/**
 * 判断 assistant 消息是否携带对 Provider 有意义的可见内容：非空文本（content 或 text 块）
 * 或工具调用。仅含 thinking 块的空响应（如全部输出 token 消耗在 reasoning、命中
 * max_tokens 的截断响应）不算可见内容——多数 Anthropic-compatible 中继会剥离历史中的
 * thinking 块，剥离后 content 为空，触发 HTTP 400 "content or tool_calls must be set"。
 */
export const hasMeaningfulAssistantContent = (
  message: Pick<AssistantMessage, 'content' | 'contentBlocks' | 'toolCalls'>,
): boolean => {
  if (assistantToolCalls(message).length > 0) return true
  if ((message.content ?? '').trim().length > 0) return true
  return (message.contentBlocks ?? []).some(
    (block) => block.type === 'text' && (block.text ?? '').trim().length > 0,
  )
}

/**
 * 单条消息的持久化字节预算，与 toolResults 的消息预算同值：message_end 是持久化
 * 屏障，Rust persist_session_message 对请求体有 2 MiB 硬上限，超限会让 run 失败
 * 关闭并把会话留在半持久化状态。工具结果超限走降级（丢图片/截断），而用户输入
 * 不能被静默改写——必须在入列前 fail-fast，给出可操作的报错。
 */
export const MAX_PERSISTABLE_MESSAGE_BYTES = 1536 * 1024

export const assertMessagePersistable = (message: AgentMessage): void => {
  const encoded = JSON.stringify(message)
  if (new TextEncoder().encode(encoded).byteLength > MAX_PERSISTABLE_MESSAGE_BYTES) {
    throw new Error(
      '消息超过单条 1.5 MiB 持久化上限：请拆分大段文本、压缩或减少图片数量后重试（会话未被写入，无需修复）',
    )
  }
}

export const normalizeAssistantMessage = (message: AssistantMessage): AssistantMessage => {
  const contentBlocks = assistantContentBlocks(message)
  return {
    ...message,
    content: textProjection(contentBlocks),
    contentBlocks,
    toolCalls: assistantToolCalls({ ...message, contentBlocks }),
    ...(message.diagnostics
      ? { diagnostics: message.diagnostics.map((diagnostic) => cloneJsonValue(diagnostic)) }
      : {}),
  }
}

export const toolResultContentBlocks = (
  message: Pick<ToolResultMessage, 'content' | 'contentBlocks'>,
): ToolResultContentBlock[] => message.contentBlocks?.map(cloneToolResultBlock)
  ?? [{ type: 'text', text: message.content }]

export const createUserMessage = (
  input: string | UserContentBlock[],
  now = Date.now(),
): UserMessage => {
  const contentBlocks = typeof input === 'string'
    ? undefined
    : input.map(cloneUserBlock)
  return {
    id: createId('message'),
    role: 'user',
    content: typeof input === 'string' ? input : textProjection(input),
    ...(contentBlocks ? { contentBlocks } : {}),
    createdAt: now,
  }
}

export const convertBuiltInCustomMessage = (
  message: Extract<AgentMessage, { role: 'custom' }>,
): UserMessage | undefined => {
  if (message.customType === BRANCH_SUMMARY_CUSTOM_TYPE) {
    return {
      id: message.id,
      role: 'user',
      content: `此前曾探索另一条会话分支。以下摘要仅作为继续工作的上下文：\n\n<branch-summary>\n${message.content}\n</branch-summary>`,
      createdAt: message.createdAt,
    }
  }
  if (message.customType === ASSISTANT_CONTINUE_CUSTOM_TYPE) {
    return {
      id: message.id,
      role: 'user',
      content: message.content,
      createdAt: message.createdAt,
    }
  }
  if (message.customType === TURN_ABORTED_CUSTOM_TYPE) {
    return {
      id: message.id,
      role: 'user',
      content: `<turn-aborted>\n${message.content}\n</turn-aborted>`,
      createdAt: message.createdAt,
    }
  }
  return undefined
}

/**
 * 生成内部"自动续写" custom 消息。模型上次响应因 max_tokens 截断（stopReason 'length'）
 * 且无工具调用时，runAgentLoop 主循环自动追加它让模型续写，避免长任务输出戛然而止。
 * custom 消息在桌面 transcript 不渲染（messagePairs 仅处理 user/assistant/tool），
 * 由 {@link convertBuiltInCustomMessage} 转为用户续写指令进入模型上下文。
 */
export const createAssistantContinueMessage = (
  truncatedMessageId?: string,
  now = Date.now(),
): Extract<AgentMessage, { role: 'custom' }> => ({
  id: createId('message'),
  role: 'custom',
  customType: ASSISTANT_CONTINUE_CUSTOM_TYPE,
  content: '你的上一次回复因输出长度达到上限而被截断。请从未完成处继续输出剩余内容；若上次回复已逻辑完整，请直接说明任务已完成。',
  ...(truncatedMessageId ? { data: { truncatedMessageId } } : {}),
  createdAt: now,
})

/** turn-aborted 标记的中断原因：用户主动中断，或达到单次运行时间上限。 */
export type TurnAbortedReason = 'user-abort' | 'time-limit'

/**
 * 生成内部「中断标记」custom 消息。run 因用户中断或超时结束时追加到历史尾部
 * （对齐 codex 的 interrupted_turn_history_marker）：下一轮模型能看到上一轮
 * 未正常收口，不假设中断前的工作已完成。custom 消息在桌面 transcript 不渲染，
 * 经 {@link convertBuiltInCustomMessage} 转为用户消息进入模型上下文。
 */
export const createTurnAbortedMessage = (
  reason: TurnAbortedReason,
  now = Date.now(),
): Extract<AgentMessage, { role: 'custom' }> => ({
  id: createId('message'),
  role: 'custom',
  customType: TURN_ABORTED_CUSTOM_TYPE,
  content: reason === 'time-limit'
    ? '上一轮回复在完成前因达到单次运行时间上限而中止。中断前执行的操作可能只完成了一部分：不要假设上一轮工作已经完成；若要继续该任务，请先核实当前实际状态。'
    : '上一轮回复在完成前被用户中断。中断前执行的操作可能只完成了一部分：不要假设上一轮工作已经完成；若要继续该任务，请先核实当前实际状态。',
  data: { reason },
  createdAt: now,
})

export const defaultConvertToModelMessages = (messages: AgentMessage[]): ModelMessage[] =>
  messages.map((message) => {
    if (message.role !== 'custom') return message
    const converted = convertBuiltInCustomMessage(message)
    if (converted) return converted
    throw new Error(`自定义消息 ${message.customType} 需要 convertToModelMessages 转换器`)
  })
