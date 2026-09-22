import type { ModelRequest, ModelStreamEvent } from '@/agent/core/types'
import type { ModelHttpRequest } from './modelHttpContract'
import { describe, expect, it } from 'vitest'
import {
  buildOpenAICompatibleBody,
  OpenAICompatibleTransport,
  type ModelHttpStreamFactory,
} from './OpenAICompatibleTransport'

const request: ModelRequest = {
  sessionId: 'session-1',
  runId: 'run-1',
  systemPrompt: 'Be careful',
  model: { provider: 'openai-compatible', model: 'model-a' },
  messages: [
    { id: 'u1', role: 'user', content: 'inspect', createdAt: 1 },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-previous', name: 'read_file', arguments: { path: '/tmp/a' }, rawArguments: '{"path":"/tmp/a"}' }],
      stopReason: 'tool_use',
      createdAt: 2,
    },
    {
      id: 't1',
      role: 'tool',
      toolCallId: 'call-previous',
      toolName: 'read_file',
      content: 'contents',
      isError: false,
      createdAt: 3,
    },
  ],
  tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }],
}

const collect = async (
  transport: OpenAICompatibleTransport,
  modelRequest: ModelRequest = request,
): Promise<ModelStreamEvent[]> => {
  const events: ModelStreamEvent[] = []
  for await (const event of transport.stream(modelRequest, new AbortController().signal)) events.push(event)
  return events
}

