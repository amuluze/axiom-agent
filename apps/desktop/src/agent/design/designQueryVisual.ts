import type { AgentToolResult, JsonValue } from '@/agent/core/types'
import { UNSUPPORTED_IMAGE_NOTE } from '@/agent/core/stripUnsupportedImages'
import { parsePenDocument, type PenDocument } from '@/agent/design/penParser'
import { parseAxDocument, projectAxToPenDocument } from '@/agent/design/axParser'
import type {
  DesignComponentDetail,
  DesignComponentSummary,
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
  COMPARE_PASS_RATIO_SAME_ENGINE,
  PIXEL_THRESHOLD,
  compareRgba,
  compareVerdictOf,
  scaleRgba,
} from '@/agent/design/visualCompare'
import { extractScanPages, scanDesignPages, type DesignScanRenderPage } from '@/agent/design/designScan'
import { designBrowserCommand } from '@/agent/design/designBrowserHost'
import {
  axComponentsUsed,
  countAxNodes,
  tokenParityOf,
  truncateToByteBudget,
} from '@/agent/design/designQueryProjection'
import {
  axPageIndex,
  inventoryOf,
  type AxModeContext,
} from '@/agent/design/designQueryContext'
import {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_SCAN_THUMBNAIL_BYTES,
  isAxFile,
  MAX_IMAGE_MAX_BYTES,
} from '@/agent/design/designQueryLimits'

/**
 * `design_query` 的视觉模式（E3 切片）：scan / render / compare。
 *
 * 副作用集中在宿主渲染与浏览器截图接缝；调用方按需动态导入本模块，避免把
 * 光栅化链路塞进启动主包。
 */

/** scan 模式最多回传的缩略图张数（只给 warn 页；fail 页没有图，ok 页不需要看）。 */
const MAX_SCAN_THUMBNAILS = 4

/**
 * 非视觉模型的产图降级说明：图片内容块对读不懂它的模型只是废负载（部分
 * provider 直接 400），显式降级并保留文字侧全部信息，比假装出图更可用。
 * 与请求侧降级共用同一占位子串（Domain 不变量 4：措辞跨工具/跨请求一致，
 * 模型据此能区分「我看不到图」与「图里没有内容」），且不泄漏内部字段名。
 */
const IMAGE_UNSUPPORTED_NOTE = `${UNSUPPORTED_IMAGE_NOTE}。这是模型能力所限（当前模型不接受图片输入），不是环境没有渲染能力；需要视觉自查请切换到视觉模型。`

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
  input: { file: string; workspacePath?: string; page?: string | number; maxBytes?: number; imageMaxBytes?: number; modelAcceptsImage?: boolean },
  sha256: string,
  options: {
    projectBrowserCommand?: import('@/platform/projectDesignPreview').ProjectPreviewBrowserCommand
    componentInventory: DesignComponentSummary[]
    projectPreview?: import('./projectPreview').ProjectDesignPreview
    projectComponents?: DesignComponentDetail[]
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
    doc.axDocument = parsed.document
    doc.axSource = options.projectComponents?.length ? source : undefined
    axTokens = parsed.document.tokens
  } else {
    // 工具面只接受 `.ax`（designQueryTool 的 file 校验），本分支仅服务仍持有 `.pen`
    // 视图模型的内部调用。它不得成为第二个格式入口：新增调用方前必须确认不违反
    // 「`.pen` 只能经 design_import 迁移」。（不变量 1）
    const parsed = parsePenDocument(source, input.file)
    if (!parsed.document) {
      return {
        content: `design_query: failed to parse ${input.file}: ${parsed.error ?? 'unknown parse error'}`,
        details: { file: input.file, sha256, parsed: false },
      }
    }
    doc = parsed.document
  }

  doc.workspacePath = input.workspacePath
  doc.projectComponents = options.projectComponents
  doc.projectPreview = options.projectPreview
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
        projectBrowserCommand: options.projectBrowserCommand,
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
      ...(page.renderReason !== undefined ? { renderReason: page.renderReason } : {}),
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
      componentInventory: context.inventory,
      projectComponents: context.projectComponents,
      projectPreview: context.projectPreview,
      projectBrowserCommand: context.projectBrowserCommand,
      fileName: context.file,
      workspacePath: context.workspacePath,
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

/** ── .ax compare：设计页 ↔ 实现路由的像素对拍（docs/ax-format.md §4.6）──────── */
// 编排：设计侧走 render 宿主链（默认 WKWebView 渲染），实现侧经浏览器工具同一条
// 平台通道截图（隔离 Chromium）——两张 PNG 解码成 RGBA 后以设计渲染尺寸为
// 基准归一、pixelmatch 对拍。判定 advisory 且永不 fail：跨引擎字体光栅化存在
// 基线噪声，本对拍度量的是量级与差异定位，不是像素级回归门禁。
// via=preview（1.5 同引擎档）：设计侧强制走 design:preview 隔离 Chromium（身份握手
// 复用），两侧同引擎后阈值收紧到 0.5%；服务未配置回落跨引擎档并在结果注明。
const DEFAULT_COMPARE_WAIT_MS = 800
const MAX_COMPARE_WAIT_MS = 15_000

