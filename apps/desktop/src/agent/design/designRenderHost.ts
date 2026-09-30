/**
 * 设计页渲染的宿主接缝（docs/ax-format.md §4.6「渲染回读」）。
 *
 * `design_query` 的 render 模式要把**整页渲染成 PNG** 回给模型自查（模型看像素，
 * 而不只是看 JSON）。但渲染必须发生在 WebView（DOM + canvas），而工具在 agent 层
 * （agent 层不得依赖 components/）——因此沿用宿主接缝模式：应用启动处注入实现，
 * agent 层只消费。
 *
 * 未注入（Node 测试、hook-only 环境）时返回 null——调用方先经 canRender* 区分，
 * 工具对「环境无渲染器」与「该次渲染失败」（ok:false + 原因）分别降级说明，
 * 不假装成功、也不把单次失败误报成环境缺陷。
 */
import type { PenDocument } from './penParser'
import type { RgbaImage } from './visualCompare'

export interface DesignPageRenderRequest {
  /** `.ax` 原文（工具已读取，避免二次 IO）。 */
  source: string
  /** 原始文件相对路径（诊断与页面名回显用）。 */
  fileName: string
  /** 页 id 或 1 起始序号。 */
  pageIdOrIndex: string | number
  /** PNG 字节预算：宿主按需降采样，仍超预算则返回 null。 */
  maxBytes: number
}

export interface DesignPageRenderResult {
  base64: string
  mediaType: 'image/png'
  /** 渲染像素尺寸（降采样后）。 */
  width: number
  height: number
  /** 使用的渲染倍率（1 为设计稿像素 1:1）。 */
  scale: number
  pageName: string
}

/** 渲染失败的显式原因：解析/挂载/光栅化/预算各环节不同——工具据此透传给模型，
 * 模型能区分「环境无渲染器」（接缝未注入）与「该次渲染失败」（可修复/可重试），
 * 一次失败不会被误记成环境的永久属性。 */
export interface DesignPageRenderFailure {
  ok: false
  reason: string
}

type Provider = (
  request: DesignPageRenderRequest,
) => Promise<DesignPageRenderResult | DesignPageRenderFailure | null>

let provider: Provider | null = null

/** 应用启动处注入（main.tsx）；传 null 可清除（测试隔离用）。 */
export const setDesignPageRenderProvider = (next: Provider | null): void => {
  provider = next
}

/** 是否具备渲染能力（工具据此决定要不要走 render 模式）。 */
export const canRenderDesignPage = (): boolean => provider !== null

/** 渲染一页；接缝未注入返回 null（调用方先经 canRenderDesignPage 区分），失败返回 ok:false + 原因。 */
export const renderDesignPage = async (
  request: DesignPageRenderRequest,
): Promise<DesignPageRenderResult | DesignPageRenderFailure | null> => {
  if (!provider) return null
  try {
    return await provider(request)
  } catch (error) {
    // 抛错归一为 ok:false + 原因：不把异常抛给模型循环，也不让「这一次为什么失败」
    // 被降级文案掩盖（与 scan 路径的 ok:false 语义对齐）。
    return { ok: false, reason: `渲染失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 扫描验证（docs/ax-format.md §4.6）的单页渲染请求：直接传**解析/投影后的
 * PenDocument**（`.pen` 解析产物与 `.ax` 投影共用同一视图模型），宿主按
 * pageIdOrIndex 挂载对应页——不做二次解析。
 */
export interface DesignScanPageRenderRequest {
  doc: PenDocument
  pageIdOrIndex: string | number
  /** 缩略图字节预算（base64 字符数上限）。 */
  maxBytes: number
}

/**
 * 扫描验证的单页渲染产物：像素统计（引擎的空白判定）+ 可选缩略图。
 * ok=false 时给 reason（页面不存在 / 无尺寸 / 光栅化失败），引擎据此记渲染失败
 * ——不再一律归 null，让「为什么没渲染出来」可读。
 */
export type DesignScanPageRenderResult = {
  ok: true
  base64?: string
  mediaType?: 'image/png'
  width: number
  height: number
  scale: number
  pageName: string
  samples?: number
  distinctColors?: number
  topColorFraction?: number
} | {
  ok: false
  reason: string
}

type ScanProvider = (
  request: DesignScanPageRenderRequest,
) => Promise<DesignScanPageRenderResult | null>

let scanProvider: ScanProvider | null = null

/** 扫描渲染的并发 lane 数：由宿主按渲染路径安全性注入（默认 1 = 串行）。 */
let scanRenderConcurrency = 1

/**
 * 是否可以并行渲染多页：capture 模式的挂载容器铺满视口（WKWebView 原生截图
 * 只能截当前视口），并行挂载会互相污染截图——native 路径必须串行（1）；
 * offscreen（视口外独立容器）并行安全（3）。main.tsx 注入 provider 处一并设置。
 */
export const setDesignScanRenderConcurrency = (lanes: number): void => {
  scanRenderConcurrency = Math.max(1, Math.min(8, Math.floor(lanes)))
}

/** 引擎据此决定 scanDesignPages 的 renderConcurrency（默认 1，串行）。 */
export const designScanRenderConcurrency = (): number => scanRenderConcurrency

/** 应用启动处注入（main.tsx）；传 null 可清除（测试隔离用）。 */
export const setDesignScanPageRenderProvider = (next: ScanProvider | null): void => {
  scanProvider = next
}

/** 是否具备扫描渲染能力（调用方据此把渲染检查标 skipped 而不是全报失败）。 */
export const canRenderDesignScanPage = (): boolean => scanProvider !== null

/**
 * 扫描验证渲染一页：成功返回像素统计与缩略图；无渲染能力返回 null（引擎据此
 * 把渲染检查标 skipped）；页面不存在/无尺寸/光栅化失败返回 ok:false + 原因。
 * 抛错同样归一为 ok:false + 原因（不是 null——那是「未回报」，而抛错是「回报了
 * 失败」），不把异常抛给扫描循环。
 */
export const renderDesignScanPage = async (
  request: DesignScanPageRenderRequest,
): Promise<DesignScanPageRenderResult | null> => {
  if (!scanProvider) return null
  try {
    return await scanProvider(request)
  } catch (error) {
    return { ok: false, reason: `渲染失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

// ---------------------------------------------------------------------------
// PNG → RGBA 解码接缝（视觉对拍用，docs/ax-format.md §4.6 可选视觉对拍）：
// 解码依赖 DOM（Image + canvas），agent 层经接缝消费；未注入（Node 测试）时
// compare 模式显式降级说明，不假装成功。
// ---------------------------------------------------------------------------

type PngDecodeProvider = (base64: string) => Promise<RgbaImage | null>

let pngDecodeProvider: PngDecodeProvider | null = null

/** 应用启动处注入（main.tsx）；传 null 可清除（测试隔离用）。 */
export const setPngDecodeProvider = (next: PngDecodeProvider | null): void => {
  pngDecodeProvider = next
}

/** 是否具备 PNG 解码能力（compare 模式据此决定可用性说明）。 */
export const canDecodePng = (): boolean => pngDecodeProvider !== null

/** 解码一张 base64 PNG；接缝未注入返回 null，解码失败由实现归一为 null。 */
export const decodePngToRgba = async (base64: string): Promise<RgbaImage | null> => {
  if (!pngDecodeProvider) return null
  return pngDecodeProvider(base64)
}
