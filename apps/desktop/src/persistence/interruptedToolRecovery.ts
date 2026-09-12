import type {
  AgentMessage,
  ToolRecoveryPolicy,
  ToolResultMessage,
} from '@/agent/core/types'

export const INTERRUPTED_TOOL_RESULT_CONTENT =
  '工具调用未形成完整的持久化结果，应用可能在收尾阶段退出。为避免重复副作用，Axiom 未自动重放此工具调用；请确认当前状态后再决定是否重试。'
/** 工具已执行完成、但结果因应用退出未保存的占位文案：副作用很可能已生效，需先确认状态。 */
export const COMPLETED_TOOL_RESULT_CONTENT =
  '此工具调用已执行完成，但结果因应用退出未保存。请先确认该副作用是否已生效，再决定是否重试，切勿盲目重放。'

export type InterruptedExecutionState = 'completed' | 'interrupted'

export interface PersistedRunMessage {
  message: AgentMessage
  runId?: string
}

const sha256 = async (value: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export const interruptedToolResultId = async (
  runId: string,
  toolCallId: string,
): Promise<string> => `tool-interrupted-${await sha256(`${runId}\0${toolCallId}`)}`

export const createInterruptedToolResult = async (
  messages: PersistedRunMessage[],
  runId: string,
  toolCallId: string,
  createdAt: number,
  recoveryPolicy: ToolRecoveryPolicy = 'never',
  executionState: InterruptedExecutionState = 'interrupted',
): Promise<ToolResultMessage | undefined> => {
  const runMessages = messages.filter((candidate) => candidate.runId === runId)
  if (runMessages.some(({ message }) =>
    message.role === 'tool' && message.toolCallId === toolCallId)) {
    return undefined
  }
  const assistant = [...runMessages].reverse().find(({ message }) =>
    message.role === 'assistant'
    && message.toolCalls.some((toolCall) => toolCall.id === toolCallId))
  if (!assistant || assistant.message.role !== 'assistant') return undefined
  const toolCall = assistant.message.toolCalls.find((candidate) => candidate.id === toolCallId)
  if (!toolCall) return undefined
  return {
    id: await interruptedToolResultId(runId, toolCallId),
    role: 'tool',
    toolCallId,
    toolName: toolCall.name,
    content: executionState === 'completed'
      ? COMPLETED_TOOL_RESULT_CONTENT
      : INTERRUPTED_TOOL_RESULT_CONTENT,
    details: {
      reason: 'application_exit',
      executionState,
      runId,
      recoveryPolicy,
      replayed: false,
      eligibleForReplay: recoveryPolicy === 'idempotent',
    },
    isError: true,
    createdAt,
  }
}
