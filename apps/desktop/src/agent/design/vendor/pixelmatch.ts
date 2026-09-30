/**
 * pixelmatch v5.3.0 的 TypeScript 移植（vendored）。
 *
 * ISC License
 *
 * Copyright (c) 2019, Mapbox
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE
 * OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 *
 * 上游：https://github.com/mapbox/pixelmatch（index.js，v5.3.0）。移植只做了
 * 两处非算法改动：CommonJS → ESM 导出、补 TypeScript 类型；YIQ 色差判定与
 * 抗锯齿排除（Vysniauskas 2009 斜率检测）与上游逐行一致——升级上游时按
 * 上游 release diff 重放本文件。
 */

export interface PixelmatchOptions {
  /** 匹配阈值（0–1），越小越敏感；上游默认 0.1。 */
  threshold?: number
  /** 是否跳过抗锯齿检测（默认 false = 检测并排除抗锯齿像素）。 */
  includeAA?: boolean
  /** 差异图里原图的混合不透明度。 */
  alpha?: number
  /** 抗锯齿像素在差异输出中的颜色。 */
  aaColor?: [number, number, number]
  /** 差异像素在差异输出中的颜色。 */
  diffColor?: [number, number, number]
  /** 检测 img1 比 img2 暗（或反之）的差异并用替代色绘制以区分方向；null = 不区分。 */
  diffColorAlt?: [number, number, number] | null
  /** 差异输出改为透明背景遮罩（只画差异像素，抗锯齿与背景都不画）。 */
  diffMask?: boolean
}

type PixelData = Uint8Array | Uint8ClampedArray

const isPixelData = (value: unknown): value is PixelData =>
  ArrayBuffer.isView(value) && (value.constructor as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT === 1

const blend = (c: number, a: number): number => 255 + (c - 255) * a

const rgb2y = (r: number, g: number, b: number): number =>
  r * 0.29889531 + g * 0.58662247 + b * 0.11448223
const rgb2i = (r: number, g: number, b: number): number =>
  r * 0.59597799 - g * 0.27417610 - b * 0.32180189
const rgb2q = (r: number, g: number, b: number): number =>
  r * 0.21147017 - g * 0.52261711 + b * 0.31114694

// calculate color difference according to the paper "Measuring perceived color difference
// using YIQ NTSC transmission color space in mobile applications" by Y. Kotsarenko and F. Ramos

const colorDelta = (
  img1: PixelData,
  img2: PixelData,
  k: number,
  m: number,
  yOnly = false,
): number => {
  let r1 = img1[k]!
  let g1 = img1[k + 1]!
  let b1 = img1[k + 2]!
  const a1 = img1[k + 3]!

  let r2 = img2[m]!
  let g2 = img2[m + 1]!
  let b2 = img2[m + 2]!
  const a2 = img2[m + 3]!

  if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) return 0

  if (a1 < 255) {
    const alpha = a1 / 255
    r1 = blend(r1, alpha)
    g1 = blend(g1, alpha)
    b1 = blend(b1, alpha)
  }

  if (a2 < 255) {
    const alpha = a2 / 255
    r2 = blend(r2, alpha)
    g2 = blend(g2, alpha)
    b2 = blend(b2, alpha)
  }

  const y1 = rgb2y(r1, g1, b1)
  const y2 = rgb2y(r2, g2, b2)
  const y = y1 - y2

  if (yOnly) return y // brightness difference only

  const i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2)
  const q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2)

  const delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q

  // encode whether the pixel lightens or darkens in the sign
  return y1 > y2 ? -delta : delta
}

const drawPixel = (
  output: PixelData,
  pos: number,
  r: number,
  g: number,
  b: number,
): void => {
  output[pos] = r
  output[pos + 1] = g
  output[pos + 2] = b
  output[pos + 3] = 255
}

const drawGrayPixel = (img: PixelData, i: number, alpha: number, output: PixelData): void => {
  const r = img[i]!
  const g = img[i + 1]!
  const b = img[i + 2]!
  const val = blend(rgb2y(r, g, b), alpha * img[i + 3]! / 255)
  drawPixel(output, i, val, val, val)
}

// check if a pixel has 3+ adjacent pixels of the same color.
const hasManySiblings = (img: PixelData, x1: number, y1: number, width: number, height: number): boolean => {
  const x0 = Math.max(x1 - 1, 0)
  const y0 = Math.max(y1 - 1, 0)
  const x2 = Math.min(x1 + 1, width - 1)
  const y2 = Math.min(y1 + 1, height - 1)
  const pos = (y1 * width + x1) * 4
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0

  // go through 8 adjacent pixels
  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue

      const pos2 = (y * width + x) * 4
      if (img[pos] === img[pos2]
        && img[pos + 1] === img[pos2 + 1]
        && img[pos + 2] === img[pos2 + 2]
        && img[pos + 3] === img[pos2 + 3]) zeroes++

      if (zeroes > 2) return true
    }
  }

  return false
}

