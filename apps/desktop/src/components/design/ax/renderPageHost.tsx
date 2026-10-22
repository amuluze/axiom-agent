/**
 * 「渲染回读」的宿主实现（docs/ax-format.md §4.6）：把 `.ax` 的一页**离屏渲染**
 * 成 PNG，作为 image 内容块回给模型自查。
 *
 * 关键设计：
 * 1. **与画布同源**：离屏渲染走的是同一套投影（`projectAxToPenDocument`）+ 同一个
 *    `PenNodeView`（含真组件渲染），所以模型看到的图就是画布上的样子——这是"自查"
 *    成立的前提。
 * 2. **离屏但不隐藏**：容器定位在视口外（`position: fixed; left: -100000px`），而不是
 *    `display: none`——后者没有布局、量不到尺寸也拿不到计算样式，光栅化会是空白。
 * 3. **按预算降采样**：先 1:1、超预算退 2×→1×→0.5× 逐级降，仍超则返回 null 让工具
 *    显式降级（不静默返回巨图把上下文撑爆）。
 * 4. **用完即拆**：React root unmount + 容器移除（渲染是副作用，不能留在 DOM 里）。
 */
import { renderProjectDesignPreview } from '@/platform/projectDesignPreview'
import { pageUsesProjectComponents } from '@/agent/design/projectPreview'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { CSSProperties } from 'react'
import { parseAxDocument, projectAxToPenDocument } from '@/agent/design/axParser'
import type { AxDocument } from '@/agent/design/axSchema'
import type { DesignComponentDetail } from '@/agent/design/componentInventoryHost'
import {
  setDesignScanRenderConcurrency,
  type DesignPageRenderFailure,
  type DesignPageRenderRequest,
  type DesignPageRenderResult,
  type DesignScanPageRenderRequest,
  type DesignScanPageRenderResult,
} from '@/agent/design/designRenderHost'
import type { RgbaImage } from '@/agent/design/visualCompare'
import { useUiStore } from '@/stores/uiStore'
import type { PenDocument, PenNode } from '@/agent/design/penParser'
import PenNodeView from '../PenNodeView'
import { axComponentInventorySummary } from './registry'
import CanvasErrorBoundary from '../CanvasErrorBoundary'
import { renderPageToPngBase64, renderPageToPngWithStats, sampleCanvasPixels } from '../exportPagePng'
import { captureMountedPage, nativeCaptureSupported } from '../nativePageCapture'

function captureProjectPage(input: Parameters<typeof renderProjectDesignPreview>[0], scan: true): Promise<DesignScanPageRenderResult>
function captureProjectPage(input: Parameters<typeof renderProjectDesignPreview>[0], scan?: false): Promise<DesignPageRenderResult | DesignPageRenderFailure>
async function captureProjectPage(input: Parameters<typeof renderProjectDesignPreview>[0], scan = false): Promise<DesignScanPageRenderResult | DesignPageRenderResult | DesignPageRenderFailure> {
  const captured = await renderProjectDesignPreview({ ...input, maxBytes: 6 * 1024 * 1024 })
  if ('ok' in captured) return captured
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image()
    element.onload = () => resolve(element)
    element.onerror = () => reject(new Error('项目预览 PNG 解码失败'))
    element.src = `data:image/png;base64,${captured.base64}`
  })
  let statistics: ReturnType<typeof sampleCanvasPixels> | undefined
  for (const factor of [1, 0.5, 0.25]) {
    const canvas = window.document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(captured.width * factor))
    canvas.height = Math.max(1, Math.round(captured.height * factor))
    const context = canvas.getContext('2d')
    if (!context) return { ok: false, reason: '无法创建项目预览图像上下文' }
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    statistics ??= sampleCanvasPixels(canvas)
    const base64 = factor === 1 ? captured.base64 : canvas.toDataURL('image/png').split(',')[1] ?? ''
    if (base64.length <= input.maxBytes) {
      const result = { ...captured, base64, width: canvas.width, height: canvas.height, scale: captured.scale * factor }
      return scan ? { ...result, ...statistics, ok: true } : result
    }
  }
  return scan ? { ok: true, width: captured.width, height: captured.height, scale: captured.scale, pageName: captured.pageName, ...statistics }
    : { ok: false, reason: '项目预览截图超过图片预算，请调大 imageMaxBytes' }
}

