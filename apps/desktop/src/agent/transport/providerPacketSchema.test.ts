import { describe, expect, it } from 'vitest'
import {
  ANTHROPIC_PACKET_SCHEMAS,
  OPENAI_COMPATIBLE_PACKET_SCHEMA,
  OPENAI_RESPONSES_PACKET_SCHEMAS,
  ProviderPacketError,
  arr,
  bool,
  num,
  obj,
  str,
  validateProviderPacket,
} from './providerPacketSchema'

const expectError = (fn: () => void): ProviderPacketError => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderPacketError)
    return error as ProviderPacketError
  }
  throw new Error('expected ProviderPacketError but none was thrown')
}

describe('validateProviderPacket', () => {
  it('passes a conforming flat packet', () => {
    expect(() => validateProviderPacket('p', 'message_start', {
      type: 'message_start',
      message: { id: 'm-1', usage: {} },
    }, ANTHROPIC_PACKET_SCHEMAS.message_start!)).not.toThrow()
  })

  it('throws on a missing required top-level field', () => {
    const error = expectError(() => validateProviderPacket(
      'p',
      'content_block_start',
      { type: 'content_block_start', content_block: { type: 'text', text: 'Hi' } },
      ANTHROPIC_PACKET_SCHEMAS.content_block_start!,
    ))
    expect(error.fieldPath).toBe('index')
    expect(error.expected).toBe('number')
    expect(error.message).toContain('content_block_start')
    expect(error.message).toContain('index')
  })

  it('throws on a required field with the wrong type', () => {
    const error = expectError(() => validateProviderPacket(
      'p',
      'content_block_delta',
      { type: 'content_block_delta', index: '0', delta: { type: 'text_delta', text: 'x' } },
      ANTHROPIC_PACKET_SCHEMAS.content_block_delta!,
    ))
    expect(error.fieldPath).toBe('index')
    expect(error.message).toContain('实际 "0"')
  })

  it('tolerates unknown event types and unknown fields', () => {
    expect(() => validateProviderPacket('p', 'some_future_event', {
      type: 'some_future_event',
      anything: [1, 2, 3],
    }, {})).not.toThrow()
  })

  it('validates optional fields only when present', () => {
    // error 字段缺失放行
    expect(() => validateProviderPacket('p', 'error', { type: 'error' }, ANTHROPIC_PACKET_SCHEMAS.error!))
      .not.toThrow()
    // error 字段存在但类型不符 → 抛
    const error = expectError(() => validateProviderPacket(
      'p',
      'error',
      { type: 'error', error: 'boom' },
      ANTHROPIC_PACKET_SCHEMAS.error!,
    ))
    expect(error.fieldPath).toBe('error')
  })

  it('treats null as absent for optional fields but rejects it for required fields', () => {
    // 兼容协议普遍以 null 表达可选字段缺席（如 delta.tool_calls: null）→ 视同缺失放行
    expect(() => validateProviderPacket('p', 'chat.completion.chunk', {
      choices: null,
    }, OPENAI_COMPATIBLE_PACKET_SCHEMA)).not.toThrow()
    // required 字段为 null 仍 fail-closed
    const error = expectError(() => validateProviderPacket(
      'p',
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: null },
      ANTHROPIC_PACKET_SCHEMAS.content_block_delta!,
    ))
    expect(error.fieldPath).toBe('delta')
    expect(error.message).toContain('实际 null')
  })

  it('rejects a non-object root', () => {
    const error = expectError(() => validateProviderPacket('p', 'x', 'nope', {}))
    expect(error.fieldPath).toBe('<root>')
  })

  it('recursively validates nested object fields', () => {
    const schema = { outer: obj({ inner: num(true) }, true) }
    const error = expectError(() => validateProviderPacket(
      'p',
      'x',
      { outer: { inner: 'oops' } },
      schema,
    ))
    expect(error.fieldPath).toBe('outer.inner')
  })

  it('validates array elements with a per-item path', () => {
    const schema = { list: arr(obj({ index: num(true) }), true) }
    const error = expectError(() => validateProviderPacket(
      'p',
      'x',
      { list: [{ index: 0 }, { index: null }] },
      schema,
    ))
    expect(error.fieldPath).toBe('list[1].index')
  })

  it('enforces declared primitive specs', () => {
    expect(() => validateProviderPacket('p', 'x', { a: true }, { a: bool(true) })).not.toThrow()
    expect(() => validateProviderPacket('p', 'x', { a: 'yes' }, { a: str(true) })).not.toThrow()
    expect(() => validateProviderPacket('p', 'x', { a: 1 }, { a: num(true) })).not.toThrow()
    expect(() => validateProviderPacket('p', 'x', { a: [1] }, { a: arr() })).not.toThrow()
  })
})