describe('OpenAICompatibleTransport', () => {
  it('serializes canonical messages and tools without placing a secret in the body', () => {
    const body = buildOpenAICompatibleBody(request, 2048)
    expect(body).toMatchObject({ model: 'model-a', stream: true, max_tokens: 2048 })
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be careful' },
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-previous',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"/tmp/a"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call-previous', content: 'contents' },
    ])
    expect(JSON.stringify(body)).not.toContain('secret')
  })

  it('serializes images, thinking replay and reasoning effort', () => {
    const body = buildOpenAICompatibleBody({
      ...request,
      reasoning: { level: 'high', mode: 'effort' },
      messages: [
        {
          id: 'rich-user',
          role: 'user',
          content: 'inspect',
          contentBlocks: [
            { type: 'text', text: 'inspect' },
            { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
          ],
          createdAt: 1,
        },
        {
          id: 'rich-assistant',
          role: 'assistant',
          content: 'done',
          contentBlocks: [
            { type: 'thinking', thinking: 'private' },
            { type: 'text', text: 'done' },
          ],
          toolCalls: [],
          stopReason: 'stop',
          createdAt: 2,
        },
      ],
    }, 2048)

    expect(body.reasoning_effort).toBe('high')
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be careful' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'inspect' },
          { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
        ],
      },
      { role: 'assistant', content: 'done', reasoning_content: 'private' },
    ])

    const crossProvider = buildOpenAICompatibleBody({
      ...request,
      messages: [{
        id: 'foreign-thinking',
        role: 'assistant',
        provider: 'anthropic-compatible',
        model: 'foreign-model',
        content: 'answer',
        contentBlocks: [
          { type: 'thinking', thinking: 'portable reasoning', signature: 'foreign-signature' },
          { type: 'text', text: 'answer' },
        ],
        toolCalls: [],
        stopReason: 'stop',
        createdAt: 1,
      }],
    })
    expect(crossProvider.messages).toEqual([
      { role: 'system', content: 'Be careful' },
      {
        role: 'assistant',
        content: '<thinking>\nportable reasoning\n</thinking>answer',
      },
    ])
  })

  it('parses text, fragmented tool calls, usage and DONE', async () => {
    let captured: ModelHttpRequest | undefined
    const encoder = new TextEncoder()
    const stream: ModelHttpStreamFactory = (rawRequest) => {
      captured = rawRequest
      return (async function* () {
                yield encoder.encode('data: {"id":"resp-1","model":"resolved-openai","choices":[{"delta":{"reasoning_content":"reason ","reasoning_signature":"reason-sig"}}]}\n\n')
        yield encoder.encode('data: {"choices":[{"delta":{"content":"Hi ","text_signature":"text-sig"}}]}\n\n')
        yield encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","thought_signature":"thought-sig","function":{"name":"read_","arguments":"{\\"path\\":"}}]}}]}\n\n')
        yield encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"\\"/tmp/a\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n')
        yield encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14,"prompt_tokens_details":{"cached_tokens":2},"completion_tokens_details":{"reasoning_tokens":3}}}\n\ndata: [DONE]\n\n')
      })()
    }
    const transport = new OpenAICompatibleTransport({
      providerId: 'generic-openai-compatible',
      endpoint: 'https://api.example.com/v1/chat/completions',
      secretId: 'provider.default.api-key',
    }, stream)

    const events = await collect(transport, {
      ...request,
      auth: { secretId: 'provider.dynamic.api-key' },
    })

    expect(captured).toMatchObject({
      providerId: 'generic-openai-compatible',
      secretId: 'provider.dynamic.api-key',
      endpoint: 'https://api.example.com/v1/chat/completions',
      // 多协议 provider 的 wire 分发与上游会话归因都依赖这两个字段透传到 Rust。
      modelId: 'model-a',
      sessionId: 'session-1',
    })
    expect(captured?.body).not.toContain('provider.default.api-key')
    expect(transport.requestByteLength(request)).toBe(
      new TextEncoder().encode(captured?.body).byteLength,
    )
    expect(events).toEqual([
      { type: 'start', responseId: 'resp-1', responseModel: 'resolved-openai' },
      { type: 'thinking_start', contentIndex: 0, thinkingSignature: 'reason-sig' },
      { type: 'thinking_delta', contentIndex: 0, delta: 'reason ' },
      { type: 'text_delta', contentIndex: 1, delta: 'Hi ', textSignature: 'text-sig' },
      {
        type: 'tool_call_start',
        index: 0,
        contentIndex: 2,
        id: 'call-1',
        name: 'read_',
        thoughtSignature: 'thought-sig',
      },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"path":' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '', nameDelta: 'file' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '"/tmp/a"}' },
      { type: 'thinking_end', contentIndex: 0 },
      { type: 'tool_call_end', index: 0 },
      {
        type: 'done',
        stopReason: 'tool_use',
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
          cacheReadTokens: 2,
          reasoningTokens: 3,
        },
      },
    ])
  })

  it('surfaces a malformed tool-call index as an error event instead of dropping the call', async () => {
    const encoder = new TextEncoder()
    const stream: ModelHttpStreamFactory = () => (async function* () {
      // tool_calls[0].index 非数字：既有实现会静默丢弃整条工具调用，现改为显式报错
      const frame = {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: null, id: 'call-1', function: { name: 'read_file' } }] },
        }],
      }
      yield encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)
      yield encoder.encode('data: [DONE]\n\n')
    })()
    const transport = new OpenAICompatibleTransport({
      providerId: 'generic-openai-compatible',
      endpoint: 'https://api.example.com/v1/chat/completions',
    }, stream)

    const events = await collect(transport)
    const errorEvent = events.find((event) => event.type === 'error')
    expect(errorEvent?.type).toBe('error')
    if (errorEvent?.type === 'error') {
      expect(JSON.stringify(errorEvent)).toContain('tool_calls[0].index')
    }
  })

  it('treats null-valued optional delta fields as absent (custom-openai-compatible 中转站实测形态)', async () => {
    // 部分中转站/模型在没有内容的 chunk 里显式下发 "tool_calls": null / "content": null，
    // 而非省略字段——校验器不得把 null 当类型不符 fail-closed 中断整轮对话
    const encoder = new TextEncoder()
    const stream: ModelHttpStreamFactory = () => (async function* () {
      yield encoder.encode('data: {"id":"resp-null-delta","choices":[{"delta":{"role":"assistant","content":null,"tool_calls":null}}]}\n\n')
      yield encoder.encode('data: {"choices":[{"delta":{"content":"ok","tool_calls":null}}]}\n\n')
      yield encoder.encode('data: {"choices":[{"delta":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n')
    })()
    const transport = new OpenAICompatibleTransport({
      providerId: 'custom-openai-compatible',
      endpoint: 'https://relay.example.com/v1/chat/completions',
    }, stream)

    const events = await collect(transport)
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events).toEqual([
      { type: 'start', responseId: 'resp-null-delta' },
      { type: 'text_delta', contentIndex: 0, delta: 'ok' },
      {
        type: 'done',
        stopReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ])
  })

  it('propagates the real HTTP status into the classified provider error', async () => {
    const encoder = new TextEncoder()
    const stream: ModelHttpStreamFactory = (_rawRequest, _signal, onResponse) => {
      return (async function* () {
        await onResponse?.({ status: 429 })
        yield encoder.encode('data: {"error":{"message":"Rate limit exceeded","type":"rate_limit_error","code":"rate_limit_exceeded"}}\n\n')
        yield encoder.encode('data: [DONE]\n\n')
      })()
    }
    const transport = new OpenAICompatibleTransport({
      providerId: 'generic-openai-compatible',
      endpoint: 'https://api.example.com/v1/chat/completions',
      secretId: 'provider.default.api-key',
    }, stream)

    const events = await collect(transport)
    const errorEvent = events.find((event) => event.type === 'error')
    expect(errorEvent?.type).toBe('error')
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error?.status).toBe(429)
      expect(errorEvent.error?.kind).toBe('rate_limit')
    }
  })

  it('converts a thrown HTTP-level error into a structured error event with the real status', async () => {
    const stream: ModelHttpStreamFactory = (_rawRequest, _signal, onResponse) => {
      return (async function* () {
        await onResponse?.({ status: 429 })
        throw new Error('HTTP 429: Rate limit exceeded')
      })()
    }
    const transport = new OpenAICompatibleTransport({
      providerId: 'generic-openai-compatible',
      endpoint: 'https://api.example.com/v1/chat/completions',
    }, stream)

    const events = await collect(transport)
    const errorEvent = events.find((event) => event.type === 'error')
    expect(errorEvent?.type).toBe('error')
    expect(events.some((event) => event.type === 'done')).toBe(false)
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error?.status).toBe(429)
      expect(errorEvent.error?.kind).toBe('rate_limit')
      expect(errorEvent.error?.retryable).toBe(true)
    }
  })

  it('fails closed on an empty 200 response instead of emitting done', async () => {
    const encoder = new TextEncoder()
    const transport = new OpenAICompatibleTransport({
      providerId: 'generic-openai-compatible',
      endpoint: 'https://api.example.com/v1/chat/completions',
    }, () => (async function* () {
      yield encoder.encode('data: [DONE]\n\n')
    })())

    const events = await collect(transport)
    const errorEvent = events.find((event) => event.type === 'error')
    expect(errorEvent?.type).toBe('error')
    expect(events.some((event) => event.type === 'done')).toBe(false)
    if (errorEvent?.type === 'error') expect(errorEvent.message).toContain('空响应')
  })

  it('fails closed when the stream truncates before [DONE] and finish_reason', async () => {
    const encoder = new TextEncoder()
    const transport = new OpenAICompatibleTransport({
      providerId: 'generic-openai-compatible',
      endpoint: 'https://api.example.com/v1/chat/completions',
    }, () => (async function* () {
      yield encoder.encode('data: {"id":"resp-truncated","choices":[{"delta":{"content":"half only"}}]}\n\n')
      // 流在此处断开：没有 finish_reason，也没有 [DONE]
    })())

    const events = await collect(transport)
    const errorEvent = events.find((event) => event.type === 'error')
    expect(errorEvent?.type).toBe('error')
    expect(events.some((event) => event.type === 'done')).toBe(false)
    if (errorEvent?.type === 'error') {
      expect(errorEvent.message).toContain('结束标记')
      // 截断按 network 分类：可重试，自动重试接管（isSafeAutoRetryFailure 安全门槛内）。
      expect(errorEvent.error?.kind).toBe('network')
      expect(errorEvent.error?.retryable).toBe(true)
    }
  })

  it('accepts a stream that ends with finish_reason but no [DONE] marker', async () => {
    const encoder = new TextEncoder()
    const transport = new OpenAICompatibleTransport({
      providerId: 'generic-openai-compatible',
      endpoint: 'https://api.example.com/v1/chat/completions',
    }, () => (async function* () {
      yield encoder.encode('data: {"id":"resp-1","choices":[{"delta":{"content":"done"}}]}\n\n')
      yield encoder.encode('data: {"id":"resp-1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
      // 部分兼容端点不发送 [DONE]，只关闭流
    })())

    const events = await collect(transport)
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'stop' })
  })
})
