/**
 * `design_query` 各 mode 的实现（从 tools/designQueryTool.ts 拆出）：
 * 工具文件只保留「契约（schema/validate/描述）+ 分发」，mode 的 payload 组装
 * 全部在本文件——每个 mode 一个显式入参的函数，互不共享闭包状态。
 *
 * 纯移动重构：payload 形状、预算截断、错误文案逐字保持（行为由
 * designQueryTool.test.ts 的 60+ 用例锁死）；本文件列入 `tool:design_query`
 * 的语义 digest sourceFiles，改动后需 `npm run sync:semantic-digests`。
 */
import type { AgentToolResult, JsonValue } from '../core/types'
import { UNSUPPORTED_IMAGE_NOTE } from '../core/stripUnsupportedImages'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { parsePenDocument, type PenDocument, type PenNodeUnion } from '@/agent/design/penParser'
import { parseAxDocument, projectAxToPenDocument } from '@/agent/design/axParser'
import type { AxDiagnostic, AxDocument, AxNode } from '@/agent/design/axSchema'
import {
  designComponentDetail,
  type DesignComponentDetail,
  type DesignComponentSummary,
} from '@/agent/design/componentInventoryHost'
import {
  canDecodePng,
  canRenderDesignPage,
  canRenderDesignScanPage,
  decodePngToRgba,
  designScanRenderConcurrency,
  renderDesignPage,
  renderDesignScanPage,
} from '@/agent/design/designRenderHost'
import {
  COMPARE_PASS_RATIO,
  PIXEL_THRESHOLD,
  compareRgba,
  compareVerdictOf,
  scaleRgba,
} from '@/agent/design/visualCompare'
import { extractScanPages, scanDesignPages, type DesignScanRenderPage } from '@/agent/design/designScan'
import { emitAxPageToTsx } from '@/agent/design/emitPage'
import { extractComponentUsage } from '@/agent/design/implementationUsage'
import type { WorkspaceEntry } from '@/platform/workspace'

/** render 模式的图片预算（base64 字符数上限）：默认 512KiB，上限 2MiB。 */
export const DEFAULT_IMAGE_MAX_BYTES = 512 * 1024
export const MAX_IMAGE_MAX_BYTES = 2 * 1024 * 1024
/** scan 模式的单张缩略图预算（32KiB ≈ 几千 token——逐页扫描必须控制上下文体积）。 */
export const DEFAULT_SCAN_THUMBNAIL_BYTES = 32 * 1024
/** scan 模式最多回传的缩略图张数（只给 warn 页；fail 页没有图，ok 页不需要看）。 */
const MAX_SCAN_THUMBNAILS = 4

/** CSS 自定义属性声明的提取（token ↔ 实现样式表一致性核对用）。 */
const CSS_VAR_DECLARATION_PATTERN = /--([a-zA-Z0-9_-]+)\s*:/g

/** missingInCss 清单的回传上限（超出的只给计数，不撑爆输出预算）。 */
const MAX_MISSING_TOKENS_LISTED = 20

/**
 * 按字节预算截断 UTF-8 文本：json.length 是 UTF-16 code unit，CJK 实际字节
 * 可达 3 倍，按 length 切既超预算又可能切断多字节字符。回退到码点边界，
 * 避免解码出 U+FFFD 替换符。
 */
export const truncateToByteBudget = (text: string, maxBytes: number): { content: string; truncated: boolean } => {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= maxBytes) return { content: text, truncated: false }
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  const slice = new TextDecoder().decode(bytes.subarray(0, end))
  return { content: `${slice}\n...[truncated at ${maxBytes} bytes]`, truncated: true }
}

/** 设计稿文件判定：`.pen`（导入源）与 `.ax`（自有格式）。 */
export const isDesignFile = (path: string): boolean => /\.(pen|ax)$/i.test(path)

export const isAxFile = (path: string): boolean => /\.ax$/i.test(path)

/** 页名（`.pen` 的视图模型里页根可能是 component/part 节点，统一走 in 窄化）。 */
export const pageNameOf = (page: PenNodeUnion): string =>
  'name' in page && typeof page.name === 'string' ? page.name : page.id

/** 深度优先查找含 nodeId 的子树（含 ref 解析后的 children）。 */
export const findNode = (nodes: readonly PenNodeUnion[], nodeId: string): PenNodeUnion | undefined => {
  for (const node of nodes) {
    if (node.id === nodeId) return node
    const children = 'children' in node ? node.children : undefined
    if (children) {
      const hit = findNode(children, nodeId)
      if (hit) return hit
    }
  }
  return undefined
}

/**
 * `.ax` 的 token 引用收集：扫树里所有 `$name` 字符串（含渐变色标的 color），
 * 用于「把 token 解析成明暗两档字面值」随页返回。
 */
export const collectTokenRefs = (value: unknown, into: Set<string>): void => {
  if (typeof value === 'string') {
    if (value.startsWith('$') && value.length > 1) into.add(value.slice(1))
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item) => {
      collectTokenRefs(item, into)
    })
    return
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => {
      collectTokenRefs(item, into)
    })
  }
}

/** `.ax` 树的节点计数与「保留前 N 个」切片（超预算时按节点收口，绝不静默）。 */
export const countAxNodes = (nodes: readonly AxNode[]): number =>
  nodes.reduce((total, node) => total + 1 + countAxNodes(node.children ?? []), 0)

export const takeAxNodes = (nodes: readonly AxNode[], budget: { left: number }): AxNode[] => {
  const kept: AxNode[] = []
  for (const node of nodes) {
    if (budget.left <= 0) break
    budget.left -= 1
    kept.push({ ...node, ...(node.children ? { children: takeAxNodes(node.children, budget) } : {}) })
  }
  return kept
}

/** 页里用到的组件名（去重、按出现顺序）。 */
export const axComponentsUsed = (nodes: readonly AxNode[], into: string[]): string[] => {
  for (const node of nodes) {
    if (node.kind === 'component' && node.name && !into.includes(node.name)) into.push(node.name)
    if (node.children) axComponentsUsed(node.children, into)
    if (node.slot) axComponentsUsed(node.slot, into)
  }
  return into
}

