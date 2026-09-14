import type { ImageContentBlock } from '@/agent/core/types'

/**
 * 粘贴截图 → 图像内容块的纯逻辑层。约束来源：
 * - Rust model_http.rs 的 MAX_REQUEST_BODY_BYTES（2 MiB）是整条请求的硬上限，
 *   视网膜截图原始 PNG 动辄数 MB，粘贴链路必须客户端降采样 + 重编码；
 * - 长边 1568px 对齐主流视觉模型的最佳输入分辨率，也压缩 token 成本；
 * - 小图保持原字节不动（保真 + 免去无谓重编码，jsdom 等无 canvas 环境同样走此路径）。
 */

export const MAX_PASTE_IMAGES = 4
/** ≤ 384KB 的原图直接内联（base64 后 ~512KB），不做重编码。 */
const KEEP_ORIGINAL_MAX_BYTES = 384 * 1024
const TARGET_LONG_EDGE = 1568
const RETRY_LONG_EDGE = 1280
const JPEG_QUALITY = 0.85
const RETRY_JPEG_QUALITY = 0.7
/** 重编码后的单图上限：再大就拒绝，避免一条消息吃光整个请求预算。 */
export const MAX_IMAGE_BYTES = 1024 * 1024

export class ImageTooLargeError extends Error {
  constructor() {
    super('image exceeds size limit after compression')
    this.name = 'ImageTooLargeError'
  }
}

export interface PastedImage {
  mediaType: string
  base64: string
  /** 原始二进制大小（非 base64）。 */
  byteSize: number
}

export interface ClipboardImageItemLike {
  type: string
  getAsFile(): File | null
}

export interface ClipboardDataLike {
  items?: ArrayLike<ClipboardImageItemLike>
  files?: ArrayLike<File>
}

/** 从剪贴板事件数据中提取全部图像文件（items 优先，files 兜底去重）。 */
export const imageFilesFromClipboard = (data: ClipboardDataLike | null): File[] => {
  if (!data) return []
  const seen = new Set<File>()
  const out: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (!item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file && !seen.has(file)) {
      seen.add(file)
      out.push(file)
    }
  }
  for (const file of Array.from(data.files ?? [])) {
    if (file.type.startsWith('image/') && !seen.has(file)) {
      seen.add(file)
      out.push(file)
    }
  }
  return out
}

/** 等比缩放：长边压到 maxEdge，已更小则原样返回。 */
export const scaledDimensions = (
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } => {
  const longest = Math.max(width, height)
  if (longest <= maxEdge || longest === 0) return { width, height }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** jsdom 等测试环境没有 createObjectURL：预览地址缺位时缩略图置空即可。 */
export const objectUrlForFile = (file: File): string => {
  try {
    return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : ''
  } catch {
    return ''
  }
}

export const revokeObjectUrl = (url: string): void => {
  if (!url) return
  try {
    URL.revokeObjectURL(url)
  } catch {
    // 忽略：个别环境对已失效地址再撤销会抛错，清理路径不应中断交互。
  }
}

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** 编码决策：小图/无 canvas 环境保原图，其余走「长边 1568 → 超限再降 1280」两档 JPEG。 */
export const shouldKeepOriginalBytes = (fileSize: number, canvasAvailable: boolean): boolean =>
  !canvasAvailable || fileSize <= KEEP_ORIGINAL_MAX_BYTES

const canvasAvailable = (): boolean => {
  if (typeof document === 'undefined') return false
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  return canvas.getContext('2d') !== null
}

interface DecodedImage {
  width: number
  height: number
  drawTo: (canvas: HTMLCanvasElement) => void
}

/** Blob → 字节：jsdom 的 Blob 缺 arrayBuffer()，FileReader 路径兜底。 */
const blobToBytes = (blob: Blob): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    if (typeof blob.arrayBuffer === 'function') {
      blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
      return
    }
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('failed to read pasted image'))
    reader.readAsArrayBuffer(blob)
  })

const decodeImage = async (file: Blob): Promise<DecodedImage | null> => {
  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement | null>((resolve) => {
      // 解码挂起兜底（个别环境对 objectURL 不派发 load/error）：退回原字节路径。
      const timer = setTimeout(() => resolve(null), 3000)
      const settle = (result: HTMLImageElement | null) => {
        clearTimeout(timer)
        resolve(result)
      }
      const element = new Image()
      element.onload = () => settle(element)
      element.onerror = () => settle(null)
      element.src = url
    })
    if (!image) return null
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      drawTo: (canvas) => {
        const context = canvas.getContext('2d')
        if (!context) throw new Error('canvas 2d context unavailable')
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
      },
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

const canvasToBlob = (canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality)
  })

const encodeAttempt = async (
  decoded: DecodedImage,
  maxEdge: number,
  quality: number,
): Promise<{ bytes: Uint8Array } | null> => {
  const { width, height } = scaledDimensions(decoded.width, decoded.height, maxEdge)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  decoded.drawTo(canvas)
  const blob = await canvasToBlob(canvas, quality)
  if (!blob) return null
  return { bytes: await blobToBytes(blob) }
}

/** 粘贴图 → 可入请求的图像块载荷。压缩失败到仍超限时抛 ImageTooLargeError。 */
export const compressPastedImage = async (file: Blob): Promise<PastedImage> => {
  const bytes = await blobToBytes(file)
  if (shouldKeepOriginalBytes(bytes.byteLength, canvasAvailable())) {
    return { mediaType: file.type || 'image/png', base64: bytesToBase64(bytes), byteSize: bytes.byteLength }
  }
  const decoded = await decodeImage(file)
  if (!decoded) {
    // 解码失败（损坏文件等）：退回原字节，交由服务端/请求上限兜底。
    return { mediaType: file.type || 'image/png', base64: bytesToBase64(bytes), byteSize: bytes.byteLength }
  }
  let attempt = await encodeAttempt(decoded, TARGET_LONG_EDGE, JPEG_QUALITY)
  if (attempt && attempt.bytes.byteLength > MAX_IMAGE_BYTES) {
    attempt = await encodeAttempt(decoded, RETRY_LONG_EDGE, RETRY_JPEG_QUALITY)
  }
  if (!attempt || attempt.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageTooLargeError()
  }
  return {
    mediaType: 'image/jpeg',
    base64: bytesToBase64(attempt.bytes),
    byteSize: attempt.bytes.byteLength,
  }
}

export const toImageContentBlock = (
  image: Pick<PastedImage, 'mediaType' | 'base64'>,
): ImageContentBlock => ({
  type: 'image',
  source: { type: 'base64', mediaType: image.mediaType, data: image.base64 },
})
