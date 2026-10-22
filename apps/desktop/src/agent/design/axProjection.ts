/**
 * `.ax` → 画布视图模型投影（自 axParser 抽出）。
 *
 * 复用既有 `PenDocument` 语义与渲染器，不为 `.ax` 再造一套渲染实现；投影只做
 * 「已校验文档 → 视图模型」的纯映射，降级（component/part 占位）以诊断如实产出。
 */
import { axBindingKind, AX_SYMBOL_ID_SEP } from './axSchema'
import type {
  AxBinding,
  AxDocument,
  AxGradient,
  AxImageFill,
  AxLineHeight,
  AxNode,
  AxParseResult,
  AxPropValue,
  AxShadow,
  AxSymbolDef,
  AxToken,
} from './axSchema'
import { absoluteOriginOf } from './axAnchors'
import { tokenToCss } from './penParser'
import type { PenDocument, PenNode, PenNodeUnion, PenPaint, PenPaintGradient, PenShadow } from './penParser'

// ---------------------------------------------------------------- 画布投影

/** 文案取值：`{$mock}` 用其文案，`{$bind}` 在画布上显示占位（实现绑真实数据源）。 */
export const axTextOf = (value: unknown): string => {
  if (typeof value === 'string') return value
  const kind = axBindingKind(value)
  // 结构化 mock 在文案位置已被校验器拒绝（checkTextValue）；这里仍只认字符串，
  // 免得绕过校验的调用方拿到 `[object Object]`。
  if (kind === 'mock') {
    const mock = (value as AxBinding).$mock
    return typeof mock === 'string' ? mock : ''
  }
  if (kind === 'bind') return `{${(value as AxBinding).$bind ?? ''}}`
  return ''
}

/** `wrap` → .pen 的 textGrowth 三态（复用既有渲染路径，不再造一套文本语义）。 */
const growthOf = (wrap: AxNode['wrap']): PenNode['textGrowth'] =>
  wrap === 'width' ? 'fixed-width' : wrap === 'width-height' ? 'fixed-width-height' : 'auto'

/** `lineHeight` → CSS：multiplier 用无单位倍数，px 用显式像素（与渲染器约定一致）。 */
const lineHeightOf = (value: AxLineHeight | undefined): number | string | undefined => {
  if (!value) return undefined
  return value.unit === 'multiplier' ? value.value : `${value.value}px`
}

/** `.ax` token → 渲染期自定义属性值（color 原样，dimension 已带单位，fontWeight 原样）。 */
/**
 * 渐变对象 → 渲染器消费的 paint（CSS 串构造与 `penParser.normalizePaint` 同口径）。
 * 色标里的 `$token` 必须过 `tokenToCss` 变成 `var(--token)`——`.ax` 存的是引用名，
 * 直接拼进 CSS 会得到无效声明（整条渐变换成空值），这是投影层最容易漏的一处。
 */
const gradientPaintOf = (gradient: AxGradient): PenPaintGradient => {
  const stops = gradient.stops.map((stop) => ({ color: tokenToCss(stop.color), position: stop.position }))
  const stopList = stops
    .map((stop) => `${stop.color} ${Math.round(stop.position * 100)}%`)
    .join(', ')
  const css = gradient.kind === 'radial'
    ? `radial-gradient(circle, ${stopList})`
    : gradient.kind === 'angular'
      ? `conic-gradient(from ${gradient.rotation}deg, ${stopList})`
      : `linear-gradient(${180 + gradient.rotation}deg, ${stopList})`
  return { kind: 'gradient', css, gradientType: gradient.kind, rotation: gradient.rotation, stops }
}

/** `.ax` 的 shadow（1.3）→ 视图模型 PenShadow（几何是纯数值 px，color 原样交渲染层解析 token）。 */
const shadowOf = (shadow: AxShadow | undefined): PenShadow | undefined =>
  shadow === undefined ? undefined : { color: shadow.color, x: shadow.offsetX, y: shadow.offsetY, blur: shadow.blur }

/** `.ax` 的 fill/stroke → 渲染器 paint（字符串 = 字面色/token，对象 = 渐变或图片）。 */
const paintOf = (value: string | AxGradient | AxImageFill | undefined): PenPaint | undefined => {
  if (value === undefined) return undefined
  if (typeof value === 'string') return { kind: 'solid', value }
  if ('asset' in value) return { kind: 'image', url: value.asset, mode: value.mode }
  return gradientPaintOf(value)
}

const tokenToVariable = (token: AxToken, mode: 'light' | 'dark'): string => {
  const value = token.$value
  if (typeof value === 'string') return value
  return mode === 'light' ? value.light : value.dark
}

