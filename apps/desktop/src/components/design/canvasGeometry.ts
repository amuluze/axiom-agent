/**
 * 画布几何与排布记忆（自 DesignCanvas 抽出的纯函数簇）。
 *
 * 这里只放无 React 状态的计算与 localStorage 记忆：缩放钳制、页面拖动吸附、
 * 页面尺寸标签、节点包含判定与手动排布偏移。画布的交互状态机留在组件内，
 * 两边以「组件消费本模块结果」单向依赖。
 */
import type { PenNodeUnion } from '@/agent/design/penParser'
import { pageNameOf as pageName } from './designPageGrouping'
import type { PagePlacement } from './designPageGrouping'

export const MIN_SCALE = 0.1
export const MAX_SCALE = 4
export const ZOOM_STEP = 0.2

export const clampScale = (value: number): number =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))

export type PageLayoutOffsets = Record<string, { x: number; y: number }>

/**
 * v2：智能分组改版后基础排布从「单行」变为「分组多行」，v1 里的绝对坐标失去
 * 参照物（相对旧单行布局的手动摆放落在新布局上是错位），整体作废不做迁移。
 */
const PAGE_LAYOUT_STORAGE_KEY = 'axiom.design.page-layout.v2'
export const MAX_SAVED_PAGE_LAYOUTS = 50

export const loadPageLayout = (docPath: string): PageLayoutOffsets => {
  try {
    const raw = window.localStorage.getItem(PAGE_LAYOUT_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, PageLayoutOffsets>
    return parsed[docPath] ?? {}
  } catch {
    return {}
  }
}

export const savePageLayout = (docPath: string, offsets: PageLayoutOffsets): void => {
  try {
    const raw = window.localStorage.getItem(PAGE_LAYOUT_STORAGE_KEY)
    const all = (raw ? JSON.parse(raw) : {}) as Record<string, PageLayoutOffsets>
    delete all[docPath]
    all[docPath] = offsets
    const stale = Object.keys(all).slice(0, Math.max(0, Object.keys(all).length - MAX_SAVED_PAGE_LAYOUTS))
    for (const path of stale) delete all[path]
    window.localStorage.setItem(PAGE_LAYOUT_STORAGE_KEY, JSON.stringify(all))
  } catch {
    // localStorage 不可用（配额/隐私模式）：仅失去跨重启记忆，本次拖动照常生效。
  }
}

/** 名称是否已自带宽×高（设计稿常见命名「… · 1180×780」），此时不再拼接尺寸。 */
const NAME_HAS_SIZE = /\d+\s*×\s*\d+\s*$/

export const pageSizeLabel = (
  page: PenNodeUnion,
  width: number,
  height: number,
): string | null => (NAME_HAS_SIZE.test(pageName(page)) ? null : `${width}×${height}`)

export const containsNode = (node: PenNodeUnion, nodeId: string): boolean => {
  if (node.id === nodeId) return true
  const children = 'children' in node ? node.children : undefined
  return (children ?? []).some((child) => containsNode(child, nodeId))
}

// ---------------------------------------------------------------- 页面拖动吸附

/** 吸附触发阈值（屏幕像素）：除以缩放得画布坐标阈值，各缩放级别手感一致。 */
export const PAGE_SNAP_THRESHOLD_SCREEN_PX = 6

/** 对齐参考线（画布坐标）：value 是参考轴坐标，start/end 是线段在另一轴的范围。 */
export interface PageSnapGuide {
  value: number
  start: number
  end: number
}

export interface PageSnapResult {
  dx: number
  dy: number
  /** 竖直参考线（x 轴对齐：左/中/右）。 */
  guideX: PageSnapGuide | null
  /** 水平参考线（y 轴对齐：上/中/下）。 */
  guideY: PageSnapGuide | null
}

/**
 * 页面拖动吸附（Figma 式智能对齐）：拖动页的左/中/右、上/中/下三轴与**其它页**
 * 的同轴做阈值吸附，返回修正后的位移与参考线段。纯函数——指针层逐帧调用，
 * 松手提交的坐标即吸附后的坐标。
 */
export const computePageSnap = (
  placements: readonly PagePlacement[],
  draggedId: string,
  baseX: number,
  baseY: number,
  rawDx: number,
  rawDy: number,
  threshold: number,
): PageSnapResult => {
  const dragged = placements.find((item) => item.page.id === draggedId)
  if (!dragged) return { dx: rawDx, dy: rawDy, guideX: null, guideY: null }
  const others = placements.filter((item) => item.page.id !== draggedId)

  const snapAxis = (
    axis: 'x' | 'y',
    raw: number,
    crossDelta: number,
  ): { delta: number; guide: PageSnapGuide | null } => {
    const size = axis === 'x' ? dragged.width : dragged.height
    const base = axis === 'x' ? baseX : baseY
    const crossBase = axis === 'x' ? baseY : baseX
    const crossSize = axis === 'x' ? dragged.height : dragged.width
    const draggedAxes = [base, base + size / 2, base + size].map((value) => value + raw)
    let best: { distance: number; delta: number; guide: PageSnapGuide } | null = null
    for (const other of others) {
      const otherSize = axis === 'x' ? other.width : other.height
      const otherBase = axis === 'x' ? other.x : other.y
      const otherCrossBase = axis === 'x' ? other.y : other.x
      const otherCrossSize = axis === 'x' ? other.height : other.width
      for (const target of [otherBase, otherBase + otherSize / 2, otherBase + otherSize]) {
        for (const value of draggedAxes) {
          const distance = Math.abs(value - target)
          if (distance > threshold) continue
          if (best && distance >= best.distance) continue
          // 参考线段覆盖拖动页与对齐页的联合范围（对齐关系一目了然）。
          const crossStart = Math.min(crossBase + crossDelta, otherCrossBase)
          const crossEnd = Math.max(crossBase + crossDelta + crossSize, otherCrossBase + otherCrossSize)
          best = { distance, delta: target - value, guide: { value: target, start: crossStart, end: crossEnd } }
        }
      }
    }
    return best ? { delta: raw + best.delta, guide: best.guide } : { delta: raw, guide: null }
  }

  const xSnap = snapAxis('x', rawDx, rawDy)
  const ySnap = snapAxis('y', rawDy, xSnap.delta)
  return { dx: xSnap.delta, dy: ySnap.delta, guideX: xSnap.guide, guideY: ySnap.guide }
}
