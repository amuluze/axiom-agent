import { describe, expect, it } from 'vitest'
import type { AssistantMessage } from './types'
import { applyStreamingEvent, initStreamingDraft } from './streamingDraft'

const baseMessage = (): AssistantMessage => ({
  id: 'm1',
  role: 'assistant',
  content: '',
  toolCalls: [],
  stopReason: 'stop',
  createdAt: 1,
  provider: 'test',
  model: 'model',
})

const replay = (events: Parameters<typeof applyStreamingEvent>[2][]) => {
  let message = initStreamingDraft(baseMessage())
  let contentIndexes: number[] = []
  for (const event of events) {
    const result = applyStreamingEvent(message, contentIndexes, event)
    message = result.message
    contentIndexes = result.contentIndexes
  }
  return { message, contentIndexes }
}

describe('applyStreamingEvent', () => {
  it('accumulates text deltas into the matching block and plain projection', () => {
    const { message } = replay([
      { type: 'text_start', contentIndex: 0 },
      { type: 'text_delta', contentIndex: 0, delta: 'hel' },
      { type: 'text_delta', contentIndex: 0, delta: 'lo' },
      { type: 'text_end', contentIndex: 0, content: 'hello' },
    ])
    expect(message.content).toBe('hello')
    expect(message.contentBlocks).toEqual([
      { type: 'text', text: 'hello' },
    ])
  })

  it('keeps thinking and text blocks ordered by contentIndex', () => {
    const { message } = replay([
      { type: 'thinking_start', contentIndex: 0 },
      { type: 'thinking_delta', contentIndex: 0, delta: 'reason' },
      { type: 'thinking_signature_delta', contentIndex: 0, delta: 'sig' },
      { type: 'text_start', contentIndex: 1 },
      { type: 'text_delta', contentIndex: 1, delta: 'answer' },
    ])
    expect(message.contentBlocks).toEqual([
      { type: 'thinking', thinking: 'reason', thinkingSignature: 'sig', signature: 'sig' },
      { type: 'text', text: 'answer' },
    ])
    expect(message.content).toBe('answer')
  })

  it('handles out-of-order block creation by sorting on contentIndex', () => {
    const { message } = replay([
      { type: 'text_start', contentIndex: 1 },
      { type: 'text_delta', contentIndex: 1, delta: 'after' },
      { type: 'thinking_start', contentIndex: 0 },
      { type: 'thinking_delta', contentIndex: 0, delta: 'before' },
    ])
    expect(message.contentBlocks).toEqual([
      { type: 'thinking', thinking: 'before' },
      { type: 'text', text: 'after' },
    ])
  })

  it('tracks tool calls in both contentBlocks and the toolCalls array', () => {
    const { message } = replay([
      { type: 'text_start', contentIndex: 0 },
      { type: 'text_delta', contentIndex: 0, delta: 'a' },
      { type: 'toolcall_start', contentIndex: 1, id: 'call-1', name: 'echo' },
      { type: 'toolcall_delta', contentIndex: 1, delta: '{"v' },
      { type: 'toolcall_delta', contentIndex: 1, delta: '":"ok"}' },
      { type: 'toolcall_end', contentIndex: 1, toolCall: {
        id: 'call-1', name: 'echo', arguments: { v: 'ok' }, rawArguments: '{"v":"ok"}',
      } },
    ])
    expect(message.contentBlocks?.[1]).toEqual({
      type: 'tool_call',
      id: 'call-1',
      name: 'echo',
      arguments: { v: 'ok' },
      rawArguments: '{"v":"ok"}',
    })
    expect(message.toolCalls).toEqual([{
      id: 'call-1',
      name: 'echo',
      arguments: { v: 'ok' },
      rawArguments: '{"v":"ok"}',
    }])
  })

  it('defensively synthesizes a text_start for a delta without a prior start', () => {
    const { message } = replay([
      { type: 'text_delta', contentIndex: 3, delta: 'ghost' },
    ])
    expect(message.content).toBe('ghost')
    expect(message.contentBlocks).toEqual([
      { type: 'text', text: 'ghost' },
    ])
  })

  it('does not overwrite an existing block when a duplicate toolcall_start arrives', () => {
    const { message, contentIndexes } = replay([
      { type: 'toolcall_start', contentIndex: 0, id: 'call-a', name: 'echo' },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"value":"a"}' },
      // 重复 contentIndex 的第二个 start（Provider 异常）：不得覆盖 call-a
      { type: 'toolcall_start', contentIndex: 0, id: 'call-b', name: 'echo' },
    ])
    expect(contentIndexes).toEqual([0])
    expect(message.contentBlocks).toEqual([
      {
        type: 'tool_call',
        id: 'call-a',
        name: 'echo',
        arguments: null,
        rawArguments: '{"value":"a"}',
      },
    ])
    expect(message.toolCalls.map((call) => call.id)).toEqual(['call-a'])
  })

  it('does not wipe accumulated text when a duplicate text_start arrives', () => {
    const { message } = replay([
      { type: 'text_start', contentIndex: 0 },
      { type: 'text_delta', contentIndex: 0, delta: 'hello' },
      // 重复 text_start 不得把已累积文本重置为空
      { type: 'text_start', contentIndex: 0 },
    ])
    expect(message.content).toBe('hello')
    expect(message.contentBlocks).toEqual([
      { type: 'text', text: 'hello' },
    ])
  })
})
