import type { ModelRequest, ModelStreamEvent, ModelTransport } from '@/agent/core/types'
import { describe, expect, it } from 'vitest'
import {
  generateSessionTitle,
  normalizeGeneratedSessionTitle,
  promptSessionTitle,
} from './title'

class TitleTransport implements ModelTransport {
  request?: ModelRequest

  constructor(private readonly events: ModelStreamEvent[]) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.request = request
    yield* this.events
  }
}

describe('session title generation', () => {
  it('normalizes model decoration and applies character limits', () => {
    expect(normalizeGeneratedSessionTitle('## 标题： “实现 branch-first 会话！”\n解释')).toBe('实现 branch-first 会话')
    expect(promptSessionTitle(`  ${'会'.repeat(90)}  `)).toHaveLength(80)
    expect(promptSessionTitle('安全\u202e标题\n第二行')).toBe('安全 标题 第二行')
  })

  it('uses a tool-free bounded auxiliary request', async () => {
    const transport = new TitleTransport([
      { type: 'start' },
      { type: 'text_delta', delta: 'Axiom 分支会话' },
      { type: 'done', stopReason: 'stop' },
    ])

    const title = await generateSessionTitle({
      sessionId: 'session-1',
      userContent: '实现会话分支',
      assistantContent: '已经完成',
      model: { provider: 'test', model: 'model' },
      transport,
    })

    expect(title).toBe('Axiom 分支会话')
    expect(transport.request).toMatchObject({
      sessionId: 'session-1',
      maxOutputTokens: 64,
      tools: [],
    })
    expect(transport.request?.messages[0]).toMatchObject({ role: 'user' })
  })

  it('rejects tool calls and oversized output', async () => {
    await expect(generateSessionTitle({
      sessionId: 'session-1',
      userContent: 'title',
      assistantContent: 'done',
      model: { provider: 'test', model: 'model' },
      transport: new TitleTransport([
        { type: 'start' },
        { type: 'tool_call_start', index: 0, id: 'call-1', name: 'read' },
      ]),
    })).rejects.toThrow('禁止调用工具')

    await expect(generateSessionTitle({
      sessionId: 'session-1',
      userContent: 'title',
      assistantContent: 'done',
      model: { provider: 'test', model: 'model' },
      transport: new TitleTransport([
        { type: 'start' },
        { type: 'text_delta', delta: 'a'.repeat(2_049) },
      ]),
    })).rejects.toThrow('超过安全上限')
  })

  it('propagates transport errors and stream termination failures', async () => {
    const base = {
      sessionId: 'session-1',
      userContent: 'title',
      assistantContent: 'done',
      model: { provider: 'test', model: 'model' },
    }
    await expect(generateSessionTitle({
      ...base,
      transport: new TitleTransport([{ type: 'error', message: 'network down' }]),
    })).rejects.toThrow('标题生成失败')

    await expect(generateSessionTitle({
      ...base,
      transport: new TitleTransport([{ type: 'start' }]),
    })).rejects.toThrow('模型流未正常结束')

    await expect(generateSessionTitle({
      ...base,
      transport: new TitleTransport([{ type: 'start' }, { type: 'done', stopReason: 'tool_use' }]),
    })).rejects.toThrow('禁止调用工具')
  })
})
