import type { ModelRequest, ModelStreamEvent } from '@/agent/core/types'
import type { ModelHttpRequest } from './modelHttpContract'
import { describe, expect, it } from 'vitest'
import {
  anthropicMessagesEndpoint,
  AnthropicCompatibleTransport,
  buildAnthropicCompatibleBody,
} from './AnthropicCompatibleTransport'
import type { ModelHttpStreamFactory } from './OpenAICompatibleTransport'

const request: ModelRequest = {
  sessionId: 'session-1',
  runId: 'run-1',
  systemPrompt: 'Be careful',
  model: { provider: 'anthropic-compatible', model: 'model-b' },
  messages: [
    { id: 'u1', role: 'user', content: 'inspect', createdAt: 1 },
    {
      id: 'a1',
      role: 'assistant',
      content: 'checking',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: '/tmp/a' }, rawArguments: '{"path":"/tmp/a"}' }],
      stopReason: 'tool_use',
      createdAt: 2,
    },
    { id: 't1', role: 'tool', toolCallId: 'call-1', toolName: 'read_file', content: 'one', isError: false, createdAt: 3 },
    { id: 't2', role: 'tool', toolCallId: 'call-2', toolName: 'other', content: 'failed', isError: true, createdAt: 4 },
  ],
  tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }],
}

const collect = async (
  transport: AnthropicCompatibleTransport,
  modelRequest: ModelRequest = request,
): Promise<ModelStreamEvent[]> => {
  const events: ModelStreamEvent[] = []
  for await (const event of transport.stream(modelRequest, new AbortController().signal)) events.push(event)
  return events
}