const compareFailure = (
  context: AxModeContext,
  stage: 'render' | 'browser' | 'decode' | 'geometry',
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
  input: { page: string | number; url: string; waitMs?: number; via?: 'preview' },
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

  // 同引擎档判定：via=preview 且目录已配置 preview 服务才生效；服务缺失回落跨引擎
  // 档（现行为）并在结果注明——「运行失败」不算缺失，配置了就按失败透传原因。
  const viaPreview = input.via === 'preview'
  const previewConfigured = context.projectPreview !== undefined
    && (context.projectComponents?.length ?? 0) > 0
  const sameEngine = viaPreview && previewConfigured
  const passRatio = sameEngine ? COMPARE_PASS_RATIO_SAME_ENGINE : COMPARE_PASS_RATIO

  // 设计侧：与 mode=render 同一条宿主渲染链；预算取上限尽量保持 1:1 像素。
  // 同引擎档带 forceProjectPreview：即使页面不含项目组件也走 design:preview 隔离
  // Chromium（身份握手已有），不落 WKWebView/foreignObject 管线。
  if (!canRenderDesignPage()) {
    return compareFailure(context, 'render', '当前环境无设计页渲染能力（渲染接缝未注入）')
  }
  const rendered = await renderDesignPage({
    source: context.source,
    componentInventory: context.inventory,
    projectComponents: context.projectComponents,
    projectPreview: context.projectPreview,
    projectBrowserCommand: context.projectBrowserCommand,
    fileName: context.file,
    workspacePath: context.workspacePath,
    pageIdOrIndex: target.id,
    maxBytes: MAX_IMAGE_MAX_BYTES,
    ...(sameEngine ? { forceProjectPreview: true } : {}),
  })
  if (!rendered) {
    return compareFailure(context, 'render', '当前环境无设计页渲染能力（渲染接缝未注入）')
  }
  if ('ok' in rendered) {
    return compareFailure(context, 'render', `设计页渲染失败：${rendered.reason}`)
  }

  // 实现侧：经浏览器工具同一条平台通道（启用门控/隔离 profile 语义一致）。
  // 视口按设计页尺寸设置，截图即与设计稿同一坐标系；结束时关掉本次打开的 tab。
  // 实现路由截图走宿主浏览器通道（默认 = 用户浏览器面板的隔离实例；projectBrowserCommand
  // 仅供测试注入）。Agent 独立浏览器通道已随会话能力预设清理移除。
  const browser = context.projectBrowserCommand ?? designBrowserCommand
  let shot: { base64: string; width: number; height: number }
  let tabId = ''
  try {
    const opened = await browser({ action: 'newTab', url: input.url })
    if (opened.type !== 'tabOpened') throw new Error('打开页面未返回 tab')
    tabId = opened.tab.tabId
    await browser({ action: 'setViewport', tabId, width: pageWidth, height: pageHeight })
    await browser({
      action: 'wait',
      tabId,
      durationMs: Math.min(MAX_COMPARE_WAIT_MS, Math.max(1, input.waitMs ?? DEFAULT_COMPARE_WAIT_MS)),
    })
    const screenshot = await browser({ action: 'screenshot', tabId })
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
      await browser({ action: 'closeTab', tabId }).catch(() => undefined)
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
  const expectedHeight = implementationImage.width * designImage.height / designImage.width
  if (!Number.isFinite(expectedHeight) || Math.abs(implementationImage.height - expectedHeight) > 1) {
    return compareFailure(context, 'geometry', '设计与实现截图的宽高比不一致，不能拉伸后判定匹配；请确认视口尺寸、截图范围与页面加载状态后重试')
  }
  const diff = compareRgba(designImage, scaleRgba(implementationImage, designImage.width, designImage.height))
  const verdict = compareVerdictOf(diff.ratio, passRatio)
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
      passRatio: Number((passRatio * 100).toFixed(1)),
    },
    ...(diff.bounds ? { bounds: diff.bounds } : {}),
    // 档位显式：same = 设计侧经 design:preview 隔离 Chromium（同引擎，阈值 0.5%）；
    // cross = 设计侧 WKWebView/foreignObject（跨引擎，阈值 5%）。via=preview 请求了
    // 但服务未配置时回落 cross 并注明，不静默按同引擎档判定。
    ...(input.via !== undefined ? { via: input.via } : {}),
    engine: sameEngine ? 'same' as const : 'cross' as const,
    ...(viaPreview && !previewConfigured
      ? { fallback: '未配置 design:preview 服务（项目目录 preview.url），回落跨引擎档（阈值 5%）' }
      : {}),
    verdict,
    note: sameEngine
      ? 'advisory：设计侧与实现侧同为隔离 Chromium（design:preview），跨引擎字体噪声消失，判定阈值收紧到 0.5%——warn 即布局级差异，按 bounds 定位后核对两张图再决定改稿还是改实现'
      : 'advisory：设计侧在 WKWebView 渲染、实现侧截图来自隔离 Chromium，跨引擎字体光栅化有基线噪声（文本页常见 1-3% 微差）；量级与 bounds 才是决策依据——warn 时先按 bounds 定位差异区域核对两张图，再决定改稿还是改实现；需要更严判定可配置 design:preview 后传 via=preview 走同引擎档（阈值 0.5%）',
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
      engine: sameEngine ? 'same' : 'cross',
      verdict,
      mismatchedPixels: diff.mismatchedPixels,
      truncated,
    },
  }
}
