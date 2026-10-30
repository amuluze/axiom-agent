// @vitest-environment jsdom
/**
 * 画布原位扫掠（批量扫描路径）的回归测试：原生截图可用时（真机形态），
 * 可见性判定必须在**画布视口坐标系**里做——DOM 真值（getBoundingClientRect，
 * WebView 窗口坐标）要减去视口原点换算。jsdom 的 getBoundingClientRect 恒返回
 * 全 0，扫掠路径在既有测试里从未真正执行过；本文件用带窗口偏移的 stub rect
 * 复现真机布局（侧栏 + 顶栏偏移），锁死「平移居中的页判不可见 → 成片降级
 * staging → 用户等不到结果」的坐标系回归。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DesignCanvas from './DesignCanvas'
import { nativeCaptureSupported, captureRectStats } from './nativePageCapture'
import { renderPenPageForScan } from './ax/renderPageHost'
import { parsePenDocument } from '@/agent/design/penParser'
import { designScanBatchRenderer } from '@/agent/design/designRenderHost'
import { extractScanPages } from '@/agent/design/designScan'
import type { PenDocument } from '@/agent/design/penParser'
import type { AxDocument } from '@/agent/design/axSchema'
import type { DesignComponentDetail } from '@/agent/design/componentInventoryHost'
import { useUiStore } from '@/stores/uiStore'

vi.mock('./nativePageCapture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./nativePageCapture')>()
  return {
    ...actual,
    nativeCaptureSupported: vi.fn(async () => true),
    captureRectStats: vi.fn(async () => ({
      stats: { samples: 9600, distinctColors: 96, topColorFraction: 0.42 },
      width: 200,
      height: 120,
    })),
  }
})

// staging 回退探针：扫掠健康（页可见、原位采集）时不应被调用。
vi.mock('./ax/renderPageHost', () => ({
  renderPenPageForScan: vi.fn(async () => ({ ok: false as const, reason: 'staging 不应被调用' })),
  renderPenPageToPngBase64: vi.fn(async () => 'UE5HQkFTRTY0'),
}))

const SWEEP_PAGES = {
  version: '2.18',
  children: [
    {
      type: 'frame', id: 'page-1', name: '首页', x: 0, y: 0, width: 200, height: 120,
      children: [{ type: 'text', id: 't-1', content: '内容' }],
    },
    {
      type: 'frame', id: 'page-2', name: '设置', x: 320, y: 0, width: 200, height: 120,
      children: [{ type: 'text', id: 't-2', content: '内容' }],
    },
  ],
}

/** 侧栏/顶栏偏移（真机布局）：视口原点不在窗口 (0,0)。 */
const VIEWPORT_ORIGIN = { left: 260, top: 96 }
const VIEWPORT_SIZE = { width: 1024, height: 768 }

const domRect = (rect: { x: number; y: number; width: number; height: number }): DOMRect =>
  ({ x: rect.x, y: rect.y, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height, width: rect.width, height: rect.height, toJSON: () => ({}) }) as DOMRect

const stubRect = (element: Element, rect: { x: number; y: number; width: number; height: number }): void => {
  element.getBoundingClientRect = () => domRect(rect)
}

/** 按画布当前 transform 推导 DOM 真值：验证取景时矩形必须随缩放/平移变化。 */
const stubCanvasRect = (element: Element, rect: { x: number; y: number; width: number; height: number }): void => {
  element.getBoundingClientRect = () => {
    const surface = document.querySelector('[data-testid="design-canvas-surface"]') as HTMLElement
    const transform = /^translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)$/.exec(surface.style.transform)
    if (!transform) throw new Error(`无法解析画布 transform：${surface.style.transform}`)
    const offsetX = Number(transform[1])
    const offsetY = Number(transform[2])
    const scale = Number(transform[3])
    return domRect({
      x: VIEWPORT_ORIGIN.left + offsetX + rect.x * scale,
      y: VIEWPORT_ORIGIN.top + offsetY + rect.y * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    })
  }
}

