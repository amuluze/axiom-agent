import type { AgentTool, AgentToolResult, JsonValue } from '../core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { desktopAgentEnvironment } from '@/agent/environment/agentEnvironmentHost'
import { parsePenDocument, type PenDocument, type PenNodeUnion } from '@/agent/design/penParser'
import { parseAxDocument, projectAxToPenDocument } from '@/agent/design/axParser'
import type { AxDocument, AxNode } from '@/agent/design/axSchema'
import {
  designComponentDetail,
  designComponentInventory,
  type DesignComponentDetail,
  type DesignComponentSummary,
} from '@/agent/design/componentInventoryHost'
import {
  canRenderDesignScanPage,
  renderDesignPage,
  renderDesignScanPage,
} from '@/agent/design/designRenderHost'
import { extractScanPages, scanDesignPages, type DesignScanRenderPage } from '@/agent/design/designScan'
import { emitAxPageToTsx } from '@/agent/design/emitPage'
import { hasOnlyKeys, isJsonObject, isSafeRelativePath, optionalInteger } from './workspaceToolUtils'

const DEFAULT_MAX_BYTES = 16384
const MAX_MAX_BYTES = 65536
/** render 模式的图片预算（base64 字符数上限）：默认 512KiB，上限 2MiB。 */
const DEFAULT_IMAGE_MAX_BYTES = 512 * 1024
const MAX_IMAGE_MAX_BYTES = 2 * 1024 * 1024
/** scan 模式的单张缩略图预算（32KiB ≈ 几千 token——逐页扫描必须控制上下文体积）。 */
const DEFAULT_SCAN_THUMBNAIL_BYTES = 32 * 1024
/** scan 模式最多回传的缩略图张数（只给 warn 页；fail 页没有图，ok 页不需要看）。 */
const MAX_SCAN_THUMBNAILS = 4

