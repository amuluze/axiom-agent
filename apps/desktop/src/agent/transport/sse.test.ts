import { describe, expect, it } from 'vitest'
import { parseServerSentEvents } from './sse'

const chunks = async function* (...values: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder()
  for (const value of values) yield encoder.encode(value)
}

describe('parseServerSentEvents', () => {
  it('handles arbitrary chunk boundaries, CRLF, comments and multi-line data', async () => {
    const events = []
    for await (const event of parseServerSentEvents(chunks(
      ': keepalive\r\nevent: message\r\ndata: {"a":',
      '1}\r\ndata: second\r\n\r',
      '\ndata: [DONE]\n\n',
    ))) {
      events.push(event)
    }

    expect(events).toEqual([
      { event: 'message', data: '{"a":1}\nsecond' },
      { event: undefined, data: '[DONE]' },
    ])
  })

  it('flushes a final event without a trailing blank line', async () => {
    const events = []
    for await (const event of parseServerSentEvents(chunks('data: final'))) events.push(event)
    expect(events).toEqual([{ event: undefined, data: 'final' }])
  })

  it('treats a lone CR as a line terminator inside a frame (SSE spec)', async () => {
    const events = []
    // 行末用 \r 而非 \n；帧以 \r\r（空行）结束
    for await (const event of parseServerSentEvents(chunks(
      'data: first\rdata: second\r\r',
    ))) {
      events.push(event)
    }
    expect(events).toEqual([{ event: undefined, data: 'first\nsecond' }])
  })

  it('yields an empty data frame', async () => {
    const events = []
    for await (const event of parseServerSentEvents(chunks('data:\n\n'))) events.push(event)
    expect(events).toEqual([{ event: undefined, data: '' }])
  })
})