describe('DesignCanvas 画布原位扫掠（原生截图路径）', () => {
  beforeEach(() => {
    vi.mocked(nativeCaptureSupported).mockClear()
    vi.mocked(captureRectStats).mockClear()
    vi.mocked(renderPenPageForScan).mockClear()
    useUiStore.setState({ requestComposerInsertion: vi.fn() })
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    })
  })

  it('窗口坐标系下视口内可见的页走原位采集：换算视口坐标，不降级、不成片「渲染检查未完成」', async () => {
    const parsed = parsePenDocument(JSON.stringify(SWEEP_PAGES), '.pen/axiom.pen')
    expect(parsed.document).not.toBeNull()
    render(<DesignCanvas doc={parsed.document as PenDocument} />)

    // 等原生探测生效（batchRender 才会被注入），再开扫描。
    await waitFor(() => expect(vi.mocked(nativeCaptureSupported).mock.calls.length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 20))

    // 视口（窗口坐标 260,96；尺寸 1024×768）。
    const viewport = document.querySelector('.design-canvas__viewport') as HTMLElement
    stubRect(viewport, { x: VIEWPORT_ORIGIN.left, y: VIEWPORT_ORIGIN.top, ...VIEWPORT_SIZE })
    // 页 1 视口坐标 (412,324) → 窗口 (672,420)；页 2 视口坐标 (620,324) →
    // 窗口 (880,420)——未换算时 880+200 > 1022 判不可见（bug 形态），换算后可见。
    // 两页矩形互不相交（612 < 620），不触发相交降级。
    stubRect(
      document.querySelector('[data-page-wrapper="page-1"]') as HTMLElement,
      { x: VIEWPORT_ORIGIN.left + 412, y: VIEWPORT_ORIGIN.top + 324, width: 200, height: 120 },
    )
    stubRect(
      document.querySelector('[data-page-wrapper="page-2"]') as HTMLElement,
      { x: VIEWPORT_ORIGIN.left + 620, y: VIEWPORT_ORIGIN.top + 324, width: 200, height: 120 },
    )

    fireEvent.click(screen.getByText('扫描验证'))
    const panel = await waitFor(() => {
      const element = document.querySelector('[data-testid="design-scan-panel"]')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    // 扫掠含光束停驻（~1s）：放宽 waitFor 超时。
    await waitFor(
      () => expect(panel.querySelectorAll('.design-scan__page')).toHaveLength(2),
      { timeout: 8000 },
    )
    // 两页都走原位采集（窗口坐标 → 截图 rect 仍用窗口真值），无 staging 降级。
    expect(vi.mocked(captureRectStats).mock.calls).toHaveLength(2)
    expect(vi.mocked(renderPenPageForScan)).not.toHaveBeenCalled()
    // 像素统计健康 → 两页 ok，无「渲染检查未完成」、无失败。
    expect(panel.querySelectorAll('.design-scan__page.is-ok')).toHaveLength(2)
    expect(panel.querySelectorAll('.design-scan__page.is-fail')).toHaveLength(0)
    expect(panel.textContent).not.toContain('渲染检查未完成')
    expect(panel.textContent).not.toContain('staging')
  })

  it('当前画布向会话暴露同一批量渲染器：设计扫描全程原位采集，不走全屏 staging', async () => {
    const parsed = parsePenDocument(JSON.stringify(SWEEP_PAGES), '.pen/axiom.pen')
    const doc = parsed.document as PenDocument
    doc.sha256 = 'd'.repeat(64)
    const { unmount } = render(<DesignCanvas doc={doc} />)
    await waitFor(() => expect(vi.mocked(nativeCaptureSupported).mock.calls.length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 20))

    const viewport = document.querySelector('.design-canvas__viewport') as HTMLElement
    stubRect(viewport, { x: VIEWPORT_ORIGIN.left, y: VIEWPORT_ORIGIN.top, ...VIEWPORT_SIZE })
    stubRect(
      document.querySelector('[data-page-wrapper="page-1"]') as HTMLElement,
      { x: VIEWPORT_ORIGIN.left + 412, y: VIEWPORT_ORIGIN.top + 324, width: 200, height: 120 },
    )
    stubRect(
      document.querySelector('[data-page-wrapper="page-2"]') as HTMLElement,
      { x: VIEWPORT_ORIGIN.left + 620, y: VIEWPORT_ORIGIN.top + 324, width: 200, height: 120 },
    )

    const batch = designScanBatchRenderer(doc, {})
    expect(batch).toBeDefined()
    const done: string[] = []
    await batch!(
      extractScanPages(doc).pages,
      (pageId) => done.push(pageId),
      () => undefined,
      { thumbnailMaxBytes: 32 * 1024 },
    )
    expect(done.sort()).toEqual(['page-1', 'page-2'])
    expect(vi.mocked(captureRectStats)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(renderPenPageForScan)).not.toHaveBeenCalled()
    unmount()
    expect(designScanBatchRenderer(doc, {})).toBeUndefined()
  })

  it('原生探测未完成时打开扫描：等待原位路径就绪，不落全屏 capture staging', async () => {
    let resolveProbe!: (supported: boolean) => void
    vi.mocked(nativeCaptureSupported).mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveProbe = resolve
    }))
    const parsed = parsePenDocument(JSON.stringify(SWEEP_PAGES), '.pen/axiom.pen')
    render(<DesignCanvas doc={parsed.document as PenDocument} />)
    await waitFor(() => expect(vi.mocked(nativeCaptureSupported)).toHaveBeenCalledTimes(1))
    const viewport = document.querySelector('.design-canvas__viewport') as HTMLElement
    stubRect(viewport, { x: VIEWPORT_ORIGIN.left, y: VIEWPORT_ORIGIN.top, ...VIEWPORT_SIZE })
    stubRect(
      document.querySelector('[data-page-wrapper="page-1"]') as HTMLElement,
      { x: VIEWPORT_ORIGIN.left + 412, y: VIEWPORT_ORIGIN.top + 324, width: 200, height: 120 },
    )
    stubRect(
      document.querySelector('[data-page-wrapper="page-2"]') as HTMLElement,
      { x: VIEWPORT_ORIGIN.left + 620, y: VIEWPORT_ORIGIN.top + 324, width: 200, height: 120 },
    )

    fireEvent.click(screen.getByText('扫描验证'))
    const panel = await waitFor(() => document.querySelector('[data-testid="design-scan-panel"]') as HTMLElement)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 旧行为在这里已调用 renderPenPageForScan；真机该调用会挂全窗口 capture 容器。
    expect(vi.mocked(renderPenPageForScan)).not.toHaveBeenCalled()
    expect(panel.querySelectorAll('.design-scan__page')).toHaveLength(0)

    resolveProbe(true)
    await waitFor(() => expect(vi.mocked(captureRectStats)).toHaveBeenCalledTimes(2), { timeout: 8000 })
    expect(vi.mocked(renderPenPageForScan)).not.toHaveBeenCalled()
  })

  it('巨页原地取景：截图矩形完整落入视口，完成后恢复用户相机', async () => {
    const giant = {
      version: '2.18',
      children: [
        {
          type: 'frame', id: 'giant', name: '巨页', x: 0, y: 0, width: 4000, height: 3000,
          children: [{ type: 'text', id: 'giant-t', content: '内容', fontSize: 12 }],
        },
      ],
    }
    const parsed = parsePenDocument(JSON.stringify(giant), '.pen/axiom.pen')
    expect(parsed.document).not.toBeNull()
    render(<DesignCanvas doc={parsed.document as PenDocument} />)
    await waitFor(() => expect(vi.mocked(nativeCaptureSupported).mock.calls.length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 20))

    const viewport = document.querySelector('.design-canvas__viewport') as HTMLElement
    const surface = document.querySelector('[data-testid="design-canvas-surface"]') as HTMLElement
    stubRect(viewport, { x: VIEWPORT_ORIGIN.left, y: VIEWPORT_ORIGIN.top, ...VIEWPORT_SIZE })
    stubCanvasRect(
      document.querySelector('[data-page-wrapper="giant"]') as HTMLElement,
      { x: 0, y: 0, width: 4000, height: 3000 },
    )
    const initialTransform = surface.style.transform

    fireEvent.click(screen.getByText('扫描验证'))
    await waitFor(() => expect(vi.mocked(captureRectStats)).toHaveBeenCalledTimes(1), { timeout: 8000 })
    const [x, y, width, height] = vi.mocked(captureRectStats).mock.calls[0]![0]
    expect(x).toBeGreaterThanOrEqual(VIEWPORT_ORIGIN.left + 2)
    expect(y).toBeGreaterThanOrEqual(VIEWPORT_ORIGIN.top + 2)
    expect(x + width).toBeLessThanOrEqual(VIEWPORT_ORIGIN.left + VIEWPORT_SIZE.width - 2)
    expect(y + height).toBeLessThanOrEqual(VIEWPORT_ORIGIN.top + VIEWPORT_SIZE.height - 2)
    await waitFor(() => expect(surface.style.transform).toBe(initialTransform), { timeout: 8000 })
    expect(viewport.classList.contains('is-sweeping')).toBe(false)
    expect(vi.mocked(renderPenPageForScan)).not.toHaveBeenCalled()
  })

  it('取景后 DOM 矩形仍越界：不截越界矩形，明确回报渲染失败', async () => {
    const giant = {
      version: '2.18',
      children: [{
        type: 'frame', id: 'giant', name: '巨页', x: 0, y: 0, width: 4000, height: 3000,
        children: [{ type: 'text', id: 'giant-t', content: '内容', fontSize: 12 }],
      }],
    }
    const parsed = parsePenDocument(JSON.stringify(giant), '.pen/axiom.pen')
    render(<DesignCanvas doc={parsed.document as PenDocument} />)
    await waitFor(() => expect(vi.mocked(nativeCaptureSupported).mock.calls.length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const viewport = document.querySelector('.design-canvas__viewport') as HTMLElement
    stubRect(viewport, { x: VIEWPORT_ORIGIN.left, y: VIEWPORT_ORIGIN.top, ...VIEWPORT_SIZE })
    // 模拟布局未随相机目标提交/陈旧 rect：编排器不得信任取景请求而直接截图。
    stubRect(
      document.querySelector('[data-page-wrapper="giant"]') as HTMLElement,
      { x: VIEWPORT_ORIGIN.left, y: VIEWPORT_ORIGIN.top, width: 4000, height: 3000 },
    )

    fireEvent.click(screen.getByText('扫描验证'))
    const panel = await waitFor(() => document.querySelector('[data-testid="design-scan-panel"]') as HTMLElement)
    await waitFor(() => expect(panel.querySelectorAll('.design-scan__page')).toHaveLength(1), { timeout: 8000 })
    expect(vi.mocked(captureRectStats)).not.toHaveBeenCalled()
    expect(vi.mocked(renderPenPageForScan)).not.toHaveBeenCalled()
    expect(panel.textContent).toContain('页面取景后仍未完整落入视口')
  })

  it('重叠页隔离采集：拍摄目标页时隐藏邻页，完成后恢复可见性', async () => {
    const overlappingPages = {
      version: '2.18',
      children: [
        {
          type: 'frame', id: 'overlap-a', name: 'A', x: 0, y: 0, width: 200, height: 120,
          children: [{ type: 'text', id: 'overlap-a-text', content: 'A' }],
        },
        {
          type: 'frame', id: 'overlap-b', name: 'B', x: 150, y: 60, width: 200, height: 120,
          children: [{ type: 'text', id: 'overlap-b-text', content: 'B' }],
        },
      ],
    }
    const parsed = parsePenDocument(JSON.stringify(overlappingPages), '.pen/axiom.pen')
    render(<DesignCanvas doc={parsed.document as PenDocument} />)
    await waitFor(() => expect(vi.mocked(nativeCaptureSupported).mock.calls.length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const viewport = document.querySelector('.design-canvas__viewport') as HTMLElement
    stubRect(viewport, { x: VIEWPORT_ORIGIN.left, y: VIEWPORT_ORIGIN.top, ...VIEWPORT_SIZE })
    const first = document.querySelector('[data-page-wrapper="overlap-a"]') as HTMLElement
    const second = document.querySelector('[data-page-wrapper="overlap-b"]') as HTMLElement
    stubRect(first, { x: VIEWPORT_ORIGIN.left + 350, y: VIEWPORT_ORIGIN.top + 300, width: 200, height: 120 })
    stubRect(second, { x: VIEWPORT_ORIGIN.left + 500, y: VIEWPORT_ORIGIN.top + 360, width: 200, height: 120 })
    const neighborVisibility: string[] = []
    const result = {
      stats: { samples: 9600, distinctColors: 96, topColorFraction: 0.42 },
      width: 200,
      height: 120,
    }
    vi.mocked(captureRectStats)
      .mockImplementationOnce(async () => {
        neighborVisibility.push(second.style.visibility)
        return result
      })
      .mockImplementationOnce(async () => {
        neighborVisibility.push(first.style.visibility)
        return result
      })

    fireEvent.click(screen.getByText('扫描验证'))
    const panel = await waitFor(() => document.querySelector('[data-testid="design-scan-panel"]') as HTMLElement)
    await waitFor(() => expect(panel.querySelectorAll('.design-scan__page')).toHaveLength(2), { timeout: 8000 })
    expect(neighborVisibility).toEqual(['hidden', 'hidden'])
    expect(first.style.visibility).toBe('')
    expect(second.style.visibility).toBe('')
    expect(vi.mocked(renderPenPageForScan)).not.toHaveBeenCalled()
  })

  it('扫掠相机移向下一机位时：缓动窗口内保留上一机位的页内容', async () => {
    const distantPages = {
      version: '2.18',
      children: [
        {
          type: 'frame', id: 'near', name: '近页', x: 0, y: 0, width: 200, height: 120,
          children: [{ type: 'text', id: 'near-text', content: '近页内容' }],
        },
        {
          type: 'frame', id: 'far', name: '远页', x: 2000, y: 0, width: 200, height: 120,
          children: [{ type: 'text', id: 'far-text', content: '远页内容' }],
        },
      ],
    }
    const parsed = parsePenDocument(JSON.stringify(distantPages), '.pen/axiom.pen')
    render(<DesignCanvas doc={parsed.document as PenDocument} />)
    await waitFor(() => expect(vi.mocked(nativeCaptureSupported).mock.calls.length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const viewport = document.querySelector('.design-canvas__viewport') as HTMLElement
    const surface = document.querySelector('[data-testid="design-canvas-surface"]') as HTMLElement
    stubRect(viewport, { x: VIEWPORT_ORIGIN.left, y: VIEWPORT_ORIGIN.top, ...VIEWPORT_SIZE })
    stubCanvasRect(document.querySelector('[data-page-wrapper="near"]') as HTMLElement, { x: 0, y: 0, width: 200, height: 120 })
    stubCanvasRect(document.querySelector('[data-page-wrapper="far"]') as HTMLElement, { x: 2000, y: 0, width: 200, height: 120 })
    await waitFor(() => expect(document.querySelector('[data-pen-id="near-text"]')).not.toBeNull())
    const initialTransform = surface.style.transform

    fireEvent.click(screen.getByText('扫描验证'))
    await waitFor(() => expect(vi.mocked(captureRectStats)).toHaveBeenCalledTimes(1), { timeout: 8000 })
    await waitFor(() => expect(surface.style.transform).not.toBe(initialTransform), { timeout: 8000 })
    // 目标机位已提交，但 220ms 缓动仍在进行：旧机位内容不能提前卸载。
    expect(document.querySelector('[data-pen-id="near-text"]')).not.toBeNull()
    expect(document.querySelector('[data-pen-id="far-text"]')).not.toBeNull()
    const panel = document.querySelector('[data-testid="design-scan-panel"]') as HTMLElement
    await waitFor(() => expect(panel.querySelectorAll('.design-scan__page')).toHaveLength(2), { timeout: 8000 })
  })

  it('用户滚轮接管相机：中断后保留用户缩放与偏移，不恢复扫描前机位', async () => {
    const parsed = parsePenDocument(JSON.stringify(SWEEP_PAGES), '.pen/axiom.pen')
    render(<DesignCanvas doc={parsed.document as PenDocument} />)
    await waitFor(() => expect(vi.mocked(nativeCaptureSupported).mock.calls.length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const viewport = document.querySelector('.design-canvas__viewport') as HTMLElement
    const surface = document.querySelector('[data-testid="design-canvas-surface"]') as HTMLElement
    stubRect(viewport, { x: VIEWPORT_ORIGIN.left, y: VIEWPORT_ORIGIN.top, ...VIEWPORT_SIZE })
    stubRect(
      document.querySelector('[data-page-wrapper="page-1"]') as HTMLElement,
      { x: VIEWPORT_ORIGIN.left + 412, y: VIEWPORT_ORIGIN.top + 324, width: 200, height: 120 },
    )
    stubRect(
      document.querySelector('[data-page-wrapper="page-2"]') as HTMLElement,
      { x: VIEWPORT_ORIGIN.left + 620, y: VIEWPORT_ORIGIN.top + 324, width: 200, height: 120 },
    )
    const initialTransform = surface.style.transform

    fireEvent.click(screen.getByText('扫描验证'))
    await waitFor(() => expect(viewport.classList.contains('is-sweeping')).toBe(true))
    fireEvent.wheel(viewport, { ctrlKey: true, deltaY: -10 })
    const userTransform = surface.style.transform
    expect(userTransform).not.toBe(initialTransform)
    await waitFor(() => expect(viewport.classList.contains('is-sweeping')).toBe(false), { timeout: 8000 })
    expect(surface.style.transform).toBe(userTransform)
    expect(vi.mocked(captureRectStats)).not.toHaveBeenCalled()
  })

  it('项目组件页强制走隔离 staging，不采集画布上的未刷新占位态', async () => {
    const parsed = parsePenDocument(JSON.stringify(SWEEP_PAGES), '.pen/axiom.ax')
    const doc = parsed.document as PenDocument
    doc.axDocument = {
      ax: '1.5',
      tokens: {},
      components: {},
      pages: [
        { id: 'page-1', name: '首页', width: 200, height: 120, tree: [{ id: 'project-card', kind: 'component', name: 'ProjectCard' }] },
        { id: 'page-2', name: '设置', width: 200, height: 120, tree: [] },
      ],
    } satisfies AxDocument
    doc.projectComponents = [{
      summary: {
        name: 'ProjectCard',
        kind: 'presentational',
        sourcePath: 'src/ProjectCard.tsx',
        props: [],
        fixtures: [],
      },
      statics: [],
      fixtures: {},
    } satisfies DesignComponentDetail]

    render(<DesignCanvas doc={doc} />)
    await waitFor(() => expect(vi.mocked(nativeCaptureSupported).mock.calls.length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const viewport = document.querySelector('.design-canvas__viewport') as HTMLElement
    stubRect(viewport, { x: VIEWPORT_ORIGIN.left, y: VIEWPORT_ORIGIN.top, ...VIEWPORT_SIZE })
    stubRect(
      document.querySelector('[data-page-wrapper="page-1"]') as HTMLElement,
      { x: VIEWPORT_ORIGIN.left + 412, y: VIEWPORT_ORIGIN.top + 324, width: 200, height: 120 },
    )
    stubRect(
      document.querySelector('[data-page-wrapper="page-2"]') as HTMLElement,
      { x: VIEWPORT_ORIGIN.left + 620, y: VIEWPORT_ORIGIN.top + 324, width: 200, height: 120 },
    )

    fireEvent.click(screen.getByText('扫描验证'))
    await waitFor(() => expect(vi.mocked(renderPenPageForScan)).toHaveBeenCalled(), { timeout: 8000 })
    expect(vi.mocked(renderPenPageForScan)).toHaveBeenCalledWith(expect.objectContaining({ pageIdOrIndex: 'page-1' }))
    expect(vi.mocked(captureRectStats)).toHaveBeenCalledTimes(1)
  })
})
