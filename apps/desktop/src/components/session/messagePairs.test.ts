import { describe, expect, it } from 'vitest'
import type {
  AgentMessage,
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from '@/agent/core/types'
import type { SessionBlock } from './messagePairs'
import {
  buildSessionBlocks,
  collectToolCallIds,
  lastUserMessage,
} from './messagePairs'

const userMessage = (id: string, content: string): UserMessage => ({
  id,
  createdAt: 0,
  role: 'user',
  content,
})

const toolCall = (id: string, name: string): ToolCall => ({
  id,
  name,
  arguments: {},
  rawArguments: '{}',
})

const assistantMessage = (input: Partial<AssistantMessage> & { id: string; toolCalls?: ToolCall[] }): AssistantMessage => ({
  id: input.id,
  createdAt: 0,
  role: 'assistant',
  content: input.content ?? '',
  contentBlocks: input.contentBlocks,
  toolCalls: input.toolCalls ?? [],
  stopReason: input.stopReason ?? 'stop',
  responseId: input.responseId,
  provider: input.provider,
  model: input.model,
  responseModel: input.responseModel,
  diagnostics: input.diagnostics,
  usage: input.usage,
  errorMessage: input.errorMessage,
  providerError: input.providerError,
  excludeFromModelContext: input.excludeFromModelContext,
})

const toolResult = (id: string, toolCallId: string, isError = false, content = ''): ToolResultMessage => ({
  id,
  createdAt: 0,
  role: 'tool',
  toolCallId,
  toolName: 'write',
  content,
  isError,
})

describe('buildSessionBlocks', () => {
  it('returns an empty array for no messages', () => {
    expect(buildSessionBlocks([])).toEqual([])
  })

  it('emits a user block for each user message in order', () => {
    const blocks = buildSessionBlocks([userMessage('u1', 'hi'), userMessage('u2', 'again')])
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ type: 'user', key: 'user-u1' })
    expect(blocks[1]).toMatchObject({ type: 'user', key: 'user-u2' })
  })

  it('pairs an assistant tool call with its later tool result', () => {
    const blocks = buildSessionBlocks([
      assistantMessage({
        id: 'a1',
        content: '',
        toolCalls: [toolCall('tc-1', 'write')],
      }),
      toolResult('r1', 'tc-1'),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'tool',
      toolCallId: 'tc-1',
      toolName: 'write',
      call: expect.objectContaining({ id: 'a1' }),
      result: expect.objectContaining({ id: 'r1', role: 'tool' }),
    })
  })

  it('pairs a tool result with its assistant call even when the result arrives first', () => {
    const blocks = buildSessionBlocks([
      toolResult('r1', 'tc-orphan'),
      assistantMessage({
        id: 'a1',
        content: '',
        toolCalls: [toolCall('tc-orphan', 'read')],
      }),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'tool',
      toolCallId: 'tc-orphan',
      toolName: 'read',
      result: expect.objectContaining({ id: 'r1' }),
      call: expect.objectContaining({ id: 'a1' }),
    })
  })

  it('deduplicates repeated assistant tool calls by toolCallId', () => {
    const blocks = buildSessionBlocks([
      assistantMessage({
        id: 'a1',
        content: '',
        toolCalls: [toolCall('tc-1', 'read'), toolCall('tc-1', 'read')],
      }),
      toolResult('r1', 'tc-1'),
    ])

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'tool',
      toolCallId: 'tc-1',
      result: expect.objectContaining({ id: 'r1' }),
    })
  })

  it('skips the assistant-text block when the assistant message has no content', () => {
    const blocks = buildSessionBlocks([
      assistantMessage({ id: 'a1', content: '   ', toolCalls: [toolCall('tc-1', 'write')] }),
    ])
    expect(blocks.some((block) => block.type === 'assistant-text')).toBe(false)
    expect(blocks.some((block) => block.type === 'tool')).toBe(true)
  })

  it('emits both assistant-text and tool blocks when the assistant message has text + tool calls', () => {
    const blocks = buildSessionBlocks([
      assistantMessage({
        id: 'a1',
        content: 'I will edit the file',
        toolCalls: [toolCall('tc-1', 'edit')],
      }),
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ type: 'assistant-text', key: 'text-a1' })
    expect(blocks[1]).toMatchObject({ type: 'tool', key: 'tool-tc-1', toolName: 'edit' })
  })

  it('adds an error-card when the assistant stopReason is "error"', () => {
    const blocks = buildSessionBlocks([
      assistantMessage({ id: 'a1', content: '', stopReason: 'error' }),
    ])
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'error-card',
      key: 'error-a1',
      error: '运行失败',
    }))
  })

  it('uses errorMessage over the default "运行失败" fallback', () => {
    const blocks = buildSessionBlocks([
      assistantMessage({
        id: 'a1',
        content: '',
        stopReason: 'error',
        errorMessage: 'npm test 退出码 1',
      }),
    ])
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'error-card',
      error: 'npm test 退出码 1',
    }))
  })

  it('adds an error-card when errorMessage is present even with stopReason "stop"', () => {
    const blocks = buildSessionBlocks([
      assistantMessage({
        id: 'a1',
        content: '',
        stopReason: 'stop',
        errorMessage: 'recovered after retry',
      }),
    ])
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'error-card',
      error: 'recovered after retry',
    }))
  })

  it('later tool result with the same toolCallId overwrites the earlier one', () => {
    const blocks = buildSessionBlocks([
      assistantMessage({ id: 'a1', content: '', toolCalls: [toolCall('tc-1', 'read')] }),
      toolResult('r-1', 'tc-1', false, 'first'),
      toolResult('r-2', 'tc-1', true, 'second'),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'tool',
      toolCallId: 'tc-1',
      result: expect.objectContaining({ id: 'r-2', isError: true, content: 'second' }),
    })
  })

  it('emits one tool block per assistant tool call when no result is paired', () => {
    const blocks = buildSessionBlocks([
      assistantMessage({
        id: 'a1',
        content: '',
        toolCalls: [toolCall('tc-1', 'write'), toolCall('tc-2', 'edit')],
      }),
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks.map((block) => block.type === 'tool' ? block.toolName : null))
      .toEqual(['write', 'edit'])
  })

  it('preserves user / assistant / tool interleaving order', () => {
    const messages: AgentMessage[] = [
      userMessage('u1', 'summarize'),
      assistantMessage({ id: 'a1', content: 'fetching', toolCalls: [toolCall('tc-1', 'ls')] }),
      toolResult('r-1', 'tc-1'),
      assistantMessage({ id: 'a2', content: 'done' }),
    ]
    const blocks = buildSessionBlocks(messages)
    expect(blocks.map((block) => block.type)).toEqual([
      'user', 'assistant-text', 'tool', 'assistant-text',
    ])
    expect(blocks[0]).toMatchObject({ key: 'user-u1' })
    expect(blocks[1]).toMatchObject({ key: 'text-a1' })
    expect(blocks[2]).toMatchObject({ key: 'tool-tc-1' })
    expect(blocks[3]).toMatchObject({ key: 'text-a2' })
  })

  it('merges a max_tokens-truncated assistant turn with its auto-continue into one text block', () => {
    const continueMessage: AgentMessage = {
      id: 'c1',
      createdAt: 0,
      role: 'custom',
      customType: 'assistant-continue',
      content: '你的上一次回复因输出长度达到上限而被截断。请从未完成处继续输出剩余内容。',
    }
    const blocks = buildSessionBlocks([
      userMessage('u1', 'long task'),
      assistantMessage({ id: 'a1', content: '前半段输出', stopReason: 'length' }),
      continueMessage,
      assistantMessage({ id: 'a2', content: '后半段输出', stopReason: 'stop' }),
    ])

    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ type: 'user' })
    expect(blocks[1]).toMatchObject({ type: 'assistant-text', key: 'text-a1' })
    // 截断段与续写段合并为一条 assistant-text，custom 连接符不渲染
    const merged = blocks[1] as Extract<SessionBlock, { type: 'assistant-text' }>
    expect(merged.message.content).toBe('前半段输出后半段输出')
    expect(merged.message.id).toBe('a1')
  })

  it('does not merge assistant turns not connected by an auto-continue marker', () => {
    const blocks = buildSessionBlocks([
      assistantMessage({ id: 'a1', content: 'first reply', stopReason: 'stop' }),
      assistantMessage({ id: 'a2', content: 'second reply', stopReason: 'stop' }),
    ])
    expect(blocks).toHaveLength(2)
    expect((blocks[0] as Extract<SessionBlock, { type: 'assistant-text' }>).message.content).toBe('first reply')
    expect((blocks[1] as Extract<SessionBlock, { type: 'assistant-text' }>).message.content).toBe('second reply')
  })

  it('does not merge across a user message boundary', () => {
    const continueMessage: AgentMessage = {
      id: 'c1',
      createdAt: 0,
      role: 'custom',
      customType: 'assistant-continue',
      content: '你的上一次回复因输出长度达到上限而被截断。',
    }
    // thinking-only 续写段无文本、不消费连接符；其后的用户消息是硬边界，
    // 下一轮对话的 assistant 不得被误合并进前一回合。
    const blocks = buildSessionBlocks([
      userMessage('u0', '任务'),
      assistantMessage({ id: 'a1', content: '前半段', stopReason: 'length' }),
      continueMessage,
      assistantMessage({ id: 'a2', content: '', stopReason: 'length' }),
      userMessage('u1', '下一个问题'),
      assistantMessage({ id: 'a3', content: '独立回答', stopReason: 'stop' }),
    ])
    expect(blocks.filter((block) => block.type === 'assistant-text')).toHaveLength(2)
    const texts = blocks
      .filter((block): block is Extract<SessionBlock, { type: 'assistant-text' }> => block.type === 'assistant-text')
      .map((block) => block.message.content)
    expect(texts).toEqual(['前半段', '独立回答'])
  })

  it('renders the continuation standalone when there is no preceding assistant-text block', () => {
    // thinking-only 截断段无文本不产生 assistant-text，续写段应独立成块
    const continueMessage: AgentMessage = {
      id: 'c1',
      createdAt: 0,
      role: 'custom',
      customType: 'assistant-continue',
      content: '你的上一次回复因输出长度达到上限而被截断。',
    }
    const blocks = buildSessionBlocks([
      assistantMessage({ id: 'a1', content: '', stopReason: 'length' }),
      continueMessage,
      assistantMessage({ id: 'a2', content: '最终方案', stopReason: 'stop' }),
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'assistant-text', key: 'text-a2' })
    expect((blocks[0] as Extract<SessionBlock, { type: 'assistant-text' }>).message.content).toBe('最终方案')
  })
})

