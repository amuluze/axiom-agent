/**
 * 画布原位扫描的**扫掠几何**（纯函数，docs/design-canvas.md 扫描验证节）。
 *
 * 相机（视口）按光栅序在画布上推进：每一停驻点，把「完全落在视口内」的待扫页
 * 一次并行采集（原生截图逐页矩形），然后平移到下一页——这就是 pen.dev 式
 * 「页面留在原位、逐片点亮」的光栅扫描。本模块只做几何决策（排序/可见判定/
 * 平移目标），采集与 React 状态在 DesignCanvas 的扫掠编排器里。
 */
import type { PagePlacement } from './designPageGrouping'

export type { PagePlacement }

export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ViewportBox {
  width: number
  height: number
}

/**
 * 光栅序：按行分桶（桶高 = 视口高，行内按 x 升序）——相机左→右、上→下逐行推进，
 * 与「光栅扫描」的字面语义一致。y 取页中心（跨行页归入其主体所在行）。
 */
export const rasterOrderOf = (
  pages: readonly { id: string; screen: ScreenRect }[],
  viewport: ViewportBox,
): string[] =>
  [...pages]
    .sort((left, right) => {
      const leftRow = Math.floor((left.screen.y + left.screen.height / 2) / Math.max(1, viewport.height))
      const rightRow = Math.floor((right.screen.y + right.screen.height / 2) / Math.max(1, viewport.height))
      if (leftRow !== rightRow) return leftRow - rightRow
      if (left.screen.x !== right.screen.x) return left.screen.x - right.screen.x
      return left.id < right.id ? -1 : 1
    })
    .map((item) => item.id)

/**
 * DOM 真值 rect（`getBoundingClientRect`，WebView **窗口坐标**，原点 = 应用窗口
 * 左上）换算到画布视口坐标系（原点 = 视口 div 左上）。可见性/平移/装得下判定
 * 都在视口坐标系工作，而画布视口在窗口里被侧栏/顶栏偏移了几百像素——漏掉这步
 * 换算时右侧与下侧判定系统性偏紧，平移居中的页永远判为不可见、成片降级
 * staging（用户看到的就是「渲染检查未完成」成片）。
 */
export const domRectToViewportFrame = (
  rect: ScreenRect,
  viewportOrigin: { left: number; top: number },
): ScreenRect => ({
  x: rect.x - viewportOrigin.left,
  y: rect.y - viewportOrigin.top,
  width: rect.width,
  height: rect.height,
})

/** 页矩形是否完全落在视口内（留 inset 边距，避免贴边裁切）。 */
export const fullyInsideViewport = (
  screen: ScreenRect,
  viewport: ViewportBox,
  inset = 2,
): boolean =>
  screen.width > 0 && screen.height > 0
  && screen.x >= inset && screen.y >= inset
  && screen.x + screen.width <= viewport.width - inset
  && screen.y + screen.height <= viewport.height - inset

/**
 * 该页**完整装进视口**的最大倍率（画布坐标尺寸 × scale ≤ 视口减两侧 inset）。
 *
 * 用途：装不下视口的页不再降级到「全屏 staging 遮罩」采集（那条路径会挂一个
 * `position:fixed;inset:0` 的全窗口不透明遮罩——用户看到的「检查设计稿时全屏
 * 浮现」就是它），而是**原地取景**：把相机缩到本页装得下的倍率再原位截取。
 * 页仍留在画布原位，只有相机倍率变了。
 *
 * 不设上限 1：调用方只在「当前倍率装不下」时用它（此时结果必然小于当前倍率），
 * 上限会让「能以 1.5 装下却按 1.0 取景」——白缩一档，纯浪费像素。
 */
export const fitScaleFor = (
  item: { width: number; height: number },
  viewport: ViewportBox,
  inset = 2,
): number => {
  const width = Math.max(item.width, 1)
  const height = Math.max(item.height, 1)
  return Math.min(
    (viewport.width - inset * 2) / width,
    (viewport.height - inset * 2) / height,
  )
}

/**
 * 页与页在**画布坐标**上的重叠关系（页 id → 与之重叠的页 id 集合）。
 *
 * 与缩放无关：整体 uniform scale 不改变相交关系，故可直接用画布坐标判定。
 * 重叠页的原位截图会拍到压在它上面的另一页内容——像素统计失真。调用方据此把
 * 重叠页**隔离采集**（采集时把目标页抬到最上层），而不是退到全屏遮罩路径。
 */
export const overlappingPageIds = (
  placements: readonly { id: string; x: number; y: number; width: number; height: number }[],
): Map<string, Set<string>> => {
  const result = new Map<string, Set<string>>()
  const link = (left: string, right: string): void => {
    const leftSet = result.get(left) ?? new Set<string>()
    leftSet.add(right)
    result.set(left, leftSet)
    const rightSet = result.get(right) ?? new Set<string>()
    rightSet.add(left)
    result.set(right, rightSet)
  }
  for (let i = 0; i < placements.length; i += 1) {
    const left = placements[i]
    if (!left) continue
    for (let j = i + 1; j < placements.length; j += 1) {
      const right = placements[j]
      if (!right) continue
      if (rectsIntersect(left, right)) link(left.id, right.id)
    }
  }
  return result
}

/**
 * 平移目标（surface 的 translate 值）：把页中心对到视口中心。入参是**画布坐标**
 * 的页矩形（placements 直出）——屏幕位置 = 画布坐标 × scale + offset。
 */
export const panTargetFor = (
  canvasRect: ScreenRect,
  scale: number,
  viewport: ViewportBox,
): { x: number; y: number } => ({
  x: viewport.width / 2 - (canvasRect.x + canvasRect.width / 2) * scale,
  y: viewport.height / 2 - (canvasRect.y + canvasRect.height / 2) * scale,
})

/**
 * 两页矩形是否相交（画布坐标）——相交页的原位截图会拍到覆盖其上的另一页内容，
 * 扫掠编排器对相交页做**隔离采集**（采集时临时隐藏压在上面的邻页）。
 */
export const rectsIntersect = (a: ScreenRect, b: ScreenRect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** 有界并发池：按 limit 并行消费队列（扫描步内多页并行截图）。 */
export const runPool = async <T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> => {
  const queue = [...items]
  const runners = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      if (item === undefined) break
      await worker(item)
    }
  })
  await Promise.all(runners)
}
