import type {
  AssistantContentBlock,
  AssistantMessage,
  AssistantMessageEvent,
  ToolCall,
} from './types'

/**
 * 基于 {@link AssistantMessageEvent} 增量事件重放 assistant 流式草稿。
 *
 * `message_update` 不再携带整条消息快照，消费端从 `message_start` 的基线消息
 * 出发，按 contentIndex 累积各 content block 的文本/思考/工具参数。`contentIndexes`
 * 是每个 contentBlock 的 contentIndex（升序），contentBlocks 数组下标即其在
 * 排序后快照中的位置——与 streamAssistantMessage.ts 内 snapshotAssistant 的稠密输出一致。
 *
 * 同时并行维护 `toolCalls` 扁平数组：assistantContentBlocks 会按 id 去重合并
 * contentBlocks 与 toolCalls，流式期间 tool_call 块以 contentBlocks 为准渲染
 * 顺序，toolCalls 供 `streamingMessage.toolCalls` 直接读取。
 */

export const initStreamingDraft = (message: AssistantMessage): AssistantMessage => ({
  ...message,
  content: message.content ?? '',
  contentBlocks: [],
  toolCalls: [],
})

export interface StreamReplayResult {
  message: AssistantMessage
  contentIndexes: number[]
}

const insertPosition = (contentIndexes: number[], contentIndex: number): number => {
  let low = 0
  let high = contentIndexes.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (contentIndexes[middle] < contentIndex) low = middle + 1
    else high = middle
  }
  return low
}

const replaceBlock = (
  blocks: AssistantContentBlock[],
  position: number,
  block: AssistantContentBlock,
): AssistantContentBlock[] => (
  blocks.map((existing, index) => index === position ? block : existing)
)

const upsertToolCall = (
  toolCalls: ToolCall[],
  next: ToolCall,
): ToolCall[] => [
  ...toolCalls.filter((call) => call.id !== next.id),
  next,
]

const insertBlock = (
  blocks: AssistantContentBlock[],
  contentIndexes: number[],
  contentIndex: number,
  block: AssistantContentBlock,
): { blocks: AssistantContentBlock[]; contentIndexes: number[] } => {
  const position = insertPosition(contentIndexes, contentIndex)
  if (contentIndexes[position] === contentIndex) {
    // 防御：同 contentIndex 的 start 重复到达（Provider 异常）时不得覆盖已有 block，
    // 否则会静默丢失此前累积的文本/思考/工具块。返回原状由调用方跳过。
    return { blocks, contentIndexes }
  }
  return {
    blocks: [
      ...blocks.slice(0, position),
      block,
      ...blocks.slice(position),
    ],
    contentIndexes: [
      ...contentIndexes.slice(0, position),
      contentIndex,
      ...contentIndexes.slice(position),
    ],
  }
}

export const applyStreamingEvent = (
  message: AssistantMessage,
  contentIndexes: number[],
  event: AssistantMessageEvent,
): StreamReplayResult => {
  const blocks = message.contentBlocks ?? []
  const toolCalls = message.toolCalls ?? []

  switch (event.type) {
    case 'text_start': {
      const inserted = insertBlock(blocks, contentIndexes, event.contentIndex, { type: 'text', text: '' })
      if (inserted.contentIndexes === contentIndexes) return { message, contentIndexes }
      return {
        message: { ...message, contentBlocks: inserted.blocks },
        contentIndexes: inserted.contentIndexes,
      }
    }

    case 'text_delta': {
      const position = contentIndexes.indexOf(event.contentIndex)
      if (position < 0) {
        // 防御：delta 先于 start 到达，补一个 start 再应用。
        const started = applyStreamingEvent(message, contentIndexes, {
          type: 'text_start',
          contentIndex: event.contentIndex,
        })
        return applyStreamingEvent(started.message, started.contentIndexes, event)
      }
      const current = blocks[position]
      const nextBlock = current?.type === 'text'
        ? { ...current, text: `${current.text}${event.delta}` }
        : { type: 'text' as const, text: event.delta }
      return {
        message: {
          ...message,
          content: `${message.content}${event.delta}`,
          contentBlocks: replaceBlock(blocks, position, nextBlock),
        },
        contentIndexes,
      }
    }

    case 'text_end':
      return { message, contentIndexes }

    case 'thinking_start': {
      const inserted = insertBlock(blocks, contentIndexes, event.contentIndex, { type: 'thinking', thinking: '' })
      if (inserted.contentIndexes === contentIndexes) return { message, contentIndexes }
      return {
        message: { ...message, contentBlocks: inserted.blocks },
        contentIndexes: inserted.contentIndexes,
      }
    }

    case 'thinking_delta': {
      const position = contentIndexes.indexOf(event.contentIndex)
      if (position < 0) {
        const started = applyStreamingEvent(message, contentIndexes, {
          type: 'thinking_start',
          contentIndex: event.contentIndex,
        })
        return applyStreamingEvent(started.message, started.contentIndexes, event)
      }
      const current = blocks[position]
      const nextBlock = current?.type === 'thinking'
        ? { ...current, thinking: `${current.thinking}${event.delta}` }
        : { type: 'thinking' as const, thinking: event.delta }
      return {
        message: { ...message, contentBlocks: replaceBlock(blocks, position, nextBlock) },
        contentIndexes,
      }
    }

    case 'thinking_signature_delta': {
      const position = contentIndexes.indexOf(event.contentIndex)
      if (position < 0) return { message, contentIndexes }
      const current = blocks[position]
      if (current?.type !== 'thinking') return { message, contentIndexes }
      const thinkingSignature = `${current.thinkingSignature ?? ''}${event.delta}`
      return {
        message: {
          ...message,
          contentBlocks: replaceBlock(blocks, position, {
            ...current,
            thinkingSignature,
            signature: thinkingSignature,
          }),
        },
        contentIndexes,
      }
    }

    case 'thinking_end':
      return { message, contentIndexes }

    case 'toolcall_start': {
      const inserted = insertBlock(blocks, contentIndexes, event.contentIndex, {
        type: 'tool_call',
        id: event.id,
        name: event.name,
        arguments: null,
        rawArguments: '',
      })
      // 冲突（同 contentIndex 重复 start）时跳过，不覆盖已有块也不新增幽灵 tool call
      if (inserted.contentIndexes === contentIndexes) return { message, contentIndexes }
      return {
        message: {
          ...message,
          contentBlocks: inserted.blocks,
          toolCalls: upsertToolCall(toolCalls, {
            id: event.id,
            name: event.name,
            arguments: null,
            rawArguments: '',
          }),
        },
        contentIndexes: inserted.contentIndexes,
      }
    }

    case 'toolcall_delta': {
      const position = contentIndexes.indexOf(event.contentIndex)
      if (position < 0) return { message, contentIndexes }
      const current = blocks[position]
      if (current?.type !== 'tool_call') return { message, contentIndexes }
      const rawArguments = `${current.rawArguments}${event.delta}`
      return {
        message: {
          ...message,
          contentBlocks: replaceBlock(blocks, position, { ...current, rawArguments }),
          toolCalls: upsertToolCall(toolCalls, {
            ...current,
            rawArguments,
          }),
        },
        contentIndexes,
      }
    }

    case 'toolcall_end': {
      const position = contentIndexes.indexOf(event.contentIndex)
      if (position < 0) return { message, contentIndexes }
      return {
        message: {
          ...message,
          contentBlocks: replaceBlock(blocks, position, {
            type: 'tool_call',
            ...event.toolCall,
          }),
          toolCalls: upsertToolCall(toolCalls, event.toolCall),
        },
        contentIndexes,
      }
    }
  }
}
