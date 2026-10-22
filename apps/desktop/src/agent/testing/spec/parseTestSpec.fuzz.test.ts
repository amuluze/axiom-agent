import { describe, expect, it } from 'vitest'
import { parseTestSpec } from './parseTestSpec'

/**
 * 确定性 fuzz：不引入 fast-check，用固定 LCG 生成可复现的畸形输入。
 * 断言重点不是「一定解析成功」，而是解析器**永不抛异常**；失败必须以
 * `{ ok:false, issues }` 的结构化结果返回，否则一次畸形 `.testspec.json` 会把
 * 扫描/运行路径直接打断。
 */
const next = (state: { value: number }): number => {
  state.value = (state.value * 1664525 + 1013904223) >>> 0
  return state.value
}

const validSpec = (): string => JSON.stringify({
  kind: 'axiom.test',
  version: 3,
  id: 'fuzz-spec',
  name: 'fuzz',
  target: {
    webBaseUrl: '$' + '{env.WEB_BASE_URL}',
    apiBaseUrl: '$' + '{env.API_BASE_URL}',
    viewport: { width: 1280, height: 800 },
  },
  testPoints: [{ id: 'tp-1', kind: 'new_feature', title: 'fuzz', acceptance: 'fuzz' }],
  cases: [{
    id: 'case-1',
    name: 'fuzz case',
    verifies: ['tp-1'],
    steps: [{ id: 'step-1', action: 'ui.assert', expect: { exists: true } }],
  }],
})

describe('parseTestSpec fuzz', () => {
  it('never throws on random JSON-like byte soup', () => {
    const random = { value: 0x5eed1234 }
    const alphabet = '{}[],:"\\/0123456789abcdefghijklmnopqrstuvwxyz \n\t\u0000'
    for (let iteration = 0; iteration < 400; iteration += 1) {
      const length = next(random) % 240
      let source = ''
      for (let index = 0; index < length; index += 1) {
        source += alphabet[next(random) % alphabet.length]
      }
      expect(() => parseTestSpec(source)).not.toThrow()
      const result = parseTestSpec(source)
      if (!result.ok) expect(Array.isArray(result.issues)).toBe(true)
    }
  })

  it('never throws on single-character mutations of a valid spec', () => {
    const base = validSpec()
    const random = { value: 0xdecafbad }
    const alphabet = '{}[],:"\\/0123456789abcdefghijklmnopqrstuvwxyz \n\t'
    for (let iteration = 0; iteration < 400; iteration += 1) {
      const index = next(random) % base.length
      const operation = next(random) % 3
      const replacement = alphabet[next(random) % alphabet.length]
      const mutated = operation === 0
        ? `${base.slice(0, index)}${base.slice(index + 1)}`
        : operation === 1
          ? `${base.slice(0, index)}${replacement}${base.slice(index)}`
          : `${base.slice(0, index)}${replacement}${base.slice(index + 1)}`
      expect(() => parseTestSpec(mutated)).not.toThrow()
      const result = parseTestSpec(mutated)
      if (!result.ok) expect(Array.isArray(result.issues)).toBe(true)
    }
  })
})
