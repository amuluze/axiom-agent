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
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { CSSProperties } from 'react'
import { parseAxDocument, projectAxToPenDocument } from '@/agent/design/axParser'
import type { AxDocument } from '@/agent/design/axSchema'
import type {
  DesignPageRenderRequest,
  DesignPageRenderResult,
  DesignScanPageRenderRequest,
  DesignScanPageRenderResult,
} from '@/agent/design/designRenderHost'
import { useUiStore } from '@/stores/uiStore'
import type { PenDocument, PenNode } from '@/agent/design/penParser'
import PenNodeView from '../PenNodeView'
import CanvasErrorBoundary from '../CanvasErrorBoundary'
import { renderPageToPngBase64, renderPageToPngWithStats } from '../exportPagePng'
import { captureMountedPage, nativeCaptureSupported } from '../nativePageCapture'

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
  container.style.cssText = options.mode === 'capture'
    ? `position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:${background};`
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
  const element = container.firstElementChild as HTMLElement | null
  if (!element) {
    root.unmount()
    container.remove()
    return {
      mounted: null,
      error: renderError
        ? `渲染树为空（React 未捕获错误：${renderError}）`
        : '渲染树为空（React 未提交任何内容）',
    }
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
  options: { mode?: 'offscreen' | 'capture' } = {},
): Promise<MountOutcome> => {
  const projection = projectAxToPenDocument(axDocument, 'render.ax').document
  if (!projection) return { mounted: null, error: '文档投影失败' }
  return mountPenPageElement(projection, pageIdOrIndex, themeMode, options)
}

/** 宿主提供者实现：挂载 → 光栅化（原生截图优先，foreignObject 回退）→ 拆容器。 */
export const renderAxPageToPng = async (
  request: DesignPageRenderRequest,
): Promise<DesignPageRenderResult | null> => {
  const parsed = parseAxDocument(request.source)
  if (!parsed.document) return null
  const themeMode = currentThemeMode()
  const native = await nativeCaptureSupported()
  const { mounted, error } = await mountAxPageElement(parsed.document, request.pageIdOrIndex, themeMode, {
    mode: native ? 'capture' : 'offscreen',
  })
  if (!mounted) {
    console.error('[renderPageHost] 页面挂载失败：', error)
    return null
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
    for (const scale of SCALE_LADDER) {
      const base64 = await renderPageToPngBase64(mounted.element, { background, scale })
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
    return null
  } catch (error) {
    // 观测点：渲染模式的降级文案较简（无渲染能力/超预算），细节落 console 供诊断。
    console.error('[renderPageHost] 页面渲染失败：', error)
    return null
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
