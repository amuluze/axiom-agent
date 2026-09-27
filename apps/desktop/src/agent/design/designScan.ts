/**
 * 设计稿「页面渲染扫描验证」（docs/ax-format.md §4.6 自校验回路 / docs/design-canvas.md
 * 扫描验证节）。
 *
 * 对稿内每一页做两类检查并给出逐页判定：
 * 1. **结构检查（纯逻辑，总是可做）**：页面尺寸、空页、未知节点降级占位框、
 *    ref 指向未定义组件、归属到该页的解析诊断。
 * 2. **渲染检查（经宿主接缝，有 WebView 才可做）**：把该页离屏渲染成 PNG——
 *    渲染抛错即 fail；渲染结果「近乎空白」（绝大多数采样像素同色）即 warn——
 *    这类页面「渲染成功但什么都没画出来」，只看 JSON 永远发现不了。
 *
 * 引擎是纯函数：渲染一步以回调注入（无渲染环境时传 undefined，渲染检查显式
 * 标注 skipped 而不是假装通过）。`.pen` 与 `.ax` 投影共用同一套视图模型
 * （PenDocument），因此同一引擎服务两种格式；`.ax` 的校验诊断带 `pages[N]`
 * 路径前缀，调用方按前缀归属到页，`.pen` 的诊断没有路径则落在文档级。
 */
import type { PenDiagnostic, PenDocument, PenNodeUnion } from './penParser'

/** 单页渲染检查的结果（宿主接缝的产物；无渲染环境时整个检查 skipped）。 */
export interface DesignScanRenderOutcome {
  ok: boolean
  /** 渲染失败原因（ok=false 时给出）。 */
  reason?: string
  /** 渲染像素尺寸（成功时）。 */
  width?: number
  height?: number
  /** 采样统计：总采样数、去重颜色数、占比最高颜色的份额（0–1）。 */
  samples?: number
  distinctColors?: number
  topColorFraction?: number
}

/** 单页扫描的输入（从 PenDocument 提取，纯数据）。 */
export interface DesignScanPageInput {
  index: number
  id: string
  name: string
  width: number | null
  height: number | null
  nodeCount: number
  /** 未知节点降级占位框数（含 originalType 摘要）。 */
  unknownNodes: string[]
  /** ref 指向未定义组件的节点 id。 */
  refMissingIds: string[]
  /** 归属到该页的解析诊断（`.ax` 校验器带 path；`.pen` 为空、落文档级）。 */
  diagnostics: PenDiagnostic[]
}

export type DesignPageStatus = 'ok' | 'warn' | 'fail'

export interface DesignScanIssue {
  /** 机器可读检查名（render/blank/size/empty/placeholder/refMissing/diagnostic）。 */
  check: string
  level: 'error' | 'warning'
  message: string
}

export interface DesignScanPageVerdict {
  index: number
  id: string
  name: string
  status: DesignPageStatus
  issues: DesignScanIssue[]
  /** 渲染检查：skipped（无渲染环境）/ ok / fail。blank 属 warn，落 issues。 */
  render: 'skipped' | 'ok' | 'fail'
  /** 渲染像素尺寸（成功时）。 */
  renderWidth?: number
  renderHeight?: number
}

export interface DesignScanReport {
  pages: DesignScanPageVerdict[]
  /** 文档级诊断（`.pen` 无 path 的解析诊断等，不属于任何单页）。 */
  documentIssues: DesignScanIssue[]
  summary: { total: number; ok: number; warn: number; fail: number }
  /** 渲染检查是否参与（无宿主渲染能力时为 false，报告只含结构检查）。 */
  rendered: boolean
}

/** 单页渲染回调签名（宿主接缝实现；null = 渲染失败）。 */
export type DesignScanRenderPage = (
  page: DesignScanPageInput,
) => Promise<DesignScanRenderOutcome | null>

/** 近乎空白的判定阈值：占比最高的颜色覆盖 ≥ 99.5% 采样像素。 */
const BLANK_TOP_COLOR_FRACTION = 0.995