describe('AnthropicCompatibleTransport', () => {
  it('normalizes SDK-style base URLs to the Anthropic Messages endpoint', () => {
    expect(anthropicMessagesEndpoint('https://open.bigmodel.cn/api/anthropic'))
      .toBe('https://open.bigmodel.cn/api/anthropic/v1/messages')
    expect(anthropicMessagesEndpoint('https://api.example.com/v1'))
      .toBe('https://api.example.com/v1/messages')
    expect(anthropicMessagesEndpoint('https://api.example.com/v1/messages/'))
      .toBe('https://api.example.com/v1/messages')
  })

  it('serializes system, tool_use and adjacent tool_result blocks', () => {
    const body = buildAnthropicCompatibleBody(request, 2048)
    expect(body).toMatchObject({ model: 'model-b', system: 'Be careful', max_tokens: 2048 })
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'inspect' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: '/tmp/a' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: 'one', is_error: false },
          { type: 'tool_result', tool_use_id: 'call-2', content: 'failed', is_error: true },
        ],
      },
    ])
  })

  it('serializes image, cache, thinking replay and adaptive reasoning blocks', () => {
    const body = buildAnthropicCompatibleBody({
      ...request,
      reasoning: { level: 'high', mode: 'adaptive' },
      messages: [
        {
          id: 'rich-user',
          role: 'user',
          content: 'inspect image',
          contentBlocks: [
            { type: 'text', text: 'inspect image', cacheControl: { type: 'ephemeral', ttl: '1h' } },
            { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'cG5n' } },
          ],
          createdAt: 1,
        },
        {
          id: 'rich-assistant',
          role: 'assistant',
          content: 'done',
          contentBlocks: [
            { type: 'thinking', thinking: 'private', thinkingSignature: 'signed' },
            {
              type: 'tool_call',
              id: 'call-rich',
              name: 'read_file',
              arguments: { path: '/tmp/a' },
              rawArguments: '{"path":"/tmp/a"}',
            },
            { type: 'text', text: 'done' },
          ],
          toolCalls: [{
            id: 'call-rich',
            name: 'read_file',
            arguments: { path: '/tmp/a' },
            rawArguments: '{"path":"/tmp/a"}',
          }],
          stopReason: 'stop',
          createdAt: 2,
        },
      ],
    })

    expect(body).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    })
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'inspect image', cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cG5n' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private', signature: 'signed' },
          { type: 'tool_use', id: 'call-rich', name: 'read_file', input: { path: '/tmp/a' } },
          { type: 'text', text: 'done' },
        ],
      },
    ])
  })

  it('serializes native deferred tools at their transcript load point only when enabled', () => {
    const deferredRequest: ModelRequest = {
      ...request,
      messages: [
        { id: 'u-discover', role: 'user', content: 'find an editor', createdAt: 1 },
        {
          id: 'a-discover',
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: 'discover-call',
            name: 'discover_agent_tools',
            arguments: { query: 'edit' },
            rawArguments: '{"query":"edit"}',
          }],
          stopReason: 'tool_use',
          createdAt: 2,
        },
        {
          id: 't-discover',
          role: 'tool',
          toolCallId: 'discover-call',
          toolName: 'discover_agent_tools',
          content: 'Loaded edit_workspace_file',
          addedToolNames: ['edit_workspace_file'],
          isError: false,
          createdAt: 3,
        },
      ],
      tools: [
        { name: 'discover_agent_tools', description: 'Discover', inputSchema: { type: 'object' } },
        { name: 'edit_workspace_file', description: 'Edit', inputSchema: { type: 'object' } },
      ],
    }

    const nativeBody = buildAnthropicCompatibleBody(deferredRequest, 2048, true)
    expect(nativeBody.tools).toEqual([
      {
        name: 'discover_agent_tools',
        description: 'Discover',
        input_schema: { type: 'object' },
      },
      {
        name: 'edit_workspace_file',
        description: 'Edit',
        input_schema: { type: 'object' },
        defer_loading: true,
      },
    ])
    expect(nativeBody.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'find an editor' }] },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'discover-call',
          name: 'discover_agent_tools',
          input: { query: 'edit' },
        }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'discover-call',
            content: [{ type: 'tool_reference', tool_name: 'edit_workspace_file' }],
            is_error: false,
          },
          { type: 'text', text: 'Loaded edit_workspace_file' },
        ],
      },
    ])

    const fallbackBody = buildAnthropicCompatibleBody(deferredRequest, 2048, false)
    expect(fallbackBody.tools).toEqual(deferredRequest.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })))
    expect(JSON.stringify(fallbackBody)).not.toContain('tool_reference')
    expect(JSON.stringify(fallbackBody)).not.toContain('defer_loading')
  })

  it('keeps consecutive tool results ahead of displaced deferred-tool output', () => {
    const body = buildAnthropicCompatibleBody({
      ...request,
      messages: [
        { id: 'u-discover', role: 'user', content: 'find an editor', createdAt: 1 },
        {
          id: 'a-discover',
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'discover-1',
              name: 'discover_agent_tools',
              arguments: { query: 'edit' },
              rawArguments: '{"query":"edit"}',
            },
            {
              id: 'discover-2',
              name: 'discover_agent_tools',
              arguments: { query: 'edit' },
              rawArguments: '{"query":"edit"}',
            },
          ],
          stopReason: 'tool_use',
          createdAt: 2,
        },
        {
          id: 't-discover-1',
          role: 'tool',
          toolCallId: 'discover-1',
          toolName: 'discover_agent_tools',
          content: 'first result',
          addedToolNames: ['edit_workspace_file'],
          isError: false,
          createdAt: 3,
        },
        {
          id: 't-discover-2',
          role: 'tool',
          toolCallId: 'discover-2',
          toolName: 'discover_agent_tools',
          content: 'second result',
          addedToolNames: ['edit_workspace_file'],
          isError: false,
          createdAt: 4,
        },
      ],
      tools: [
        { name: 'discover_agent_tools', description: 'Discover', inputSchema: { type: 'object' } },
        { name: 'edit_workspace_file', description: 'Edit', inputSchema: { type: 'object' } },
      ],
    }, 2048, true)

    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'find an editor' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'discover-1', name: 'discover_agent_tools', input: { query: 'edit' } },
          { type: 'tool_use', id: 'discover-2', name: 'discover_agent_tools', input: { query: 'edit' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'discover-1',
            content: [{ type: 'tool_reference', tool_name: 'edit_workspace_file' }],
            is_error: false,
          },
          {
            type: 'tool_result',
            tool_use_id: 'discover-2',
            content: 'second result',
            is_error: false,
          },
          { type: 'text', text: 'first result' },
        ],
      },
    ])
  })

  it('keeps every tool immediate when the current tool set would otherwise be fully deferred', () => {
    const fullyDeferredRequest: ModelRequest = {
      ...request,
      messages: [
        { id: 'u-discover', role: 'user', content: 'load late tool', createdAt: 1 },
        {
          id: 'a-discover',
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: 'discover-call',
            name: 'discover_agent_tools',
            arguments: { query: 'late' },
            rawArguments: '{"query":"late"}',
          }],
          stopReason: 'tool_use',
          createdAt: 2,
        },
        {
          id: 't-discover',
          role: 'tool',
          toolCallId: 'discover-call',
          toolName: 'discover_agent_tools',
          content: 'loaded',
          addedToolNames: ['late_tool'],
          isError: false,
          createdAt: 3,
        },
      ],
      tools: [{ name: 'late_tool', description: 'Late', inputSchema: { type: 'object' } }],
    }

    const body = buildAnthropicCompatibleBody(fullyDeferredRequest, 2048, true)

    expect(body.tools).toEqual([{
      name: 'late_tool',
      description: 'Late',
      input_schema: { type: 'object' },
    }])
    expect(JSON.stringify(body)).not.toContain('tool_reference')
    expect(JSON.stringify(body)).not.toContain('defer_loading')
  })

  it('uses the native capability consistently when estimating request bytes', () => {
    const deferredRequest: ModelRequest = {
      ...request,
      messages: [
        { id: 'u-discover', role: 'user', content: 'find a reader', createdAt: 1 },
        {
          id: 'a-discover',
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: 'discover-call',
            name: 'discover_agent_tools',
            arguments: { query: 'read' },
            rawArguments: '{"query":"read"}',
          }],
          stopReason: 'tool_use',
          createdAt: 2,
        },
        {
          id: 't-discover',
          role: 'tool',
          toolCallId: 'discover-call',
          toolName: 'discover_agent_tools',
          content: 'loaded',
          addedToolNames: ['read_file'],
          isError: false,
          createdAt: 3,
        },
      ],
      tools: [
        { name: 'discover_agent_tools', description: 'Discover', inputSchema: { type: 'object' } },
        { name: 'read_file', description: 'Read', inputSchema: { type: 'object' } },
      ],
    }
    const transport = new AnthropicCompatibleTransport({
      providerId: 'generic-anthropic-compatible',
      endpoint: 'https://api.example.com/v1/messages',
      maxTokens: 2048,
      supportsToolReferences: true,
    })
    const expectedBody = buildAnthropicCompatibleBody(deferredRequest, 2048, true)

    expect(transport.requestByteLength(deferredRequest)).toBe(
      new TextEncoder().encode(JSON.stringify(expectedBody)).byteLength,
    )
    expect(JSON.stringify(expectedBody)).toContain('tool_reference')
  })

  it('parses text, input_json_delta, stop reason and usage', async () => {
    let captured: ModelHttpRequest | undefined
    const stream: ModelHttpStreamFactory = (rawRequest) => {
      captured = rawRequest
      return (async function* () {
        const encoder = new TextEncoder()
        const frames = [
          {
            type: 'message_start',
            message: {
              id: 'msg-1',
              model: 'resolved-anthropic',
              usage: {
                input_tokens: 9,
                cache_read_input_tokens: 3,
                cache_creation_input_tokens: 5,
                cache_creation: { ephemeral_1h_input_tokens: 2 },
              },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'Hi' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' there' } },
          { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} } },
          { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
          { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"/tmp/a"}' } },
          { type: 'content_block_stop', index: 2 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } },
          { type: 'message_stop' },
        ]
        yield encoder.encode(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''))
      })()
    }
    const transport = new AnthropicCompatibleTransport({
      providerId: 'generic-anthropic-compatible',
      endpoint: 'https://api.example.com/v1/messages',
      secretId: 'provider.anthropic.api-key',
    }, stream)

    const events = await collect(transport, {
      ...request,
      auth: { secretId: 'provider.dynamic.api-key' },
    })

    expect(captured).toMatchObject({
      providerId: 'generic-anthropic-compatible',
      secretId: 'provider.dynamic.api-key',
    })
    expect(captured?.body).not.toContain('provider.anthropic.api-key')
    expect(transport.requestByteLength(request)).toBe(
      new TextEncoder().encode(captured?.body).byteLength,
    )
    expect(events).toEqual([
      { type: 'start', responseId: 'msg-1', responseModel: 'resolved-anthropic' },
      { type: 'thinking_start', contentIndex: 0, thinkingSignature: '', redacted: false },
      { type: 'thinking_delta', contentIndex: 0, delta: 'reason' },
      { type: 'thinking_signature_delta', contentIndex: 0, delta: 'sig' },
      { type: 'thinking_end', contentIndex: 0 },
      { type: 'text_delta', contentIndex: 1, delta: 'Hi' },
      { type: 'text_delta', contentIndex: 1, delta: ' there' },
      { type: 'tool_call_start', index: 2, contentIndex: 2, id: 'tool-1', name: 'read_file' },
      { type: 'tool_call_delta', index: 2, argumentsDelta: '{"path":' },
      { type: 'tool_call_delta', index: 2, argumentsDelta: '"/tmp/a"}' },
      { type: 'tool_call_end', index: 2 },
      {
        type: 'done',
        stopReason: 'tool_use',
        usage: {
          inputTokens: 9,
          outputTokens: 6,
          totalTokens: 15,
          cacheReadTokens: 3,
          cacheWriteTokens: 5,
          cacheWrite1hTokens: 2,
        },
      },
    ])
  })

  it('surfaces a malformed required packet field as an error event instead of silently skipping', async () => {
    const encoder = new TextEncoder()
    const stream: ModelHttpStreamFactory = () => (async function* () {
      // content_block_start 缺 index：协议关键字段漂移，必须显式报错而非静默丢包
      const frame = { type: 'content_block_start', content_block: { type: 'text', text: 'Hi' } }
      yield encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(frame)}\n\n`)
    })()
    const transport = new AnthropicCompatibleTransport({
      providerId: 'generic-anthropic-compatible',
      endpoint: 'https://api.example.com/v1/messages',
    }, stream)

    const events = await collect(transport, request)
    const errorEvent = events.find((event) => event.type === 'error')
    expect(errorEvent?.type).toBe('error')
    if (errorEvent?.type === 'error') {
      expect(JSON.stringify(errorEvent)).toContain('index')
    }
  })

  it('rejects a successful HTTP response without Anthropic SSE events', async () => {
    const transport = new AnthropicCompatibleTransport({
      providerId: 'generic-anthropic-compatible',
      endpoint: 'https://open.bigmodel.cn/api/anthropic',
    }, () => (async function* () {
      yield new TextEncoder().encode('{"ok":true}')
    })())

    await expect(collect(transport)).rejects.toThrow('空响应或非 SSE 响应')
  })

  it('rejects a stream that closes after keepalive pings only', async () => {
    const transport = new AnthropicCompatibleTransport({
      providerId: 'generic-anthropic-compatible',
      endpoint: 'https://api.example.com/v1/messages',
    }, () => (async function* () {
      yield new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n')
    })())

    await expect(collect(transport)).rejects.toThrow('空响应或非 SSE 响应')
  })

  it('fails closed when the stream truncates before message_stop instead of emitting done', async () => {
    const encoder = new TextEncoder()
    const stream: ModelHttpStreamFactory = () => (async function* () {
      const frames = [
        {
          type: 'message_start',
          message: { id: 'msg-truncated', model: 'm', usage: { input_tokens: 1 } },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'half' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' only' } },
        // 流在此处断开：没有 message_stop
      ]
      yield encoder.encode(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''))
    })()
    const transport = new AnthropicCompatibleTransport({
      providerId: 'generic-anthropic-compatible',
      endpoint: 'https://api.example.com/v1/messages',
    }, stream)

    const events = await collect(transport)
    const errorEvent = events.find((event) => event.type === 'error')
    expect(errorEvent?.type).toBe('error')
    expect(events.some((event) => event.type === 'done')).toBe(false)
    if (errorEvent?.type === 'error') {
      expect(errorEvent.message).toContain('message_stop')
      expect(errorEvent.error?.retryable).toBe(false)
    }
  })

  it('flushes a complete stream as done when message_stop is present', async () => {
    const encoder = new TextEncoder()
    const stream: ModelHttpStreamFactory = () => (async function* () {
      const frames = [
        { type: 'message_start', message: { id: 'msg-ok', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'full' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]
      yield encoder.encode(frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''))
    })()
    const transport = new AnthropicCompatibleTransport({
      providerId: 'generic-anthropic-compatible',
      endpoint: 'https://api.example.com/v1/messages',
    }, stream)

    const events = await collect(transport)
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'stop' })
  })
})
