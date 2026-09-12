import { createId } from '@/agent/core/id'
import { BRANCH_SUMMARY_CUSTOM_TYPE, normalizeAssistantMessage } from '@/agent/core/messages'
import type { AgentMessage, CustomAgentMessage } from '@/agent/core/types'

export interface BranchMessageCopy {
  sourceMessageId: string
  message: AgentMessage
}

export interface BranchMessageAction {
  branchable: boolean
  retryBoundaryId?: string
  /** 用户消息的编辑边界（其前一条消息）：存在即可「编辑并重发」。 */
  editBoundaryId?: string
}

export interface BranchSummarySource {
  content: string
  sourceFromMessageId: string
  sourceThroughMessageId: string
  readFiles: string[]
  modifiedFiles: string[]
}

export const createBranchSummaryMessage = (
  source: BranchSummarySource,
  now = Date.now(),
): CustomAgentMessage => ({
  id: createId('message'),
  role: 'custom',
  customType: BRANCH_SUMMARY_CUSTOM_TYPE,
  content: source.content,
  data: {
    version: 1,
    sourceFromMessageId: source.sourceFromMessageId,
    sourceThroughMessageId: source.sourceThroughMessageId,
    readFiles: source.readFiles.slice(),
    modifiedFiles: source.modifiedFiles.slice(),
  },
  createdAt: now,
})

const messageIndex = (messages: AgentMessage[], messageId: string): number => {
  const index = messages.findIndex((message) => message.id === messageId)
  if (index < 0) throw new Error('分支边界消息不存在于当前会话')
  return index
}

const assertCompleteToolGroup = (messages: AgentMessage[], boundaryIndex: number): void => {
  const boundary = messages[boundaryIndex]
  if (boundary.role === 'assistant' && boundary.toolCalls.length > 0) {
    throw new Error('不能在 Assistant ToolCall 与 ToolResult 之间创建分支')
  }
  if (boundary.role !== 'tool') return

  let firstResultIndex = boundaryIndex
  while (firstResultIndex > 0 && messages[firstResultIndex - 1]?.role === 'tool') {
    firstResultIndex -= 1
  }
  const assistant = messages[firstResultIndex - 1]
  if (assistant?.role !== 'assistant' || assistant.toolCalls.length === 0) {
    throw new Error('工具结果缺少对应的 Assistant ToolCall')
  }
  const expected = new Set(assistant.toolCalls.map((call) => call.id))
  const actual = messages
    .slice(firstResultIndex, boundaryIndex + 1)
    .flatMap((message) => message.role === 'tool' ? [message.toolCallId] : [])
  const actualSet = new Set(actual)
  if (
    expected.size !== assistant.toolCalls.length
    || actual.length !== expected.size
    || actualSet.size !== expected.size
    || Array.from(expected).some((toolCallId) => !actualSet.has(toolCallId))
  ) {
    throw new Error('不能在一批 ToolResult 完成前创建分支')
  }
}

export const getBranchHistoryPrefix = (
  messages: AgentMessage[],
  throughMessageId: string,
): AgentMessage[] => {
  const boundaryIndex = messageIndex(messages, throughMessageId)
  assertCompleteToolGroup(messages, boundaryIndex)
  return messages.slice(0, boundaryIndex + 1)
}

export const canBranchThrough = (messages: AgentMessage[], messageId: string): boolean => {
  try {
    getBranchHistoryPrefix(messages, messageId)
    return true
  } catch {
    return false
  }
}

export const getBranchMessageActions = (messages: AgentMessage[]): BranchMessageAction[] => {
  const actions: BranchMessageAction[] = []
  let expectedToolCallIds: Set<string> | undefined
  let expectedToolCallCount = 0
  let actualToolCallIds: string[] = []
  let actualToolCallIdSet = new Set<string>()

  messages.forEach((message, index) => {
    let branchable: boolean
    if (message.role === 'tool') {
      if (messages[index - 1]?.role !== 'tool') {
        const assistant = messages[index - 1]
        expectedToolCallIds = assistant?.role === 'assistant' && assistant.toolCalls.length > 0
          ? new Set(assistant.toolCalls.map((call) => call.id))
          : undefined
        expectedToolCallCount = assistant?.role === 'assistant' ? assistant.toolCalls.length : 0
        actualToolCallIds = []
        actualToolCallIdSet = new Set()
      }
      actualToolCallIds.push(message.toolCallId)
      actualToolCallIdSet.add(message.toolCallId)
      branchable = Boolean(
        expectedToolCallIds
        && expectedToolCallIds.size === expectedToolCallCount
        && actualToolCallIds.length === expectedToolCallCount
        && actualToolCallIdSet.size === expectedToolCallCount
        && Array.from(expectedToolCallIds).every((toolCallId) => actualToolCallIdSet.has(toolCallId)),
      )
    } else {
      expectedToolCallIds = undefined
      expectedToolCallCount = 0
      actualToolCallIds = []
      actualToolCallIdSet = new Set()
      branchable = message.role !== 'assistant' || message.toolCalls.length === 0
    }

    const previous = messages[index - 1]
    const previousBranchable = previous && actions[index - 1]?.branchable
    const retryBoundaryId = message.role === 'assistant' && previousBranchable
      ? previous.id
      : undefined
    const editBoundaryId = message.role === 'user' && previousBranchable
      ? previous.id
      : undefined
    actions.push({ branchable, retryBoundaryId, editBoundaryId })
  })

  return actions
}