/**
 * `.ax` tokens ↔ 实现样式表的一致性核对（B5）：`$name` 在实现侧落到 `var(--name)`，
 * 稿里声明而样式表没有同名变量的 token 会让「设计稿引用 → 实现接线」断链。
 * 这是**建议性**报告（设计系统的度量 token 不必然有 CSS 变量对应），不产生页级
 * fail/warn 判定；由调用方显式传 `tokensCss` 才参与（不同工作区的样式表路径不同）。
 */
export const tokenParityOf = (
  tokens: Record<string, unknown>,
  cssFile: string,
  cssText: string,
): JsonValue => {
  const cssVars = new Set<string>()
  for (const match of cssText.matchAll(CSS_VAR_DECLARATION_PATTERN)) cssVars.add(match[1] ?? '')
  cssVars.delete('')
  const names = Object.keys(tokens).sort()
  const missing = names.filter((name) => !cssVars.has(name))
  return {
    cssFile,
    cssVariables: cssVars.size,
    tokens: names.length,
    missingCount: missing.length,
    missingInCss: missing.slice(0, MAX_MISSING_TOKENS_LISTED),
    ...(missing.length > MAX_MISSING_TOKENS_LISTED
      ? { note: `另有 ${missing.length - MAX_MISSING_TOKENS_LISTED} 个未列出` }
      : {}),
  }
}

/** mode=reconcile 的实现文件收集上限：递归深度、文件数、单目录 list 上限。
 * 文件数上限按「真实单仓前端源码（含测试）可达数百文件」定档——太小会让
 * 整目录对账必然触顶、missingInImplementation 对未扫文件失真（本仓实测
 * apps/desktop/src 含测试 578 个 .ts/.tsx）。触顶时报告 fileCapReached=true，
 * 模型按提示词收窄 roots 分批重跑。 */
const RECONCILE_MAX_DEPTH = 6
const RECONCILE_MAX_FILES = 800
const RECONCILE_LIST_LIMIT = 1000
/** 目录递归时跳过的非实现目录（构建产物/依赖/测试快照）。 */
const RECONCILE_SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'build', 'coverage', 'artifacts'])

/**
 * mode=reconcile 的实现文件收集：根路径为 .ts/.tsx 文件时直接收录，否则按目录
 * 递归（BFS）收集 .ts/.tsx。跳过的目录与触及的文件上限都在结果里显式给出——
 * 对账报告的结论只对「实际扫过的文件集」负责，不静默缩窄。
 */
export const collectReconcileFiles = async (
  environment: AgentEnvironment,
  roots: readonly string[],
): Promise<{ files: string[]; directoriesSkipped: string[]; fileCapReached: boolean }> => {
  const files: string[] = []
  const directoriesSkipped: string[] = []
  const seen = new Set<string>()
  let fileCapReached = false
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (fileCapReached || depth > RECONCILE_MAX_DEPTH) return
    let entries: WorkspaceEntry[]
    try {
      entries = (await environment.workspace.list(directory, RECONCILE_LIST_LIMIT)).entries
    } catch {
      directoriesSkipped.push(directory)
      return
    }
    for (const entry of entries) {
      if (fileCapReached) return
      if (entry.kind === 'directory') {
        if (RECONCILE_SKIP_DIRS.has(entry.name)) {
          directoriesSkipped.push(entry.path)
          continue
        }
        await visit(entry.path, depth + 1)
      } else if (/\.(ts|tsx)$/.test(entry.name) && !seen.has(entry.path)) {
        if (files.length >= RECONCILE_MAX_FILES) {
          fileCapReached = true
          return
        }
        seen.add(entry.path)
        files.push(entry.path)
      }
    }
  }
  for (const root of roots) {
    if (/\.(ts|tsx)$/.test(root)) {
      if (!seen.has(root)) {
        seen.add(root)
        files.push(root)
      }
      continue
    }
    await visit(root, 0)
  }
  return { files, directoriesSkipped, fileCapReached }
}

/**
 * `.ax` 各 mode 的共享上下文：分发层装配一次，mode 实现只读。
 * `source` 供 render 模式重走解析渲染链（与画布同一入口）。
 */
export interface AxModeContext {
  file: string
  sha256: string
  source: string
  axDoc: AxDocument
  diagnostics: readonly AxDiagnostic[]
  inventory: readonly DesignComponentSummary[]
  maxBytes: number
  /**
   * 当前模型是否接受图片输入（由 toolExecution 从 model.input 推导后透传）。
   * 显式 false 时产图 mode 必须降级为文字说明——目录外自定义模型一律按 false
   * 传（见 ProviderRegistry.resolveModel），不把模型读不懂的图塞进请求。
   */
  modelAcceptsImage?: boolean
}

/**
 * 非视觉模型的产图降级说明：图片内容块对读不懂它的模型只是废负载（部分
 * provider 直接 400），显式降级并保留文字侧全部信息，比假装出图更可用。
 * 与请求侧降级共用同一占位子串（Domain 不变量 4：措辞跨工具/跨请求一致，
 * 模型据此能区分「我看不到图」与「图里没有内容」），且不泄漏内部字段名。
 */
const IMAGE_UNSUPPORTED_NOTE = `${UNSUPPORTED_IMAGE_NOTE}。这是模型能力所限（当前模型不接受图片输入），不是环境没有渲染能力；需要视觉自查请切换到视觉模型。`

/** 组件名清单 → 注册表摘要子集（page/node/render 模式的「该页组件契约」）。 */
const inventoryOf = (
  inventory: readonly DesignComponentSummary[],
  names: readonly string[],
): DesignComponentSummary[] => inventory.filter((entry) => names.includes(entry.name))