describe('collectToolCallIds', () => {
  it('returns an empty set for an empty transcript', () => {
    expect(collectToolCallIds([]).size).toBe(0)
  })

  it('extracts ids from assistant tool calls', () => {
    const ids = collectToolCallIds([
      assistantMessage({ id: 'a1', content: '', toolCalls: [toolCall('tc-1', 'write'), toolCall('tc-2', 'edit')] }),
    ])
    expect([...ids]).toEqual(['tc-1', 'tc-2'])
  })

  it('falls back to the tool message toolCallId when contentBlocks are absent', () => {
    const ids = collectToolCallIds([toolResult('r-1', 'tc-orphan')])
    expect([...ids]).toEqual(['tc-orphan'])
  })

  it('deduplicates ids that appear in both assistant and tool messages', () => {
    const ids = collectToolCallIds([
      assistantMessage({ id: 'a1', content: '', toolCalls: [toolCall('tc-1', 'write')] }),
      toolResult('r-1', 'tc-1'),
    ])
    expect([...ids]).toEqual(['tc-1'])
  })

  it('ignores user messages', () => {
    const ids = collectToolCallIds([userMessage('u1', 'hi')])
    expect([...ids]).toEqual([])
  })
})

describe('lastUserMessage', () => {
  it('returns null for an empty transcript', () => {
    expect(lastUserMessage([])).toBeNull()
  })

  it('returns the most recent user message', () => {
    const last = lastUserMessage([
      userMessage('u1', 'first'),
      userMessage('u2', 'second'),
      userMessage('u3', 'third'),
    ])
    expect(last).toMatchObject({ id: 'u3', content: 'third' })
  })

  it('returns null when no user message exists', () => {
    expect(lastUserMessage([
      assistantMessage({ id: 'a1', content: 'no user here' }),
    ])).toBeNull()
  })
})