/** base64 → UTF-8 文本（agent 层不依赖 platform/base64，浏览器/Node 双环境） */
const decodeBase64ToText = (base64: string): string => {
  const binary =
    typeof atob === 'function'
      ? atob(base64)
      : Buffer.from(base64, 'base64').toString('binary')
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

/** CSS 自定义属性声明的提取（token ↔ 实现样式表一致性核对用）。 */
const CSS_VAR_DECLARATION_PATTERN = /--([a-zA-Z0-9_-]+)\s*:/g

/** missingInCss 清单的回传上限（超出的只给计数，不撑爆输出预算）。 */
const MAX_MISSING_TOKENS_LISTED = 20

/**
 * `.ax` tokens ↔ 实现样式表的一致性核对（B5）：`$name` 在实现侧落到 `var(--name)`，
 * 稿里声明而样式表没有同名变量的 token 会让「设计稿引用 → 实现接线」断链。
 * 这是**建议性**报告（设计系统的度量 token 不必然有 CSS 变量对应），不产生页级
 * fail/warn 判定；由调用方显式传 `tokensCss` 才参与（不同工作区的样式表路径不同）。
 */
const tokenParityOf = (
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

/** 深度优先查找含 nodeId 的子树（含 ref 解析后的 children）。 */
const findNode = (nodes: readonly PenNodeUnion[], nodeId: string): PenNodeUnion | undefined => {
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

/** 设计稿文件判定：`.pen`（导入源）与 `.ax`（自有格式）。 */
const isDesignFile = (path: string): boolean => /\.(pen|ax)$/i.test(path)

const isAxFile = (path: string): boolean => /\.ax$/i.test(path)

/** 页名（`.pen` 的视图模型里页根可能是 component/part 节点，统一走 in 窄化）。 */
const pageNameOf = (page: PenNodeUnion): string =>
  'name' in page && typeof page.name === 'string' ? page.name : page.id

/**
 * 按字节预算截断 UTF-8 文本：json.length 是 UTF-16 code unit，CJK 实际字节
 * 可达 3 倍，按 length 切既超预算又可能切断多字节字符。回退到码点边界，
 * 避免解码出 U+FFFD 替换符。
 */
const truncateToByteBudget = (text: string, maxBytes: number): { content: string; truncated: boolean } => {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= maxBytes) return { content: text, truncated: false }
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  const slice = new TextDecoder().decode(bytes.subarray(0, end))
  return { content: `${slice}\n...[truncated at ${maxBytes} bytes]`, truncated: true }
}

export interface DesignQueryOptions {
  /** 组件清单来源；缺省用宿主接缝（应用启动处注入的注册表摘要）。 */
  componentInventory?: () => DesignComponentSummary[]
}

/**
 * `.ax` 的 token 引用收集：扫树里所有 `$name` 字符串（含渐变色标的 color），
 * 用于「把 token 解析成明暗两档字面值」随页返回。
 */
const collectTokenRefs = (value: unknown, into: Set<string>): void => {
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
const countAxNodes = (nodes: readonly AxNode[]): number =>
  nodes.reduce((total, node) => total + 1 + countAxNodes(node.children ?? []), 0)

const takeAxNodes = (nodes: readonly AxNode[], budget: { left: number }): AxNode[] => {
  const kept: AxNode[] = []
  for (const node of nodes) {
    if (budget.left <= 0) break
    budget.left -= 1
    kept.push({ ...node, ...(node.children ? { children: takeAxNodes(node.children, budget) } : {}) })
  }
  return kept
}

/** 页里用到的组件名（去重、按出现顺序）。 */
const axComponentsUsed = (nodes: readonly AxNode[], into: string[]): string[] => {
  for (const node of nodes) {
    if (node.kind === 'component' && node.name && !into.includes(node.name)) into.push(node.name)
    if (node.children) axComponentsUsed(node.children, into)
    if (node.slot) axComponentsUsed(node.slot, into)
  }
  return into
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
const executeScan = async (
  source: string,
  input: { file: string; page?: string | number; maxBytes?: number; imageMaxBytes?: number },
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
      if (result.base64) thumbnails.set(page.id, { base64: result.base64, pageName: result.pageName })
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
  }
  const maxBytes = typeof input.maxBytes === 'number' ? input.maxBytes : DEFAULT_MAX_BYTES
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

export const createDesignQueryTool = (
  environment: AgentEnvironment,
  options: DesignQueryOptions = {},
): AgentTool => ({
  name: 'design_query',
  label: 'design_query',
  promptSnippet: '查询设计稿（.ax/.pen）的页面与子树；.ax 另返回「已解析的规格 + 组件清单」，无需整读文件。',
  promptGuidelines: [
    'file 为授权工作区相对路径（.ax 或 .pen）；page 传页名或 1 起始序号，nodeId 精确定位子树。',
    '不传 page/nodeId 时返回摘要（页清单 + 组件清单 + token 清单）——先看摘要再按页/子树取细节。',
    '.ax 的返回已解析：token 给出明暗两档字面值、组件给出真实源码路径与 props 契约；直接据此写实现，不必猜。',
    '写 component 节点前先用 mode=component 查该组件的详单（props 契约 + statics + fixture 数据形状）：json 型 props 的结构化 $mock 照 fixture 形状写，缺隐式前提（如 assistant 消息的 toolCalls）会在渲染期抛错。',
    '.ax 的组件节点会与组件注册表核对：组件不在注册表、props 键/必填/值型与契约不符都会在读取时报错（写稿当场暴露，不必等画布渲染红框）；按报错列出的可用项自修。',
    'mode=render 返回该页的 PNG（作为图像内容块）：写完设计稿后用它自查「画出来的和想要的是否一致」。',
    'mode=scan 逐页扫描整份稿（结构检查 + 逐页离屏渲染 + 空白检测），返回逐页判定与问题清单——多页改动或整稿完成后跑一遍，按 fail/warn 页的 issues 修复后重扫直到全绿。可选 tokensCss 传实现样式表路径（如 apps/desktop/src/styles/tokens.css），报告附带 token ↔ CSS 变量的一致性清单（建议性）。',
    'mode=code 返回该页的 TSX 骨架：组件节点是恒等映射（props 已校验），原语映射到 CSS 变量；unresolved 列出需要人工接线的部分，据此再补数据与交互。',
    '按子树操作，不要用 read 整读设计稿；写坏 JSON 时再次调用本工具按 parse error 自修。',
  ],
  runtimeVersion: '4',
  recoveryPolicy: 'idempotent',
  idempotencyKey: (input) => {
    if (!isJsonObject(input)) return 'design_query:invalid'
    const mode = typeof input.mode === 'string' ? input.mode : ''
    const file = typeof input.file === 'string' ? input.file : ''
    const page = typeof input.page === 'number' ? String(input.page) : typeof input.page === 'string' ? input.page : ''
    const nodeId = typeof input.nodeId === 'string' ? input.nodeId : ''
    const component = typeof input.component === 'string' ? input.component : ''
    // mode 进 key：同一 file+page 的 scan/render/page/component 结果形状不同，不能互为幂等回放。
    return `design_query:${file}:${mode}:${page}:${nodeId}:${component}`
  },
  description:
    'Query a design document (.ax or .pen, workspace-relative) without reading the whole file. '
    + 'For .ax: summary returns pages plus the component inventory (name → real source path, props contract) and token list; '
    + 'page/node return the authored tree with tokens resolved to light/dark literals and the components used by that page; '
    + 'mode=component returns one component\'s full contract (props, statics, fixture data shapes) so structured $mock values can be authored without reading source; '
    + 'component nodes are cross-checked against the component registry at read time (unknown component/props/type mismatches fail here, not at canvas render). '
    + 'mode=render emits the page as a PNG image block for visual self-check; '
    + 'mode=scan verifies every page renders (structure checks + offscreen render + blank detection, per-page verdicts and issue list; optional tokensCss adds a token ↔ CSS variable parity report); '
    + 'mode=code emits a TSX skeleton for the page (component nodes map 1:1, primitives map to CSS variables; unresolved items are listed). '
    + 'For .pen: the resolved JSON subtree (legacy import format). Output is capped by the byte budget and truncation is always explicit. '
    + 'Parse failures return the parser diagnostics so the model can repair malformed JSON.',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Workspace-relative design path (e.g. .pen/axiom.ax or .pen/axiom.pen). Optional only for mode=component.',
      },
      mode: {
        type: 'string',
        description: 'Optional for .ax: summary (pages + component inventory), page (fully resolved page spec), node, component (one component\'s contract detail), render (the page as a PNG image block for visual self-check), code (generated TSX skeleton), or scan (per-page render verification: structure checks + offscreen render + blank detection with per-page verdicts). Inferred when omitted.',
      },
      component: {
        type: 'string',
        description: 'Component registry name for mode=component (see the inventory in summary).',
      },
      tokensCss: {
        type: 'string',
        description: 'Workspace-relative implementation stylesheet for mode=scan (e.g. apps/desktop/src/styles/tokens.css); adds an advisory token ↔ CSS variable parity report.',
      },
      imageMaxBytes: {
        type: 'number',
        description: `PNG budget for mode render (default ${DEFAULT_IMAGE_MAX_BYTES}) or per-thumbnail budget for mode scan (default ${DEFAULT_SCAN_THUMBNAIL_BYTES}); range 1024-${MAX_IMAGE_MAX_BYTES}.`,
      },
      page: {
        description: 'Page name or 1-based page index. Omit with nodeId to list pages.',
      },
      nodeId: {
        type: 'string',
        description: 'Node id to locate a subtree (searched across pages and reusable components).',
      },
      maxBytes: {
        type: 'number',
        description: `Output byte budget (1-${MAX_MAX_BYTES}), default ${DEFAULT_MAX_BYTES}.`,
      },
    },
    required: [],
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input)
      || !hasOnlyKeys(input, ['file', 'page', 'nodeId', 'maxBytes', 'mode', 'imageMaxBytes', 'component', 'tokensCss'])) {
      return { ok: false, error: 'Arguments must be an object with only file, page, nodeId, maxBytes, mode, imageMaxBytes, component, and tokensCss.' }
    }
    if (input.mode !== undefined
      && input.mode !== 'summary' && input.mode !== 'page'
      && input.mode !== 'node' && input.mode !== 'render' && input.mode !== 'code'
      && input.mode !== 'scan' && input.mode !== 'component') {
      return { ok: false, error: 'mode must be summary, page, node, component, render, code, or scan.' }
    }
    if (input.component !== undefined) {
      if (input.mode !== 'component') {
        return { ok: false, error: 'component is only valid with mode=component.' }
      }
      if (typeof input.component !== 'string' || !input.component.trim()) {
        return { ok: false, error: 'component must be a non-empty component name when mode=component.' }
      }
    }
    if (input.mode === 'component' && typeof input.component !== 'string') {
      return { ok: false, error: 'mode=component requires a component name.' }
    }
    if (input.tokensCss !== undefined) {
      if (input.mode !== 'scan') {
        return { ok: false, error: 'tokensCss is only valid with mode=scan.' }
      }
      if (typeof input.tokensCss !== 'string' || !isSafeRelativePath(input.tokensCss, false)) {
        return { ok: false, error: 'tokensCss must be a workspace-relative stylesheet path.' }
      }
    }
    // file 仅在 mode=component 下可省（组件契约与具体稿件无关）；其余模式必填。
    if (input.mode === 'component' && input.file === undefined) {
      if (input.page !== undefined || input.nodeId !== undefined || input.imageMaxBytes !== undefined) {
        return { ok: false, error: 'mode=component takes only component (and optionally maxBytes).' }
      }
      if (!optionalInteger(input.maxBytes, 1, MAX_MAX_BYTES)) {
        return { ok: false, error: `maxBytes must be an integer between 1 and ${MAX_MAX_BYTES}.` }
      }
      return { ok: true, value: input }
    }
    if (typeof input.file !== 'string' || !isDesignFile(input.file) || !isSafeRelativePath(input.file, false)) {
      return { ok: false, error: 'file must be a workspace-relative path ending in .ax or .pen.' }
    }
    if ((input.mode === 'render' || input.mode === 'code') && input.page === undefined) {
      return { ok: false, error: 'mode render/code requires a page (name or 1-based index).' }
    }
    if ((input.mode === 'render' || input.mode === 'code') && input.page === undefined) {
      return { ok: false, error: 'mode render/code requires a page (name or 1-based index).' }
    }
    if (!optionalInteger(input.imageMaxBytes, 1024, MAX_IMAGE_MAX_BYTES)) {
      return { ok: false, error: `imageMaxBytes must be an integer between 1024 and ${MAX_IMAGE_MAX_BYTES}.` }
    }
    if (
      input.page !== undefined
      && typeof input.page !== 'string'
      && !optionalInteger(input.page, 1, Number.MAX_SAFE_INTEGER)
    ) {
      return { ok: false, error: 'page must be a page name string or a 1-based integer index.' }
    }
    if (input.nodeId !== undefined && (typeof input.nodeId !== 'string' || !input.nodeId.trim())) {
      return { ok: false, error: 'nodeId must be a non-empty string when provided.' }
    }
    if (!optionalInteger(input.maxBytes, 1, MAX_MAX_BYTES)) {
      return { ok: false, error: `maxBytes must be an integer between 1 and ${MAX_MAX_BYTES}.` }
    }
    return { ok: true, value: input }
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    if (!isJsonObject(input)) throw new Error('Invalid design_query arguments.')
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const inventory = options.componentInventory?.() ?? designComponentInventory()
    const maxBytesForInput = typeof input.maxBytes === 'number' ? input.maxBytes : DEFAULT_MAX_BYTES

    // ── component：单组件契约详单（与具体稿件无关，file 可省）────────────────
    // 写 component 节点前查一次：props 契约 + statics + fixture 数据形状——
    // json 型 props 的结构化 $mock 照 fixture 形状写，不必读组件源码反推隐式前提。
    if (input.mode === 'component') {
      const name = typeof input.component === 'string' ? input.component : ''
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
        const { content, truncated } = truncateToByteBudget(JSON.stringify(payload, null, 2), maxBytesForInput)
        return {
          content,
          details: { mode: 'component', found: true, source: 'inventory-summary', truncated },
        }
      }
      const { content, truncated } = truncateToByteBudget(
        JSON.stringify({ mode: 'component' as const, component: detail }, null, 2),
        maxBytesForInput,
      )
      return { content, details: { mode: 'component', found: true, truncated } }
    }

    if (typeof input.file !== 'string') throw new Error('Invalid design_query arguments.')
    const document = await environment.design.readDocument(input.file)
    const source = decodeBase64ToText(document.contentBase64)

    // ── scan：两种格式共用的逐页渲染验证（结构检查 + 离屏渲染 + 空白检测） ────
    if (input.mode === 'scan') {
      // 可选的实现样式表：读取失败不阻断扫描，报告里带原因（建议性核对不假装成功）。
      let tokensCss: { file: string; content: string } | { file: string; error: string } | undefined
      if (typeof input.tokensCss === 'string') {
        try {
          const css = await environment.workspace.readText(input.tokensCss)
          tokensCss = { file: input.tokensCss, content: css.content }
        } catch (error) {
          tokensCss = { file: input.tokensCss, error: error instanceof Error ? error.message : String(error) }
        }
      }
      return executeScan(source, {
        file: input.file,
        page: typeof input.page === 'number'
          ? input.page
          : typeof input.page === 'string' ? input.page : undefined,
        maxBytes: typeof input.maxBytes === 'number' ? input.maxBytes : undefined,
        imageMaxBytes: typeof input.imageMaxBytes === 'number' ? input.imageMaxBytes : undefined,
      }, document.sha256, {
        componentInventory: inventory,
        ...(tokensCss !== undefined ? { tokensCss } : {}),
      })
    }

    // ── `.ax`（自有格式）：三层读取 —— 摘要 / 页（已解析规格）/ 子树 ──────────
    if (isAxFile(input.file)) {
      // 注册表核对：有清单时传给解析器（组件名/props 键/必填/值型在读取时报错）。
      const parsed = parseAxDocument(source, inventory.length > 0 ? { componentInventory: inventory } : {})
      if (!parsed.document) {
        const detail = parsed.error
          ?? parsed.diagnostics
            .filter((item) => item.level === 'error')
            .map((item) => `- ${item.path ?? '?'}: ${item.message}`)
            .join('\n')
        return {
          content: `design_query: failed to validate ${input.file}:\n${detail}`,
          details: { file: input.file, sha256: document.sha256, parsed: false },
        }
      }
      const axDoc: AxDocument = parsed.document
      const inventoryOf = (names: string[]): DesignComponentSummary[] =>
        inventory.filter((entry) => names.includes(entry.name))
      const tokensOf = (tree: readonly AxNode[]): Record<string, { light: string; dark: string }> => {
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

      const mode = typeof input.mode === 'string'
        ? input.mode
        : input.nodeId !== undefined ? 'node' : input.page !== undefined ? 'page' : 'summary'

      if (mode === 'summary') {
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
          file: input.file,
          format: `ax@${axDoc.ax}`,
          mode,
          pages,
          // 组件清单：模型据此把设计稿里的组件名对到实现源码与 props 契约。
          components: inventory,
          tokens: Object.keys(axDoc.tokens).sort(),
          ...(parsed.diagnostics.length > 0 ? { diagnostics: parsed.diagnostics } : {}),
        }
        const { content, truncated } = truncateToByteBudget(JSON.stringify(payload, null, 2), maxBytesForInput)
        return {
          content,
          details: {
            file: input.file,
            sha256: document.sha256,
            format: 'ax',
            mode,
            pages: pages.length,
            truncated,
          },
        }
      }

      // ── render：整页 PNG（图像内容块）供模型自查「画出来的对不对」 ──────────
      if (mode === 'render') {
        const pageInput = input.page
        const pageIndex = typeof pageInput === 'number'
          ? pageInput - 1
          : axDoc.pages.findIndex((page) => page.name === pageInput || page.id === pageInput)
        const target = pageIndex >= 0 ? axDoc.pages[pageIndex] : undefined
        if (!target) {
          const names = axDoc.pages.map((page, index) => `${index + 1}:${page.name ?? page.id}`)
          return {
            content: `design_query: page ${JSON.stringify(String(pageInput))} not found in ${input.file}. Pages: ${names.join(', ')}.`,
            details: { file: input.file, parsed: true, found: false },
          }
        }
        const componentsUsed = axComponentsUsed(target.tree, [])
        const imageBudget = typeof input.imageMaxBytes === 'number' ? input.imageMaxBytes : DEFAULT_IMAGE_MAX_BYTES
        const rendered = await renderDesignPage({
          source,
          fileName: input.file,
          pageIdOrIndex: target.id,
          maxBytes: imageBudget,
        })
        const summary = {
          file: input.file,
          format: `ax@${axDoc.ax}`,
          mode,
          page: {
            index: pageIndex + 1,
            id: target.id,
            name: target.name ?? target.id,
            width: target.width ?? null,
            height: target.height ?? null,
          },
          components: inventoryOf(componentsUsed),
          counts: { nodes: countAxNodes(target.tree) },
          render: rendered
            ? { available: true, width: rendered.width, height: rendered.height, scale: rendered.scale, mediaType: rendered.mediaType }
            // 显式降级：没有渲染能力（无 DOM 环境）或超出图片预算时说明原因，不假装成功。
            : { available: false, reason: 'no renderer available in this environment, or the PNG exceeded the image budget' },
        }
        const summaryText = JSON.stringify(summary, null, 2)
        if (!rendered) {
          return {
            content: summaryText,
            details: { file: input.file, sha256: document.sha256, format: 'ax', mode, rendered: false },
          }
        }
        return {
          content: summaryText,
          contentBlocks: [
            { type: 'text', text: summaryText },
            {
              type: 'image',
              source: { type: 'base64', mediaType: rendered.mediaType, data: rendered.base64 },
            },
          ],
          details: {
            file: input.file,
            sha256: document.sha256,
            format: 'ax',
            mode,
            rendered: true,
            pageIndex: pageIndex + 1,
            scale: rendered.scale,
          },
        }
      }

      // ── code：该页的 TSX 骨架（组件恒等 + 原语 → CSS 变量） ──────────────────
      if (mode === 'code') {
        const pageInput = input.page
        const pageIndex = typeof pageInput === 'number'
          ? pageInput - 1
          : axDoc.pages.findIndex((page) => page.name === pageInput || page.id === pageInput)
        const target = pageIndex >= 0 ? axDoc.pages[pageIndex] : undefined
        if (!target) {
          const names = axDoc.pages.map((page, index) => `${index + 1}:${page.name ?? page.id}`)
          return {
            content: `design_query: page ${JSON.stringify(String(pageInput))} not found in ${input.file}. Pages: ${names.join(', ')}.`,
            details: { file: input.file, parsed: true, found: false },
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
            details: { file: input.file, parsed: true, found: false },
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
            file: input.file,
            sha256: document.sha256,
            format: 'ax',
            mode,
            pageIndex: pageIndex + 1,
            componentName: emitted.componentName,
            counts: emitted.counts,
            unresolved: emitted.unresolved as unknown as JsonValue,
          },
        }
      }

      if (mode === 'node') {
        const nodeId = typeof input.nodeId === 'string' ? input.nodeId : ''
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
            content: `design_query: node "${nodeId}" not found in ${input.file}.`,
            details: { file: input.file, parsed: true, found: false },
          }
        }
        const names = axComponentsUsed([found], [])
        const payload = {
          file: input.file,
          format: `ax@${axDoc.ax}`,
          mode,
          nodeId,
          node: found,
          components: inventoryOf(names),
          tokens: tokensOf([found]),
        }
        const { content, truncated } = truncateToByteBudget(JSON.stringify(payload, null, 2), maxBytesForInput)
        return {
          content,
          details: { file: input.file, sha256: document.sha256, format: 'ax', mode, found: true, truncated },
        }
      }

      // mode === 'page'：返回**已解析的规格**（token 字面值 + 作者视角的树 + 该页组件清单）。
      const pageInput = input.page
      const pageIndex = typeof pageInput === 'number'
        ? pageInput - 1
        : axDoc.pages.findIndex((page) => page.name === pageInput || page.id === pageInput)
      if (pageIndex < 0 || pageIndex >= axDoc.pages.length) {
        const names = axDoc.pages.map((page, index) => `${index + 1}:${page.name ?? page.id}`)
        return {
          content: `design_query: page ${JSON.stringify(String(pageInput))} not found in ${input.file}. Pages: ${names.join(', ')}.`,
          details: { file: input.file, parsed: true, found: false },
        }
      }
      const page = axDoc.pages[pageIndex]!
      const totalNodes = countAxNodes(page.tree)
      const componentsUsed = axComponentsUsed(page.tree, [])
      const payloadOf = (tree: AxNode[], truncated?: { keptNodes: number; omittedNodes: number }) => ({
        file: input.file,
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
        components: inventoryOf(componentsUsed),
        tokens: tokensOf(page.tree),
        tree,
        counts: { nodes: totalNodes, ...(truncated ? { keptNodes: truncated.keptNodes } : {}) },
        ...(truncated ? { truncated: { omittedNodes: truncated.omittedNodes } } : {}),
      })
      const full = JSON.stringify(payloadOf(page.tree), null, 2)
      if (new TextEncoder().encode(full).length <= maxBytesForInput) {
        return {
          content: full,
          details: { file: input.file, sha256: document.sha256, format: 'ax', mode: 'page', pageIndex: pageIndex + 1, truncated: false },
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
        if (new TextEncoder().encode(candidate).length <= maxBytesForInput) {
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
          file: input.file,
          sha256: document.sha256,
          format: 'ax',
          mode: 'page',
          pageIndex: pageIndex + 1,
          truncated: true,
          omittedNodes: totalNodes - best,
        },
      }
    }

    const result = parsePenDocument(source, input.file)
    if (result.document === null) {
      // 解析完全失败：把错误原样回传，模型按「写后自查」步骤修复 JSON。
      return {
        content: `design_query: failed to parse ${input.file}: ${result.error ?? 'unknown parse error'}`,
        details: { file: input.file, sha256: document.sha256, parsed: false },
      }
    }
    const doc = result.document
    const maxBytes = typeof input.maxBytes === 'number' ? input.maxBytes : DEFAULT_MAX_BYTES

    // 无 page 且无 nodeId：返回页级摘要（页名/根 id），引导模型再按子树查询。
    if (input.page === undefined && input.nodeId === undefined) {
      const summary = doc.pages.map((page, index) => ({
        index: index + 1,
        name: pageNameOf(page),
      }))
      const pages = summary as unknown as JsonValue
      return {
        content: JSON.stringify({ file: input.file, pages: summary }, null, 2),
        details: { file: input.file, sha256: document.sha256, pages },
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
          content: `design_query: node "${input.nodeId}" not found in ${input.file}.`,
          details: { file: input.file, parsed: true, found: false },
        }
      }
      const json = JSON.stringify(found, null, 2)
      const { content, truncated } = truncateToByteBudget(json, maxBytes)
      return {
        content,
        details: {
          file: input.file,
          sha256: document.sha256,
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
        content: `design_query: page ${JSON.stringify(String(pageInput))} not found in ${input.file}. Pages: ${names.join(', ')}.`,
        details: { file: input.file, parsed: true, found: false },
      }
    }
    const page = doc.pages[pageIndex]
    const json = JSON.stringify(page, null, 2)
    const { content, truncated } = truncateToByteBudget(json, maxBytes)
    return {
      content,
      details: {
        file: input.file,
        sha256: document.sha256,
        found: true,
        truncated,
        pageIndex: pageIndex + 1,
      },
    }
  },
})

export const designQueryTool = createDesignQueryTool(desktopAgentEnvironment)
