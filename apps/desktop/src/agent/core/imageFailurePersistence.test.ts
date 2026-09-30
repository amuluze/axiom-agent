import { createUserMessage } from './messages'
import { runAgentLoop } from './runAgentLoop'
import type { AgentContext, AgentEvent, ModelStreamEvent, ModelTransport, UserContentBlock } from './types'
import { describe, expect, it } from 'vitest'
import { MemorySessionRepository } from '@/persistence/MemorySessionRepository'

class FailingTransport implements ModelTransport {
  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield { type: 'start', responseId: 'response-1' }
    throw new Error('provider upstream 500')
  }
}

describe('图片发送失败的可持久化性（复现 ledger 级联）', () => {
  it('provider 失败后失败消息可完整落库且不引发 ledger 级联', async () => {
    const repository = new MemorySessionRepository()
    const snapshot = await repository.createSession({ systemPrompt: 'Test system prompt' } as never)
    const sessionId = snapshot.session.id

    const context: AgentContext = {
      sessionId,
      systemPrompt: 'Test system prompt',
      // 视觉模型：图片直达 provider，失败来自 provider 自身（图片能力降级后，
      // 仅文本模型不再抛错，这里改由 provider 故障复现同一个持久化场景）。
      model: { provider: 'deepseek', model: 'deepseek-flash', input: ['text', 'image'] },
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
      transport: new FailingTransport(),
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
    // provider 流失败归类为 model-stream 类诊断（不再是编排失败——图片能力不匹配
    // 已改为发送副本降级，见 Domain 不变量 4）；这里只锁定「失败消息带诊断」与
    // 「持久化监听器不抛级联错误」这两个复现观察点。
    expect((message.diagnostics ?? []).length).toBeGreaterThan(0)
    expect(message.errorMessage).toContain('provider upstream 500')

    // 复现观察点：持久化监听器是否抛出 ledger 级联错误
    console.log('recordErrors:', JSON.stringify(recordErrors))
    expect(recordErrors).toEqual([])
  })
})
