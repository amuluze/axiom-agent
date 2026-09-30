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
  /** 非空文本节点数（blank 误报防御的交叉核验信号）。 */
  textNodes: number
  /** 未知节点降级占位框数（含 originalType 摘要）。 */
  unknownNodes: string[]
  /** ref 指向未定义组件的节点 id。 */
  refMissingIds: string[]
  /** 归属到该页的解析诊断（`.ax` 校验器带 path；`.pen` 为空、落文档级）。 */
  diagnostics: PenDiagnostic[]
}

export type DesignPageStatus = 'ok' | 'warn' | 'fail'

export interface DesignScanIssue {
  /** 机器可读检查名（render/blank/blankSparse/size/empty/placeholder/refMissing/diagnostic）。 */
  check: string
  /** info 不影响页状态（供参考的核验结论，如稀疏文本页的 blank 疑似误报）。 */
  level: 'error' | 'warning' | 'info'
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
    let textNodes = 0
    walkNodes([page], (node) => {
      nodeCount += 1
      if (node.type === 'unknown') {
        unknownNodes.push(`${node.name ?? node.id}(${node.originalType})`)
      } else if (node.type === 'ref' && node.refMissing) {
        refMissingIds.push(node.id)
      }
      if (node.type === 'text' && typeof node.content === 'string' && node.content.trim() !== '') {
        textNodes += 1
      }
    })
    return {
      index: index + 1,
      id: page.id,
      name: pageNameOf(page),
      width: 'width' in page && typeof page.width === 'number' ? page.width : null,
      height: 'height' in page && typeof page.height === 'number' ? page.height : null,
      nodeCount,
      textNodes,
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
 * 逐页扫描。渲染默认逐页串行；renderConcurrency > 1 时有界并发（仅对并行安全的
 * 渲染路径开放——offscreen 独立容器，见 DesignScanOptions）。onProgress 始终按
 * 页序在每页判定就绪时回调，供 UI 显示进度与逐页点亮画布；onActive 显式回报
 * 在途页集合（串行 = 单元素，并发 = 已开始未完成的页）。
 *
 * requireSize 的两种口径：`.ax` 的页面按格式必须声明尺寸（缺尺寸是作者错误，
 * 判 fail）；`.pen` 的顶层 frame 允许无高度（实测 axiom.pen 的 6 条 `Section — …`
 * 组织性带——画布同样不把它们当页面渲染），此时跳过渲染检查并给 warning，
 * 不产生成片的假失败。
 */
export interface DesignScanOptions {
  requireSize?: boolean
  onProgress?: (progress: DesignScanProgress) => void
  /** 批量扫描：在途页集合变化（null = 无在途；画布据此显示多页扫描光束）。 */
  onActive?: (pageIds: readonly string[] | null) => void
  /**
   * 渲染并发 lane 数（默认 1 = 逐页串行；上限 8）。判定与进度**始终按页序**产出，
   * 与并发无关。是否可以并行由宿主渲染路径决定——例如 capture 模式的挂载容器
   * 铺满视口（WKWebView 原生截图的前提），并行挂载会互相污染截图，必须传 1；
   * offscreen（视口外独立容器）并行安全。
   */
  renderConcurrency?: number
}

export const scanDesignPages = async (
  pages: readonly DesignScanPageInput[],
  documentIssues: readonly DesignScanIssue[],
  renderPage: DesignScanRenderPage | undefined,
  options: DesignScanOptions = {},
): Promise<DesignScanReport> => {
  const concurrency = Math.max(1, Math.min(8, options.renderConcurrency ?? 1))
  const requireSize = options.requireSize ?? true
  const outcomes: (DesignScanPageVerdict | undefined)[] = new Array(pages.length).fill(undefined)

  if (!renderPage || concurrency === 1) {
    // 串行路径：在途页经 onActive 显式回报（与批量路径同一契约，不依赖
    // 「onProgress 计数 = 下标」的隐式推导）。
    for (const [index, page] of pages.entries()) {
      options.onActive?.([page.id])
      const verdict = await scanSinglePage(page, renderPage, requireSize)
      outcomes[index] = verdict
      options.onProgress?.({ done: index + 1, total: pages.length, verdict })
    }
    options.onActive?.(null)
  } else {
    // 并发路径：有界 lane 渲染（offscreen 容器各自独立），判定按页序产出——
    // onProgress 语义与串行一致（第 N 次回报 = 页序第 N 页），消费方无需感知并发。
    let cursor = 0
    const active = new Set<string>()
    let emitted = 0
    const emitOrdered = (): void => {
      while (emitted < pages.length && outcomes[emitted] !== undefined) {
        const verdict = outcomes[emitted]!
        emitted += 1
        options.onProgress?.({ done: emitted, total: pages.length, verdict })
      }
    }
    const worker = async (): Promise<void> => {
      while (cursor < pages.length) {
        const index = cursor
        cursor += 1
        const page = pages[index]!
        active.add(page.id)
        options.onActive?.([...active])
        outcomes[index] = await scanSinglePage(page, renderPage, requireSize)
        active.delete(page.id)
        options.onActive?.([...active])
        emitOrdered()
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, pages.length) }, () => worker()),
    )
    options.onActive?.(null)
  }