/**
 * 编辑用户消息的分支边界：该消息**之前**的一条消息。
 * 编辑等价于「放弃这条消息及其后续历史，用新内容重发」，因此需要这条消息之前
 * 存在一个完整的分支边界；首条用户消息之前没有边界，返回 undefined。
 */
export const editBoundaryFor = (
  messages: AgentMessage[],
  userMessageId: string,
): string | undefined => {
  const targetIndex = messages.findIndex((message) => message.id === userMessageId)
  if (targetIndex <= 0 || messages[targetIndex]?.role !== 'user') return undefined
  const boundaryId = messages[targetIndex - 1]?.id
  return boundaryId && canBranchThrough(messages, boundaryId) ? boundaryId : undefined
}

export const retryBoundaryFor = (
  messages: AgentMessage[],
  assistantMessageId: string,
): string | undefined => {
  const targetIndex = messages.findIndex((message) => message.id === assistantMessageId)
  if (targetIndex <= 0 || messages[targetIndex]?.role !== 'assistant') return undefined
  const boundaryId = messages[targetIndex - 1]?.id
  return boundaryId && canBranchThrough(messages, boundaryId) ? boundaryId : undefined
}

export const assertRetryTarget = (
  messages: AgentMessage[],
  throughMessageId: string,
  retriedMessageId: string | undefined,
): void => {
  if (!retriedMessageId) throw new Error('Retry 分支缺少目标 Assistant 消息')
  const boundaryIndex = messageIndex(messages, throughMessageId)
  const retriedIndex = messageIndex(messages, retriedMessageId)
  if (retriedIndex !== boundaryIndex + 1 || messages[retriedIndex]?.role !== 'assistant') {
    throw new Error('Retry 目标必须是分支边界后的第一条 Assistant 消息')
  }
}

export const assertBranchSummarySource = (
  messages: AgentMessage[],
  throughMessageId: string,
  summary: BranchSummarySource,
): void => {
  const boundaryIndex = messageIndex(messages, throughMessageId)
  const expectedFrom = messages[boundaryIndex + 1]
  const expectedThrough = messages[messages.length - 1]
  if (!expectedFrom || summary.sourceFromMessageId !== expectedFrom.id
    || summary.sourceThroughMessageId !== expectedThrough?.id) {
    throw new Error('Branch Summary 必须覆盖分支边界后的完整已离开历史')
  }
  if (!summary.content.trim()) throw new Error('Branch Summary 内容不能为空')
  if (new TextEncoder().encode(summary.content).byteLength > 128 * 1024) {
    throw new Error('Branch Summary 内容超过 128 KiB 安全上限')
  }
  for (const paths of [summary.readFiles, summary.modifiedFiles]) {
    if (new Set(paths).size !== paths.length || paths.some((path) => !path.trim())) {
      throw new Error('Branch Summary 文件事实无效')
    }
  }
}

export const normalizeSessionTitle = (title: string): string => {
  const normalized = title
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!normalized) throw new Error('会话标题不能为空')
  return Array.from(normalized).slice(0, 80).join('')
}

export const branchSessionTitle = (title: string, kind: 'branch' | 'retry'): string => {
  const suffix = kind === 'retry' ? ' · 重试' : ' · 分支'
  const prefix = Array.from(normalizeSessionTitle(title))
    .slice(0, 80 - Array.from(suffix).length)
    .join('')
  return `${prefix}${suffix}`
}

const cloneMessage = (message: AgentMessage): AgentMessage => {
  if (message.role === 'assistant') {
    const cloned = JSON.parse(JSON.stringify(message)) as typeof message
    return normalizeAssistantMessage({
      ...cloned,
      id: createId('message'),
    })
  }
  if (message.role === 'user') {
    return {
      ...message,
      id: createId('message'),
      contentBlocks: message.contentBlocks?.map((block) => block.type === 'image'
        ? { ...block, source: { ...block.source } }
        : { ...block }),
    }
  }
  if (message.role === 'tool') {
    return {
      ...message,
      id: createId('message'),
      contentBlocks: message.contentBlocks?.map((block) => block.type === 'image'
        ? { ...block, source: { ...block.source } }
        : { ...block }),
      artifact: message.artifact ? { ...message.artifact } : undefined,
    }
  }
  return {
    ...message,
    id: createId('message'),
    data: message.data === undefined ? undefined : JSON.parse(JSON.stringify(message.data)) as typeof message.data,
  }
}

export const createBranchMessageCopies = (
  messages: AgentMessage[],
  throughMessageId: string,
): BranchMessageCopy[] => getBranchHistoryPrefix(messages, throughMessageId).map((message) => ({
  sourceMessageId: message.id,
  message: cloneMessage(message),
}))
