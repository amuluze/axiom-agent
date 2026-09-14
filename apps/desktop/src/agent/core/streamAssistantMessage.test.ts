import { describe, expect, it, vi } from 'vitest'
import type {
  AgentContext,
  AgentEvent,
  AgentEventSink,
  AgentMessage,
  ModelRequest,
  ModelStreamEvent,
  ModelTransport,
} from './types'
import { streamAssistantMessage } from './streamAssistantMessage'

class ScriptedTransport implements ModelTransport {
  readonly requests: ModelRequest[] = []

  constructor(private readonly scripts: ModelStreamEvent[][]) {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request)
    const script = this.scripts[this.requests.length - 1]
    if (!script) throw new Error('No scripted model response')
    for (const event of script) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      yield event
    }
  }
}

const makeContext = (): AgentContext => ({
  sessionId: 's',
  systemPrompt: 'sys',
  model: { provider: 'p', model: 'm' },
  messages: [],
  tools: [],
})

const sink = (): { emit: AgentEventSink; events: AgentEvent[] } => {
  const events: AgentEvent[] = []
  return {
    emit: (event) => { events.push(event) },
    events,
  }
}

const run = async (
  transport: ModelTransport,
  events: AgentEvent[],
  signal = new AbortController().signal,
  maxMessageBytes = 64 * 1024,
) => streamAssistantMessage(
  makeContext(),
  'r',
  transport,
  signal,
  (event) => { events.push(event) },
  maxMessageBytes,
)

const textScript = (content: string): ModelStreamEvent[] => [
  { type: 'start', responseId: 'resp-1' },
  { type: 'text_delta', contentIndex: 0, delta: content },
  { type: 'done', stopReason: 'stop' },
]

const imageUserMessage: AgentMessage = {
  id: 'u-img',
  role: 'user',
  content: '看这张图',
  contentBlocks: [
    { type: 'text', text: '看这张图' },
    { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'aGk=' } },
  ],
  createdAt: 1,
}

