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
import { UNSUPPORTED_IMAGE_NOTE } from './stripUnsupportedImages'

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

  it('declared text-only model strips image payloads instead of failing the turn', async () => {
    const transport = new ScriptedTransport([textScript('hi')])
    const { events } = sink()
    const context: AgentContext = {
      ...makeContext(),
      model: { provider: 'p', model: 'm', input: ['text'] },
      messages: [imageUserMessage],
    }
    // Domain 不变量 4：能力不匹配不得中断整轮。原实现在此抛错并走编排失败路径；
    // 现在请求照发，图片负载逐处替换为固定子串（验收 9 钉死措辞）。
    const message = await streamAssistantMessage(
      context, 'r', transport, new AbortController().signal, (event) => { events.push(event) }, 64 * 1024,
    )
    expect(message.stopReason).toBe('stop')
    expect(transport.requests).toHaveLength(1)
    const forwarded = transport.requests[0].messages.find((m) => m.role === 'user')
    expect(forwarded?.contentBlocks?.some((block) => block.type === 'image')).toBe(false)
    expect(JSON.stringify(forwarded)).toContain('[图片已省略：当前模型不支持图片输入]')
    // 降级只作用于发出副本：持久化侧的消息仍保留原图片块。
    expect(JSON.stringify(context.messages)).toContain('"type":"image"')
  })

  it('input omitted on the ModelRef forwards images to the provider', async () => {
    // 目录判定已恒有值（目录外一律 ['text']），ModelRef 省略 input 只可能来自直接
    // 构造的引用；此时保持旧的「能力未知即放行」行为，由 provider 自己裁决。
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

// 验收 5/7/8/16/18：请求组装期降级的完整契约。
describe('图片能力降级：持久化、可逆性与在途快照', () => {
  const textOnly = (messages: AgentMessage[]): AgentContext => ({
    ...makeContext(),
    model: { provider: 'p', model: 'm', input: ['text'] },
    messages,
  })
  const multimodal = (messages: AgentMessage[]): AgentContext => ({
    ...makeContext(),
    model: { provider: 'p', model: 'm', input: ['text', 'image'] },
    messages,
  })
  const call = (context: AgentContext, transport: ScriptedTransport) => streamAssistantMessage(
    context, 'r', transport, new AbortController().signal, () => {}, 64 * 1024,
  )
  const sentUserMessage = (transport: ScriptedTransport) =>
    transport.requests[0].messages.find((m) => m.role === 'user')

  it('验收 5：仅文本判定下请求照发、无图片块、无 data URL 串、每处一条占位', async () => {
    const transport = new ScriptedTransport([textScript('ok')])
    await call(textOnly([imageUserMessage, {
      id: 'u-inline', role: 'user', content: '内嵌图 data:image/png;base64,ZZZ', createdAt: 2,
      contentBlocks: [{ type: 'text', text: '内嵌图 data:image/png;base64,ZZZ' }],
    }]), transport)

    expect(transport.requests).toHaveLength(1)
    const payload = JSON.stringify(transport.requests[0].messages)
    expect(payload).not.toContain('"type":"image"')
    expect(payload).not.toContain('data:image')
    expect(payload).not.toContain('aGk=')
    // 每个原图片负载位置各一条占位：image 块 1 处 + 内嵌串 1 处。
    // （`content` 扁平投影是同一负载的重复视图，额外一条不算独立负载位置。）
    const forwarded = transport.requests[0].messages.filter((m) => m.role === 'user')
    const notes = forwarded.flatMap((m) => m.contentBlocks ?? [])
      .filter((b) => b.type === 'text' && b.text.includes(UNSUPPORTED_IMAGE_NOTE))
    expect(notes).toHaveLength(2)
  })

  it('验收 5：同一消息 + 支持图片判定 → 图片负载原样出现在请求中', async () => {
    const transport = new ScriptedTransport([textScript('ok')])
    await call(multimodal([imageUserMessage]), transport)
    const forwarded = sentUserMessage(transport)
    expect(forwarded?.contentBlocks?.some((block) => block.type === 'image')).toBe(true)
    expect(JSON.stringify(forwarded)).toContain('aGk=')
  })

  it('验收 7：降级前后 context.messages 与审计快照逐字节一致（不污染持久化）', async () => {
    const context = textOnly([imageUserMessage])
    const before = JSON.stringify(context.messages)
    const transport = new ScriptedTransport([textScript('ok')])
    const audited: ModelRequest[] = []
    await streamAssistantMessage(
      context, 'r', transport, new AbortController().signal, () => {}, 64 * 1024,
      undefined, undefined, undefined, undefined,
      (request) => { audited.push(structuredClone(request)) },
    )
    // 持久化侧逐字节不变（占位只存在于发出副本）。
    expect(JSON.stringify(context.messages)).toBe(before)
    // 审计快照记录的是实际送出的降级副本（与持久化数据无关）。
    expect(JSON.stringify(audited[0].messages)).not.toContain('"type":"image"')
  })

  it('验收 7：prepareModelRequest 的回写路径不会被占位符污染', async () => {
    const context = textOnly([imageUserMessage])
    const before = JSON.stringify(context.messages)
    const transport = new ScriptedTransport([textScript('ok')])
    // 回写发生在降级之前：prepareModelRequest 返回同 messages 引用时不得触发写回，
    // 返回新数组时写入的也应是未经占位替换的版本。
    await streamAssistantMessage(
      context, 'r', transport, new AbortController().signal, () => {}, 64 * 1024,
      undefined, undefined, undefined,
      (request) => Promise.resolve({ ...request, messages: [...request.messages] }),
    )
    expect(JSON.stringify(context.messages)).toBe(before)
    expect(JSON.stringify(context.messages)).toContain('"type":"image"')
  })

  it('验收 8：声明切回支持图片后，图片负载重新可见（降级可逆）', async () => {
    // 同一个 context（同一份持久化消息）在两种判定下各发一次。
    const context = textOnly([imageUserMessage])
    const stripped = new ScriptedTransport([textScript('a')])
    await call(context, stripped)
    const restored = new ScriptedTransport([textScript('b')])
    context.model = { provider: 'p', model: 'm', input: ['text', 'image'] }
    await call(context, restored)
    expect(sentUserMessage(restored)?.contentBlocks?.some((b) => b.type === 'image')).toBe(true)
  })

  it('验收 16：run 内能力结论取 run 启动快照（不随中途声明变更重算）', async () => {
    // 模拟「run 启动时仅文本，中途用户把声明改成支持图片」：context.model 是
    // run 启动固化的 ModelRef，run 内不得重新解析 profile。
    const context = textOnly([imageUserMessage])
    const transport = new ScriptedTransport([textScript('one'), textScript('two')])
    const before = JSON.stringify(context.messages)
    await call(context, transport)
    // 中途改声明（不触碰 run 上下文）后发起下一次请求。
    await call(context, transport)
    for (const request of transport.requests) {
      expect(JSON.stringify(request.messages)).not.toContain('"type":"image"')
    }
    expect(JSON.stringify(context.messages)).toBe(before)
  })

  it('验收 18：异常图片负载以显式失败中断，不静默放行', async () => {
    const transport = new ScriptedTransport([textScript('never')])
    const context = textOnly([{
      id: 'u-weird', role: 'user', content: 'x', createdAt: 3,
      contentBlocks: [{ type: 'image', source: { type: 'data-url', payload: 'x' } }],
    } as unknown as AgentMessage])
    await expect(call(context, transport)).rejects.toThrow('图片负载形态无法替换')
    // 失败发生在 provider 收到请求之前。
    expect(transport.requests).toHaveLength(0)
    expect(JSON.stringify(context.messages)).toContain('data-url')
  })

  it('验收 18：同一异常负载 + 支持图片判定 → 正常发出，不视为错误', async () => {
    const transport = new ScriptedTransport([textScript('seen')])
    const context = multimodal([{
      id: 'u-weird', role: 'user', content: 'x', createdAt: 3,
      contentBlocks: [{ type: 'image', source: { type: 'data-url', payload: 'x' } }],
    } as unknown as AgentMessage])
    const message = await call(context, transport)
    expect(message.stopReason).toBe('stop')
    expect(sentUserMessage(transport)?.contentBlocks?.some((b) => b.type === 'image')).toBe(true)
  })
})
