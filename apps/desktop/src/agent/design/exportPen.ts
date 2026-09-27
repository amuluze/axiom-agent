/**
 * `.ax → .pen` 反向导出（docs/ax-format.md §6 P1）：把自有格式导回 pen.dev 能打开的
 * `.pen`，**保住「精修视觉」的外部工具路径**（导入是一次性的、可重跑；导出让用户在
 * pen.dev 里继续改，再导入回来）。
 *
 * 三条设计约束：
 * 1. **按 `.pen` 的字段语义反向映射**，不是把 `.ax` 结构照搬：`wrap` → `textGrowth`、
 *    `lineHeight.unit` → 数值（multiplier 原样、px 折回倍数）、`fill/stroke` 对象 →
 *    `{type:'solid'|'gradient'|'image'}`、token 的 `$name` 引用原样保留、dimension 去掉
 *    `px` 后缀（`.pen` 的 number token 是无单位的，渲染期由我们补 px）。
 * 2. **坐标只在 `.pen` 侧有意义**：`.ax` 的 overlay 是按「锚点 + 残差」描述的，导出时
 *    用 `absoluteOriginOf` 反解成 `x/y`（父容器尺寸从父节点取，与投影同源）。
 * 3. **无法表达的东西要说出来**：`.ax` 的 `component`/`part` 在 `.pen` 里没有对应物
 *    （pen.dev 不认识我们的组件），导出为带名占位框并记 warning——不静默。
 */
import { absoluteOriginOf } from '@/agent/design/axParser'
import type { AxDocument, AxGradient, AxImageFill, AxNode, AxPage, AxToken } from '@/agent/design/axSchema'

/** `.pen` 页面在画布上的排列间距（导出物的顶层 frame 需要坐标才可见）。 */
const PAGE_GAP_PX = 80

type PenRaw = Record<string, unknown>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 文案：`$mock`/`$bind` 在 `.pen` 里没有对应概念，导出为投影时的可读文本。 */
const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (isRecord(value)) {
    if (typeof value.$mock === 'string') return value.$mock
    if (typeof value.$bind === 'string') return `{${value.$bind}}`
  }
  return ''
}

const wrapToGrowth = (wrap: AxNode['wrap']): string =>
  wrap === 'width' ? 'fixed-width' : wrap === 'width-height' ? 'fixed-width-height' : 'auto'

/** 渐变对象 → `.pen` 的 gradient paint（token 引用原样保留，`.pen` 同样用 `$name`）。 */
const gradientToPen = (gradient: AxGradient): PenRaw => ({
  type: 'gradient',
  gradientType: gradient.kind,
  rotation: gradient.rotation,
  enabled: true,
  colors: gradient.stops.map((stop) => ({ color: stop.color, position: stop.position })),
})

const imageFillToPen = (fill: AxImageFill): PenRaw => ({
  type: 'image',
  enabled: true,
  url: fill.asset,
  ...(fill.mode ? { mode: fill.mode } : {}),
})

/** `.ax` 的 fill/stroke → `.pen` 的 paint。 */
const paintToPen = (value: string | AxGradient | AxImageFill | undefined): unknown => {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  return 'asset' in value ? imageFillToPen(value) : gradientToPen(value)
}

/** token 值：`.pen` 的 number 型 token 无单位（渲染期由我们补 px），导出时去掉 px 后缀。 */
const tokenValueToPen = (value: string): string => {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value)
  const number = match?.[1]
  return number ?? value
}

const tokenTypeToPen = (token: AxToken): string => {
  if (token.$type === 'color') return 'color'
  if (token.$type === 'fontFamily') return 'string'
  return 'number'
}

export interface ExportPenOptions {
  /** `.pen` spec 版本头（默认 2.18＝扩展当前支持的版本）。 */
  version?: string
  /** 设计稿名（缺省用 `.ax` 的 name）。 */
  name?: string
}

export interface ExportPenResult {
  json: string
  warnings: string[]
}