/** 子树引用到的 token → 明暗两档字面值（`.ax` 读取路径「全解析」承诺的落点）。 */
const tokensOf = (
  axDoc: AxDocument,
  tree: readonly AxNode[],
): Record<string, { light: string; dark: string }> => {
  const names = new Set<string>()
  collectTokenRefs(tree, names)
  const out: Record<string, { light: string; dark: string }> = {}
  for (const name of [...names].sort()) {
    const token = axDoc.tokens[name]
    if (!token) continue
    const value = token.$value
    out[name] = typeof value === 'string' ? { light: value, dark: value } : { light: value.light, dark: value.dark }
  }
  return out
}

/** ── component：单组件契约详单（与具体稿件无关，file 可省）────────────────── */
export const executeComponentMode = (
  name: string,
  inventory: readonly DesignComponentSummary[],
  maxBytes: number,
): AgentToolResult => {
  const available = inventory.map((entry) => entry.name).sort()
  const detail: DesignComponentDetail | null = designComponentDetail(name)
  if (!detail) {
    const summary = inventory.find((entry) => entry.name === name)
    if (!summary) {
      return {
        content: available.length > 0
          ? `design_query: component ${JSON.stringify(name)} not found in the component registry. Available: ${available.join(', ')}.`
          : `design_query: component ${JSON.stringify(name)} not found: the component inventory is empty (host seam not injected in this environment).`,
        details: { mode: 'component', found: false },
      }
    }
    // 有清单但详单接缝未注入：回萘认证过的摘要（无 statics/fixture 形状），不假装完整。
    const payload = {
      mode: 'component' as const,
      component: {
        summary,
        statics: [] as string[],
        fixtures: {} as Record<string, never>,
        note: '详单接缝未注入：无 statics 与 fixture 数据形状；props 契约以清单摘要为准',
      },
    }
    const { content, truncated } = truncateToByteBudget(JSON.stringify(payload, null, 2), maxBytes)
    return {
      content,
      details: { mode: 'component', found: true, source: 'inventory-summary', truncated },
    }
  }
  const { content, truncated } = truncateToByteBudget(
    JSON.stringify({ mode: 'component' as const, component: detail }, null, 2),
    maxBytes,
  )
  return { content, details: { mode: 'component', found: true, truncated } }
}

/** scan 模式的缩略图缓存条目（渲染成功时随像素统计一起拿到）。 */
interface ScanThumbnail {
  base64: string
  pageName: string
}

/**
 * mode=scan：对整份稿（或单页）做「结构检查 + 逐页离屏渲染」的扫描验证
 * （docs/ax-format.md §4.6 自校验回路）。两种格式共用：`.ax` 先投影成视图模型，
 * `.pen` 直接用解析产物——渲染与检查都发生在同一套 PenDocument 上。
 * 缩略图只随 warn 页回传（fail 页没有图，ok 页不需要看），张数与单张预算受限，
 * 避免逐页扫描把上下文撑爆。
 *
 * `componentInventory` 传给解析器做注册表核对（空表 = 不核对）；
 * `tokensCss` 是可选的实现样式表（读取失败带原因，报告仍照常产出）。
 */
export const executeScan = async (
  source: string,
  input: { file: string; page?: string | number; maxBytes?: number; imageMaxBytes?: number; modelAcceptsImage?: boolean },
  sha256: string,
  options: {
    componentInventory: DesignComponentSummary[]
    tokensCss?: { file: string; content: string } | { file: string; error: string }
  },
): Promise<AgentToolResult> => {
  const isAx = isAxFile(input.file)
  let doc: PenDocument
  let axTokens: Record<string, unknown> | undefined
  if (isAx) {
    const parsed = parseAxDocument(source, {
      ...(options.componentInventory.length > 0 ? { componentInventory: options.componentInventory } : {}),
    })
    if (!parsed.document) {
      const detail = parsed.error
        ?? parsed.diagnostics
          .filter((item) => item.level === 'error')
          .map((item) => `- ${item.path ?? '?'}: ${item.message}`)
          .join('\n')
      return {
        content: `design_query: failed to validate ${input.file}:\n${detail}`,
        details: { file: input.file, sha256, parsed: false },
      }
    }
    doc = projectAxToPenDocument(parsed.document, input.file).document!
    axTokens = parsed.document.tokens
  } else {
    const parsed = parsePenDocument(source, input.file)
    if (!parsed.document) {
      return {
        content: `design_query: failed to parse ${input.file}: ${parsed.error ?? 'unknown parse error'}`,
        details: { file: input.file, sha256, parsed: false },
      }
    }
    doc = parsed.document
  }

  const { pages, documentIssues } = extractScanPages(doc)

  // 可选单页扫描：页名 / 页 id / 1 起始序号。
  let targets = pages
  if (input.page !== undefined) {
    const pageInput = input.page
    targets = pages.filter((page) =>
      typeof pageInput === 'number'
        ? page.index === pageInput
        : page.name === pageInput || page.id === pageInput)
    if (targets.length === 0) {
      const names = pages.map((page) => `${page.index}:${page.name}`)
      return {
        content: `design_query: page ${JSON.stringify(String(pageInput))} not found in ${input.file}. Pages: ${names.join(', ')}.`,
        details: { file: input.file, sha256, parsed: true, found: false },
      }
    }
  }

  // 无渲染能力（Node 测试 / 接缝未注入）时渲染检查整体 skipped——报告只含结构检查。
  const thumbnails = new Map<string, ScanThumbnail>()
  const renderPage: DesignScanRenderPage | undefined = canRenderDesignScanPage()
    ? async (page) => {
      const result = await renderDesignScanPage({
        doc,
        pageIdOrIndex: page.id,
        maxBytes: typeof input.imageMaxBytes === 'number' ? input.imageMaxBytes : DEFAULT_SCAN_THUMBNAIL_BYTES,
      })
      if (!result) return null
      if (!result.ok) return { ok: false, reason: result.reason }
      // 非视觉模型不保留缩略图：离屏渲染的空白检测结论照常回传，只有图本身丢弃。
      if (result.base64 && input.modelAcceptsImage !== false) {
        thumbnails.set(page.id, { base64: result.base64, pageName: result.pageName })
      }
      return {
        ok: true,
        width: result.width,
        height: result.height,
        samples: result.samples,
        distinctColors: result.distinctColors,
        topColorFraction: result.topColorFraction,
      }
    }
    : undefined

  const report = await scanDesignPages(targets, documentIssues, renderPage, {
    // `.ax` 的页面按格式必须声明尺寸；`.pen` 的无高度顶层 frame 是组织性带（正常形态）。
    requireSize: isAx,
    // 渲染并发度由宿主按光栅化路径注入（native capture 挂载铺满视口必须串行=1，
    // offscreen 独立容器并行安全）——引擎保证判定与进度始终按页序，消费方无感。
    renderConcurrency: designScanRenderConcurrency(),
  })

  // token ↔ 实现样式表一致性（仅 .ax；建议性报告，不产生页级判定）。
  const tokenParity: JsonValue | undefined = (() => {
    if (!axTokens || !options.tokensCss) return undefined
    if ('error' in options.tokensCss) {
      return { available: false, cssFile: options.tokensCss.file, reason: options.tokensCss.error }
    }
    return tokenParityOf(axTokens, options.tokensCss.file, options.tokensCss.content)
  })()

  const payload = {
    file: input.file,
    format: isAx ? 'ax' : 'pen',
    mode: 'scan' as const,
    rendered: report.rendered,
    summary: report.summary,
    pages: report.pages.map((page) => ({
      index: page.index,
      id: page.id,
      name: page.name,
      status: page.status,
      render: page.render,
      ...(page.renderWidth !== undefined ? { renderWidth: page.renderWidth, renderHeight: page.renderHeight } : {}),
      issues: page.issues,
    })),
    ...(report.documentIssues.length > 0 ? { documentIssues: report.documentIssues } : {}),
    ...(tokenParity !== undefined ? { tokenParity } : {}),
    ...(input.modelAcceptsImage === false ? { imageNote: IMAGE_UNSUPPORTED_NOTE } : {}),
  }
  const maxBytes = typeof input.maxBytes === 'number' ? input.maxBytes : 16384
  const { content, truncated } = truncateToByteBudget(JSON.stringify(payload, null, 2), maxBytes)

  // 缩略图：warn 页按页序取前 N 张（fail 页渲染不出图；ok 页没有看的必要）。
  const warnPagesWithImage = report.pages
    .filter((page) => page.status === 'warn' && thumbnails.has(page.id))
    .slice(0, MAX_SCAN_THUMBNAILS)
  if (warnPagesWithImage.length === 0) {
    return {
      content,
      details: {
        file: input.file,
        sha256,
        format: isAx ? 'ax' : 'pen',
        mode: 'scan',
        summary: report.summary,
        truncated,
        thumbnails: 0,
      },
    }
  }
  return {
    content,
    contentBlocks: [
      { type: 'text', text: content },
      ...warnPagesWithImage.map((page) => {
        const thumb = thumbnails.get(page.id)!
        return {
          type: 'image' as const,
          source: { type: 'base64' as const, mediaType: 'image/png' as const, data: thumb.base64 },
        }
      }),
    ],
    details: {
      file: input.file,
      sha256,
      format: isAx ? 'ax' : 'pen',
      mode: 'scan',
      summary: report.summary,
      truncated,
      thumbnails: warnPagesWithImage.length,
    },
  }
}

