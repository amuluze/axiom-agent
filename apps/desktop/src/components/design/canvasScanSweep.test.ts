import { describe, expect, it } from 'vitest'
import {
  domRectToViewportFrame,
  fitScaleFor,
  fullyInsideViewport,
  overlappingPageIds,
  panTargetFor,
  rasterOrderOf,
  rectsIntersect,
  runPool,
  type ScreenRect,
} from './canvasScanSweep'

const rect = (x: number, y: number, width = 200, height = 120): ScreenRect => ({ x, y, width, height })
const VP = { width: 1024, height: 768 }

describe('canvasScanSweep（画布原位扫描几何）', () => {
  it('取景倍率：该页完整装进视口的最大倍率（巨页据此原地取景，不走全屏遮罩）', () => {
    const place = (id: string, x: number, y: number, width: number, height: number) => ({ id, x, y, width, height })
    // 与视口同尺寸的页：宽高都受限，取二者较小值（高方向更紧）。
    expect(fitScaleFor(place('a', 0, 0, 1024, 768), VP, 8)).toBeCloseTo((VP.height - 16) / 768, 5)
    // 宽度受限：宽页按宽度定倍率。
    expect(fitScaleFor(place('wide', 0, 0, 4000, 300), VP, 8)).toBeCloseTo((VP.width - 16) / 4000, 5)
    // 高度受限：高页按高度定倍率（两者取小）。
    expect(fitScaleFor(place('tall', 0, 0, 200, 3000), VP, 8)).toBeCloseTo((VP.height - 16) / 3000, 5)
    // 极巨页需要低于 0.01 的倍率：不得用任意下限把页重新放大到视口外。
    const extreme = place('extreme', 0, 0, 200000, 100)
    const extremeScale = fitScaleFor(extreme, VP, 8)
    expect(extremeScale).toBeCloseTo((VP.width - 16) / 200000, 8)
    const extremeTarget = panTargetFor(extreme, extremeScale, VP)
    expect(fullyInsideViewport({
      x: extreme.x * extremeScale + extremeTarget.x,
      y: extreme.y * extremeScale + extremeTarget.y,
      width: extreme.width * extremeScale,
      height: extreme.height * extremeScale,
    }, VP)).toBe(true)
    // 不变量：按取景倍率居中后，该页必然「完全可见」——否则平移循环会空转。
    const page = place('a', 40, 400, 1020, 764)
    const scale = fitScaleFor(page, VP, 8)
    const target = panTargetFor(page, scale, VP)
    const onScreen = { x: page.x * scale + target.x, y: page.y * scale + target.y, width: page.width * scale, height: page.height * scale }
    expect(fullyInsideViewport(onScreen, VP)).toBe(true)
  })

  it('重叠页判定：相交的双方互为重叠（采集时需隔离，否则拍到邻页像素）', () => {
    const place = (id: string, x: number, y: number, width: number, height: number) => ({ id, x, y, width, height })
    const overlapping = overlappingPageIds([
      place('overlap-a', 0, 0, 200, 120),
      place('overlap-b', 150, 60, 200, 120),
      place('solo', 600, 0, 200, 120),
    ])
    // 相交的**双方**都要记录：漏掉任一方都会让它留在原位截图，拍到覆盖它的内容。
    expect([...overlapping.get('overlap-a')!].sort()).toEqual(['overlap-b'])
    expect([...overlapping.get('overlap-b')!].sort()).toEqual(['overlap-a'])
    // 独立页不出现在重叠表里。
    expect(overlapping.has('solo')).toBe(false)
    // 恰好相邻不算相交（边界相接不重叠）。
    const adjacent = overlappingPageIds([place('a', 0, 0, 200, 120), place('b', 200, 0, 200, 120)])
    expect(adjacent.size).toBe(0)
  })

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

  it('平移目标：页中心对到视口中心（画布坐标 × scale）', () => {
    // 页画布中心 (200, 100)，scale 0.5 → 屏幕偏移 100/50；目标 = 视口中心 - 中心×scale。
    const target = panTargetFor(rect(100, 40, 200, 120), 0.5, VP)
    expect(target.x).toBe(512 - 200 * 0.5)
    expect(target.y).toBe(384 - 100 * 0.5)
  })

  it('相交判定：矩形重叠即为相交（截图会串内容，需隔离采集）', () => {
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