/** 降采样阶梯（设计稿像素倍率）。 */
const SCALE_LADDER = [2, 1, 0.5] as const

const prefersDark = (): boolean =>
  typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-color-scheme: dark)').matches

/** 当前画布主题（与 useCanvasThemeMode 同口径，但本模块在 React 之外调用）。 */
const currentThemeMode = (): 'light' | 'dark' => {
  const theme = useUiStore.getState().theme
  if (theme === 'light' || theme === 'dark') return theme
  return prefersDark() ? 'dark' : 'light'
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 0)
  })

/** 非帧同步的等待节拍（`setTimeout` 宏任务）。 */
const waitTick = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * 等 React 首次提交（有界等待）。
 *
 * 并发渲染下首次提交可能晚于两帧——页越重、扫描的并发 lane 越明显。只采样一次会把
 * 合法页误判成「渲染树为空」，而这是**错误级**判定（整页 fail，模型会据此去「修」没坏
 * 的页）。已提交立即返回，只有持续为空才判失败；失败路径才付这段等待。
 *
 * 轮询**刻意不用 `requestAnimationFrame`**：WKWebView 在窗口不可见/被遮挡时会把 rAF
 * 节流到 1Hz 甚至暂停，帧同步的等待就变成不可控的长等待（挂载卡住，而不是按预算判
 * 失败）。`setTimeout` 的节奏不受可见性影响，等待时长因此可预期。
 */
const COMMIT_WAIT_BUDGET_MS = 2_000
const COMMIT_POLL_MIN_MS = 16
const COMMIT_POLL_MAX_MS = 200

/** 首次提交等待的过程数据（失败原因里回显，便于区分「页没提交」与「等得不够」）。 */
export interface CommitWaitOutcome {
  attempts: number
  elapsedMs: number
}

export const waitForCommittedTree = async (
  container: HTMLElement,
  options: { budgetMs?: number; outcome?: CommitWaitOutcome } = {},
): Promise<HTMLElement | null> => {
  const budgetMs = options.budgetMs ?? COMMIT_WAIT_BUDGET_MS
  const startedAt = Date.now()
  const outcome = options.outcome ?? { attempts: 0, elapsedMs: 0 }
  let attempts = 0
  for (;;) {
    const element = container.firstElementChild as HTMLElement | null
    outcome.attempts = attempts
    outcome.elapsedMs = Date.now() - startedAt
    if (element) return element
    if (outcome.elapsedMs >= budgetMs) return null
    attempts += 1
    // 递增退避（16 → 200ms）：早期轮询密（提交通常几毫秒内到），后期稀疏——不与主
    // 线程上的光栅化/截图抢时间片。
    await waitTick(Math.min(COMMIT_POLL_MAX_MS, COMMIT_POLL_MIN_MS * 2 ** Math.min(attempts - 1, 4)))
  }
}

export interface MountedPage {
  element: HTMLElement
  pageName: string
  width: number
  height: number
  /** capture 模式的等比适配缩放（offscreen 恒为 1）。 */
  fitScale: number
  /** 卸载 React root 并移除容器（必须调用）。 */
  dispose: () => void
}

/** 挂载结果：mounted 为 null 时 error 给出可读原因（含渲染期捕获的真实错误）。 */
export interface MountOutcome {
  mounted: MountedPage | null
  error?: string
}