describe('streamAssistantMessage', () => {
  it('streams a text response and emits a correct lifecycle', async () => {
    const transport = new ScriptedTransport([textScript('hello')])
    const { events } = sink()
    const message = await run(transport, events)

    expect(message.role).toBe('assistant')
    expect(message.content).toBe('hello')
    expect(message.stopReason).toBe('stop')
    expect(message.provider).toBe('p')
    expect(message.responseId).toBe('resp-1')

    const types = events.map((event) => event.type)
    expect(types[0]).toBe('message_start')
    expect(types[types.length - 1]).toBe('message_end')
    const updates = events.filter((event) => event.type === 'message_update')
    expect(updates.map((event) => (event as { assistantMessageEvent: { type: string } }).assistantMessageEvent.type))
      .toEqual(['text_start', 'text_delta', 'text_end'])
  })

  it('accumulates a tool call into toolCalls and contentBlocks, with stopReason tool_use', async () => {
    const script: ModelStreamEvent[] = [
      { type: 'start', responseId: 'resp-t' },
      { type: 'tool_call_start', index: 0, contentIndex: 0, id: 'call-1', name: 'echo' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"v":"1"}' },
      { type: 'tool_call_end', index: 0 },
      { type: 'done', stopReason: 'tool_use' },
    ]
    const transport = new ScriptedTransport([script])
    const { events } = sink()
    const message = await run(transport, events)

    expect(message.toolCalls).toHaveLength(1)
    expect(message.toolCalls[0]).toMatchObject({ id: 'call-1', name: 'echo', arguments: { v: '1' } })
    expect(message.stopReason).toBe('tool_use')
  })

  it('promotes content truncation to the length stopReason', async () => {
    const longContent = 'a'.repeat(100)
    const transport = new ScriptedTransport([textScript(longContent)])
    const { events } = sink()
    const message = await run(transport, events, new AbortController().signal, 10)

    expect(message.stopReason).toBe('length')
    expect(message.content.length).toBeLessThanOrEqual(10)
  })

  it('marks a signal-aborted stream as aborted and strips dangling tool calls', async () => {
    const script: ModelStreamEvent[] = [
      { type: 'start' },
      { type: 'tool_call_start', index: 0, contentIndex: 0, id: 'call-1', name: 'echo' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"v":"1"}' },
      { type: 'tool_call_end', index: 0 },
    ]
    // 在事件之间让出宏任务，使 setTimeout 的 abort 能在流消费中途生效。
    class InterruptibleTransport implements ModelTransport {
      async *stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
        for (const event of script) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
          yield event
        }
      }
    }
    const transport = new InterruptibleTransport()
    const { events } = sink()
    const controller = new AbortController()
    const messagePromise = streamAssistantMessage(
      makeContext(), 'r', transport, controller.signal, (event) => { events.push(event) }, 64 * 1024,
    )
    // 在 generator 让出宏任务期间中断。
    setTimeout(() => controller.abort(), 5)
    const message = await messagePromise

    expect(message.stopReason).toBe('aborted')
    expect(message.toolCalls).toEqual([])
  })

  it('marks an empty assistant message as excluded from model context', async () => {
    const transport = new ScriptedTransport([[{ type: 'start' }, { type: 'done', stopReason: 'stop' }]])
    const { events } = sink()
    const message = await run(transport, events)

    expect(message.content).toBe('')
    expect(message.excludeFromModelContext).toBe(true)
  })

  it('forwards thinking deltas and signature out of the visible content budget', async () => {
    const script: ModelStreamEvent[] = [
      { type: 'start' },
      { type: 'thinking_start', contentIndex: 0, thinkingSignature: 'sig-1' },
      { type: 'thinking_delta', contentIndex: 0, delta: 'reasoning' },
      { type: 'thinking_end', contentIndex: 0 },
      { type: 'text_delta', contentIndex: 1, delta: 'answer' },
      { type: 'done', stopReason: 'stop' },
    ]
    const transport = new ScriptedTransport([script])
    const { events } = sink()
    const message = await run(transport, events)

    const blocks = message.contentBlocks ?? []
    const thinking = blocks.find((block) => block.type === 'thinking')
    const text = blocks.find((block) => block.type === 'text')
    expect(thinking).toMatchObject({ type: 'thinking', thinking: 'reasoning' })
    expect(text).toMatchObject({ type: 'text', text: 'answer' })
  })

  it('records a provider error when the transport emits an error', async () => {
    const script: ModelStreamEvent[] = [
      { type: 'start' },
      { type: 'error', message: 'boom' },
    ]
    const transport = new ScriptedTransport([script])
    const { events } = sink()
    const message = await run(transport, events)

    expect(message.stopReason).toBe('error')
    expect(message.errorMessage).toBe('boom')
    expect(message.diagnostics?.some((d) => d.type === 'provider-error')).toBe(true)
  })

  it('invokes prepareModelRequest and reflects request mutations', async () => {
    const prepareModelRequest = vi.fn(async (request: ModelRequest) => ({
      ...request,
      messages: [...request.messages, { id: 'extra', role: 'user' as const, content: 'x', createdAt: 1 }],
    }))
    const transport = new ScriptedTransport([textScript('hi')])
    const { events } = sink()
    await streamAssistantMessage(
      makeContext(),
      'r',
      transport,
      new AbortController().signal,
      (event) => { events.push(event) },
      64 * 1024,
      undefined,
      undefined,
      undefined,
      prepareModelRequest,
    )
    expect(prepareModelRequest).toHaveBeenCalled()
    expect(transport.requests[0].messages.map((m) => m.role)).toContain('user')
  })

  it('declared text-only model rejects image input before reaching the provider', async () => {
    const transport = new ScriptedTransport([textScript('hi')])
    const { events } = sink()
    const context: AgentContext = {
      ...makeContext(),
      model: { provider: 'p', model: 'm', input: ['text'] },
      messages: [imageUserMessage],
    }
    // 请求构造期失败（图片硬闸在 sentRequest 建立之前）：原样上抛走编排失败路径，
    // 不落库为 model-stream-error 消息。
    await expect(streamAssistantMessage(
      context, 'r', transport, new AbortController().signal, (event) => { events.push(event) }, 64 * 1024,
    )).rejects.toThrow('不支持图片输入')
    expect(transport.requests).toHaveLength(0)
  })

  it('unknown-capability model (input omitted) forwards images to the provider', async () => {
    // 目录外自定义模型多为多模态：input 缺省表示能力未知，图片直达 provider 由其裁决。
    const transport = new ScriptedTransport([textScript('seen')])
    const { events } = sink()
    const context: AgentContext = { ...makeContext(), messages: [imageUserMessage] }
    const message = await streamAssistantMessage(
      context, 'r', transport, new AbortController().signal, (event) => { events.push(event) }, 64 * 1024,
    )

    expect(message.stopReason).toBe('stop')
    expect(message.content).toBe('seen')
    const forwarded = transport.requests[0].messages.find((m) => m.role === 'user')
    expect(forwarded?.contentBlocks?.some((block) => block.type === 'image')).toBe(true)
  })
})
