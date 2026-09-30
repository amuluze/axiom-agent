/**
 * vendored pixelmatch 的行为锚定测试（对上游语义的最小锁定：计数、阈值、
 * 尺寸校验与 diffMask 输出口径——升级上游重放移植时以此回归）。
 */
import { describe, expect, it } from 'vitest'
import { pixelmatch } from './pixelmatch'

const solid = (width: number, height: number, color: [number, number, number]): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = color[0]
    data[i * 4 + 1] = color[1]
    data[i * 4 + 2] = color[2]
    data[i * 4 + 3] = 255
  }
  return data
}

describe('vendored pixelmatch', () => {
  it('完全一致的图 → 0 差异', () => {
    expect(pixelmatch(solid(2, 2, [255, 0, 0]), solid(2, 2, [255, 0, 0]), null, 2, 2)).toBe(0)
  })

  it('单像素大幅色差 → 计 1（YIQ 距离超阈值）', () => {
    const a = solid(2, 1, [255, 255, 255])
    const b = solid(2, 1, [255, 255, 255])
    b[0] = 0
    b[1] = 0
    b[2] = 255
    expect(pixelmatch(a, b, null, 2, 1)).toBe(1)
  })

  it('低于阈值的微小色差不计（阈值 0.1 的默认灵敏度）', () => {
    const a = solid(1, 1, [255, 255, 255])
    const b = solid(1, 1, [254, 254, 254])
    expect(pixelmatch(a, b, null, 1, 1)).toBe(0)
  })

  it('尺寸与数据长度不一致 → 抛错（fail-closed，不产出错误计数）', () => {
    expect(() => pixelmatch(solid(2, 2, [0, 0, 0]), solid(1, 1, [0, 0, 0]), null, 2, 2)).toThrow()
    expect(() => pixelmatch(solid(2, 2, [0, 0, 0]), solid(2, 2, [0, 0, 0]), null, 1, 1)).toThrow()
  })

  it('diffMask 输出只画差异像素（alpha=255），其余保持透明', () => {
    const a = solid(2, 1, [0, 0, 0])
    const b = solid(2, 1, [0, 0, 0])
    b[0] = 255
    b[2] = 255
    const mask = new Uint8ClampedArray(2 * 1 * 4)
    const diff = pixelmatch(a, b, mask, 2, 1, { diffMask: true })
    expect(diff).toBe(1)
    expect(mask[3]).toBe(255)
    expect(mask[7]).toBe(0)
  })
})