/**
 * 实例 prop 值 → body 文案位的替换值：string 直取；`{$mock}` 解包字符串；`{$bind}`
 * 直通（画布显示 `{数据源}` 占位，实现绑真实数据）。数值/布尔经校验器拦截，不可达。
 */
export const axSymbolParamValueOf = (value: AxPropValue | undefined): string | AxBinding | undefined => {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  const kind = axBindingKind(value)
  if (kind === 'mock') {
    const mock = (value as AxBinding).$mock
    return typeof mock === 'string' ? mock : undefined
  }
  if (kind === 'bind') return value as AxBinding
  return undefined
}

/**
 * 投影期展开 symbol 实例（1.4）：body 深拷贝 + 参数替换 + id 派生
 * （`${实例id}~s:${bodyId}`，分隔符见 `AX_SYMBOL_ID_SEP`）。实例展成多个 body 根
 * （flatMap），投影层因此只看见 part/原语——现有渲染链零改动。body 内无 component
 * （校验器强制），嵌套实例不存在；非实例节点递归展开 children/slot。校验保证参数
 * 齐备，替换值缺省时回落空串（不可达路径，防御性收口）。
 */
export const expandSymbolInstances = (
  nodes: readonly AxNode[],
  symbols: Record<string, AxSymbolDef>,
): AxNode[] => {
  const substituteText = (value: AxNode['text'], props: Record<string, AxPropValue> | undefined): AxNode['text'] => {
    if (value === undefined || typeof value === 'string' || axBindingKind(value) !== 'param') return value
    const resolved = axSymbolParamValueOf(props?.[(value as AxBinding).$param ?? ''])
    return resolved ?? ''
  }
  const cloneBody = (body: AxNode, instanceId: string, props: Record<string, AxPropValue> | undefined): AxNode => ({
    ...body,
    id: `${instanceId}${AX_SYMBOL_ID_SEP}${body.id}`,
    ...(body.text !== undefined ? { text: substituteText(body.text, props) } : {}),
    ...(body.label !== undefined ? { label: substituteText(body.label, props) } : {}),
    ...(body.supporting !== undefined ? { supporting: substituteText(body.supporting, props) } : {}),
    // icon 的枚举位（1.6）：`{$param}` 换成实例传的字面量，其余（字面量名）原样。
    ...(body.name !== undefined && typeof body.name !== 'string'
      ? {
          name: (() => {
            const resolved = axSymbolParamValueOf(props?.[(body.name as { $param: string }).$param])
            return typeof resolved === 'string' ? resolved : ''
          })(),
        }
      : {}),
    ...(body.children ? { children: body.children.map((child) => cloneBody(child, instanceId, props)) } : {}),
    ...(body.slot ? { slot: body.slot.map((child) => cloneBody(child, instanceId, props)) } : {}),
  })
  const expandNode = (node: AxNode): AxNode[] => {
    if (node.kind === 'component' && typeof node.name === 'string' && Object.hasOwn(symbols, node.name)) {
      const def = symbols[node.name]
      if (!def) return []
      return def.body.map((bodyRoot) => cloneBody(bodyRoot, node.id, node.props))
    }
    return [{
      ...node,
      ...(node.children ? { children: node.children.flatMap(expandNode) } : {}),
      ...(node.slot ? { slot: node.slot.flatMap(expandNode) } : {}),
    }]
  }
  return nodes.flatMap(expandNode)
}

/**
 * 投影为画布视图模型。P0 只处理 primitive：`component`/`part` 降级为带名占位框
 * （`PenUnknownNode`，画布既有占位渲染路径），并在诊断里标明「P2 接入后渲染为真组件」。
 * 页面不携带坐标：画布用既有的无坐标页自动排布兜底（坐标不进设计稿，见 §3.3 规则 9）。
 */
