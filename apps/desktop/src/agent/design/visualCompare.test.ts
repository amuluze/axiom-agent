/**
 * 像素对拍的纯函数测试（docs/ax-format.md §4.6 可选视觉对拍）：
 * 归一缩放、差异计数/占比/包围盒与 advisory 判定阈值。
 */
import { describe, expect, it } from 'vitest'
import {
  COMPARE_PASS_RATIO,
  compareRgba,
  compareVerdictOf,
  scaleRgba,
  type RgbaImage,
} from './visualCompare'

const solidImage = (
  width: number,
  height: number,
  color: [number, number, number],
): RgbaImage => ({ width, height, data: buildSolid(width, height, color) })

const buildSolid = (width: number, height: number, color: [number, number, number]): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = color[0]
    data[i * 4 + 1] = color[1]
    data[i * 4 + 2] = color[2]
    data[i * 4 + 3] = 255
  }
  return data
}

describe('scaleRgba（归一）', () => {
  it('同尺寸直接返回原引用（不拷贝）', () => {
    const image = solidImage(4, 4, [10, 20, 30])
    expect(scaleRgba(image, 4, 4)).toBe(image)
  })

  it('纯色缩放（4x4 → 2x2）后仍是同一纯色', () => {
    const scaled = scaleRgba(solidImage(4, 4, [200, 100, 50]), 2, 2)
    expect(scaled.width).toBe(2)
    for (let i = 0; i < 4; i++) {
      expect([...scaled.data.slice(i * 4, i * 4 + 3)]).toEqual([200, 100, 50])
    }
  })
})

describe('compareRgba（对拍）', () => {
  it('完全一致 → ratio 0、无包围盒', () => {
    const result = compareRgba(solidImage(3, 3, [0, 128, 255]), solidImage(3, 3, [0, 128, 255]))
    expect(result.mismatchedPixels).toBe(0)
    expect(result.ratio).toBe(0)
    expect(result.bounds).toBeNull()
  })

  it('单块差异 → 精确计数、占比与包围盒', () => {
    const design = solidImage(4, 4, [255, 255, 255])
    const implementation = solidImage(4, 4, [255, 255, 255])
    // 右下角 1x1 像素改成纯蓝。
    const corner = (3 * 4 + 3) * 4
    implementation.data[corner] = 0
    implementation.data[corner + 1] = 0
    implementation.data[corner + 2] = 255
    const result = compareRgba(design, implementation)
    expect(result.mismatchedPixels).toBe(1)
    expect(result.ratio).toBeCloseTo(1 / 16)
    expect(result.bounds).toEqual({ x: 3, y: 3, width: 1, height: 1 })
  })

  it('尺寸不一致 → 抛错（调用方必须先归一）', () => {
    expect(() => compareRgba(solidImage(2, 2, [0, 0, 0]), solidImage(3, 2, [0, 0, 0]))).toThrow()
  })
})

describe('compareVerdictOf（advisory 判定）', () => {
  it('占比 ≤ 5% 为 pass，超过为 warn，永不 fail', () => {
    expect(compareVerdictOf(0)).toBe('pass')
    expect(compareVerdictOf(COMPARE_PASS_RATIO)).toBe('pass')
    expect(compareVerdictOf(COMPARE_PASS_RATIO + 0.0001)).toBe('warn')
    expect(compareVerdictOf(1)).toBe('warn')
  })
})
