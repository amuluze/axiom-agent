import { describe, expect, it } from 'vitest'
import type { AgentContext } from './types'
import { createOrchestrationFailureMessage } from './diagnostics'

const context: AgentContext = {
  sessionId: 's1',
  systemPrompt: '',
  model: { provider: 'p', model: 'm' },
  messages: [],
  tools: [],
}

describe('createOrchestrationFailureMessage', () => {
  it('marks the empty terminal assistant as excluded from model context', () => {
    // 空 assistant（无 content、无 tool_calls）一旦进入投影会被 OpenAI 兼容端以
    // 400（content or tool_calls must be set）拒绝整条请求。
    const message = createOrchestrationFailureMessage(context, new Error('持久化失败'), false)
    expect(message.stopReason).toBe('error')
    expect(message.content).toBe('')
    expect(message.excludeFromModelContext).toBe(true)
  })

  it('marks aborted runs the same way', () => {
    const message = createOrchestrationFailureMessage(context, new DOMException('取消', 'AbortError'), true)
    expect(message.stopReason).toBe('aborted')
    expect(message.excludeFromModelContext).toBe(true)
  })
})