/** ── .ax summary：页清单 + 组件清单 + token 清单 ──────────────────────────── */
export const executeAxSummaryMode = (context: AxModeContext): AgentToolResult => {
  const { axDoc, inventory, maxBytes } = context
  const pages = axDoc.pages.map((page, index) => ({
    index: index + 1,
    id: page.id,
    name: page.name ?? page.id,
    ...(page.group !== undefined ? { group: page.group } : {}),
    ...(page.state !== undefined ? { state: page.state } : {}),
    width: page.width ?? null,
    height: page.height ?? null,
    nodes: countAxNodes(page.tree),
    components: axComponentsUsed(page.tree, []),
  }))
  const payload = {
    file: context.file,
    format: `ax@${axDoc.ax}`,
    mode: 'summary',
    pages,
    // 组件清单：模型据此把设计稿里的组件名对到实现源码与 props 契约。
    components: inventory,
    tokens: Object.keys(axDoc.tokens).sort(),
    ...(context.diagnostics.length > 0 ? { diagnostics: context.diagnostics } : {}),
  }
  const { content, truncated } = truncateToByteBudget(JSON.stringify(payload, null, 2), maxBytes)
  return {
    content,
    details: {
      file: context.file,
      sha256: context.sha256,
      format: 'ax',
      mode: 'summary',
      pages: pages.length,
      truncated,
    },
  }
}

/** 页定位（页名字符串或 1 起始序号）→ 0 起始下标；未命中返回 -1。 */
const axPageIndex = (axDoc: AxDocument, pageInput: string | number): number =>
  typeof pageInput === 'number'
    ? pageInput - 1
    : axDoc.pages.findIndex((page) => page.name === pageInput || page.id === pageInput)