  const verdicts = outcomes.map((verdict) => verdict!)
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

/** 单页的**结构**检查（无渲染）；批量扫描先做结构检查、渲染判定随后逐页合入。 */
export const structureIssuesOf = (page: DesignScanPageInput, requireSize: boolean): DesignScanIssue[] => {
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
  return issues
}

/** 结构问题 + 渲染判定 → 页级判定（两条路径共用）。 */
const verdictOf = (
  page: DesignScanPageInput,
  issues: readonly DesignScanIssue[],
  render: DesignScanPageVerdict['render'],
  outcome: DesignScanRenderOutcome | undefined,
  renderWidth?: number,
  renderHeight?: number,
): DesignScanPageVerdict => {
  const all = [...issues]
  if (outcome?.ok === false) {
    all.push({ check: 'render', level: 'error', message: `渲染失败：${outcome.reason ?? '渲染器不可用'}` })
  }
  const fraction = outcome?.topColorFraction
  if (outcome?.ok === true && fraction !== undefined && fraction >= BLANK_TOP_COLOR_FRACTION) {
    // 交叉核验：页面树有非空文本节点时，「近乎空白」大概率是稀疏文本页的形态
    // （深底一行小字的像素占比可 < 0.5%），降为 info 不阻断全绿门禁；无文本
    // 节点的页仍按 warning 处理（图形页画空了是真实问题）。
    if (page.textNodes > 0) {
      all.push({
        check: 'blankSparse',
        level: 'info',
        message: `渲染近乎空白（${(fraction * 100).toFixed(1)}% 像素同色），但页面树有 ${page.textNodes} 个文本节点——稀疏文本页的常见形态，疑似误报；需确认用 mode=render 单页渲染自查`,
      })
    } else {
      all.push({
        check: 'blank',
        level: 'warning',
        message: `渲染结果近乎空白（${(fraction * 100).toFixed(1)}% 像素为同一颜色${
          outcome.distinctColors !== undefined ? `，共 ${outcome.distinctColors} 种颜色` : ''
        }）`,
      })
    }
  }
  const status: DesignPageStatus = all.some((issue) => issue.level === 'error')
    ? 'fail'
    : all.some((issue) => issue.level === 'warning') ? 'warn' : 'ok'
  return {
    index: page.index,
    id: page.id,
    name: page.name,
    status,
    issues: all,
    render,
    ...(renderWidth !== undefined ? { renderWidth } : {}),
    ...(renderHeight !== undefined ? { renderHeight } : {}),
  }
}

/**
 * 批量扫描（画布原位扫描的引擎侧）：结构检查先做（纯逻辑），渲染交给调用方的
 * **批量渲染器**——它一次拿到全部待渲染页，自行决定并行/分组策略（画布扫掠 =
 * 相机按行推进 + 并行矩形截图），每页完成时经 onPageDone 回报，引擎即时产出
 * 判定与进度（画布逐页点亮不等待整批结束）。
 *
 * 批量渲染器**必须**对每个待渲染页回报一次；未回报（扫描被中断等）的页记
 * warning「渲染检查未完成」而不是 fail——中断不应伪装成页面错误。
 */
export type DesignScanBatchRenderPage = (
  pages: readonly DesignScanPageInput[],
  onPageDone: (pageId: string, outcome: DesignScanRenderOutcome) => void,
  onActive: (pageIds: readonly string[] | null) => void,
) => Promise<void>

export const scanDesignPagesBatch = async (
  pages: readonly DesignScanPageInput[],
  documentIssues: readonly DesignScanIssue[],
  batchRender: DesignScanBatchRenderPage,
  options: DesignScanOptions = {},
): Promise<DesignScanReport> => {
  const requireSize = options.requireSize ?? true
  const verdicts = new Map<string, DesignScanPageVerdict>()
  const structureByid = new Map<string, DesignScanIssue[]>()
  const renderable: DesignScanPageInput[] = []
  for (const page of pages) {
    const issues = structureIssuesOf(page, requireSize)
    structureByid.set(page.id, issues)
    const hasSize = page.width !== null && page.height !== null && page.width > 0 && page.height > 0
    if (hasSize) renderable.push(page)
    else verdicts.set(page.id, verdictOf(page, issues, 'skipped', undefined))
  }

  let done = verdicts.size
  const complete = (page: DesignScanPageInput, outcome?: DesignScanRenderOutcome) => {
    if (verdicts.has(page.id)) return
    const issues = [...structureByid.get(page.id) ?? []]
    let render: DesignScanPageVerdict['render']
    if (outcome === undefined) {
      // 批量渲染器未回报（中断/漏报）：skipped + warning，不伪装成通过或失败。
      render = 'skipped'
      issues.push({ check: 'render', level: 'warning', message: '渲染检查未完成（扫描中断）' })
    } else {
      render = outcome.ok ? 'ok' : 'fail'
    }
    const verdict = verdictOf(page, issues, render, outcome, outcome?.width, outcome?.height)
    verdicts.set(page.id, verdict)
    done += 1
    options.onProgress?.({ done, total: pages.length, verdict })
  }

  await batchRender(
    renderable,
    (pageId, outcome) => {
      const page = renderable.find((item) => item.id === pageId)
      if (page) complete(page, outcome)
    },
    (pageIds) => options.onActive?.(pageIds),
  )
  // 批量渲染器未回报的页（中断/漏报）：skipped + warning，不伪装成通过或失败。
  for (const page of renderable) complete(page)

  const ordered = pages.map((page) => verdicts.get(page.id)!).filter(Boolean)
  const summary = { total: ordered.length, ok: 0, warn: 0, fail: 0 }
  for (const verdict of ordered) summary[verdict.status] += 1
  return { pages: ordered, documentIssues: [...documentIssues], summary, rendered: true }
}

/**
 * 串行单页扫描（staging 回退路径）：结构检查与判定合成**复用批量路径的纯函数**
 * （`structureIssuesOf`/`verdictOf`）——同一份检查规则只存在一份实现，改规则不会
 * 出现单页/批量口径漂移。渲染回调抛错按「渲染器不可用或超时」合成失败结果。
 */
const scanSinglePage = async (
  page: DesignScanPageInput,
  renderPage: DesignScanRenderPage | undefined,
  requireSize: boolean,
): Promise<DesignScanPageVerdict> => {
  const issues = structureIssuesOf(page, requireSize)
  const hasSize = page.width !== null && page.height !== null && page.width > 0 && page.height > 0
  // 渲染检查：无渲染环境时 skipped（结构检查兜底）；无尺寸页面按 requireSize
  // 口径处理——`.pen` 的组织性 frame 跳过渲染，`.ax` 的缺尺寸页直接 fail。
  let render: DesignScanPageVerdict['render'] = 'skipped'
  let outcome: DesignScanRenderOutcome | undefined
  if (renderPage !== undefined && hasSize) {
    const result = await renderPage(page).catch(() => null)
    if (result?.ok === true) {
      render = 'ok'
      outcome = result
    } else {
      render = 'fail'
      outcome = {
        ok: false,
        reason: result?.ok === false ? result.reason : '渲染器不可用或超时',
      }
    }
  }
  return verdictOf(page, issues, render, outcome, outcome?.width, outcome?.height)
}
