import type {
  JsonValue,
  ModelRequest,
  ModelStreamEvent,
  ModelTransportLifecycle,
} from '@/agent/core/types'
import type { ModelHttpRequest } from './modelHttpContract'
import { describe, expect, it } from 'vitest'
import type { ModelHttpStreamFactory } from './OpenAICompatibleTransport'
import {
  buildOpenAIResponsesBody,
  OpenAIResponsesTransport,
} from './OpenAIResponsesTransport'

const request: ModelRequest = {
  sessionId: 'session-1',
  runId: 'run-1',
  systemPrompt: 'Be careful',
  model: { provider: 'openai-responses', model: 'gpt-test' },
  messages: [
    { id: 'u1', role: 'user', content: 'inspect', createdAt: 1 },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [{
        id: 'discover-call|fc_discover',
        name: 'discover',
        arguments: { query: 'edit' },
        rawArguments: '{"query":"edit"}',
      }],
      stopReason: 'tool_use',
      createdAt: 2,
    },
    {
      id: 't1',
      role: 'tool',
      toolCallId: 'discover-call|fc_discover',
      toolName: 'discover',
      content: 'loaded edit',
      addedToolNames: ['edit'],
      isError: false,
      createdAt: 3,
    },
  ],
  tools: [
    { name: 'discover', description: 'Discover', inputSchema: { type: 'object' } },
    { name: 'edit', description: 'Edit', inputSchema: { type: 'object' } },
  ],
  reasoning: { level: 'high', mode: 'effort' },
}

const collect = async (
  transport: OpenAIResponsesTransport,
  lifecycle?: ModelTransportLifecycle,
): Promise<ModelStreamEvent[]> => {
  const events: ModelStreamEvent[] = []
  for await (const event of transport.stream(request, new AbortController().signal, lifecycle)) events.push(event)
  return events
}