const walkNodes = (nodes: readonly PenNodeUnion[], visit: (node: PenNodeUnion) => void): void => {
  for (const node of nodes) {
    visit(node)
    const children = 'children' in node ? node.children : undefined
    if (children) walkNodes(children, visit)
  }
}

const pageNameOf = (page: PenNodeUnion): string =>
  'name' in page && typeof page.name === 'string' ? page.name : page.id

/**
 * 从解析后的文档提取逐页扫描输入。`.ax` 校验诊断按 `pages[N]` 前缀归属到页
 * （N 是 0 起始序号）；无路径或前缀不匹配的落文档级。
 */
export const extractScanPages = (
  doc: PenDocument,
): { pages: DesignScanPageInput[]; documentIssues: DesignScanIssue[] } => {
  const pages: DesignScanPageInput[] = doc.pages.map((page, index) => {
    const unknownNodes: string[] = []
    const refMissingIds: string[] = []
    let nodeCount = 0
    walkNodes([page], (node) => {
      nodeCount += 1
      if (node.type === 'unknown') {
        unknownNodes.push(`${node.name ?? node.id}(${node.originalType})`)
      } else if (node.type === 'ref' && node.refMissing) {
        refMissingIds.push(node.id)
      }
    })
    return {
      index: index + 1,
      id: page.id,
      name: pageNameOf(page),
      width: 'width' in page && typeof page.width === 'number' ? page.width : null,
      height: 'height' in page && typeof page.height === 'number' ? page.height : null,
      nodeCount,
      unknownNodes,
      refMissingIds,
      diagnostics: [],
    }
  })

  const documentIssues: DesignScanIssue[] = []
  for (const diagnostic of doc.diagnostics) {
    const match = /^pages\[(\d+)\]/.exec(diagnostic.path ?? '')
    const pageIndex = match ? Number.parseInt(match[1] ?? '', 10) : Number.NaN
    const issue: DesignScanIssue = { check: 'diagnostic', level: diagnostic.level, message: diagnostic.message }
    const target = Number.isNaN(pageIndex) || pageIndex < 0 || pageIndex >= pages.length
      ? undefined
      : pages[pageIndex]
    if (target) {
      target.diagnostics.push(diagnostic)
    } else {
      documentIssues.push(issue)
    }
  }
  return { pages, documentIssues }
}

/**
 * 逐页扫描进度：每页完成后回调（串行执行，UI 据此在画布上逐页点亮——
 * 当前页显示扫描光束、已完成的页按判定显示状态描边）。
 */
export interface DesignScanProgress {
  done: number
  total: number
  /** 刚完成扫描的页判定。 */
  verdict: DesignScanPageVerdict
}

/**
 * 逐页扫描。渲染按页串行（离屏挂载 + 光栅化是 DOM 重活，并行会互相拖慢）；
 * onProgress 在每页完成后回调，供 UI 显示进度与逐页点亮画布。
 *
 * requireSize 的两种口径：`.ax` 的页面按格式必须声明尺寸（缺尺寸是作者错误，
 * 判 fail）；`.pen` 的顶层 frame 允许无高度（实测 axiom.pen 的 6 条 `Section — …`
 * 组织性带——画布同样不把它们当页面渲染），此时跳过渲染检查并给 warning，
 * 不产生成片的假失败。
 */
export interface DesignScanOptions {
  requireSize?: boolean
  onProgress?: (progress: DesignScanProgress) => void
}

export const scanDesignPages = async (
  pages: readonly DesignScanPageInput[],
  documentIssues: readonly DesignScanIssue[],
  renderPage: DesignScanRenderPage | undefined,
  options: DesignScanOptions = {},
): Promise<DesignScanReport> => {
  const verdicts: DesignScanPageVerdict[] = []
  for (const page of pages) {
    const verdict = await scanSinglePage(page, renderPage, options.requireSize ?? true)
    verdicts.push(verdict)
    options.onProgress?.({ done: verdicts.length, total: pages.length, verdict })
  }

  const summary = { total: verdicts.length, ok: 0, warn: 0, fail: 0 }
  for (const verdict of verdicts) summary[verdict.status] += 1
  return { pages: verdicts, documentIssues: [...documentIssues], summary, rendered: renderPage !== undefined }
}

