import type { AgentMessage, AssistantMessage, ToolResultMessage } from '@/agent/core/types'
import { assistantContentBlocks, assistantToolCalls, ASSISTANT_CONTINUE_CUSTOM_TYPE } from '@/agent/core/messages'

export type SessionBlock =
  | { type: 'user'; key: string; message: AgentMessage }
  | { type: 'assistant-text'; key: string; message: AssistantMessage }
  | { type: 'tool'; key: string; toolCallId: string; toolName: string; call?: AssistantMessage; result?: ToolResultMessage }
  | { type: 'result-chip'; key: string; message: AssistantMessage }
  | { type: 'error-card'; key: string; message: AssistantMessage; error: string }

const toolCallIdsOfAssistant = (message: AssistantMessage): string[] => {
  const ids: string[] = []
  if (Array.isArray(message.contentBlocks)) {
    for (const block of message.contentBlocks) {
      if (block.type === 'tool_call') ids.push(block.id)
    }
  }
  for (const call of message.toolCalls ?? []) {
    if (!ids.includes(call.id)) ids.push(call.id)
  }
  return ids
}

const toolCallIdOf = (message: AgentMessage): string | null => {
  if (message.role === 'tool') return message.toolCallId
  return null
}

/** 合并 max_tokens 截断段与自动续写段：保留前一条消息身份，拼接文本与内容块。 */
const mergeContinuedAssistant = (
  previous: AssistantMessage,
  continuation: AssistantMessage,
): AssistantMessage => ({
  ...previous,
  content: `${previous.content}${continuation.content}`,
  contentBlocks: [
    ...assistantContentBlocks(previous),
    ...assistantContentBlocks(continuation),
  ],
})

export const buildSessionBlocks = (messages: AgentMessage[]): SessionBlock[] => {
  const blocks: SessionBlock[] = []
  const toolBlocks = new Map<string, Extract<SessionBlock, { type: 'tool' }>>()
  // 自动续写连接符：assistant-continue custom 消息后的有文本 assistant 与前一
  // assistant-text 块合并，避免截断段与续写段在界面上割裂为两条。
  let continuePending = false
  for (const message of messages) {
    if (message.role === 'custom') {
      if (message.customType === ASSISTANT_CONTINUE_CUSTOM_TYPE) continuePending = true
      continue
    }
    if (message.role === 'user') {
      // 用户消息是硬边界：续写连接符不跨用户消息生效
      continuePending = false
      blocks.push({ type: 'user', key: `user-${message.id}`, message })
      continue
    }
    if (message.role === 'assistant') {
      const text = message.content
      if (text && text.trim().length > 0) {
        if (continuePending) {
          const previous = blocks[blocks.length - 1]
          if (previous?.type === 'assistant-text') {
            previous.message = mergeContinuedAssistant(previous.message, message)
          } else {
            blocks.push({ type: 'assistant-text', key: `text-${message.id}`, message })
          }
          continuePending = false
        } else {
          blocks.push({ type: 'assistant-text', key: `text-${message.id}`, message })
        }
      }
      for (const toolCall of assistantToolCalls(message)) {
        const existing = toolBlocks.get(toolCall.id)
        if (existing) {
          existing.toolName = toolCall.name
          existing.call = message
          continue
        }
        const block: Extract<SessionBlock, { type: 'tool' }> = {
          type: 'tool',
          key: `tool-${toolCall.id}`,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          call: message,
        }
        toolBlocks.set(toolCall.id, block)
        blocks.push(block)
      }
      if (message.stopReason === 'error' || message.errorMessage) {
        blocks.push({
          type: 'error-card',
          key: `error-${message.id}`,
          message,
          error: message.errorMessage ?? '运行失败',
        })
      }
      continue
    }
    if (message.role === 'tool') {
      continuePending = false
      const id = message.toolCallId
      const existing = toolBlocks.get(id)
      if (existing) {
        existing.result = message
      } else {
        const block: Extract<SessionBlock, { type: 'tool' }> = {
          type: 'tool',
          key: `tool-${id}`,
          toolCallId: id,
          toolName: message.toolName,
          result: message,
        }
        toolBlocks.set(id, block)
        blocks.push(block)
      }
    }
  }
  return blocks
}

export const collectToolCallIds = (messages: AgentMessage[]): Set<string> => {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const id of toolCallIdsOfAssistant(message)) ids.add(id)
      continue
    }
    const id = toolCallIdOf(message)
    if (id) ids.add(id)
  }
  return ids
}

export const lastUserMessage = (messages: AgentMessage[]): AgentMessage | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') return message
  }
  return null
}