const pageIndexOf = (
  pages: readonly { id: string }[],
  pageIdOrIndex: string | number,
): number => {
  if (typeof pageIdOrIndex === 'number') return pageIdOrIndex - 1
  return pages.findIndex((page) => (
    page.id === pageIdOrIndex
    || ('name' in page && typeof page.name === 'string' && page.name === pageIdOrIndex)
  ))
}

/**
 * 从**解析/投影后的 PenDocument** 离屏挂载一页（`.pen` 解析产物与 `.ax` 投影共用
 * 同一视图模型，扫描验证因此对两种格式走同一条路）。页 id/序号都接受。
 *
 * mode='capture'：**可见挂载**（原生截图的前提——WKWebView takeSnapshot 只能截取
 * 当前视口）：容器铺满视口、不透明底、页面等比缩放适配居中；返回的 element 即页面
 * 根（getBoundingClientRect 为适配后的可视矩形，供截图 rect 传参）。
 * mode='offscreen'（缺省）：视口外挂载，供 foreignObject 管线量取计算样式。
 */
export const mountPenPageElement = async (
  doc: PenDocument,
  pageIdOrIndex: string | number,
  themeMode: 'light' | 'dark' = currentThemeMode(),
  options: { mode?: 'offscreen' | 'capture' } = {},
): Promise<MountOutcome> => {
  const pageIndex = pageIndexOf(doc.pages, pageIdOrIndex)
  const page = pageIndex >= 0 ? doc.pages[pageIndex] : undefined
  if (!page) return { mounted: null, error: `页面不存在：${String(pageIdOrIndex)}` }
  const frame = page as PenNode
  const externalNames = new Set(doc.projectComponents?.map((entry) => entry.summary.name))
  const hasExternal = (node: PenDocument['pages'][number]): boolean =>
    (node.type === 'component' && externalNames.has(node.name)) || ('children' in node && (node.children ?? []).some(hasExternal))
  if (hasExternal(page)) return { mounted: null, error: '项目组件尚无隔离的运行预览，请在项目开发服务中验证；目录仅提供类型契约' }
  const width = typeof frame.width === 'number' ? frame.width : 0
  const height = typeof frame.height === 'number' ? frame.height : 0
  if (width <= 0 || height <= 0) {
    return { mounted: null, error: `页面没有有效尺寸（${width}×${height}）` }
  }

  const background = doc.modeVariables[themeMode]['bg-main'] ?? '#ffffff'
  const variableStyle: Record<string, string> = {}
  for (const [name, value] of Object.entries(doc.modeVariables[themeMode])) {
    variableStyle[`--${name}`] = value
  }
  const container = window.document.createElement('div')
  container.setAttribute('data-ax-render-host', '')
  // capture 模式必须**可见**（takeSnapshot 只截当前视口）：铺满视口 + 不透明底，
  // 避免截图混入应用其它 UI；offscreen 模式沿用视口外定位（display:none 无布局）。
  // pointer-events:none 让遮罩期间的点击穿透到下层 UI——扫描的 staging 回退是
  // 连续多页的遮罩闪烁，吞掉输入等于用户「想停也停不了」。
  container.style.cssText = options.mode === 'capture'
    ? `position:fixed;inset:0;z-index:2147483000;pointer-events:none;display:flex;align-items:center;justify-content:center;background:${background};`
    : 'position:fixed;left:-100000px;top:0;pointer-events:none;'
  window.document.body.appendChild(container)
  // capture 模式等比缩放适配视口（Retina 截图仍是 2× 像素，缩略图预算足够）。
  const fitScale = options.mode === 'capture'
    ? Math.min(1, window.innerWidth / width, window.innerHeight / height)
    : 1
  // React 19 渲染期未捕获错误会**卸载整棵树**（容器变空、React 静默）——根选项把
  // 真实错误带出来，配合根级错误边界（兜住后渲染错误卡片而非空树），调用方拿到
  // 的不再是裸 null。
  let renderError: string | null = null
  const root: Root = createRoot(container, {
    onUncaughtError(error) {
      renderError = error instanceof Error ? error.message : String(error)
    },
  })
  root.render(
    <CanvasErrorBoundary title="页面渲染失败" retryLabel="重试">
      <div
        data-theme-mode={themeMode}
        style={{
          ...(variableStyle as CSSProperties),
          width,
          height,
          background,
          position: 'relative',
          overflow: 'hidden',
          flex: '0 0 auto',
          ...(fitScale < 1 ? { transform: `scale(${fitScale})`, transformOrigin: 'center center' } : {}),
        }}
      >
        <PenNodeView node={page} document={doc} themeMode={themeMode} />
      </div>
    </CanvasErrorBoundary>
  )
  // 两帧 + 字体就绪：等 React 提交与样式计算落地（真组件里还有异步资产，尽力而为）。
  // fonts.ready 在字体被 CSP 拦截等场景可能长期不落定——限时 3s 兜底，不拖死扫描。
  await nextFrame()
  await nextFrame()
  if (typeof window.document.fonts?.ready?.then === 'function') {
    await Promise.race([
      window.document.fonts.ready,
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ])
  }
  const commitWait: CommitWaitOutcome = { attempts: 0, elapsedMs: 0 }
  const element = await waitForCommittedTree(container, { outcome: commitWait })
  if (!element) {
    // 失败原因带上过程数据：区分「页面确实没提交」与「等待预算不够」——前者要修稿或
    // 修组件，后者只是这一次没赶上，模型不该据此去改没坏的页。
    const reason = renderError
      ? `渲染树为空（React 未捕获错误：${renderError}）`
      : `渲染树为空（React 未提交任何内容；等待 ${commitWait.elapsedMs}ms、轮询 ${commitWait.attempts} 次后仍无子节点，visibility=${window.document.visibilityState}）`
    root.unmount()
    container.remove()
    return { mounted: null, error: reason }
  }
  return {
    mounted: {
      element,
      pageName: 'name' in frame && typeof frame.name === 'string' ? frame.name : frame.id,
      width,
      height,
      fitScale,
      dispose: () => {
        root.unmount()
        container.remove()
      },
    },
  }
}

