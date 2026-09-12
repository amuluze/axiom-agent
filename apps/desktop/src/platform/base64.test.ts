import { describe, expect, it } from 'vitest'
import { decodeBase64ToBytes } from './base64'

describe('decodeBase64ToBytes', () => {
  it('decodes standard base64 payloads back to raw bytes', () => {
    expect(Array.from(decodeBase64ToBytes('aGk='))).toEqual([104, 105])
    expect(Array.from(decodeBase64ToBytes(''))).toEqual([])
  })

  it('round-trips arbitrary binary chunks (PTY 输出可为任意字节)', () => {
    const bytes = Uint8Array.from([0xe8, 0xbf, 0x9e, 0x00, 0xff, 0x7f])
    const encoded = btoa(String.fromCharCode(...bytes))
    expect(Array.from(decodeBase64ToBytes(encoded))).toEqual(Array.from(bytes))
  })
})
