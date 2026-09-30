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
import type { PenDocument } from '@/agent/design/penParser'
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

const stubRect = (element: Element, rect: { x: number; y: number; width: number; height: number }): void => {
  element.getBoundingClientRect = () =>
    ({ x: rect.x, y: rect.y, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height, width: rect.width, height: rect.height, toJSON: () => ({}) }) as DOMRect
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
})