// check if a pixel is likely a part of anti-aliasing;
// based on "Anti-aliased Pixel and Intensity Slope Detector" paper by V. Vysniauskas, 2009

const antialiased = (
  img: PixelData,
  x1: number,
  y1: number,
  width: number,
  height: number,
  img2: PixelData,
): boolean => {
  const x0 = Math.max(x1 - 1, 0)
  const y0 = Math.max(y1 - 1, 0)
  const x2 = Math.min(x1 + 1, width - 1)
  const y2 = Math.min(y1 + 1, height - 1)
  const pos = (y1 * width + x1) * 4
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0
  let min = 0
  let max = 0
  let minX = 0
  let minY = 0
  let maxX = 0
  let maxY = 0

  // go through 8 adjacent pixels
  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue

      // brightness delta between the center pixel and adjacent one
      const delta = colorDelta(img, img, pos, (y * width + x) * 4, true)

      // count the number of equal, darker and brighter adjacent pixels
      if (delta === 0) {
        zeroes++
        // if found more than 2 equal siblings, it's definitely not anti-aliasing
        if (zeroes > 2) return false

        // remember the darkest pixel
      } else if (delta < min) {
        min = delta
        minX = x
        minY = y

        // remember the brightest pixel
      } else if (delta > max) {
        max = delta
        maxX = x
        maxY = y
      }
    }
  }

  // if there are no both darker and brighter pixels among siblings, it's not anti-aliasing
  if (min === 0 || max === 0) return false

  // if either the darkest or the brightest pixel has 3+ equal siblings in both images
  // (definitely not anti-aliased), this pixel is anti-aliased
  return (hasManySiblings(img, minX, minY, width, height) && hasManySiblings(img2, minX, minY, width, height))
    || (hasManySiblings(img, maxX, maxY, width, height) && hasManySiblings(img2, maxX, maxY, width, height))
}

export const pixelmatch = (
  img1: PixelData,
  img2: PixelData,
  output: PixelData | null,
  width: number,
  height: number,
  options: PixelmatchOptions = {},
): number => {
  if (!isPixelData(img1) || !isPixelData(img2) || (output !== null && !isPixelData(output))) {
    throw new Error('Image data: Uint8Array, Uint8ClampedArray or Buffer expected.')
  }

  if (img1.length !== img2.length || (output !== null && output.length !== img1.length)) {
    throw new Error('Image sizes do not match.')
  }

  if (img1.length !== width * height * 4) throw new Error('Image data size does not match width/height.')

  const threshold = options.threshold ?? 0.1
  const includeAA = options.includeAA ?? false
  const alpha = options.alpha ?? 0.1
  const aaColor = options.aaColor ?? [255, 255, 0]
  const diffColor = options.diffColor ?? [255, 0, 0]
  const diffColorAlt = options.diffColorAlt ?? null
  const diffMask = options.diffMask ?? false

  // check if images are identical
  const len = width * height
  const a32 = new Uint32Array(img1.buffer, img1.byteOffset, len)
  const b32 = new Uint32Array(img2.buffer, img2.byteOffset, len)
  let identical = true

  for (let i = 0; i < len; i++) {
    if (a32[i] !== b32[i]) { identical = false; break }
  }
  if (identical) { // fast path if identical
    if (output !== null && !diffMask) {
      for (let i = 0; i < len; i++) drawGrayPixel(img1, 4 * i, alpha, output)
    }
    return 0
  }

  // maximum acceptable square distance between two colors;
  // 35215 is the maximum possible value for the YIQ difference metric
  const maxDelta = 35215 * threshold * threshold
  let diff = 0

  // compare each pixel of one image against the other one
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pos = (y * width + x) * 4

      // squared YUV distance between colors at this pixel position, negative if the img2 pixel is darker
      const delta = colorDelta(img1, img2, pos, pos)

      // the color difference is above the threshold
      if (Math.abs(delta) > maxDelta) {
        // check it's a real rendering difference or just anti-aliasing
        if (!includeAA && (antialiased(img1, x, y, width, height, img2)
          || antialiased(img2, x, y, width, height, img1))) {
          // one of the pixels is anti-aliasing; draw as yellow and do not count as difference
          // note that we do not include such pixels in a mask
          if (output !== null && !diffMask) drawPixel(output, pos, aaColor[0], aaColor[1], aaColor[2])
        } else {
          // found substantial difference not caused by anti-aliasing; draw it as such
          if (output !== null) {
            const color = delta < 0 && diffColorAlt !== null ? diffColorAlt : diffColor
            drawPixel(output, pos, color[0], color[1], color[2])
          }
          diff++
        }
      } else if (output !== null) {
        // pixels are similar; draw background as grayscale image blended with white
        if (!diffMask) drawGrayPixel(img1, pos, alpha, output)
      }
    }
  }

  // return the number of different pixels
  return diff
}