/**
 * 离屏挂载一页（不涉及光栅化，可在 jsdom 下测）：返回承载该页的 DOM 元素，
 * 交给 `renderPageToPngBase64` 或测试断言。页 id/序号都接受。
 */
export const mountAxPageElement = async (
  axDocument: AxDocument,
  pageIdOrIndex: string | number,
  themeMode: 'light' | 'dark' = currentThemeMode(),
  options: { mode?: 'offscreen' | 'capture'; fileName?: string; workspacePath?: string; projectComponents?: DesignComponentDetail[] } = {},
): Promise<MountOutcome> => {
  const projection = projectAxToPenDocument(axDocument, options.fileName ?? 'render.ax').document
  if (!projection) return { mounted: null, error: '文档投影失败' }
  projection.workspacePath = options.workspacePath
  projection.projectComponents = options.projectComponents
  return mountPenPageElement(projection, pageIdOrIndex, themeMode, options)
}

/** 宿主提供者实现：挂载 → 光栅化（原生截图优先，foreignObject 回退）→ 拆容器。
 * 失败一律返回 ok:false + 可读原因（解析/挂载/光栅化/预算各有措辞），不再静默归
 * null——工具据此把「这一次为什么没渲染出来」透传给模型，而非笼统报无渲染器。 */
export const renderAxPageToPng = async (
  request: DesignPageRenderRequest,
): Promise<DesignPageRenderResult | DesignPageRenderFailure | null> => {
  const parsed = parseAxDocument(request.source, { componentInventory: request.componentInventory ?? axComponentInventorySummary() })
  if (!parsed.document) {
    const detail = parsed.error
      ?? parsed.diagnostics
        .filter((item) => item.level === 'error')
        .map((item) => `${item.path ?? '?'}: ${item.message}`)
        .join('; ')
    return { ok: false, reason: `设计稿解析失败：${detail || '未知错误'}` }
  }
  const themeMode = currentThemeMode()
  const index = pageIndexOf(parsed.document.pages, request.pageIdOrIndex)
  const externalPage = parsed.document.pages[index]
  // compare via=preview 的同引擎档：显式旗标强制走 design:preview 隔离 Chromium——
  // 即使页面不含项目组件（纯原语页也经项目运行时渲染），两侧同引擎后判定阈值收紧。
  // 服务未配置时由调用方先判定回落；配置了但运行失败照常返回 ok:false + 原因。
  if (request.forceProjectPreview && externalPage) {
    return await captureProjectPage({ command: request.projectBrowserCommand, workspacePath: request.workspacePath, preview: request.projectPreview, file: request.fileName, source: request.source,
      page: externalPage, theme: themeMode, maxBytes: request.maxBytes })
  }
  if (externalPage && pageUsesProjectComponents(externalPage.tree, request.projectComponents)) {
    return await captureProjectPage({ command: request.projectBrowserCommand, workspacePath: request.workspacePath, preview: request.projectPreview, file: request.fileName, source: request.source,
      page: externalPage, theme: themeMode, maxBytes: request.maxBytes })
  }
  const native = await nativeCaptureSupported()
  const { mounted, error } = await mountAxPageElement(parsed.document, request.pageIdOrIndex, themeMode, {
    mode: native ? 'capture' : 'offscreen',
    fileName: request.fileName,
    workspacePath: request.workspacePath,
    projectComponents: request.projectComponents,
  })
  if (!mounted) {
    return { ok: false, reason: `页面挂载失败：${error ?? '未知原因'}` }
  }
  try {
    // 原生路径（WKWebView）：Webkit 污染含 foreignObject 的 SVG 画布，唯一可靠光栅化源。
    if (native) {
      const captured = await captureMountedPage(mounted.element, mounted.width, mounted.height, {
        maxBytes: request.maxBytes,
      })
      return {
        base64: captured.base64,
        mediaType: 'image/png',
        width: captured.width,
        height: captured.height,
        scale: captured.scale,
        pageName: mounted.pageName,
      }
    }
    // foreignObject 回退（浏览器 dev / Chromium）：按预算降采样。
    const background = getComputedStyle(mounted.element).backgroundColor || '#ffffff'
    let smallest = ''
    for (const scale of SCALE_LADDER) {
      const base64 = await renderPageToPngBase64(mounted.element, { background, scale })
      smallest = base64
      // base64 字符数 ≈ 字节数（PNG 是 8bit 二进制，base64 后 4/3 膨胀）。
      if (base64.length <= request.maxBytes) {
        return {
          base64,
          mediaType: 'image/png',
          width: Math.round(mounted.width * scale),
          height: Math.round(mounted.height * scale),
          scale,
          pageName: mounted.pageName,
        }
      }
    }
    return { ok: false, reason: `PNG 超出图片预算：最小档倍率仍 ${smallest.length} > ${request.maxBytes} 字符（可调大 imageMaxBytes 重试）` }
  } catch (error) {
    return { ok: false, reason: `光栅化失败：${error instanceof Error ? error.message : String(error)}` }
  } finally {
    mounted.dispose()
  }
}

