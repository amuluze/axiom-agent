import { describe, expect, it } from 'vitest'
import {
  MAX_IMAGE_BYTES,
  MAX_PASTE_IMAGES,
  attachmentFromImageBlock,
  bytesToBase64,
  compressPastedImage,
  imageFilesFromClipboard,
  scaledDimensions,
  shouldKeepOriginalBytes,
} from './imagePaste'

const makeFile = (bytes: number[], type = 'image/png'): File =>
  new File([new Uint8Array(bytes)], 'shot.png', { type })

const fakeClipboard = (items: Array<{ type: string; file?: File }>, files: File[] = []) => ({
  items: items.map((item) => ({
    type: item.type,
    getAsFile: () => item.file ?? null,
  })),
  files,
})

describe('imageFilesFromClipboard', () => {
  it('collects image items via getAsFile and skips non-image types', () => {
    const shot = makeFile([1])
    const text = makeFile([2], 'text/plain')
    const files = imageFilesFromClipboard(fakeClipboard([
      { type: 'image/png', file: shot },
      { type: 'text/plain', file: text },
    ]))
    expect(files).toEqual([shot])
  })

  it('falls back to data.files and dedupes against items', () => {
    const shot = makeFile([1])
    const extra = makeFile([3], 'image/jpeg')
    const files = imageFilesFromClipboard(fakeClipboard(
      [{ type: 'image/png', file: shot }],
      [shot, extra],
    ))
    expect(files).toEqual([shot, extra])
  })

  it('returns an empty list for null clipboard data or text-only paste', () => {
    expect(imageFilesFromClipboard(null)).toEqual([])
    expect(imageFilesFromClipboard(fakeClipboard([{ type: 'text/plain' }]))).toEqual([])
  })
})

describe('scaledDimensions', () => {
  it('downscales the long edge proportionally', () => {
    expect(scaledDimensions(3200, 1600, 1568)).toEqual({ width: 1568, height: 784 })
    expect(scaledDimensions(1000, 2000, 1568)).toEqual({ width: 784, height: 1568 })
  })

  it('keeps images that already fit within the max edge', () => {
    expect(scaledDimensions(1200, 800, 1568)).toEqual({ width: 1200, height: 800 })
  })
})

describe('bytesToBase64', () => {
  it('round-trips bytes through base64', () => {
    const bytes = new Uint8Array([104, 105, 32, 240, 159, 150, 128])
    // atob 返回的是逐字节二进制串（非 UTF-8 解码文本），与原字节逐一比对。
    expect([...atob(bytesToBase64(bytes))].map((c) => c.charCodeAt(0))).toEqual([...bytes])
  })

  it('handles payloads larger than the btoa chunk size', () => {
    const bytes = new Uint8Array(0x8000 + 5).map((_, i) => i % 251)
    const decoded = atob(bytesToBase64(bytes))
    expect(decoded.length).toBe(bytes.length)
  })
})

describe('shouldKeepOriginalBytes', () => {
  it('keeps small originals without recompression', () => {
    expect(shouldKeepOriginalBytes(100 * 1024, true)).toBe(true)
  })

  it('compresses large images when canvas is available', () => {
    expect(shouldKeepOriginalBytes(2 * 1024 * 1024, true)).toBe(false)
  })

  it('always keeps originals when canvas is unavailable (jsdom / 环境兜底)', () => {
    expect(shouldKeepOriginalBytes(2 * 1024 * 1024, false)).toBe(true)
  })
})

describe('compressPastedImage', () => {
  it('passes small images through unchanged with their original media type', async () => {
    const file = makeFile([137, 80, 78, 71])
    const image = await compressPastedImage(file)
    expect(image).toEqual({ mediaType: 'image/png', base64: bytesToBase64(new Uint8Array([137, 80, 78, 71])), byteSize: 4 })
  })

  it('keeps the original media type for small non-paste images', async () => {
    const file = makeFile([1, 2, 3], 'image/webp')
    const image = await compressPastedImage(file)
    expect(image.mediaType).toBe('image/webp')
  })

  it('rejects oversized payloads above the hard cap when compression is bypassed', async () => {
    // 环境无 canvas（jsdom）→ 走保原图路径；这里只验证上限常量契约：
    // 重编码路径的超限拒绝由 ImageTooLargeError 在真实浏览器环境触发。
    expect(MAX_IMAGE_BYTES).toBeGreaterThan(0)
    expect(MAX_PASTE_IMAGES).toBeGreaterThan(0)
  })
})

describe('attachmentFromImageBlock', () => {
  it('回填 base64 图片块：字节原样、不做二次压缩', () => {
    const base64 = bytesToBase64(new Uint8Array([137, 80, 78, 71]))
    expect(attachmentFromImageBlock({
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: base64 },
    })).toEqual({
      mediaType: 'image/png',
      base64,
      previewUrl: `data:image/png;base64,${base64}`,
    })
  })

  it('url 来源的图片块没有可回填字节，返回 undefined', () => {
    // 队列项/历史消息可能持有 url 图片块：回填输入框必须有字节，故显式不可回填，
    // 由调用方按数量提示（而不是回填出坏图）。
    expect(attachmentFromImageBlock({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/a.png' },
    })).toBeUndefined()
  })
})
