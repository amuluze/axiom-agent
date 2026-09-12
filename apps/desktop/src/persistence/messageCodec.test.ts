import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@/agent/core/types'
import { decodeAgentMessage, encodeAgentMessage } from './messageCodec'

describe('messageCodec', () => {
  it('normalizes legacy assistant projections into ordered rich content', () => {
    const decoded = decodeAgentMessage(JSON.stringify({
      id: 'legacy-assistant',
      role: 'assistant',
      content: 'answer',
      contentBlocks: [
        { type: 'thinking', thinking: 'reason', signature: 'legacy-signature' },
        { type: 'text', text: 'answer' },
      ],
      toolCalls: [{
        id: 'call-legacy',
        name: 'read_file',
        arguments: { path: '/tmp/a' },
        rawArguments: '{"path":"/tmp/a"}',
      }],
      stopReason: 'tool_use',
      createdAt: 1,
    }))

    expect(decoded).toMatchObject({
      role: 'assistant',
      contentBlocks: [
        {
          type: 'thinking',
          thinking: 'reason',
          thinkingSignature: 'legacy-signature',
        },
        { type: 'text', text: 'answer' },
        { type: 'tool_call', id: 'call-legacy', name: 'read_file' },
      ],
      toolCalls: [{ id: 'call-legacy', name: 'read_file' }],
    })
  })

  it('round-trips rich assistant metadata without losing ordered blocks', () => {
    const message = {
      id: 'rich-assistant',
      role: 'assistant' as const,
      content: 'answer',
      contentBlocks: [
        { type: 'text' as const, text: 'answer', textSignature: 'text-signature' },
        {
          type: 'tool_call' as const,
          id: 'call-1',
          name: 'read_file',
          arguments: { path: '/tmp/a' },
          rawArguments: '{"path":"/tmp/a"}',
          thoughtSignature: 'thought-signature',
        },
      ],
      toolCalls: [{
        id: 'call-1',
        name: 'read_file',
        arguments: { path: '/tmp/a' },
        rawArguments: '{"path":"/tmp/a"}',
        thoughtSignature: 'thought-signature',
      }],
      responseModel: 'resolved-model',
      diagnostics: [{ type: 'provider', timestamp: 2, details: { recovered: true } }],
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        cacheWrite1hTokens: 1,
      },
      stopReason: 'tool_use' as const,
      createdAt: 1,
    }

    expect(decodeAgentMessage(encodeAgentMessage(message))).toEqual(message)
  })

  it('round-trips deferred tool declarations on tool results', () => {
    const message = {
      id: 'tool-result',
      role: 'tool' as const,
      toolCallId: 'call-1',
      toolName: 'discover',
      content: 'loaded',
      addedToolNames: ['read_file', 'search_files'],
      isError: false,
      createdAt: 1,
    }

    expect(decodeAgentMessage(encodeAgentMessage(message))).toEqual(message)
  })

  it('rejects duplicate or failed deferred tool declarations from SQLite', () => {
    const base = {
      id: 'tool-result',
      role: 'tool',
      toolCallId: 'call-1',
      toolName: 'discover',
      content: 'loaded',
      isError: false,
      createdAt: 1,
    }
    expect(() => decodeAgentMessage(JSON.stringify({
      ...base,
      addedToolNames: ['read_file', 'read_file'],
    }))).toThrow('格式无效')
    expect(() => decodeAgentMessage(JSON.stringify({
      ...base,
      isError: true,
      addedToolNames: ['read_file'],
    }))).toThrow('格式无效')
  })

  it('round-trips an encoded message with an explicit codec version marker', async () => {
    const message: AgentMessage = {
      id: 'm-codec-1',
      role: 'assistant',
      content: 'versioned',
      toolCalls: [],
      stopReason: 'stop',
      provider: 'test',
      model: 'm',
      createdAt: 1,
    }
    const encoded = encodeAgentMessage(message)
    expect(JSON.parse(encoded)).toMatchObject({ codecVersion: 1 })
    // 解码结果剥离 codecVersion 标记，且保留消息核心字段
    const decoded = decodeAgentMessage(encoded)
    expect('codecVersion' in decoded).toBe(false)
    expect(decoded).toMatchObject({
      id: 'm-codec-1',
      role: 'assistant',
      content: 'versioned',
      toolCalls: [],
      stopReason: 'stop',
    })
  })

  it('decodes legacy messages without a codec version marker', () => {
    const legacy: AgentMessage = {
      id: 'm-legacy-1',
      role: 'assistant',
      content: 'legacy',
      toolCalls: [],
      stopReason: 'stop',
      provider: 'test',
      model: 'm',
      createdAt: 1,
    }
    expect(decodeAgentMessage(JSON.stringify(legacy))).toMatchObject({
      id: 'm-legacy-1',
      role: 'assistant',
      content: 'legacy',
      stopReason: 'stop',
    })
  })

  it('rejects an unknown future codec version with an observable error', () => {
    const message: AgentMessage = {
      id: 'm-future-1',
      role: 'assistant',
      content: 'future',
      toolCalls: [],
      stopReason: 'stop',
      provider: 'test',
      model: 'm',
      createdAt: 1,
    }
    expect(() => decodeAgentMessage(JSON.stringify({
      codecVersion: 99,
      ...message,
    }))).toThrow('不支持的 Agent 消息 codec 版本')
  })
})
