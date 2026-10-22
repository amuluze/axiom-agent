import { describe, expect, it } from 'vitest'
import {
  ANTHROPIC_PACKET_SCHEMAS,
  OPENAI_COMPATIBLE_PACKET_SCHEMA,
  OPENAI_RESPONSES_PACKET_SCHEMAS,
  ProviderPacketError,
  arr,
  num,
  obj,
  str,
  validateProviderPacket,
  type FieldSpec,
  type PacketSchema,
} from './providerPacketSchema'
import { parseServerSentEvents, type ServerSentEvent } from './sse'

/** 固定 LCG：同一台机器/CI 上可复现，不引入 fast-check 依赖。 */
const next = (state: { value: number }): number => {
  state.value = (state.value * 1664525 + 1013904223) >>> 0
  return state.value
}

const randomValue = (state: { value: number }, depth = 0): unknown => {
  const kind = next(state) % 9
  if (depth > 3) return next(state) % 2 === 0 ? 'leaf' : next(state) % 2 === 0 ? 1 : null
  switch (kind) {
    case 0: return null
    case 1: return next(state) % 2 === 0
    case 2: return next(state) % 1_000
    case 3: return `s${next(state) % 97}`
    case 4: return { nested: randomValue(state, depth + 1) }
    case 5: return [randomValue(state, depth + 1)]
    case 6: return undefined
    case 7: return []
    default: return {}
  }
}

const valueFor = (state: { value: number }, spec: FieldSpec, depth = 0): unknown => {
  if (spec.required === false && next(state) % 3 === 0) return undefined
  switch (spec.kind) {
    case 'string': return `s${next(state) % 997}`
    case 'number': return next(state) % 1_000
    case 'boolean': return next(state) % 2 === 0
    case 'any': return randomValue(state, depth)
    case 'array': return spec.items ? [valueFor(state, spec.items, depth + 1)] : []
    case 'object': {
      const value: Record<string, unknown> = {}
      for (const [name, child] of Object.entries(spec.fields ?? {})) {
        const field = valueFor(state, child, depth + 1)
        if (field !== undefined) value[name] = field
      }
      return value
    }
  }
}

const packetFor = (state: { value: number }, schema: PacketSchema): Record<string, unknown> => {
  const packet: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(schema)) {
    const value = valueFor(state, spec)
    if (value !== undefined) packet[name] = value
  }
  return packet
}

const allSchemas = [
  ...Object.entries(ANTHROPIC_PACKET_SCHEMAS),
  ...Object.entries(OPENAI_RESPONSES_PACKET_SCHEMAS),
  ['chat.completion.chunk', OPENAI_COMPATIBLE_PACKET_SCHEMA] as const,
]

describe('provider packet schema fuzz', () => {
  it('never leaks a non-ProviderPacketError for arbitrary packets', () => {
    const random = { value: 0x51ee_d00d }
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const packet = randomValue(random)
      const [packetType, schema] = allSchemas[next(random) % allSchemas.length]!
      try {
        validateProviderPacket('fuzz', packetType, packet, schema)
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderPacketError)
        const packetError = error as ProviderPacketError
        expect(packetError.fieldPath.length).toBeGreaterThan(0)
        expect(packetError.expected.length).toBeGreaterThan(0)
      }
    }
  })

  it('accepts generated packets that satisfy the schema', () => {
    const random = { value: 0x0bad_f00d }
    for (let iteration = 0; iteration < 400; iteration += 1) {
      const [packetType, schema] = allSchemas[next(random) % allSchemas.length]!
      expect(() => validateProviderPacket(
        'fuzz',
        packetType,
        packetFor(random, schema),
        schema,
      )).not.toThrow()
    }
  })

  it('rejects a wrong primitive type at the declared path', () => {
    const schema = { value: num(true), label: obj({ text: str(true) }, true), tags: arr(str(), false) }
    const cases: unknown[] = [
      { value: 'not-a-number', label: { text: 'x' } },
      { value: 1, label: { text: 2 } },
      { value: 1, label: { text: 'x' }, tags: ['ok', false] },
    ]
    for (const packet of cases) {
      expect(() => validateProviderPacket('fuzz', 'packet', packet, schema))
        .toThrow(ProviderPacketError)
    }
    expect(() => validateProviderPacket('fuzz', 'packet', {
      value: 1,
      label: { text: 'x' },
      tags: ['a', 'b'],
    }, schema)).not.toThrow()
  })

  it('parses SSE frames split at arbitrary byte boundaries', async () => {
    const random = { value: 0xfeed_beef }
    const source = 'event: message_delta\r\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\r\n\r\n'
      + ': keepalive\n\n'
      + 'data: [DONE]\n\n'
    for (let iteration = 0; iteration < 120; iteration += 1) {
      const encoded = new TextEncoder().encode(source)
      const chunks: Uint8Array[] = []
      let offset = 0
      while (offset < encoded.length) {
        const size = 1 + (next(random) % 11)
        chunks.push(encoded.slice(offset, offset + size))
        offset += size
      }
      const events: ServerSentEvent[] = []
      for await (const event of parseServerSentEvents((async function* () {
        for (const chunk of chunks) yield chunk
      })())) {
        events.push(event)
      }
      expect(events).toEqual([
        {
          event: 'message_delta',
          data: '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        },
        { event: undefined, data: '[DONE]' },
      ])
    }
  })

  it('never throws on random SSE-like byte soup', async () => {
    const random = { value: 0x1234_5678 }
    const alphabet = 'data:event:\r\n{}[],"\\/0123456789abcdefghijklmnopqrstuvwxyz \t'
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const length = next(random) % 240
      let source = ''
      for (let index = 0; index < length; index += 1) source += alphabet[next(random) % alphabet.length]
      const encoded = new TextEncoder().encode(source)
      const drain = async (): Promise<void> => {
        for await (const event of parseServerSentEvents((async function* () {
          yield encoded
        })())) {
          expect(typeof event.data).toBe('string')
        }
      }
      await expect(drain()).resolves.toBeUndefined()
    }
  })
})
