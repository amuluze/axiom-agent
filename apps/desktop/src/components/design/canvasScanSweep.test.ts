import { describe, expect, it } from 'vitest'
import {
  domRectToViewportFrame,
  fitsViewport,
  fullyInsideViewport,
  panTargetFor,
  rasterOrderOf,
  rectsIntersect,
  runPool,
  type ScreenRect,
} from './canvasScanSweep'

const rect = (x: number, y: number, width = 200, height = 120): ScreenRect => ({ x, y, width, height })
const VP = { width: 1024, height: 768 }

describe('canvasScanSweep（画布原位扫描几何）', () => {
  it('光栅序：按行分桶（行内 x 升序），相机左→右、上→下推进', () => {
    const order = rasterOrderOf([
      { id: 'c', screen: rect(500, 900) },
      { id: 'a', screen: rect(600, 10) },
      { id: 'b', screen: rect(100, 20) },
      { id: 'd', screen: rect(0, 910) },
    ], VP)
    expect(order).toEqual(['b', 'a', 'd', 'c'])
  })

  it('完全可见判定：贴边（inset 内）不算完全可见', () => {
    expect(fullyInsideViewport(rect(0, 0), VP)).toBe(false)
    expect(fullyInsideViewport(rect(10, 10, 800, 600), VP)).toBe(true)
    expect(fullyInsideViewport(rect(10, 10, 1020, 600), VP)).toBe(false)
  })

  it('装得下判定：与完全可见同 inset 口径——居中后必完全可见（平移不死循环）', () => {
    // 视口同尺寸的页「装得下」但居中后贴边（y=0 < inset），必须路由 staging。
    expect(fitsViewport(rect(0, 0, 1024, 768), VP)).toBe(false)
    expect(fitsViewport(rect(0, 0, 2000, 300), VP)).toBe(false)
    // 恰好装进视口减两侧 inset（1020×764）：居中后 y=2，判定完全可见。
    expect(fitsViewport(rect(0, 0, 1020, 764), VP)).toBe(true)
    // 不变量：任何「装得下」的页，按平移目标居中后必满足完全可见。
    const candidate = rect(40, 400, 1020, 764)
    expect(fitsViewport(candidate, VP)).toBe(true)
    const target = panTargetFor(candidate, 1, VP)
    expect(fullyInsideViewport({ ...candidate, x: candidate.x + target.x, y: candidate.y + target.y }, VP)).toBe(true)
  })

  it('平移目标：页中心对到视口中心（画布坐标 × scale）', () => {
    // 页画布中心 (200, 100)，scale 0.5 → 屏幕偏移 100/50；目标 = 视口中心 - 中心×scale。
    const target = panTargetFor(rect(100, 40, 200, 120), 0.5, VP)
    expect(target.x).toBe(512 - 200 * 0.5)
    expect(target.y).toBe(384 - 100 * 0.5)
  })

  it('相交判定：重叠页双方都路由 staging（截图会串内容）', () => {
    expect(rectsIntersect(rect(0, 0), rect(100, 50))).toBe(true)
    expect(rectsIntersect(rect(0, 0), rect(300, 0))).toBe(false)
  })

  it('DOM 真值换算：窗口坐标减视口原点后，视口内可见的页判定完全可见', () => {
    // 应用布局：画布视口被侧栏/顶栏偏移（left 260 / top 96）。页在视口坐标系里
    // 完全可见（x 600 + 200 = 800 ≤ 1022）——DOM 真值（窗口坐标）若不换算，
    // 右侧判定被偏移量收紧（860 + 200 = 1060 > 1022），该页永远判不可见
    // （扫掠退化 + 成片「渲染检查未完成」的根因）。
    const viewport = { width: 1024, height: 768 }
    const origin = { left: 260, top: 96 }
    const viewportFrame = rect(600, 324)
    const domRect: ScreenRect = {
      x: viewportFrame.x + origin.left,
      y: viewportFrame.y + origin.top,
      width: 200,
      height: 120,
    }
    // 未换算（bug 形态）：窗口坐标直接判 → 右侧越界。
    expect(fullyInsideViewport(domRect, viewport)).toBe(false)
    // 换算后：完全可见。
    expect(fullyInsideViewport(domRectToViewportFrame(domRect, origin), viewport)).toBe(true)
  })

  it('并发池：limit 内并行、全部消费、结果不丢', async () => {
    const processed: number[] = []
    let inFlight = 0
    let peak = 0
    await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      processed.push(item)
      inFlight -= 1
    })
    expect(processed).toHaveLength(7)
    expect(peak).toBeLessThanOrEqual(3)
  })
})
