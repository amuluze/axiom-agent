/**
 * 原生截图光栅化（WKWebView 路径，docs/ax-format.md §4.6）：页面以「可见挂载 +
 * 等比缩放适配视口」呈现，Rust `capture_webview_viewport` 截取页面矩形，回传的
 * 普通 PNG 画到 canvas 做像素统计与预算降采样。
 *
 * 为什么需要原生路径：SVG foreignObject 管线会被 WebKit 污染画布（SecurityError），
 * 只在 Chromium 可用——见 exportPagePng.ts 顶部说明与 renderPageHost.tsx 的回退链。
 */
import { captureWebViewViewport, probeWebViewCapture } from '@/platform/webviewCapture'
import { sampleCanvasPixels, type PngPixelStats } from './exportPagePng'

/**
 * 原生截图瞬时失败重试一次：快照经主线程派发（Rust 侧 15s 有界等待），渲染队列
 * 拥塞、窗口瞬时遮挡等会造成偶发超时与空快照，重试大概率恢复。能走到这里的调用方
 * 都已通过支持性探测（命令已注册），失败只剩瞬时类；两次都失败按第二次的错误抛出。
 */
const captureViewportWithRetry = async (
  rect?: [number, number, number, number],
): Promise<Awaited<ReturnType<typeof captureWebViewViewport>>> => {
  try {
    return await captureWebViewViewport(rect)
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250))
    return captureWebViewViewport(rect)
  }
}

/** 支持性探测只做一次（Rust 侧 probe 不真正截图，无画面闪动）。 */
let supportPromise: Promise<boolean> | null = null

export const nativeCaptureSupported = (): Promise<boolean> => {
  supportPromise ??= probeWebViewCapture()
  return supportPromise
}

/** 测试隔离：清除探测缓存。 */
export const resetNativeCaptureProbe = (): void => {
  supportPromise = null
}

const loadImageFromBase64 = (base64: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('截图 PNG 解码失败'))
    image.src = `data:image/png;base64,${base64}`
  })

/** base64 PNG → canvas（1:1 绘制），供像素统计与再编码（data: 源不污染画布）。 */
const canvasFromImage = (image: HTMLImageElement, width: number, height: number): HTMLCanvasElement => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建画布上下文（像素统计用）')
  context.drawImage(image, 0, 0, width, height)
  return canvas
}

const dataUrlBase64Of = (canvas: HTMLCanvasElement): string => {
  const dataUrl = canvas.toDataURL('image/png')
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('PNG 编码失败')
  return dataUrl.slice(comma + 1)
}

export interface CapturedRegionStats {
  /** 全分辨率像素统计（空白判定）。 */
  stats: PngPixelStats
  /** 截图像素尺寸（Retina 下为 CSS 尺寸 × dpr）。 */
  width: number
  height: number
}

/**
 * 原位矩形采集（画布扫描的光栅步骤）：视口坐标 rect → 原生截图 → 解码 → 像素
 * 统计。与 captureMountedPage 的差别：页面**已经在画布上渲染**，无须挂载，也不
 * 产缩略图（画布扫描只消费统计；工具路径的缩略图走 staging 挂载路径）。
 */
export const captureRectStats = async (
  rect: [number, number, number, number],
): Promise<CapturedRegionStats> => {
  const shot = await captureViewportWithRetry(rect)
  if (!shot.imageBase64) {
    throw new Error('原生截图返回空数据')
  }
  const image = await loadImageFromBase64(shot.imageBase64)
  const canvas = canvasFromImage(image, image.width, image.height)
  return {
    stats: sampleCanvasPixels(canvas),
    width: image.width,
    height: image.height,
  }
}

export interface CapturedPagePng {
  base64: string
  /** 输出像素尺寸。 */
  width: number
  height: number
  /** 相对页面设计尺寸的倍率（Retina 截图 ≈ dpr × 适配缩放）。 */
  scale: number
  /** 全分辨率下的像素统计（空白判定不随预算降采样失真）。 */
  stats: PngPixelStats
}

export interface CaptureMountedPageOptions {
  /** 输出 base64 字符数上限；超出沿阶梯降采样，到底仍超则抛错（调用方显式降级）。 */
  maxBytes: number
  /** 降采样阶梯（相对全分辨率的倍率，逐级取半到底）。 */
  scaleLadder?: readonly number[]
  /** 预算耗尽不抛错、返回阶梯最低档（扫描验证的语义：统计有效，缩略图降级）。 */
  returnSmallestOnExhausted?: boolean
}

const DEFAULT_CAPTURE_LADDER = [1, 0.5, 0.25] as const

/**
 * 截取已挂载（capture 模式）的页面元素：整幅截图 → 像素统计 → 按预算降采样。
 * element 必须由 renderPageHost 的 capture 模式挂载（可见且完整落在视口内）。
 */
export const captureMountedPage = async (
  element: HTMLElement,
  pageWidth: number,
  pageHeight: number,
  options: CaptureMountedPageOptions,
): Promise<CapturedPagePng> => {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    throw new Error('页面没有可截取的可见区域')
  }
  const shot = await captureViewportWithRetry([rect.x, rect.y, rect.width, rect.height])
  if (!shot.imageBase64) {
    throw new Error('原生截图返回空数据')
  }
  const image = await loadImageFromBase64(shot.imageBase64)
  // 全分辨率统计：空白判定在最高保真度上做，不随预算降采样失真。
  const fullCanvas = canvasFromImage(image, image.width, image.height)
  const stats = sampleCanvasPixels(fullCanvas)

  // 倍率取宽高两向的较大估计（非等比内容的保守值；等比挂载下两者应一致）。
  const naturalScale = Math.max(
    pageWidth > 0 ? image.width / pageWidth : 1,
    pageHeight > 0 ? image.height / pageHeight : 1,
  )
  const ladder = options.scaleLadder ?? DEFAULT_CAPTURE_LADDER
  let base64 = dataUrlBase64Of(fullCanvas)
  let outputWidth = image.width
  let outputHeight = image.height
  let scale = naturalScale
  for (const factor of ladder) {
    if (base64.length <= options.maxBytes) {
      return { base64, width: outputWidth, height: outputHeight, scale, stats }
    }
    const nextWidth = Math.max(1, Math.round(image.width * factor))
    const nextHeight = Math.max(1, Math.round(image.height * factor))
    const downsized = canvasFromImage(image, nextWidth, nextHeight)
    base64 = dataUrlBase64Of(downsized)
    outputWidth = nextWidth
    outputHeight = nextHeight
    scale = naturalScale * factor
  }
  if (options.returnSmallestOnExhausted) {
    return { base64, width: outputWidth, height: outputHeight, scale, stats }
  }
  throw new Error(`截图超出字节预算（${base64.length} > ${options.maxBytes}）`)
}