/** ── .ax render：整页 PNG（图像内容块）供模型自查「画出来的对不对」 ────────── */
export const executeAxRenderMode = async (
  context: AxModeContext,
  pageInput: string | number,
  imageMaxBytes: number | undefined,
): Promise<AgentToolResult> => {
  const { axDoc, inventory, source } = context
  const pageIndex = axPageIndex(axDoc, pageInput)
  const target = pageIndex >= 0 ? axDoc.pages[pageIndex] : undefined
  if (!target) {
    const names = axDoc.pages.map((page, index) => `${index + 1}:${page.name ?? page.id}`)
    return {
      content: `design_query: page ${JSON.stringify(String(pageInput))} not found in ${context.file}. Pages: ${names.join(', ')}.`,
      details: { file: context.file, parsed: true, found: false },
    }
  }
  const componentsUsed = axComponentsUsed(target.tree, [])
  const imageBudget = typeof imageMaxBytes === 'number' ? imageMaxBytes : DEFAULT_IMAGE_MAX_BYTES
  // 非视觉模型：连光栅化都不做（省一次挂载与字节预算），显式降级并说明原因。
  const imageUnsupported = context.modelAcceptsImage === false
  const rendererInjected = !imageUnsupported && canRenderDesignPage()
  const rendered = rendererInjected
    ? await renderDesignPage({
      source,
      fileName: context.file,
      pageIdOrIndex: target.id,
      maxBytes: imageBudget,
    })
    : null
  const failure = rendered && 'ok' in rendered ? rendered : undefined
  const summary = {
    file: context.file,
    format: `ax@${axDoc.ax}`,
    mode: 'render',
    page: {
      index: pageIndex + 1,
      id: target.id,
      name: target.name ?? target.id,
      width: target.width ?? null,
      height: target.height ?? null,
    },
    components: inventoryOf(inventory, componentsUsed),
    counts: { nodes: countAxNodes(target.tree) },
    render: rendered && !('ok' in rendered)
      ? { available: true, width: rendered.width, height: rendered.height, scale: rendered.scale, mediaType: rendered.mediaType }
      // 显式降级且携带原因，两类分开：接缝未注入才是「环境无渲染器」；
      // 其余（解析/挂载/光栅化/预算）是该次失败的具体原因——模型据此修复
      // 或重试，而不是把一次失败误判成环境无渲染能力。
      : {
        available: false,
        reason: imageUnsupported
          ? IMAGE_UNSUPPORTED_NOTE
          : !rendererInjected
            ? 'no renderer available in this environment (host seam not injected)'
            : failure?.reason ?? '渲染失败（渲染器未返回原因）',
      },
  }
  const summaryText = JSON.stringify(summary, null, 2)
  // 只有真正拿到渲染产物才产 image 内容块；失败（ok:false）走文本降级分支。
  const image = rendered && !('ok' in rendered) ? rendered : undefined
  if (!image) {
    return {
      content: summaryText,
      details: {
        file: context.file,
        sha256: context.sha256,
        format: 'ax',
        mode: 'render',
        rendered: false,
        ...(imageUnsupported ? { modelAcceptsImage: false } : {}),
      },
    }
  }
  return {
    content: summaryText,
    contentBlocks: [
      { type: 'text', text: summaryText },
      {
        type: 'image',
        source: { type: 'base64', mediaType: image.mediaType, data: image.base64 },
      },
    ],
    details: {
      file: context.file,
      sha256: context.sha256,
      format: 'ax',
      mode: 'render',
      rendered: true,
      pageIndex: pageIndex + 1,
      scale: image.scale,
    },
  }
}

