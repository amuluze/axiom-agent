/**
 * 设计 ↔ 实现的像素对拍（docs/ax-format.md §4.6「可选视觉对拍」，pixelmatch）。
 *
 * 纯函数：输入 RGBA 数组（解码由宿主接缝完成），输出差异计数、占比、差异
 * 包围盒与 advisory 判定。判定刻意宽松且**永不 fail**：设计侧渲染发生在
 * WKWebView、实现侧截图来自隔离 Chromium——跨引擎的字体光栅化基线噪声
 * 会让文本页存在成片微小差异，本对拍的价值在量级与差异定位（布局崩坏是
 * 30%+ 的差异，与 1-3% 的字体噪声量级分明），不是像素级回归门禁。
 */
import { pixelmatch } from './vendor/pixelmatch'

export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** 像素级匹配阈值（pixelmatch per-pixel，越小越敏感；上游默认 0.1）。 */
export const PIXEL_THRESHOLD = 0.1

/** 判定阈值：差异像素占比 ≤ 5% 记 pass（跨引擎字体噪声基线之上的余量）。 */
export const COMPARE_PASS_RATIO = 0.05

export interface RgbaDiffBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface RgbaCompareResult {
  /** 参与比较的像素尺寸（归一后）。 */
  width: number
  height: number
  /** 差异像素数（pixelmatch 口径：抗锯齿像素不计入）。 */
  mismatchedPixels: number
  /** 差异像素占比（0–1）。 */
  ratio: number
  /** 差异像素包围盒（定位「哪里不一样」；无差异为 null）。 */
  bounds: RgbaDiffBounds | null
}

/**
 * 双线性缩放到目标尺寸（比较前归一——实现截图与设计渲染的像素尺寸不一致时，
 * 以**设计渲染尺寸为基准**把实现侧缩放过去：设计稿是规格）。整数倍恒等尺寸
 * 直接返回原引用，避免无谓拷贝。
 */
export const scaleRgba = (image: RgbaImage, width: number, height: number): RgbaImage => {
  if (image.width === width && image.height === height) return image
  const output = new Uint8ClampedArray(width * height * 4)
  const ratioX = image.width / width
  const ratioY = image.height / height
  for (let y = 0; y < height; y++) {
    // 目标像素中心映射回源坐标；边界钳制防止越界采样。
    const sourceY = Math.min(image.height - 1, Math.max(0, (y + 0.5) * ratioY - 0.5))
    const y0 = Math.floor(sourceY)
    const y1 = Math.min(image.height - 1, y0 + 1)
    const fy = sourceY - y0
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(image.width - 1, Math.max(0, (x + 0.5) * ratioX - 0.5))
      const x0 = Math.floor(sourceX)
      const x1 = Math.min(image.width - 1, x0 + 1)
      const fx = sourceX - x0
      const target = (y * width + x) * 4
      for (let channel = 0; channel < 4; channel++) {
        const p00 = image.data[(y0 * image.width + x0) * 4 + channel]!
        const p10 = image.data[(y0 * image.width + x1) * 4 + channel]!
        const p01 = image.data[(y1 * image.width + x0) * 4 + channel]!
        const p11 = image.data[(y1 * image.width + x1) * 4 + channel]!
        output[target + channel] = p00 * (1 - fx) * (1 - fy)
          + p10 * fx * (1 - fy)
          + p01 * (1 - fx) * fy
          + p11 * fx * fy
      }
    }
  }
  return { width, height, data: output }
}

/**
 * 对拍两张同尺寸 RGBA 图。diffMask 输出只画差异像素（alpha=255），据此求
 * 差异包围盒；计数用 pixelmatch 返回值（与包围盒像素数一致——同一来源）。
 */
export const compareRgba = (design: RgbaImage, implementation: RgbaImage): RgbaCompareResult => {
  if (design.width !== implementation.width || design.height !== implementation.height) {
    throw new Error(`compareRgba 要求同尺寸输入（${design.width}x${design.height} vs ${implementation.width}x${implementation.height}），先经 scaleRgba 归一`)
  }
  const { width, height } = design
  const mask = new Uint8ClampedArray(width * height * 4)
  const mismatchedPixels = pixelmatch(
    design.data,
    implementation.data,
    mask,
    width,
    height,
    { threshold: PIXEL_THRESHOLD, diffMask: true },
  )
  let minX = -1
  let minY = -1
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[(y * width + x) * 4 + 3] !== 255) continue
      if (minX < 0 || x < minX) minX = x
      if (minY < 0 || y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  const bounds = minX < 0
    ? null
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
  return {
    width,
    height,
    mismatchedPixels,
    ratio: mismatchedPixels / (width * height),
    bounds,
  }
}

/** advisory 判定：占比 ≤ COMPARE_PASS_RATIO 为 pass，否则 warn（永不 fail）。 */
export const compareVerdictOf = (ratio: number): 'pass' | 'warn' =>
  ratio <= COMPARE_PASS_RATIO ? 'pass' : 'warn'
