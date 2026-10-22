/**
 * `.ax` 浮层锚点几何（自 axParser 抽出的纯函数簇）。
 *
 * 正向（矩形 → 锚点 + 残差）用于 `.pen` 导入，反向（锚点 + 残差 → 左上角）用于
 * 画布投影与导出；两者共用同一组阈值常量，保持严格互逆。
 */
import type { AxOverlayAnchor } from './axSchema'

/**
 * 浮层贴合父容器边缘的吸附阈值（px）：超出这个距离就按左上角锚定——语义更诚实
 * （「从左上角偏移」而不是把一个中间位置的元素叫成 bottom-right）。
 */
const ANCHOR_SNAP_PX = 24
/** 居中判定阈值（px）。 */
const ANCHOR_CENTER_TOLERANCE_PX = 2

export interface AxAnchorPlacement {
  anchor: AxOverlayAnchor
  offset: [number, number]
}

/**
 * 矩形 → 锚点 + 残差偏移（正向，导入期用）。**无损**：反向函数 `absoluteOriginOf`
 * 用同一组规则可精确还原左上角坐标，因此锚点化只改变「怎么描述位置」，不改变位置。
 * 父容器尺寸未知（fit_content/auto）时退回左上角锚定——此时残差就是绝对 x/y，同样精确。
 */
export const anchorPlacementOf = (
  rect: { x: number; y: number; width: number; height: number },
  parent: { width: number; height: number } | undefined,
): AxAnchorPlacement => {
  if (!parent) return { anchor: 'top-left', offset: [rect.x, rect.y] }
  const rightGap = parent.width - (rect.x + rect.width)
  const bottomGap = parent.height - (rect.y + rect.height)
  const centeredX = Math.abs(rect.x + rect.width / 2 - parent.width / 2) <= ANCHOR_CENTER_TOLERANCE_PX
  const centeredY = Math.abs(rect.y + rect.height / 2 - parent.height / 2) <= ANCHOR_CENTER_TOLERANCE_PX
  const horizontal: 'left' | 'center' | 'right' =
    rightGap < ANCHOR_SNAP_PX ? 'right' : centeredX ? 'center' : 'left'
  const vertical: 'top' | 'center' | 'bottom' =
    bottomGap < ANCHOR_SNAP_PX ? 'bottom' : centeredY ? 'center' : 'top'
  const offsetX = horizontal === 'left'
    ? rect.x
    : horizontal === 'center'
      ? rect.x + rect.width / 2 - parent.width / 2
      : rect.x + rect.width - parent.width
  const offsetY = vertical === 'top'
    ? rect.y
    : vertical === 'center'
      ? rect.y + rect.height / 2 - parent.height / 2
      : rect.y + rect.height - parent.height
  // 双向居中在锚点闭集里是单词 `center`（没有 `center-center`）——直接拼会产出
  // 校验器拒绝的锚点，导入 perfectly-centered 浮层即报错。
  const anchor: AxOverlayAnchor = vertical === 'center' && horizontal === 'center'
    ? 'center'
    : `${vertical}-${horizontal}` as AxOverlayAnchor
  return { anchor, offset: [offsetX, offsetY] }
}

/** 锚点 + 残差 + 父/自身尺寸 → 左上角坐标（反向，投影期与 `.pen` 导出共用；与正向严格互逆）。 */
export const absoluteOriginOf = (
  placement: AxAnchorPlacement,
  parent: { width: number; height: number } | undefined,
  size: { width: number; height: number },
): { x: number; y: number } => {
  const [offsetX, offsetY] = placement.offset
  // `center` 是单词锚点（正中）：split 后缺横向段，回退用纵向段——否则
  // horizontal 为 undefined 落进右对齐分支，正中锚点被摆到右下角。
  const [vertical, horizontal = vertical] = placement.anchor.split('-') as [
    'top' | 'center' | 'bottom',
    'left' | 'center' | 'right',
  ]
  const width = parent?.width ?? 0
  const height = parent?.height ?? 0
  const x = horizontal === 'left'
    ? offsetX
    : horizontal === 'center'
      ? width / 2 - size.width / 2 + offsetX
      : width - size.width + offsetX
  const y = vertical === 'top'
    ? offsetY
    : vertical === 'center'
      ? height / 2 - size.height / 2 + offsetY
      : height - size.height + offsetY
  return { x, y }
}