/** ── .ax code：该页的 TSX 骨架（组件恒等 + 原语 → CSS 变量） ───────────────── */
export const executeAxCodeMode = (
  context: AxModeContext,
  pageInput: string | number,
): AgentToolResult => {
  const { axDoc, inventory } = context
  const pageIndex = axPageIndex(axDoc, pageInput)
  const target = pageIndex >= 0 ? axDoc.pages[pageIndex] : undefined
  if (!target) {
    const names = axDoc.pages.map((page, index) => `${index + 1}:${page.name ?? page.id}`)
    return {
      content: `design_query: page ${JSON.stringify(String(pageInput))} not found in ${context.file}. Pages: ${names.join(', ')}.`,
      details: { file: context.file, parsed: true, found: false },
    }
  }
  // 导入来源来自组件清单（注册表登记的 sourcePath）——模型不用猜路径。
  const componentImports: Record<string, { from: string }> = {}
  for (const entry of inventory) {
    const from = entry.sourcePath.replace(/\.tsx?$/, '').replace(/^src\//, '@/')
    componentImports[entry.name] = { from: from.startsWith('@/') ? from : `@/${from}` }
  }
  const emitted = emitAxPageToTsx(axDoc, target.id, { componentImports })
  if (!emitted) {
    return {
      content: `design_query: cannot emit code for page ${target.id}（缺页尺寸或无节点）。`,
      details: { file: context.file, parsed: true, found: false },
    }
  }
  const unresolvedLines = emitted.unresolved.map((item) => `- ${item.id} (${item.kind}): ${item.reason}`)
  const header = [
    `mode: code · page: ${target.name ?? target.id} (${pageIndex + 1}/${axDoc.pages.length})`
      + ` · nodes: ${emitted.counts.nodes} · components: ${emitted.counts.components}`,
    `生成组件名：${emitted.componentName}`,
    unresolvedLines.length > 0
      ? ['未映射（需人工接线）：', ...unresolvedLines].join('\n')
      : '未映射：无',
  ].join('\n')
  return {
    content: `${header}\n\n\`\`\`tsx\n${emitted.code}\`\`\`\n`,
    details: {
      file: context.file,
      sha256: context.sha256,
      format: 'ax',
      mode: 'code',
      pageIndex: pageIndex + 1,
      componentName: emitted.componentName,
      counts: emitted.counts,
      unresolved: emitted.unresolved as unknown as JsonValue,
    },
  }
}

/** ── .ax reconcile：设计 ↔ 实现结构对账（docs/ax-format.md §4.6.4）────────── */
// 稿侧组件清单 × 实现源码的实际使用，双向 diff：missingInImplementation
// ＝稿有实无（漏实现）；extraInImplementation＝实有稿无（设计外使用，供
// 反向更新设计稿参考）。词法提取（advisory），与 tokenParity 同口径不产生 fail。
export const executeAxReconcileMode = async (
  context: AxModeContext,
  environment: AgentEnvironment,
  roots: readonly string[],
): Promise<AgentToolResult> => {
  const { axDoc, inventory, maxBytes } = context
  const collected = await collectReconcileFiles(environment, roots)
  const registryNames = inventory.map((entry) => entry.name)
  // 实现侧：逐文件提取（读失败/截断标注后照常计入其余文件），按组件合并。
  const implUsage = new Map<string, { files: string[]; imports: number; jsxUses: number }>()
  const readFailures: string[] = []
  const truncatedFiles: string[] = []
  for (const file of collected.files) {
    let content: string
    try {
      const read = await environment.workspace.readText(file)
      content = read.content
      if (read.truncated) truncatedFiles.push(file)
    } catch (error) {
      readFailures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const [name, usage] of extractComponentUsage(content, registryNames)) {
      const existing = implUsage.get(name)
      if (existing) {
        existing.files.push(file)
        existing.imports += usage.imports
        existing.jsxUses += usage.jsxUses
      } else {
        implUsage.set(name, { files: [file], imports: usage.imports, jsxUses: usage.jsxUses })
      }
    }
  }
  // 稿侧：组件 → 用到它的页（含 slot 内的使用）。
  const designUsage = new Map<string, string[]>()
  for (const page of axDoc.pages) {
    for (const name of axComponentsUsed(page.tree, [])) {
      const list = designUsage.get(name)
      if (list) list.push(page.name ?? page.id)
      else designUsage.set(name, [page.name ?? page.id])
    }
  }
  // 在用口径：JSX 使用 > 0（import 了未使用是死导入，不构成「实现在用」）。
  const implUsed = [...implUsage.entries()]
    .filter(([, usage]) => usage.jsxUses > 0)
    .map(([name]) => name)
  const missingInImplementation = [...designUsage.entries()]
    .filter(([name]) => !implUsed.includes(name))
    .map(([component, pages]) => ({ component, pages }))
  const extraInImplementation = implUsed
    .filter((name) => !designUsage.has(name))
    .sort()
    .flatMap((component) => {
      const usage = implUsage.get(component)
      // implUsed 由 implUsage 派生（jsxUses>0 的键），必然命中；收窄只为类型系统。
      if (!usage) return []
      return [{ component, jsxUses: usage.jsxUses, files: usage.files.slice(0, 8) }]
    })
  const matched = [...designUsage.entries()]
    .filter(([name]) => implUsed.includes(name))
    .flatMap(([component, pages]) => {
      const usage = implUsage.get(component)
      if (!usage) return []
      return [{
        component,
        pages: pages.length,
        files: usage.files.length,
        jsxUses: usage.jsxUses,
        imports: usage.imports,
      }]
    })
    .sort((left, right) => left.component.localeCompare(right.component))
  const payload = {
    file: context.file,
    format: `ax@${axDoc.ax}`,
    mode: 'reconcile' as const,
    note: 'advisory：missingInImplementation 为稿有实无（漏实现）；extraInImplementation 为实有稿无（设计外使用，可据此反向补设计稿）。在用口径 = 实现里出现该组件的 JSX 开标签。',
    implementation: {
      roots,
      filesScanned: collected.files.length,
      ...(truncatedFiles.length > 0 ? { truncatedFiles } : {}),
      ...(readFailures.length > 0 ? { readFailures: readFailures.slice(0, 10) } : {}),
      ...(collected.directoriesSkipped.length > 0 ? { directoriesSkipped: collected.directoriesSkipped.slice(0, 10) } : {}),
      fileCapReached: collected.fileCapReached,
    },
    design: {
      pages: axDoc.pages.map((page, index) => ({
        index: index + 1,
        name: page.name ?? page.id,
        components: axComponentsUsed(page.tree, []),
      })),
      componentsUsed: [...designUsage.keys()].sort(),
    },
    missingInImplementation,
    extraInImplementation,
    matched,
  }
  const { content, truncated } = truncateToByteBudget(JSON.stringify(payload, null, 2), maxBytes)
  return {
    content,
    details: {
      file: context.file,
      sha256: context.sha256,
      format: 'ax',
      mode: 'reconcile',
      filesScanned: collected.files.length,
      missing: missingInImplementation.length,
      extra: extraInImplementation.length,
      matched: matched.length,
      truncated,
    },
  }
}

/** ── .ax compare：设计页 ↔ 实现路由的像素对拍（docs/ax-format.md §4.6）──────── */
// 编排：设计侧走 render 宿主链（WKWebView 渲染），实现侧经浏览器工具同一条
// 平台通道截图（隔离 Chromium）——两张 PNG 解码成 RGBA 后以设计渲染尺寸为
// 基准归一、pixelmatch 对拍。判定 advisory 且永不 fail：跨引擎字体光栅化存在
// 基线噪声，本对拍度量的是量级与差异定位，不是像素级回归门禁。
const DEFAULT_COMPARE_WAIT_MS = 800
const MAX_COMPARE_WAIT_MS = 15_000

const compareFailure = (
  context: AxModeContext,
  stage: 'render' | 'browser' | 'decode',
  reason: string,
): AgentToolResult => ({
  content: JSON.stringify({
    file: context.file,
    mode: 'compare',
    available: false,
    stage,
    reason,
  }, null, 2),
  details: { file: context.file, sha256: context.sha256, format: 'ax', mode: 'compare', stage },
})

export const executeAxCompareMode = async (
  context: AxModeContext,
  environment: AgentEnvironment,
  input: { page: string | number; url: string; waitMs?: number },
): Promise<AgentToolResult> => {
  const { axDoc, maxBytes } = context
  const pageIndex = axPageIndex(axDoc, input.page)
  const target = pageIndex >= 0 ? axDoc.pages[pageIndex] : undefined
  if (!target) {
    const names = axDoc.pages.map((page, index) => `${index + 1}:${page.name ?? page.id}`)
    return {
      content: `design_query: page ${JSON.stringify(String(input.page))} not found in ${context.file}. Pages: ${names.join(', ')}.`,
      details: { file: context.file, parsed: true, found: false },
    }
  }
  const pageWidth = typeof target.width === 'number' ? target.width : 0
  const pageHeight = typeof target.height === 'number' ? target.height : 0
  if (pageWidth <= 0 || pageHeight <= 0) {
    return compareFailure(context, 'render', 'compare 需要页面声明有效尺寸（该页缺失），先补齐页面 width/height')
  }

  // 设计侧：与 mode=render 同一条宿主渲染链；预算取上限尽量保持 1:1 像素。
  if (!canRenderDesignPage()) {
    return compareFailure(context, 'render', '当前环境无设计页渲染能力（渲染接缝未注入）')
  }
  const rendered = await renderDesignPage({
    source: context.source,
    fileName: context.file,
    pageIdOrIndex: target.id,
    maxBytes: MAX_IMAGE_MAX_BYTES,
  })
  if (!rendered) {
    return compareFailure(context, 'render', '当前环境无设计页渲染能力（渲染接缝未注入）')
  }
  if ('ok' in rendered) {
    return compareFailure(context, 'render', `设计页渲染失败：${rendered.reason}`)
  }

  // 实现侧：经浏览器工具同一条平台通道（启用门控/隔离 profile 语义一致）。
  // 视口按设计页尺寸设置，截图即与设计稿同一坐标系；结束时关掉本次打开的 tab。
  let shot: { base64: string; width: number; height: number }
  let tabId = ''
  try {
    const opened = await environment.browser.command({ action: 'newTab', url: input.url })
    if (opened.type !== 'tabOpened') throw new Error('打开页面未返回 tab')
    tabId = opened.tab.tabId
    await environment.browser.command({ action: 'setViewport', tabId, width: pageWidth, height: pageHeight })
    await environment.browser.command({
      action: 'wait',
      tabId,
      durationMs: Math.min(MAX_COMPARE_WAIT_MS, Math.max(1, input.waitMs ?? DEFAULT_COMPARE_WAIT_MS)),
    })
    const screenshot = await environment.browser.command({ action: 'screenshot', tabId })
    if (screenshot.type !== 'screenshot') throw new Error('截图未返回图像')
    shot = { base64: screenshot.imageBase64, width: screenshot.width, height: screenshot.height }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return compareFailure(
      context,
      'browser',
      `实现路由截图失败：${reason}。浏览器能力未启用时到 设置 → 浏览器 开启；dev server 未运行时先用 bash 启动再对拍`,
    )
  } finally {
    if (tabId !== '') {
      await environment.browser.command({ action: 'closeTab', tabId }).catch(() => undefined)
    }
  }

  // 解码 → 以设计渲染尺寸为基准归一 → pixelmatch 对拍。
  if (!canDecodePng()) {
    return compareFailure(context, 'decode', '当前环境无 PNG 解码能力（解码接缝未注入）')
  }
  const designImage = await decodePngToRgba(rendered.base64)
  const implementationImage = await decodePngToRgba(shot.base64)
  if (!designImage || !implementationImage) {
    return compareFailure(context, 'decode', 'PNG 解码失败（设计渲染或实现截图之一无法解码为 RGBA）')
  }
  const diff = compareRgba(designImage, scaleRgba(implementationImage, designImage.width, designImage.height))
  const verdict = compareVerdictOf(diff.ratio)
  const payload = {
    file: context.file,
    format: `ax@${axDoc.ax}`,
    mode: 'compare' as const,
    page: {
      index: pageIndex + 1,
      name: target.name ?? target.id,
      designSize: [pageWidth, pageHeight],
    },
    implementation: {
      url: input.url,
      viewport: [pageWidth, pageHeight],
      captured: [shot.width, shot.height],
      waitMs: Math.min(MAX_COMPARE_WAIT_MS, Math.max(1, input.waitMs ?? DEFAULT_COMPARE_WAIT_MS)),
    },
    design: { rendered: [rendered.width, rendered.height], scale: rendered.scale },
    compared: [diff.width, diff.height],
    diff: {
      mismatchedPixels: diff.mismatchedPixels,
      ratio: Number((diff.ratio * 100).toFixed(2)),
      pixelThreshold: PIXEL_THRESHOLD,
      passRatio: Number((COMPARE_PASS_RATIO * 100).toFixed(1)),
    },
    ...(diff.bounds ? { bounds: diff.bounds } : {}),
    verdict,
    note: 'advisory：设计侧在 WKWebView 渲染、实现侧截图来自隔离 Chromium，跨引擎字体光栅化有基线噪声（文本页常见 1-3% 微差）；量级与 bounds 才是决策依据——warn 时先按 bounds 定位差异区域核对两张图，再决定改稿还是改实现',
  }
  const { content, truncated } = truncateToByteBudget(JSON.stringify(payload, null, 2), maxBytes)
  return {
    content,
    details: {
      file: context.file,
      sha256: context.sha256,
      format: 'ax',
      mode: 'compare',
      pageIndex: pageIndex + 1,
      verdict,
      mismatchedPixels: diff.mismatchedPixels,
      truncated,
    },
  }
}

/** ── .ax node：子树精确定位（含该子树的组件清单与 token 字面值） ──────────── */
export const executeAxNodeMode = (context: AxModeContext, nodeId: string): AgentToolResult => {
  const { axDoc, inventory, maxBytes } = context
  const allNodes: AxNode[] = []
  const collectNodes = (nodes: readonly AxNode[]): void => {
    for (const node of nodes) {
      allNodes.push(node)
      collectNodes(node.children ?? [])
      if (node.slot) collectNodes(node.slot)
    }
  }
  axDoc.pages.forEach((page) => {
    collectNodes(page.tree)
  })
  const found = allNodes.find((node) => node.id === nodeId)
  if (!found) {
    return {
      content: `design_query: node "${nodeId}" not found in ${context.file}.`,
      details: { file: context.file, parsed: true, found: false },
    }
  }
  const names = axComponentsUsed([found], [])
  const payload = {
    file: context.file,
    format: `ax@${axDoc.ax}`,
    mode: 'node',
    nodeId,
    node: found,
    components: inventoryOf(inventory, names),
    tokens: tokensOf(axDoc, [found]),
  }
  const { content, truncated } = truncateToByteBudget(JSON.stringify(payload, null, 2), maxBytes)
  return {
    content,
    details: { file: context.file, sha256: context.sha256, format: 'ax', mode: 'node', found: true, truncated },
  }
}

/** ── .ax page：返回**已解析的规格**（token 字面值 + 作者视角的树 + 组件清单）── */
export const executeAxPageMode = (
  context: AxModeContext,
  pageInput: string | number,
): AgentToolResult => {
  const { axDoc, inventory, maxBytes } = context
  const pageIndex = axPageIndex(axDoc, pageInput)
  if (pageIndex < 0 || pageIndex >= axDoc.pages.length) {
    const names = axDoc.pages.map((page, index) => `${index + 1}:${page.name ?? page.id}`)
    return {
      content: `design_query: page ${JSON.stringify(String(pageInput))} not found in ${context.file}. Pages: ${names.join(', ')}.`,
      details: { file: context.file, parsed: true, found: false },
    }
  }
  const page = axDoc.pages[pageIndex]!
  const totalNodes = countAxNodes(page.tree)
  const componentsUsed = axComponentsUsed(page.tree, [])
  const payloadOf = (tree: AxNode[], truncated?: { keptNodes: number; omittedNodes: number }) => ({
    file: context.file,
    format: `ax@${axDoc.ax}`,
    mode: 'page',
    page: {
      index: pageIndex + 1,
      id: page.id,
      name: page.name ?? page.id,
      ...(page.group !== undefined ? { group: page.group } : {}),
      ...(page.state !== undefined ? { state: page.state } : {}),
      ...(page.layout !== undefined ? { layout: page.layout } : {}),
      ...(page.gap !== undefined ? { gap: page.gap } : {}),
      ...(page.padding !== undefined ? { padding: page.padding } : {}),
      width: page.width ?? null,
      height: page.height ?? null,
      ...(page.background !== undefined ? { background: page.background } : {}),
    },
    components: inventoryOf(inventory, componentsUsed),
    tokens: tokensOf(axDoc, page.tree),
    tree,
    counts: { nodes: totalNodes, ...(truncated ? { keptNodes: truncated.keptNodes } : {}) },
    ...(truncated ? { truncated: { omittedNodes: truncated.omittedNodes } } : {}),
  })
  const full = JSON.stringify(payloadOf(page.tree), null, 2)
  if (new TextEncoder().encode(full).length <= maxBytes) {
    return {
      content: full,
      details: { file: context.file, sha256: context.sha256, format: 'ax', mode: 'page', pageIndex: pageIndex + 1, truncated: false },
    }
  }
  // 超预算：按**节点**收口（二分保留前 N 个），并显式标注省略数量——不静默收窄。
  let low = 1
  let high = totalNodes
  let best = 0
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = JSON.stringify(
      payloadOf(takeAxNodes(page.tree, { left: mid }), { keptNodes: mid, omittedNodes: totalNodes - mid }),
      null,
      2,
    )
    if (new TextEncoder().encode(candidate).length <= maxBytes) {
      best = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  const keptNodes = takeAxNodes(page.tree, { left: best })
  const trimmed = JSON.stringify(
    payloadOf(keptNodes, { keptNodes: best, omittedNodes: totalNodes - best }),
    null,
    2,
  )
  return {
    content: trimmed,
    details: {
      file: context.file,
      sha256: context.sha256,
      format: 'ax',
      mode: 'page',
      pageIndex: pageIndex + 1,
      truncated: true,
      omittedNodes: totalNodes - best,
    },
  }
}

/** ── .pen（导入源）：解析后的子树 JSON（legacy 读取口径） ─────────────────── */
export const executePenMode = (
  context: { file: string; sha256: string; source: string },
  input: { page?: string | number; nodeId?: string; maxBytes?: number },
): AgentToolResult => {
  const result = parsePenDocument(context.source, context.file)
  if (result.document === null) {
    // 解析完全失败：把错误原样回传，模型按「写后自查」步骤修复 JSON。
    return {
      content: `design_query: failed to parse ${context.file}: ${result.error ?? 'unknown parse error'}`,
      details: { file: context.file, sha256: context.sha256, parsed: false },
    }
  }
  const doc = result.document
  const maxBytes = typeof input.maxBytes === 'number' ? input.maxBytes : 16384

  // 无 page 且无 nodeId：返回页级摘要（页名/根 id），引导模型再按子树查询。
  if (input.page === undefined && input.nodeId === undefined) {
    const summary = doc.pages.map((page, index) => ({
      index: index + 1,
      name: pageNameOf(page),
    }))
    const pages = summary as unknown as JsonValue
    return {
      content: JSON.stringify({ file: context.file, pages: summary }, null, 2),
      details: { file: context.file, sha256: context.sha256, pages },
    }
  }

  if (typeof input.nodeId === 'string') {
    const pageNodes = doc.pages
    const node = findNode(pageNodes, input.nodeId)
    // Object.hasOwn 而非 in：in 走原型链，"constructor" 等 id 会命中 Object.prototype。
    const componentsNode = Object.hasOwn(doc.components, input.nodeId)
      ? doc.components[input.nodeId]
      : undefined
    const found = node ?? componentsNode
    if (!found) {
      return {
        content: `design_query: node "${input.nodeId}" not found in ${context.file}.`,
        details: { file: context.file, parsed: true, found: false },
      }
    }
    const json = JSON.stringify(found, null, 2)
    const { content, truncated } = truncateToByteBudget(json, maxBytes)
    return {
      content,
      details: {
        file: context.file,
        sha256: context.sha256,
        found: true,
        truncated,
        nodeId: input.nodeId,
      },
    }
  }

  // page 定位：字符串按页名匹配，数字按 1 起始序号。
  const pageInput = input.page
  const pageIndex = typeof pageInput === 'number'
    ? pageInput - 1
    : doc.pages.findIndex((page) => pageNameOf(page) === pageInput || page.id === pageInput)
  if (pageIndex < 0 || pageIndex >= doc.pages.length) {
    const names = doc.pages.map((page, index) => `${index + 1}:${pageNameOf(page)}`)
    return {
      content: `design_query: page ${JSON.stringify(String(pageInput))} not found in ${context.file}. Pages: ${names.join(', ')}.`,
      details: { file: context.file, parsed: true, found: false },
    }
  }
  const page = doc.pages[pageIndex]
  const json = JSON.stringify(page, null, 2)
  const { content, truncated } = truncateToByteBudget(json, maxBytes)
  return {
    content,
    details: {
      file: context.file,
      sha256: context.sha256,
      found: true,
      truncated,
      pageIndex: pageIndex + 1,
    },
  }
}