export const projectAxToPenDocument = (
  document: AxDocument,
  fileName: string,
): { document: PenDocument; diagnostics: AxParseResult['diagnostics'] } => {
  const diagnostics: AxParseResult['diagnostics'] = []
  const modeVariables: PenDocument['modeVariables'] = { light: {}, dark: {} }
  for (const [name, token] of Object.entries(document.tokens)) {
    modeVariables.light[name] = tokenToVariable(token, 'light')
    modeVariables.dark[name] = tokenToVariable(token, 'dark')
  }

  /** 父容器尺寸（锚点反解用）：只在父容器声明了数值尺寸时可用。 */
  const sizeOfContainer = (node: AxNode): { width: number; height: number } | undefined =>
    typeof node.width === 'number' && typeof node.height === 'number'
      ? { width: node.width, height: node.height }
      : undefined

  const projectNodes = (
    nodes: AxNode[],
    path: string,
    parentSize: { width: number; height: number } | undefined,
  ): PenNodeUnion[] => {
    const out: PenNodeUnion[] = []
    nodes.forEach((node, index) => {
      const nodePath = `${path}[${index}]`
      const projected = projectNode(node, nodePath, projectNodes, parentSize)
      if (projected) out.push(projected)
    })
    return out
  }

  const projectNode = (
    node: AxNode,
    path: string,
    recurse: (nodes: AxNode[], path: string, parentSize?: { width: number; height: number } | undefined) => PenNodeUnion[],
    parentSize: { width: number; height: number } | undefined,
  ): PenNodeUnion | null => {
    const base: Partial<PenNode> = { id: node.id }
    if (node.theme !== undefined) base.theme = { mode: node.theme }
    const width = node.width as PenNode['width']
    const height = node.height as PenNode['height']
    if (width !== undefined) base.width = width
    if (height !== undefined) base.height = height
    switch (node.kind) {
      case 'component':
        // 真组件渲染：投影成视图模型的 component 节点，由注册表解析成真实组件渲染
        // （注册表缺该名时宿主显式报错，不静默降级）。
        return {
          type: 'component',
          id: node.id,
          name: typeof node.name === 'string' ? node.name : '',
          ...(node.variant !== undefined ? { variant: node.variant } : {}),
          ...(node.props !== undefined ? { props: node.props as Record<string, unknown> } : {}),
          ...(node.fixture !== undefined ? { fixture: node.fixture } : {}),
          ...(node.slot && node.slot.length > 0
            ? { children: recurse(node.slot, `${path}.slot`, parentSize) }
            : {}),
        }
      case 'part':
        // 部件：投影成视图模型的 part 节点，由 `axParts` 的词表映射到真实实现的元素与类名
        // （词表缺该部件时在校验期已 fail-closed，不会走到这里）。
        return {
          type: 'part',
          id: node.id,
          part: node.part ?? '',
          ...(node.variant !== undefined ? { variant: node.variant } : {}),
          ...(node.label !== undefined ? { label: axTextOf(node.label) } : {}),
          ...(node.supporting !== undefined ? { supporting: axTextOf(node.supporting) } : {}),
          ...(node.icon !== undefined ? { icon: node.icon } : {}),
          ...(node.count !== undefined ? { count: node.count } : {}),
          ...(node.selected !== undefined ? { selected: node.selected } : {}),
          ...(node.state !== undefined ? { state: node.state } : {}),
        }
      case 'text':
        return {
          ...base,
          type: 'text',
          content: axTextOf(node.text),
          fontSize: node.fontSize as PenNode['fontSize'],
          fontWeight: node.fontWeight as PenNode['fontWeight'],
          fontFamily: node.fontFamily,
          lineHeight: lineHeightOf(node.lineHeight),
          letterSpacing: node.letterSpacing as PenNode['letterSpacing'],
          textAlign: node.textAlign,
          textGrowth: growthOf(node.wrap),
          fill: paintOf(node.fill),
          shadow: shadowOf(node.shadow),
        } as PenNode
      case 'icon':
        return {
          ...base,
          type: 'icon',
          icon: node.name,
          library: 'lucide',
          // `.ax` 的 size 同时决定字形与盒子（.pen 里两者一致，投影保持同形以便逐节点对账）。
          fontSize: node.size,
          width: node.size,
          height: node.size,
          fill: paintOf(node.fill),
          shadow: shadowOf(node.shadow),
        } as PenNode
      case 'rect':
      case 'ellipse':
        return {
          ...base,
          type: node.kind === 'rect' ? 'rectangle' : 'ellipse',
          fill: paintOf(node.fill),
          stroke: paintOf(node.stroke),
          strokeWidth: node.strokeWidth,
          cornerRadius: node.cornerRadius,
          innerRadius: node.kind === 'ellipse' ? node.innerRadius : undefined,
          shadow: shadowOf(node.shadow),
        } as PenNode
      case 'path':
        return {
          ...base,
          type: 'path',
          geometry: node.geometry,
          viewBox: node.viewBox,
          fill: paintOf(node.fill),
          stroke: paintOf(node.stroke),
          shadow: shadowOf(node.shadow),
        } as PenNode
      case 'image':
        return {
          ...base,
          type: 'rectangle',
          fill: { kind: 'image', url: node.asset ?? '', mode: node.mode },
          cornerRadius: node.cornerRadius,
        } as PenNode
      case 'frame':
      case 'overlay': {
        const contentFrame = {
          ...base,
          type: 'frame',
          fill: paintOf(node.fill),
          stroke: paintOf(node.stroke),
          strokeWidth: node.strokeWidth,
          cornerRadius: node.cornerRadius,
          shadow: shadowOf(node.shadow),
          layout: node.layout,
          gap: node.gap,
          padding: node.padding,
          justifyContent: node.justifyContent,
          alignItems: node.alignItems,
          clip: node.clip,
          // 锚点 + 残差 → 左上角坐标（与导入期 anchorPlacementOf 严格互逆）。
          // 尺寸取自被包住的那个节点：overlay 本身按格式不携带尺寸（规则 9）。
          ...(node.kind === 'overlay'
            ? (() => {
              const geometry = node.children?.[0] ?? node
              const origin = absoluteOriginOf(
                { anchor: node.anchor ?? 'top-left', offset: node.offset ?? [0, 0] },
                parentSize,
                {
                  width: typeof geometry.width === 'number' ? geometry.width : 0,
                  height: typeof geometry.height === 'number' ? geometry.height : 0,
                },
              )
              return { layoutPosition: 'absolute' as const, x: origin.x, y: origin.y }
            })()
            : {}),
          children: recurse(node.children ?? [], `${path}.children`, sizeOfContainer(node)),
        } as PenNode
        if (!node.scrim) return contentFrame
        // 遮罩语义（1.2）：外层帧铺满父级（页面级浮层即整页）、fill 为遮罩绘制值，
        // 内容帧原样叠在其上——锚点坐标相对父级计算，遮罩帧铺满父级且位于原点，
        // 内层坐标无需换算。父级没有可用尺寸（页未声明宽高）时降级为普通浮层并记诊断，
        // 不发明遮罩边界。
        if (!parentSize || parentSize.width <= 0 || parentSize.height <= 0) {
          diagnostics.push({
            level: 'warning',
            message: `overlay「${node.id}」的 scrim 需要父级尺寸（页面/容器声明宽高），已降级为普通浮层`,
            path,
          })
          return contentFrame
        }
        return {
          type: 'frame',
          // 外层是投影合成层：id 加后缀避免与内容帧（保留 overlay 本 id）冲突。
          id: `${node.id}~scrim`,
          layoutPosition: 'absolute',
          x: 0,
          y: 0,
          width: parentSize.width,
          height: parentSize.height,
          fill: paintOf(node.scrim.fill),
          clip: true,
          children: [contentFrame],
        } as PenNode
      }
      default:
        return null
    }
  }

  /** 展开前按 authored 树统计 symbol 实例：展开会把实例摊成 body 原语，复用事实只在此刻可见。 */
  const symbolInstances = document.symbols ?? {}
  const countSymbolInstances = (nodes: readonly AxNode[]): number =>
    nodes.reduce((sum, node) => sum
      + (node.kind === 'component' && typeof node.name === 'string' && Object.hasOwn(symbolInstances, node.name) ? 1 : 0)
      + countSymbolInstances(node.children ?? [])
      + countSymbolInstances(node.slot ?? []), 0)
  const symbolInstanceCounts = Object.fromEntries(
    document.pages.map((page) => [page.id, countSymbolInstances(page.tree ?? [])]),
  )

  const pages: PenNodeUnion[] = document.pages.map((page, index) => {
    const pagePath = `pages[${index}]`
    const pageSize = page.width !== undefined && page.height !== undefined
      ? { width: page.width, height: page.height }
      : undefined
    const tree = expandSymbolInstances(page.tree ?? [], document.symbols ?? {})
      .map((node, nodeIndex) => projectNode(node, `${pagePath}.tree[${nodeIndex}]`, projectNodes, pageSize))
      .filter((node): node is PenNodeUnion => node !== null)
    const frame: PenNode = {
      type: 'frame',
      id: page.id,
      name: page.name ?? page.id,
      // 页尺寸不发明兜底值：`.pen` 里「无高度的组织性 frame」（Section 带/状态展示区）
      // 本就无高度，画布的 pageSizeOf 兜底与 hasHeight 判定会同样处理两者。
      ...(page.width !== undefined ? { width: page.width } : {}),
      ...(page.height !== undefined ? { height: page.height } : {}),
      fill: page.background !== undefined ? { kind: 'solid', value: page.background } : undefined,
      // 缺省 horizontal：与 .pen 的缺省一致（缺省即横向流式）。
      layout: page.layout ?? 'horizontal',
      ...(page.gap !== undefined ? { gap: page.gap } : {}),
      ...(page.padding !== undefined ? { padding: page.padding } : {}),
      children: tree,
    }
    return frame
  })

  return {
    document: {
      fileName,
      version: document.ax,
      pageMetadata: Object.fromEntries(document.pages.map((page) => [page.id, { group: page.group, state: page.state }])),
      // 只在真有实例时落键：无 symbol 的稿（含 `.pen` 投影）保持字段集合不变。
      ...(Object.values(symbolInstanceCounts).some((count) => count > 0) ? { symbolInstanceCounts } : {}),
      pages,
      components: {},
      variables: {},
      modeVariables,
      diagnostics: diagnostics.map((item) => ({ level: item.level, message: item.message, path: item.path })),
    },
    diagnostics,
  }
}
