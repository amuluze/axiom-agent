/**
 * 设计页渲染的宿主接缝（docs/ax-format.md §4.6「渲染回读」）。
 *
 * `design_query` 的 render 模式要把**整页渲染成 PNG** 回给模型自查（模型看像素，
 * 而不只是看 JSON）。但渲染必须发生在 WebView（DOM + canvas），而工具在 agent 层
 * （agent 层不得依赖 components/）——因此沿用宿主接缝模式：应用启动处注入实现，
 * agent 层只消费。
 *
 * 未注入（Node 测试、hook-only 环境）或渲染失败时返回 null——**工具据此显式降级**
 * 为「仅规格、无渲染图」并在文本里说明原因，不假装成功。
 */
import type { PenDocument } from './penParser'

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

type Provider = (request: DesignPageRenderRequest) => Promise<DesignPageRenderResult | null>

let provider: Provider | null = null

/** 应用启动处注入（main.tsx）；传 null 可清除（测试隔离用）。 */
export const setDesignPageRenderProvider = (next: Provider | null): void => {
  provider = next
}

/** 是否具备渲染能力（工具据此决定要不要走 render 模式）。 */
export const canRenderDesignPage = (): boolean => provider !== null

/** 渲染一页；无渲染能力或渲染失败返回 null。 */
export const renderDesignPage = async (
  request: DesignPageRenderRequest,
): Promise<DesignPageRenderResult | null> => {
  if (!provider) return null
  try {
    return await provider(request)
  } catch {
    // 渲染失败一律归一为 null：工具据此显式降级，不把异常抛给模型循环。
    return null
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

/** 应用启动处注入（main.tsx）；传 null 可清除（测试隔离用）。 */
export const setDesignScanPageRenderProvider = (next: ScanProvider | null): void => {
  scanProvider = next
}

/** 是否具备扫描渲染能力（调用方据此把渲染检查标 skipped 而不是全报失败）。 */
export const canRenderDesignScanPage = (): boolean => scanProvider !== null

/**
 * 扫描验证渲染一页：成功返回像素统计与缩略图；无渲染能力返回 null（引擎据此
 * 把渲染检查标 skipped）；页面不存在/无尺寸/光栅化失败返回 ok:false + 原因。
 * 抛错统一归一为 null，不把异常抛给扫描循环。
 */
export const renderDesignScanPage = async (
  request: DesignScanPageRenderRequest,
): Promise<DesignScanPageRenderResult | null> => {
  if (!scanProvider) return null
  try {
    return await scanProvider(request)
  } catch {
    return null
  }
}
