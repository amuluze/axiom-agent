import { createUserMessage } from './messages'
import { runAgentLoop } from './runAgentLoop'
import type { AgentContext, AgentEvent, ModelStreamEvent, ModelTransport, UserContentBlock } from './types'
import { describe, expect, it } from 'vitest'
import { MemorySessionRepository } from '@/persistence/MemorySessionRepository'

class ScriptedTransport implements ModelTransport {
  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield { type: 'start', responseId: 'response-1' }
    yield { type: 'text_delta', delta: 'hello' }
    yield { type: 'done', stopReason: 'stop' }
  }
}

describe('图片发送失败的可持久化性（复现 ledger 级联）', () => {
  it('非视觉模型的图片消息失败后，失败消息可完整落库且错误保留图片原因', async () => {
    const repository = new MemorySessionRepository()
    const snapshot = await repository.createSession({ systemPrompt: 'Test system prompt' } as never)
    const sessionId = snapshot.session.id

    const context: AgentContext = {
      sessionId,
      systemPrompt: 'Test system prompt',
      // 声明 input 但不含 image：命中 streamAssistantMessage 的图片校验
      model: { provider: 'deepseek', model: 'deepseek-flash', input: ['text'] },
      messages: [],
      tools: [],
    }
    const imageBlock: UserContentBlock = {
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: 'cG5n' },
    }
    const events: AgentEvent[] = []
    const recordErrors: string[] = []

    await runAgentLoop({
      context,
      prompts: [createUserMessage(['看这张截图', imageBlock] as UserContentBlock[])],
      transport: new ScriptedTransport(),
      emit: async (event) => {
        events.push(event)
        try {
          await repository.recordEvent(sessionId, event as never)
        } catch (error) {
          recordErrors.push(error instanceof Error ? error.message : String(error))
        }
      },
    })

    // 事件流应包含失败 assistant 消息，且带编排失败诊断
    const failureEnd = events.find((event) => event.type === 'message_end'
      && (event as { message?: { role?: string } }).message?.role === 'assistant')
    expect(failureEnd).toBeDefined()
    const message = (failureEnd as { message: { diagnostics?: Array<{ type?: string }>; errorMessage?: string } }).message
    expect(message.diagnostics?.some((diagnostic) => diagnostic.type === 'agent-orchestration-error')).toBe(true)
    expect(message.errorMessage).toContain('不支持图片输入')

    // 复现观察点：持久化监听器是否抛出 ledger 级联错误
    console.log('recordErrors:', JSON.stringify(recordErrors))
    expect(recordErrors).toEqual([])
  })
})
