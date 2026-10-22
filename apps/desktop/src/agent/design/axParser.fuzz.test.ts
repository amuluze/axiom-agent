import { describe, expect, it } from 'vitest'
import { parseAxDocument, serializeAxDocument } from './axParser'

/**
 * `.ax` 是模型直接写的 JSON，解析器必须对任意损坏输入返回诊断而不是抛异常；
 * 一旦返回 document，就必须能再次经幂等序列化器往返。固定 LCG 保证可复现。
 */
const next = (state: { value: number }): number => {
  state.value = (state.value * 1664525 + 1013904223) >>> 0
  return state.value
}

const validDocument = (): string => JSON.stringify({
  ax: '1.6',
  name: 'fuzz',
  tokens: {
    'bg-main': { $type: 'color', $value: { light: '#F8F7F3', dark: '#161514' } },
    'space-6': { $type: 'dimension', $value: '6px' },
    'text-md': { $type: 'dimension', $value: '13px' },
  },
  components: {},
  pages: [{
    id: 'p1',
    name: 'Fuzz',
    width: 1180,
    height: 780,
    background: '$bg-main',
    tree: [{ id: 'n1', kind: 'frame', layout: 'vertical', gap: '$space-6', children: [] }],
  }],
})

describe('parseAxDocument fuzz', () => {
  it('never throws on random JSON-like byte soup', () => {
    const random = { value: 0xabad1dea }
    const alphabet = '{}[],:"\\/0123456789abcdefghijklmnopqrstuvwxyz \n\t'
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const length = next(random) % 240
      let source = ''
      for (let index = 0; index < length; index += 1) {
        source += alphabet[next(random) % alphabet.length]
      }
      expect(() => parseAxDocument(source)).not.toThrow()
    }
  })

  it('round-trips any document that survives a single-character mutation', () => {
    const base = validDocument()
    const random = { value: 0x1234abcd }
    const alphabet = '{}[],:"\\/0123456789abcdefghijklmnopqrstuvwxyz \n\t'
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const index = next(random) % base.length
      const operation = next(random) % 3
      const replacement = alphabet[next(random) % alphabet.length]
      const mutated = operation === 0
        ? `${base.slice(0, index)}${base.slice(index + 1)}`
        : operation === 1
          ? `${base.slice(0, index)}${replacement}${base.slice(index)}`
          : `${base.slice(0, index)}${replacement}${base.slice(index + 1)}`
      expect(() => parseAxDocument(mutated)).not.toThrow()
      const parsed = parseAxDocument(mutated)
      if (!parsed.document) continue
      const once = serializeAxDocument(parsed.document)
      const reparsed = parseAxDocument(once)
      expect(reparsed.document).not.toBeNull()
      if (reparsed.document) {
        expect(serializeAxDocument(reparsed.document)).toBe(once)
      }
    }
  })
})