describe('OpenAIResponsesTransport', () => {
  it('serializes stateless Responses input and optional client-side deferred tools', () => {
    const body = buildOpenAIResponsesBody(request, 2048, true)
    expect(body).toMatchObject({
      model: 'gpt-test',
      stream: true,
      store: false,
      instructions: 'Be careful',
      max_output_tokens: 2048,
      reasoning: { effort: 'high', summary: 'auto' },
    })
    expect(body.tools).toEqual([expect.objectContaining({ name: 'discover' })])
    expect(body.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', call_id: 'discover-call' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'discover-call' }),
      expect.objectContaining({ type: 'tool_search_call', execution: 'client' }),
      expect.objectContaining({
        type: 'tool_search_output',
        tools: [expect.objectContaining({ name: 'edit', defer_loading: true })],
      }),
    ]))
  })

  it('parses text, reasoning, function calls, usage and controlled lifecycle hooks', async () => {
    let captured: ModelHttpRequest | undefined
    const stream: ModelHttpStreamFactory = (rawRequest, _signal, onResponse) => {
      captured = rawRequest
      return (async function* () {
        await onResponse?.({ status: 200 })
        const encoder = new TextEncoder()
        const frames = [
          { type: 'response.created', response: { id: 'resp-1', model: 'gpt-resolved' } },
          { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs-1' } },
          { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'reason' },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: { type: 'reasoning', id: 'rs-1', summary: [{ type: 'summary_text', text: 'reason' }], encrypted_content: 'opaque' },
          },
          { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg-1' } },
          { type: 'response.output_text.delta', output_index: 1, delta: 'hello' },
          {
            type: 'response.output_item.done',
            output_index: 1,
            item: { type: 'message', id: 'msg-1', content: [{ type: 'output_text', text: 'hello' }] },
          },
          {
            type: 'response.output_item.added',
            output_index: 2,
            item: { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'edit', arguments: '' },
          },
          { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{}' },
          {
            type: 'response.output_item.done',
            output_index: 2,
            item: { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'edit', arguments: '{}' },
          },
          {
            type: 'response.completed',
            response: {
              id: 'resp-1',
              status: 'completed',
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                input_tokens_details: { cached_tokens: 2 },
                output_tokens_details: { reasoning_tokens: 3 },
              },
            },
          },
        ]
        for (const frame of frames) yield encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)
      })()
    }
    const statuses: number[] = []
    const lifecycle: ModelTransportLifecycle = {
      beforeRequest: () => ({ timeoutMs: 2_000 }),
      beforePayload: ({ payload }) => ({
        payload: { ...(payload as Record<string, JsonValue>), metadata: { source: 'test-hook' } },
      }),
      afterResponse: ({ status }) => { statuses.push(status) },
    }
    const transport = new OpenAIResponsesTransport({
      providerId: 'openai',
      endpoint: 'https://api.openai.com/v1/responses',
      secretId: 'provider.openai-responses.api-key',
      maxTokens: 2048,
    }, stream)

    const events = await collect(transport, lifecycle)

    expect(captured).toMatchObject({
      providerId: 'openai',
      timeoutMs: 2_000,
      secretId: 'provider.openai-responses.api-key',
      // 多协议 wire 分发与上游会话归因依赖这两个字段透传到 Rust。
      modelId: 'gpt-test',
      sessionId: 'session-1',
    })
    expect(JSON.parse(captured!.body)).toMatchObject({ metadata: { source: 'test-hook' } })
    expect(statuses).toEqual([200])
    expect(events).toEqual([
      { type: 'start', responseId: 'resp-1', responseModel: 'gpt-resolved' },
      { type: 'thinking_start', contentIndex: 0 },
      { type: 'thinking_delta', contentIndex: 0, delta: 'reason' },
      {
        type: 'thinking_signature_delta',
        contentIndex: 0,
        delta: JSON.stringify({
          type: 'reasoning',
          id: 'rs-1',
          summary: [{ type: 'summary_text', text: 'reason' }],
          encrypted_content: 'opaque',
        }),
      },
      { type: 'thinking_end', contentIndex: 0 },
      { type: 'text_delta', contentIndex: 1, delta: 'hello' },
      { type: 'tool_call_start', index: 0, contentIndex: 2, id: 'call-1|fc-1', name: 'edit' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' },
      { type: 'tool_call_end', index: 0 },
      {
        type: 'done',
        stopReason: 'tool_use',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cacheReadTokens: 2,
          reasoningTokens: 3,
        },
      },
    ])
  })

  it('surfaces a malformed required packet field as an error event instead of silently degrading', async () => {
    const encoder = new TextEncoder()
    const stream: ModelHttpStreamFactory = () => (async function* () {
      // response.output_item.added 缺 output_index：既有实现会默认成 0 折叠 slot，现改为显式报错
      const frame = { type: 'response.output_item.added', item: { type: 'message', id: 'msg-1' } }
      yield encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)
    })()
    const transport = new OpenAIResponsesTransport({
      providerId: 'openai-responses',
      endpoint: 'https://api.openai.com/v1/responses',
    }, stream)

    const events = await collect(transport)
    const errorEvent = events.find((event) => event.type === 'error')
    expect(errorEvent?.type).toBe('error')
    if (errorEvent?.type === 'error') {
      expect(JSON.stringify(errorEvent)).toContain('output_index')
    }
  })

  it('fails closed when the stream has no terminal Responses event', async () => {
    const stream: ModelHttpStreamFactory = () => (async function* () {
      yield new TextEncoder().encode('data: {"type":"response.created","response":{"id":"resp"}}\n\n')
    })()
    const events = await collect(new OpenAIResponsesTransport({ providerId: 'openai', endpoint: 'https://example.com' }, stream))
    const errorEvent = events.find((event) => event.type === 'error')
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    // 截断按 network 分类：可重试，自动重试接管（isSafeAutoRetryFailure 安全门槛内）。
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error?.kind).toBe('network')
      expect(errorEvent.error?.retryable).toBe(true)
    }
  })

  it('recovers complete text and tool arguments from output-item done events', async () => {
    const stream: ModelHttpStreamFactory = () => (async function* () {
      const encoder = new TextEncoder()
      const frames = [
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: 'msg-1',
            content: [{ type: 'output_text', text: 'complete text' }],
          },
        },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: {
            type: 'function_call',
            id: 'fc-1',
            call_id: 'call-1',
            name: 'edit',
            arguments: '{"path":"README.md"}',
          },
        },
        { type: 'response.completed', response: { status: 'completed' } },
      ]
      for (const frame of frames) yield encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)
    })()

    const events = await collect(new OpenAIResponsesTransport({ providerId: 'openai', endpoint: 'https://example.com' }, stream))

    expect(events).toEqual([
      { type: 'start' },
      { type: 'text_delta', contentIndex: 0, delta: 'complete text' },
      { type: 'tool_call_start', index: 0, contentIndex: 1, id: 'call-1|fc-1', name: 'edit' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"path":"README.md"}' },
      { type: 'tool_call_end', index: 0 },
      { type: 'done', stopReason: 'tool_use', usage: undefined },
    ])
  })

  it('does not fail the whole turn when reasoning CoT and summary share the same item', async () => {
    // 旧实现在 reasoning_text(CoT) 与 reasoning_summary_text 混入同一 slot 后,
    // done 校验把 summary 与 CoT+summary 前缀比对 → throw → 整轮失败。
    // CoT 被忽略、thinking 只以 summary 为准,不得抛错。
    const stream: ModelHttpStreamFactory = (_rawRequest, _signal, onResponse) => {
      return (async function* () {
        await onResponse?.({ status: 200 })
        const encoder = new TextEncoder()
        const frames = [
          { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs-1' } },
          { type: 'response.reasoning_text.delta', output_index: 0, delta: 'full chain of thought...' },
          { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'short summary' },
          {
            type: 'response.reasoning_summary_text.done',
            output_index: 0,
            text: 'short summary',
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: { type: 'reasoning', id: 'rs-1', summary: [{ type: 'summary_text', text: 'short summary' }] },
          },
          { type: 'response.completed', response: { id: 'resp-1', status: 'completed' } },
        ]
        for (const frame of frames) yield encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)
      })()
    }

    const events = await collect(new OpenAIResponsesTransport({ providerId: 'openai', endpoint: 'https://example.com' }, stream))

    const thinkingDeltas = events
      .filter((event): event is Extract<ModelStreamEvent, { type: 'thinking_delta' }> => event.type === 'thinking_delta')
      .map((event) => event.delta)
    expect(thinkingDeltas).toEqual(['short summary'])
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.some((event) => event.type === 'done')).toBe(true)
  })
})