describe('ANTHROPIC_PACKET_SCHEMAS', () => {
  it('declares the core parse-critical fields', () => {
    expect(ANTHROPIC_PACKET_SCHEMAS.message_start).toEqual({ message: obj({}, true) })
    expect(ANTHROPIC_PACKET_SCHEMAS.content_block_start).toEqual({
      index: num(true),
      content_block: obj({}, true),
    })
    expect(ANTHROPIC_PACKET_SCHEMAS.content_block_delta).toEqual({
      index: num(true),
      delta: obj({}, true),
    })
    expect(ANTHROPIC_PACKET_SCHEMAS.message_delta).toEqual({ delta: obj({}, true) })
    // 未知事件类型（如 ping）不应有 schema 条目 → 宽容放行
    expect(ANTHROPIC_PACKET_SCHEMAS.ping).toBeUndefined()
  })
})

describe('OPENAI_RESPONSES_PACKET_SCHEMAS', () => {
  it('requires output_index for output-index-keyed events', () => {
    for (const type of [
      'response.output_item.added',
      'response.output_text.delta',
      'response.refusal.delta',
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_part.done',
      'response.output_text.done',
      'response.refusal.done',
      'response.reasoning_summary_text.done',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
    ]) {
      const schema = OPENAI_RESPONSES_PACKET_SCHEMAS[type]
      expect(schema).toBeDefined()
      expect(schema!.output_index).toEqual(num(true))
    }
  })

  it('requires item on output_item events and arguments on args.done', () => {
    expect(OPENAI_RESPONSES_PACKET_SCHEMAS['response.output_item.added']!.item).toEqual(obj({}, true))
    expect(OPENAI_RESPONSES_PACKET_SCHEMAS['response.output_item.done']!.item).toEqual(obj({}, true))
    expect(OPENAI_RESPONSES_PACKET_SCHEMAS['response.function_call_arguments.done']!.arguments)
      .toEqual(str(true))
  })

  it('accepts a conforming representative Responses stream', () => {
    const conforming = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs-1' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg-1' } },
      { type: 'response.output_text.delta', output_index: 1, delta: 'hello' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg-1', content: [] } },
      { type: 'response.completed', response: { id: 'r-1', status: 'completed' } },
    ]
    for (const packet of conforming) {
      const schema = OPENAI_RESPONSES_PACKET_SCHEMAS[packet.type]
      if (schema) expect(() => validateProviderPacket('openai', packet.type, packet, schema)).not.toThrow()
    }
  })
})

describe('OPENAI_COMPATIBLE_PACKET_SCHEMA', () => {
  it('rejects a tool call chunk whose index is not a number', () => {
    const packet = {
      choices: [{
        delta: {
          tool_calls: [{ index: null, id: 'call-1', function: { name: 'read_file' } }],
        },
      }],
    }
    const error = expectError(() => validateProviderPacket(
      'openai-compatible',
      'chat.completion.chunk',
      packet,
      OPENAI_COMPATIBLE_PACKET_SCHEMA,
    ))
    expect(error.fieldPath).toBe('choices[0].delta.tool_calls[0].index')
    expect(error.expected).toBe('number')
  })

  it('tolerates missing choices / delta and absent tool_calls', () => {
    expect(() => validateProviderPacket('p', 'chat.completion.chunk', { usage: { total_tokens: 1 } }, OPENAI_COMPATIBLE_PACKET_SCHEMA)).not.toThrow()
    expect(() => validateProviderPacket('p', 'chat.completion.chunk', { choices: [{ delta: { content: 'hi' } }] }, OPENAI_COMPATIBLE_PACKET_SCHEMA)).not.toThrow()
    expect(() => validateProviderPacket('p', 'chat.completion.chunk', { choices: [{ delta: {} }] }, OPENAI_COMPATIBLE_PACKET_SCHEMA)).not.toThrow()
  })

  it('tolerates null-valued optional fields in delta (custom-openai-compatible 中转站实测形态)', () => {
    // 部分中转站/模型在没有工具调用的 chunk 里显式下发 "tool_calls": null、
    // "content": null，而非省略字段
    expect(() => validateProviderPacket('p', 'chat.completion.chunk', {
      choices: [{ delta: { content: null, tool_calls: null } }],
    }, OPENAI_COMPATIBLE_PACKET_SCHEMA)).not.toThrow()
    expect(() => validateProviderPacket('p', 'chat.completion.chunk', {
      choices: [{ delta: null, finish_reason: 'stop' }],
    }, OPENAI_COMPATIBLE_PACKET_SCHEMA)).not.toThrow()
  })
})
