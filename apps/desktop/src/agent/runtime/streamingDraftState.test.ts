import { describe, expect, it } from 'vitest'
import type { AssistantMessage, UserMessage } from '@/agent/core/types'
import { StreamingDraftState } from './streamingDraftState'

const assistant = (): AssistantMessage => ({
  id: 'm1',
  role: 'assistant',
  content: '',
  toolCalls: [],
  stopReason: 'stop',
  createdAt: 1,
  provider: 'test',
  model: 'model',
})

describe('StreamingDraftState', () => {
  it('applies assistant stream events and returns isolated snapshots', () => {
    const state = new StreamingDraftState()
    state.start(assistant())
    state.apply({ type: 'text_start', contentIndex: 0 })
    state.apply({ type: 'text_delta', contentIndex: 0, delta: 'hi' })
    const first = state.messageSnapshot()
    expect(first?.content).toBe('hi')
    if (first) first.content = 'mutated'
    expect(state.messageSnapshot()?.content).toBe('hi')
  })

  it('ignores assistant events when the current message is not assistant', () => {
    const state = new StreamingDraftState()
    const user: UserMessage = {
      id: 'u1',
      role: 'user',
      content: 'hello',
      createdAt: 1,
    }
    state.start(user)
    state.apply({ type: 'text_delta', contentIndex: 0, delta: 'ignored' })
    expect(state.messageSnapshot()).toMatchObject({ role: 'user', content: 'hello' })
  })

  it('clears the draft on message end without clearing active tool calls', () => {
    const state = new StreamingDraftState()
    state.start(assistant())
    state.beginToolCall('tool-1')
    state.beginToolCall('tool-2')
    state.clearMessage()
    expect(state.messageSnapshot()).toBeUndefined()
    expect([...state.pendingToolCalls()]).toEqual(['tool-1', 'tool-2'])
    state.endToolCall('tool-1')
    expect([...state.pendingToolCalls()]).toEqual(['tool-2'])
    state.reset()
    expect(state.pendingToolCalls().size).toBe(0)
  })
})