/** 便捷入口：从解析后的文档直接扫描（提取 + 逐页 + 文档级诊断汇入报告）。 */
export const scanDesignDocument = async (
  doc: PenDocument,
  renderPage: DesignScanRenderPage | undefined,
  options: DesignScanOptions = {},
): Promise<DesignScanReport> => {
  const { pages, documentIssues } = extractScanPages(doc)
  return scanDesignPages(pages, documentIssues, renderPage, options)
}

const scanSinglePage = async (
  page: DesignScanPageInput,
  renderPage: DesignScanRenderPage | undefined,
  requireSize: boolean,
): Promise<DesignScanPageVerdict> => {
  const issues: DesignScanIssue[] = []
  const hasSize = page.width !== null && page.height !== null && page.width > 0 && page.height > 0

  if (!hasSize) {
    if (requireSize) {
      issues.push({ check: 'size', level: 'error', message: '页面没有有效尺寸，无法渲染' })
    } else {
      issues.push({ check: 'size', level: 'warning', message: '页面无声明尺寸（组织性 frame），跳过渲染检查' })
    }
  } else if (page.nodeCount <= 1) {
    // 只有页根本身（nodeCount=1）即空页。
    issues.push({ check: 'empty', level: 'warning', message: '页面没有任何内容节点' })
  }
  if (page.unknownNodes.length > 0) {
    issues.push({
      check: 'placeholder',
      level: 'warning',
      message: `${page.unknownNodes.length} 个节点降级为占位框（${page.unknownNodes.slice(0, 3).join('、')}${page.unknownNodes.length > 3 ? ' …' : ''}）`,
    })
  }
  if (page.refMissingIds.length > 0) {
    issues.push({
      check: 'refMissing',
      level: 'warning',
      message: `${page.refMissingIds.length} 个组件引用指向未定义组件（${page.refMissingIds.slice(0, 3).join('、')}）`,
    })
  }
  for (const diagnostic of page.diagnostics) {
    issues.push({ check: 'diagnostic', level: diagnostic.level, message: diagnostic.message })
  }

  // 渲染检查：无渲染环境时 skipped（结构检查兜底）；无尺寸页面按 requireSize
  // 口径处理——`.pen` 的组织性 frame 跳过渲染，`.ax` 的缺尺寸页直接 fail。
  let render: DesignScanPageVerdict['render'] = 'skipped'
  let renderWidth: number | undefined
  let renderHeight: number | undefined
  if (renderPage !== undefined && hasSize) {
    const outcome = await renderPage(page).catch(() => null)
    if (outcome?.ok !== true) {
      render = 'fail'
      issues.push({
        check: 'render',
        level: 'error',
        message: `渲染失败：${outcome?.ok === false ? outcome.reason : '渲染器不可用或超时'}`,
      })
    } else {
      render = 'ok'
      renderWidth = outcome.width
      renderHeight = outcome.height
      const fraction = outcome.topColorFraction
      if (fraction !== undefined && fraction >= BLANK_TOP_COLOR_FRACTION) {
        issues.push({
          check: 'blank',
          level: 'warning',
          message: `渲染结果近乎空白（${(fraction * 100).toFixed(1)}% 像素为同一颜色${
            outcome.distinctColors !== undefined ? `，共 ${outcome.distinctColors} 种颜色` : ''
          }）`,
        })
      }
    }
  }

  const status: DesignPageStatus = issues.some((issue) => issue.level === 'error')
    ? 'fail'
    : issues.length > 0 ? 'warn' : 'ok'
  return { index: page.index, id: page.id, name: page.name, status, issues, render, renderWidth, renderHeight }
}