export const exportAxToPenDocument = (
  document: AxDocument,
  options: ExportPenOptions = {},
): ExportPenResult => {
  const warnings: string[] = []

  const node = (ax: AxNode, parentSize: { width: number; height: number } | undefined): PenRaw | null => {
    const base: PenRaw = { id: ax.id, ...(ax.name !== undefined ? { name: ax.name } : {}) }
    if (ax.theme) base.theme = { mode: ax.theme }
    // overlay：`.pen` 用「内层节点 + layoutPosition absolute + x/y」表达浮层。
    if (ax.kind === 'overlay') {
      const inner = ax.children?.[0]
      if (!inner) return null
      const origin = absoluteOriginOf(
        { anchor: ax.anchor ?? 'top-left', offset: ax.offset ?? [0, 0] },
        parentSize,
        {
          width: typeof inner.width === 'number' ? inner.width : 0,
          height: typeof inner.height === 'number' ? inner.height : 0,
        },
      )
      const projected = node(inner, parentSize)
      if (!projected) return null
      const content: PenRaw = { ...projected, layoutPosition: 'absolute', x: origin.x, y: origin.y }
      if (!ax.scrim) return content
      // 遮罩语义（1.2）：导出为「铺满父级的遮罩帧 + 内容帧」——.pen 没有遮罩语义，
      // 用绝对定位帧携带半透明 fill 等价表达；父级无尺寸时省略遮罩并记账。
      if (!parentSize || parentSize.width <= 0 || parentSize.height <= 0) {
        warnings.push(`overlay「${ax.id}」的 scrim 需要父级尺寸（页面/容器声明宽高），导出已省略遮罩`)
        return content
      }
      return {
        type: 'frame',
        id: `${ax.id}~scrim`,
        name: 'scrim',
        layoutPosition: 'absolute',
        x: 0,
        y: 0,
        width: parentSize.width,
        height: parentSize.height,
        ...(ax.scrim.fill !== undefined ? { fill: paintToPen(ax.scrim.fill) } : {}),
        clip: true,
        children: [content],
      }
    }

    const size: PenRaw = {}
    if (ax.width !== undefined) size.width = ax.width
    if (ax.height !== undefined) size.height = ax.height

    switch (ax.kind) {
      case 'component':
      case 'part': {
        // pen.dev 不认识我们的组件/部件：导出为带名占位框（可见、可读，但不可编辑语义）。
        const label = ax.kind === 'part' ? ax.part : ax.name
        warnings.push(`「${label ?? ax.kind}」在 .pen 里没有对应物，已导出为占位框（${ax.id}）`)
        return {
          type: 'frame',
          ...base,
          name: `${ax.kind}:${label ?? '?'}`,
          ...size,
          ...(ax.fill !== undefined ? { fill: paintToPen(ax.fill) } : {}),
          children: [],
        }
      }
      case 'frame': {
        const childSize = typeof ax.width === 'number' && typeof ax.height === 'number'
          ? { width: ax.width, height: ax.height }
          : undefined
        return {
          type: 'frame',
          ...base,
          ...size,
          ...(ax.layout ? { layout: ax.layout } : {}),
          ...(ax.gap !== undefined ? { gap: ax.gap } : {}),
          ...(ax.padding !== undefined ? { padding: ax.padding } : {}),
          ...(ax.justifyContent ? { justifyContent: ax.justifyContent } : {}),
          ...(ax.alignItems ? { alignItems: ax.alignItems } : {}),
          ...(ax.clip ? { clip: true } : {}),
          ...(ax.fill !== undefined ? { fill: paintToPen(ax.fill) } : {}),
          ...(ax.stroke !== undefined ? { stroke: paintToPen(ax.stroke) } : {}),
          ...(ax.strokeWidth !== undefined ? { strokeWidth: ax.strokeWidth } : {}),
          ...(ax.cornerRadius !== undefined ? { cornerRadius: ax.cornerRadius } : {}),
          children: (ax.children ?? []).map((child) => node(child, childSize)).filter((item) => item !== null),
        }
      }
      case 'text': {
        const pen: PenRaw = {
          type: 'text',
          ...base,
          ...size,
          content: textOf(ax.text),
          textGrowth: wrapToGrowth(ax.wrap),
          ...(ax.fontSize !== undefined ? { fontSize: ax.fontSize } : {}),
          ...(ax.fontWeight !== undefined ? { fontWeight: ax.fontWeight } : {}),
          ...(ax.fontFamily !== undefined ? { fontFamily: ax.fontFamily } : {}),
          ...(ax.letterSpacing !== undefined ? { letterSpacing: ax.letterSpacing } : {}),
          ...(ax.textAlign ? { textAlign: ax.textAlign } : {}),
          ...(ax.fill !== undefined ? { fill: paintToPen(ax.fill) } : {}),
        }
        if (ax.lineHeight) {
          if (ax.lineHeight.unit === 'multiplier') {
            pen.lineHeight = ax.lineHeight.value
          } else if (typeof ax.fontSize === 'number' && ax.fontSize > 0) {
            // `.pen` 的 lineHeight 是字体倍数：px 值折回倍数（保留视觉行距）。
            pen.lineHeight = Math.round((ax.lineHeight.value / ax.fontSize) * 1000) / 1000
          } else {
            warnings.push(`lineHeight 为 px 且缺少数值 fontSize，未导出（${ax.id}）`)
          }
        }
        return pen
      }
      case 'icon':
        return {
          type: 'icon',
          ...base,
          icon: ax.name,
          library: 'lucide',
          ...(ax.size !== undefined ? { fontSize: ax.size, width: ax.size, height: ax.size } : {}),
          ...(ax.fill !== undefined ? { fill: paintToPen(ax.fill) } : {}),
        }
      case 'rect':
      case 'ellipse':
        return {
          type: ax.kind === 'rect' ? 'rectangle' : 'ellipse',
          ...base,
          ...size,
          ...(ax.fill !== undefined ? { fill: paintToPen(ax.fill) } : {}),
          ...(ax.stroke !== undefined ? { stroke: paintToPen(ax.stroke) } : {}),
          ...(ax.strokeWidth !== undefined ? { strokeWidth: ax.strokeWidth } : {}),
          ...(ax.cornerRadius !== undefined ? { cornerRadius: ax.cornerRadius } : {}),
          ...(ax.innerRadius !== undefined ? { innerRadius: ax.innerRadius } : {}),
        }
      case 'path':
        return {
          type: 'path',
          ...base,
          ...size,
          geometry: ax.geometry,
          ...(ax.viewBox ? { viewBox: ax.viewBox } : {}),
          ...(ax.fill !== undefined ? { fill: paintToPen(ax.fill) } : {}),
          ...(ax.stroke !== undefined ? { stroke: paintToPen(ax.stroke) } : {}),
        }
      case 'image':
        return {
          type: 'rectangle',
          ...base,
          ...size,
          ...(ax.cornerRadius !== undefined ? { cornerRadius: ax.cornerRadius } : {}),
          fill: imageFillToPen({ asset: ax.asset ?? '', ...(ax.mode ? { mode: ax.mode } : {}) }),
        }
      default:
        warnings.push(`未知节点种类，已跳过（${ax.id}）`)
        return null
    }
  }

  // 页 → 顶层 frame（并排摆放：`.pen` 的顶层 frame 必须带坐标才在画布上可见）。
  let cursorX = 0
  const children = document.pages.map((page: AxPage) => {
    const size = typeof page.width === 'number' && typeof page.height === 'number'
      ? { width: page.width, height: page.height }
      : undefined
    const frame: PenRaw = {
      type: 'frame',
      id: page.id,
      ...(page.name ? { name: page.name } : {}),
      ...(page.layout ? { layout: page.layout } : {}),
      ...(page.gap !== undefined ? { gap: page.gap } : {}),
      ...(page.padding !== undefined ? { padding: page.padding } : {}),
      ...(page.width !== undefined ? { width: page.width } : {}),
      ...(page.height !== undefined ? { height: page.height } : {}),
      ...(page.background !== undefined
        ? { fill: paintToPen(page.background) }
        : {}),
      x: cursorX,
      y: 0,
      children: page.tree.map((child) => node(child, size)).filter((item) => item !== null),
    }
    cursorX += (page.width ?? 320) + PAGE_GAP_PX
    return frame
  })

  const variables: Record<string, unknown> = {}
  for (const [name, token] of Object.entries(document.tokens)) {
    const type = tokenTypeToPen(token)
    const value = typeof token.$value === 'string'
      ? tokenValueToPen(token.$value)
      : {
        light: tokenValueToPen(token.$value.light),
        dark: tokenValueToPen(token.$value.dark),
      }
    if (typeof value === 'string') {
      variables[name] = { type, value }
    } else {
      variables[name] = {
        type,
        value: [
          { value: value.light, theme: { mode: 'light' } },
          { value: value.dark, theme: { mode: 'dark' } },
        ],
      }
    }
  }

  const penDocument = {
    version: options.version ?? '2.18',
    themes: { mode: ['light', 'dark'] },
    variables,
    children,
  }
  return { json: `${JSON.stringify(penDocument, null, 2)}\n`, warnings }
}