/**
 * 扫描验证的缩放阶梯：缩略图不求清晰，从 1× 起步逐级减半——整稿扫描逐页光栅化，
 * 控制单页成本比控制保真度更重要。
 */
const SCAN_SCALE_LADDER = [1, 0.5, 0.25] as const

/**
 * 扫描验证的扫描渲染并发度：native 截图走 capture 模式挂载（容器铺满视口），
 * 并行会互相污染截图，必须串行；offscreen（foreignObject）容器各自独立在
 * 视口外，3 路并行安全。探测结果有缓存（nativeCaptureSupported）。
 */
export const configureScanRenderConcurrency = (): void => {
  void nativeCaptureSupported().then((native) => {
    setDesignScanRenderConcurrency(native ? 1 : 3)
  })
}

/**
 * 扫描验证的单页渲染实现（main.tsx 注入 `setDesignScanPageRenderProvider`）：
 * 挂载 → 光栅化（同趟采样像素统计供空白判定）→ 按预算降采样取缩略图。
 * 页面不存在 / 无尺寸返回 ok:false + 原因；全部倍率超预算时仍返回统计
 * （空白判定不受预算影响），只是不带缩略图。
 */
export const renderPenPageForScan = async (
  request: DesignScanPageRenderRequest,
): Promise<DesignScanPageRenderResult | null> => {
  const themeMode = currentThemeMode()
  const native = await nativeCaptureSupported()
  const pageIndex = pageIndexOf(request.doc.pages, request.pageIdOrIndex)
  const page = pageIndex >= 0 ? request.doc.pages[pageIndex] : undefined
  if (!page) {
    return { ok: false, reason: `页面不存在：${String(request.pageIdOrIndex)}` }
  }
  const frame = page as PenNode
  const width = typeof frame.width === 'number' ? frame.width : 0
  const height = typeof frame.height === 'number' ? frame.height : 0
  if (width <= 0 || height <= 0) {
    return { ok: false, reason: '页面没有有效尺寸' }
  }
  const axPage = request.doc.axDocument?.pages.find((entry) => entry.id === page.id)
  if (axPage && pageUsesProjectComponents(axPage.tree, request.doc.projectComponents)) {
    if (!request.doc.axSource) return { ok: false, reason: '项目预览缺少原始稿件，无法校验 SHA-256' }
    const rendered = await captureProjectPage({ command: request.projectBrowserCommand, workspacePath: request.doc.workspacePath, preview: request.doc.projectPreview, source: request.doc.axSource,
      file: request.doc.fileName, page: axPage, theme: themeMode, maxBytes: request.maxBytes }, true)
    return rendered
  }
  const mounted_ = await mountPenPageElement(request.doc, request.pageIdOrIndex, themeMode, {
    mode: native ? 'capture' : 'offscreen',
  })
  const mounted = mounted_.mounted
  if (!mounted) {
    // 原因可读：页不存在/无尺寸/渲染树为空（含 React 未捕获错误的具体信息）。
    return { ok: false, reason: `页面挂载失败：${mounted_.error ?? '未知原因'}` }
  }
  try {
    // 原生路径（WKWebView）：预算耗尽降级为「只有统计、无缩略图」（空白判定不受影响），
    // 与回退路径的超预算语义一致。
    if (native) {
      try {
        const captured = await captureMountedPage(mounted.element, mounted.width, mounted.height, {
          maxBytes: request.maxBytes,
          returnSmallestOnExhausted: true,
        })
        return {
          ok: true,
          base64: captured.base64,
          mediaType: 'image/png',
          width: captured.width,
          height: captured.height,
          scale: captured.scale,
          pageName: mounted.pageName,
          samples: captured.stats.samples,
          distinctColors: captured.stats.distinctColors,
          topColorFraction: captured.stats.topColorFraction,
        }
      } catch (error) {
        return {
          ok: false,
          reason: `原生截图失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
    const background = getComputedStyle(mounted.element).backgroundColor || '#ffffff'
    let stats: Awaited<ReturnType<typeof renderPageToPngWithStats>>['stats'] | undefined
    try {
      for (const scale of SCAN_SCALE_LADDER) {
        const rendered = await renderPageToPngWithStats(mounted.element, { background, scale })
        stats = rendered.stats
        if (rendered.base64.length <= request.maxBytes) {
          return {
            ok: true,
            base64: rendered.base64,
            mediaType: 'image/png',
            width: Math.round(mounted.width * scale),
            height: Math.round(mounted.height * scale),
            scale,
            pageName: mounted.pageName,
            samples: rendered.stats.samples,
            distinctColors: rendered.stats.distinctColors,
            topColorFraction: rendered.stats.topColorFraction,
          }
        }
      }
    } catch (error) {
      // 光栅化失败（SecurityError / 无 canvas / SVG 解析失败）：可读原因而不是静默 null。
      return {
        ok: false,
        reason: `光栅化失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    // 全部倍率超预算：统计仍有效（空白判定不依赖缩略图），缩略图缺省。
    return {
      ok: true,
      width: Math.round(mounted.width * SCAN_SCALE_LADDER[SCAN_SCALE_LADDER.length - 1]),
      height: Math.round(mounted.height * SCAN_SCALE_LADDER[SCAN_SCALE_LADDER.length - 1]),
      scale: SCAN_SCALE_LADDER[SCAN_SCALE_LADDER.length - 1],
      pageName: mounted.pageName,
      ...(stats
        ? {
          samples: stats.samples,
          distinctColors: stats.distinctColors,
          topColorFraction: stats.topColorFraction,
        }
        : {}),
    }
  } finally {
    mounted.dispose()
  }
}

/**
 * PNG → RGBA 解码实现（main.tsx 注入 `setPngDecodeProvider`，视觉对拍用）：
 * data: URL 加载（不污染画布）→ 1:1 绘制 → getImageData。解码失败归一 null。
 */
export const decodePngToRgbaHost = async (base64: string): Promise<RgbaImage | null> => {
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('PNG 解码失败'))
      element.src = `data:image/png;base64,${base64}`
    })
    const canvas = window.document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(image, 0, 0)
    const { width, height, data } = context.getImageData(0, 0, image.width, image.height)
    return { width, height, data }
  } catch {
    return null
  }
}

/**
 * 画布 PNG 导出的共享入口（DesignCanvas 导出按钮与工具渲染链同源）：原生截图优先，
 * 无原生能力（浏览器 dev）回退 foreignObject 管线。返回 base64（无 data URL 前缀）；
 * 页面不存在/无尺寸/渲染失败返回 null 或抛错由调用方提示。
 */
export const renderPenPageToPngBase64 = async (
  doc: PenDocument,
  pageIdOrIndex: string | number,
): Promise<string | null> => {
  const native = await nativeCaptureSupported()
  const themeMode = currentThemeMode()
  const page = doc.axDocument?.pages[pageIndexOf(doc.pages, pageIdOrIndex)]
  if (page && pageUsesProjectComponents(page.tree, doc.projectComponents)) {
    if (!doc.axSource) throw new Error('项目预览缺少原始稿件，无法校验 SHA-256')
    const result = await renderProjectDesignPreview({ workspacePath: doc.workspacePath, preview: doc.projectPreview, source: doc.axSource, file: doc.fileName,
      page, theme: themeMode, maxBytes: Number.MAX_SAFE_INTEGER })
    if ('ok' in result) throw new Error(result.reason)
    return result.base64
  }
  const { mounted } = await mountPenPageElement(doc, pageIdOrIndex, themeMode, {
    mode: native ? 'capture' : 'offscreen',
  })
  if (!mounted) return null
  try {
    if (native) {
      // 导出不设预算：Rust 侧 4 MiB 守卫已兜底，这里跳过降采样保住清晰度。
      const captured = await captureMountedPage(mounted.element, mounted.width, mounted.height, {
        maxBytes: Number.MAX_SAFE_INTEGER,
      })
      return captured.base64
    }
    const background = getComputedStyle(mounted.element).backgroundColor || '#ffffff'
    return await renderPageToPngBase64(mounted.element, { background, scale: 2 })
  } finally {
    mounted.dispose()
  }
}
