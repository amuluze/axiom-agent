/**
 * `.pen → .ax` 导入转换器（docs/ax-format.md §6 P1 的第一版，P0 用它产出验证夹具）。
 *
 * 范围：
 * - **primitive 1:1 映射**：frame/text/icon/rectangle/ellipse/path → 对应的 `.ax` primitive。
 * - **组件实例升级**（`ref → component`）：稿里 `ref` 到 `component/` 前缀的 reusable 组件
 *   时，实例的来源记在 `PenNode.refComponentName`（`penParser`）；命中 `axComponentMap`
 *   的映射即整棵实例升成 `.ax` 的 `component` 节点（真组件渲染），未命中则留在 primitive
 *   层并**带原因记账**（哪些实例没升级、为什么，可数可排期）。`part` 升级与几何归约未做。
 * - **不静默丢字段**：源节点上有、而 `.ax` 目标种类不接受的字段（如 `opacity`、
 *   `effect`）逐条记 warning 诊断并列出字段名——这样「格式还没覆盖什么」是可数、
 *   可回归的，而不是悄悄消失（P0 的验收据此对账）。
 * - **绝对定位进 overlay**：`.pen` 的 `layoutPosition: absolute`（含页面级坐标）
 *   在 `.ax` 里没有坐标可用（硬规则 4/9），改为 `overlay{offset}` 包一层，
 *   几何信息以 offset 保留、且不违反「坐标不进设计稿」。
 */
import { AX_FORMAT_VERSION, AX_OVERLAY_ID_SUFFIX } from '@/agent/design/axSchema'
import { anchorPlacementOf } from '@/agent/design/axParser'
import type { AxBinding, AxComponentDecl, AxDocument, AxNode, AxPage, AxShadow, AxToken, AxTokenType } from '@/agent/design/axSchema'
import { AX_ALLOWED_KEYS } from '@/agent/design/axSchema'
import type { AxGradient, AxImageFill } from '@/agent/design/axSchema'
import type { PenDocument, PenNode, PenNodeUnion, PenPaint } from '@/agent/design/penParser'
import {
  axDeferReasonOfPenComponent,
  axInstanceOfPenComponent,
  penComponentIdentityOf,
} from '@/agent/design/axComponentMap'

/** 组件实例升级的对账条目（按 pen 组件名聚合）。 */
export interface ImportedComponentCount {
  /** pen 稿里的组件定义名（去掉 `component/` 前缀与语言后缀后的可读名）。 */
  name: string
  /** `.ax` 组件名（已升级的才是注册表键；未升级的为空）。 */
  component?: string
  count: number
  /** 未升级的原因（已升级时为 undefined）。 */
  reason?: string
  /**
   * 升级时被真组件内容取代的实例子树文案条数（已升级项专用）。
   * 组件节点不携带子树（内容由真组件 + props/fixture 给），因此实例里那些**没被
   * props 取走**的文案不再进稿——必须可数：0 表示该组件的 props 已完整表达实例内容
   * （如工具卡的标题与字节数），大于 0 表示这部分内容改由实现侧数据提供。
   */
  replacedTexts?: number
}

export interface ImportPenResult {
  document: AxDocument
  /** 未迁移字段/降级项的清单（每条带节点路径），供 P0 验收与 P1 待办取用。 */
  warnings: { path: string; message: string }[]
  /** 组件实例升级/未升级的对账（按 pen 组件名聚合，两种状态都在这里）。 */
  components: ImportedComponentCount[]
}


const COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(|oklch\(|color\()/
const DIMENSION_TOKEN_HINT = /^(space|radius|text|size|width|height|gap|pad)/

/** token 值 → `.ax` 的 `$type` 与取值（dimension 必须带单位）。 */
const tokenTypeOf = (name: string, value: string): { type: AxTokenType; value: string } => {
  if (COLOR_PATTERN.test(value)) return { type: 'color', value }
  if (name.startsWith('font-')) return { type: 'fontFamily', value }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    // .pen 的 number 型 token 是长度（第八轮实测：只被 gap/padding/radius/fontSize 消费），
    // 渲染期本就靠补 px 生效，`.ax` 把这件事写进格式（dimension 必须带单位）。
    return { type: DIMENSION_TOKEN_HINT.test(name) ? 'dimension' : 'number', value: `${value}px` }
  }
  return { type: 'number', value }
}

/**
 * 渐变色标在 `penParser` 里已 tokenToCss 成 `var(--x)`；`.ax` 的引用形态是 `$x`，
 * 这里做一次机械反解（只对完全匹配的 var() 生效，字面色原样保留）。
 */
const unTokenCss = (value: string): string => {
  const match = /^var\(--([^)]+)\)$/.exec(value)
  return match ? `$${match[1]}` : value
}

/**
 * 填充/描边 → `.ax` 取值：字面色/token 用字符串，渐变用显式对象（kind/rotation/stops）。
 * 渐变是渲染子集的一部分（.pen 实测用到 linear 与 angular），不能在导入时丢掉。
 */
const paintToAx = (paint: PenPaint | undefined): string | AxGradient | AxImageFill | undefined => {
  if (!paint) return undefined
  if (paint.kind === 'solid') return paint.value
  if (paint.kind === 'gradient') {
    return {
      kind: paint.gradientType,
      rotation: paint.rotation,
      stops: paint.stops.map((stop) => ({ color: unTokenCss(stop.color), position: stop.position })),
    }
  }
  if (paint.kind === 'image') {
    // 图片填充：只接同目录相对路径（远程 URL 在 .pen 侧已被拒绝渲染，这里同样丢弃）。
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(paint.url) || paint.url.startsWith('//') || paint.url.startsWith('/')) {
      return undefined
    }
    return { asset: paint.url, ...(paint.mode ? { mode: paint.mode } : {}) }
  }
  // `descendants` 覆写整棵替换的子树不过解析器归一（实测存在）：原始实色填充形如
  // `{ type:'solid', value:'$x' }`。渲染器读 `.value` 照画，导入器必须镜像同一口径，
  // 否则同一份稿在画布上两种样子（原始渐变无 `.value`，渲染器本就画不出 → 一致丢弃）。
  const raw = paint as unknown as Record<string, unknown>
  if (typeof raw.value === 'string') return raw.value
  return undefined
}

/** `$token` → `$name`（.ax 与 .pen 的引用同形，这里只做形状确认）。 */
const tokenRef = (value: string | number | undefined): string | number | undefined => value

/** `.pen` 的 textGrowth → `.ax` 的 wrap 三态（与投影反向）。 */
const wrapOf = (growth: PenNode['textGrowth']): AxNode['wrap'] =>
  growth === 'fixed-width' ? 'width' : growth === 'fixed-width-height' ? 'width-height' : 'nowrap'

/** `.pen` 的 lineHeight 数值是字体倍数，但历史上也出现过像素值（≥5 视为 px）。 */
const lineHeightOf = (value: PenNode['lineHeight']): AxNode['lineHeight'] | undefined => {
  if (typeof value === 'number') {
    return value >= 5 ? { unit: 'px', value } : { unit: 'multiplier', value }
  }
  return undefined
}

/**
 * 实例子树里的全部文案（按遍历顺序）。组件升级要给出 props 的 mock 值时，数据只能
 * 取自稿里已有的文案——**不编内容**（认不出就 defer，留在 primitive 层）。
 */
export const penInstanceTexts = (node: PenNode): string[] => {
  const texts: string[] = []
  const visit = (current: PenNodeUnion): void => {
    const pen = current as PenNode
    if (typeof pen.content === 'string' && pen.content !== '') texts.push(pen.content)
    ;(pen.children ?? []).forEach(visit)
  }
  ;(node.children ?? []).forEach(visit)
  return texts
}

/** 三态尺寸：`fill_container(840)` 这类带兜底参数的写法在 `.ax` 里非法，归一到关键字。 */
const sizeOf = (value: PenNode['width']): AxNode['width'] | undefined => {
  if (typeof value === 'string') {
    if (value.startsWith('fill_container')) return 'fill_container'
    if (value.startsWith('fit_content') || value.startsWith('hug_content')) return 'fit_content'
  }
  return value
}

export const importPenDocument = (document: PenDocument, name?: string): ImportPenResult => {
  const warnings: ImportPenResult['warnings'] = []
  const dropped = new Map<string, number>()
  /** 组件实例对账：pen 组件名 → 计数（含已升级的注册表组件名与未升级的原因）。 */
  const components = new Map<string, ImportedComponentCount>()
  /** 本稿实际用到的组件词汇表声明（规则 1 的校验源：`component.name` 必须在此）。 */
  const usedComponents = new Map<string, AxComponentDecl>()

  const noteComponent = (
    penName: string,
    result: { component?: string; reason?: string; replacedTexts?: number },
  ): void => {
    const current = components.get(penName)
    components.set(penName, {
      name: penName,
      ...(result.component !== undefined ? { component: result.component } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      count: (current?.count ?? 0) + 1,
      replacedTexts: (current?.replacedTexts ?? 0) + (result.replacedTexts ?? 0),
    })
  }

  /** 记一条「未迁移字段」（同一字段多次出现聚合计数：清单取前几条 + 总数可读）。 */
  const noteDropped = (path: string, field: string): void => {
    const count = (dropped.get(field) ?? 0) + 1
    dropped.set(field, count)
    if (count <= 3) warnings.push({ path, message: `未迁移字段 \`${field}\`（.ax 暂不接受）` })
  }

  /**
   * 字段级容错：ref 的 `descendants` 覆写里用 `children` 整棵替换的子树**不经过
   * 解析器归一**（原始字段直接进了解析树，实测 axiom.pen 有 1 处 `padding` 是
   * 字符串而非数组）。渲染器对此容错（非数组即视为无值），导入器必须镜像同一
   * 容错——否则这不是「导入丢了样式」，而是导入与渲染分叉（同一份稿两个样子）。
   */
  const arrayOr = (value: unknown): unknown[] | undefined => (Array.isArray(value) ? value : undefined)

  /**
   * 取填充/描边值，并在「源有值但目标不接受」时记账：远程图片填充在 `.pen` 侧
   * 本就不渲染（占位纹理），`.ax` 也拒绝远程资产——两者渲染等价，但**不能静默**。
   */
  const fieldFill = (
    paint: PenPaint | undefined,
    path: string,
    field: string,
  ): string | AxGradient | AxImageFill | undefined => {
    const value = paintToAx(paint)
    if (paint !== undefined && value === undefined) {
      noteDropped(path, `${field}(${paint.kind === 'image' ? '远程/图片填充' : '未知形态'})`)
      return undefined
    }
    return value
  }

  /** 视图模型 PenShadow（{x,y} 偏移）→ `.ax` 的 AxShadow（offsetX/offsetY 显式命名）。 */
  const shadowToAx = (shadow: NonNullable<PenNode['shadow']>): AxShadow => ({
    color: shadow.color,
    offsetX: shadow.x,
    offsetY: shadow.y,
    blur: shadow.blur,
  })

  /** 描边不接受图片填充（无意义）：命中即按未迁移记账。 */
  const fieldStroke = (
    paint: PenPaint | undefined,
    path: string,
    field: string,
  ): string | AxGradient | undefined => {
    const value = fieldFill(paint, path, field)
    if (value !== undefined && typeof value === 'object' && 'asset' in value) return undefined
    return value
  }

  /** padding：数组原样迁移；非数组（覆写透传的原始值）按未迁移记账并视为无值。 */
  const paddingOf = (pen: PenNode, path: string): { padding?: Array<number | string> } => {
    const raw = arrayOr(pen.padding) as Array<number | string> | undefined
    if (raw) return { padding: raw.map((value) => value) }
    if (pen.padding !== undefined) noteDropped(path, 'padding(非数组)')
    return {}
  }

  /**
   * 绝对定位 → `overlay`（`.ax` 里坐标只能写在 overlay 上）。位置用**锚点 + 残差**
   * 表达（「右下角内缩 8px」）而不是绝对像素——这是「坐标不进设计稿」的落地，也让
   * codegen 产出 `right/bottom` 而不是 `left: 1052px`。父容器尺寸未知时退回左上角
   * 锚定（残差即绝对坐标），两种情况都精确无损（见 axParser.absoluteOriginOf）。
   */
  const overlayOf = (pen: PenNode, parentSize: { width: number; height: number } | undefined): AxNode => {
    const rect = typeof pen.width === 'number' && typeof pen.height === 'number'
      ? { x: typeof pen.x === 'number' ? pen.x : 0, y: typeof pen.y === 'number' ? pen.y : 0, width: pen.width, height: pen.height }
      : undefined
    const placement = rect && parentSize
      ? anchorPlacementOf(rect, parentSize)
      : { anchor: 'top-left' as const, offset: [typeof pen.x === 'number' ? pen.x : 0, typeof pen.y === 'number' ? pen.y : 0] as [number, number] }
    // 后缀落在包装层：内层保留源 id，往返才稳定（见 axSchema.AX_OVERLAY_ID_SUFFIX）。
    return {
      id: `${pen.id}${AX_OVERLAY_ID_SUFFIX}`,
      kind: 'overlay',
      anchor: placement.anchor,
      offset: placement.offset,
      children: [],
    }
  }

  /** 当前节点的尺寸（数值才有意义：锚点反解需要它）。 */
  const rectOf = (pen: PenNode): { width: number; height: number } | undefined =>
    typeof pen.width === 'number' && typeof pen.height === 'number'
      ? { width: pen.width, height: pen.height }
      : undefined

  const convert = (
    node: PenNodeUnion,
    path: string,
    parentSize?: { width: number; height: number },
  ): AxNode | null => {
    if (node.type === 'unknown') {
      warnings.push({ path, message: `跳过不支持的节点 ${node.originalType}` })
      return null
    }
    const pen = node as PenNode
    const id = pen.id

    // 组件实例升级：命中映射即整棵实例升成 `component` 节点（真组件自带内容与度量，
    // 稿里这份几何是同一组件的另一种画法）。未命中则记账后照常走 primitive 展开——
    // 升级面因此是「可数的两堆」：升级 N 处、未升级 M 处（每处带原因）。
    if (pen.refComponentName !== undefined) {
      const identity = penComponentIdentityOf(pen.refComponentName)
      const instanceTexts = penInstanceTexts(pen)
      const instance = axInstanceOfPenComponent(pen.refComponentName, { texts: instanceTexts })
      if (identity && instance && !('defer' in instance)) {
        // 组件节点不携带子树：真组件的内容来自 props 与 fixture。实例文案里**没被 props
        // 消费**的那些（如审批卡的标题与命令文案——它们由 store 数据提供）就此不再进稿，
        // 必须计数。判据是映射**显式声明**的 `consumedTexts`，不做文本匹配（`2.1 KB`
        // 变成 `details.sizeBytes: 2150` 之后字符串本就不在 props 里，匹配必然误报）。
        const consumed = new Set(instance.consumedTexts ?? [])
        const replacedTexts = instanceTexts.filter((text) => !consumed.has(text)).length
        noteComponent(identity.name, { component: instance.component, replacedTexts })
        usedComponents.set(instance.component, instance.decl)
        const componentNode: AxNode = {
          id,
          kind: 'component',
          name: instance.component,
          ...(instance.props !== undefined ? { props: instance.props } : {}),
          ...(instance.fixture !== undefined ? { fixture: instance.fixture } : {}),
        }
        // 绝对定位的实例：`.ax` 的坐标只写在 overlay 上，包一层保住落点（组件节点自身
        // 不带度量——度量在实现侧，这是格式的硬规则）。
        if (pen.layoutPosition === 'absolute') {
          return { ...overlayOf(pen, parentSize), children: [componentNode] }
        }
        return componentNode
      }
      if (identity) {
        // 「登记了但这一处升不了」（如工具卡标题不合形）优先用实例级原因，其次才是
        // 名字级延后原因（注册表缺条目/画布容纳未做），最后是兜底文案。
        const reason = (instance && 'defer' in instance ? instance.defer : undefined)
          ?? axDeferReasonOfPenComponent(pen.refComponentName)
          ?? '未登记的组件（映射表与注册表都查不到对应实现）'
        noteComponent(identity.name, { reason })
        const count = components.get(identity.name)?.count ?? 1
        if (count <= 3) {
          warnings.push({
            path,
            message: `组件实例「${identity.name}」未升级为真实组件，保持 primitive 展开（${reason}）`,
          })
        }
      }
    }

    if (pen.layoutPosition === 'absolute' && pen.type !== 'frame') {
      const overlay = overlayOf(pen, parentSize)
      const inner = convert({ ...pen, layoutPosition: undefined } as PenNode, `${path}.children[0]`)
      if (!inner) return null
      return { ...overlay, children: [inner] }
    }

    const common: Pick<AxNode, 'id'> = { id }
    let result: AxNode | null = null

    switch (pen.type) {
      case 'frame':
      case 'ref': {
        const selfSize = rectOf(pen)
        const children = (pen.children ?? [])
          .map((child, index) => convert(child, `${path}.children[${index}]`, selfSize))
          .filter((child): child is AxNode => child !== null)
        const absolute = pen.layoutPosition === 'absolute'
        result = {
          ...common,
          kind: 'frame',
          ...(pen.layout ? { layout: pen.layout } : {}),
          ...(pen.gap !== undefined ? { gap: tokenRef(pen.gap) as AxNode['gap'] } : {}),
          ...paddingOf(pen, path),
          ...(pen.width !== undefined ? { width: sizeOf(pen.width) } : {}),
          ...(pen.height !== undefined ? { height: sizeOf(pen.height) } : {}),
          ...(pen.justifyContent ? { justifyContent: pen.justifyContent === 'space-between' ? 'space_between' : pen.justifyContent } : {}),
          ...(pen.alignItems ? { alignItems: pen.alignItems } : {}),
          ...(pen.clip ? { clip: true } : {}),
          ...(pen.theme?.mode ? { theme: pen.theme.mode } : {}),
          ...(pen.fill ? { fill: fieldFill(pen.fill, path, 'fill') } : {}),
          // 容器同样可以带描边/圆角（.pen 实测 frame 大量用描边画分隔线、圆角画卡片）；
          // 漏掉会让导入稿丢掉这些视觉，且字段对账记成「未迁移」。
          ...(pen.stroke ? { stroke: fieldStroke(pen.stroke, path, 'stroke') } : {}),
          ...(pen.strokeWidth !== undefined ? { strokeWidth: pen.strokeWidth } : {}),
          ...(pen.cornerRadius !== undefined ? { cornerRadius: pen.cornerRadius } : {}),
          ...(pen.shadow ? { shadow: shadowToAx(pen.shadow) } : {}),
          children,
        }
        if (absolute) {
          // frame 的绝对定位：同上用 overlay 包一层（内层保留全部尺寸与布局字段，
          // 用派生 id 保证唯一性——`.ax` 要求 id 在页内不重复）。
          const overlay = overlayOf(pen, parentSize)
          result = { ...overlay, children: [result] }
        }
        break
      }
      case 'text':
        result = {
          ...common,
          kind: 'text',
          // .pen 的文案是 mock 展示文本：`.ax` 用 `$mock` 显式记下这个语义（规则 2）。
          text: { $mock: pen.content ?? '' } satisfies AxBinding,
          ...(pen.width !== undefined ? { width: sizeOf(pen.width) } : {}),
          ...(pen.height !== undefined ? { height: sizeOf(pen.height) } : {}),
          ...(pen.fontSize !== undefined ? { fontSize: pen.fontSize } : {}),
          ...(pen.fontWeight !== undefined ? { fontWeight: pen.fontWeight } : {}),
          ...(pen.fontFamily ? { fontFamily: pen.fontFamily } : {}),
          ...(pen.lineHeight !== undefined ? { lineHeight: lineHeightOf(pen.lineHeight) } : {}),
          ...(pen.letterSpacing !== undefined ? { letterSpacing: pen.letterSpacing } : {}),
          ...(pen.textAlign ? { textAlign: pen.textAlign } : {}),
          wrap: wrapOf(pen.textGrowth),
          ...(pen.fill ? { fill: fieldFill(pen.fill, path, 'fill') } : {}),
          ...(pen.shadow ? { shadow: shadowToAx(pen.shadow) } : {}),
          ...(pen.theme?.mode ? { theme: pen.theme.mode } : {}),
        }
        break
      case 'icon': {
        // 图标尺寸三个来源同值（.pen 里 fontSize/width/height 一致）；取第一个数值。
        // 覆写透传的原始子树可能只有 width/height，缺失会让投影出无尺寸图标。
        const iconSize = [pen.fontSize, pen.width, pen.height]
          .find((value) => typeof value === 'number') as number | undefined
        result = {
          ...common,
          kind: 'icon',
          ...(pen.icon ? { name: pen.icon } : {}),
          ...(iconSize !== undefined ? { size: iconSize } : {}),
          ...(pen.fill ? { fill: fieldFill(pen.fill, path, 'fill') } : {}),
          ...(pen.shadow ? { shadow: shadowToAx(pen.shadow) } : {}),
          ...(pen.theme?.mode ? { theme: pen.theme.mode } : {}),
        }
        break
      }
      case 'rectangle':
      case 'ellipse':
        result = {
          ...common,
          kind: pen.type === 'rectangle' ? 'rect' : 'ellipse',
          ...(pen.width !== undefined ? { width: sizeOf(pen.width) } : {}),
          ...(pen.height !== undefined ? { height: sizeOf(pen.height) } : {}),
          ...(pen.fill ? { fill: fieldFill(pen.fill, path, 'fill') } : {}),
          ...(pen.stroke ? { stroke: fieldStroke(pen.stroke, path, 'stroke') } : {}),
          ...(pen.strokeWidth !== undefined ? { strokeWidth: pen.strokeWidth } : {}),
          ...(pen.cornerRadius !== undefined ? { cornerRadius: pen.cornerRadius } : {}),
          ...(pen.shadow ? { shadow: shadowToAx(pen.shadow) } : {}),
          ...(pen.type === 'ellipse' && pen.innerRadius !== undefined ? { innerRadius: pen.innerRadius } : {}),
          ...(pen.theme?.mode ? { theme: pen.theme.mode } : {}),
        }
        break
      case 'path':
        result = {
          ...common,
          kind: 'path',
          ...(pen.geometry ? { geometry: pen.geometry } : {}),
          ...(pen.viewBox ? { viewBox: pen.viewBox } : {}),
          ...(pen.width !== undefined ? { width: sizeOf(pen.width) } : {}),
          ...(pen.height !== undefined ? { height: sizeOf(pen.height) } : {}),
          ...(pen.fill ? { fill: fieldFill(pen.fill, path, 'fill') } : {}),
          ...(pen.stroke ? { stroke: fieldStroke(pen.stroke, path, 'stroke') } : {}),
          ...(pen.shadow ? { shadow: shadowToAx(pen.shadow) } : {}),
          ...(pen.theme?.mode ? { theme: pen.theme.mode } : {}),
        }
        break
      default:
        warnings.push({ path, message: `跳过无法映射的节点类型 ${pen.type}` })
        return null
    }

    if (!result) return null
    // 未迁移字段对账：源节点上有、目标种类不接受的键逐个记账（含显式不带的坐标）。
    const allowed = AX_ALLOWED_KEYS[result.kind]
    for (const key of Object.keys(pen as unknown as Record<string, unknown>)) {
      if (key === 'children' || key === 'id' || key === 'name' || key === 'type') continue
      // 实例来源标记（ref → component 升级用）：解析器加的溯源信息，不是稿里的设计字段。
      if (key === 'refComponentId' || key === 'refComponentName') continue
      if (allowed.includes(key)) continue
      if (key === 'layoutPosition' || key === 'x' || key === 'y') continue
      if (key === 'icon' && result.kind === 'icon') continue
      if (key === 'library' && result.kind === 'icon') continue
      // icon 的尺寸由 `size` 派生（.pen 的 width/height/fontSize 三者同值），不算丢失。
      if (result.kind === 'icon' && result.size !== undefined
        && (key === 'width' || key === 'height' || key === 'fontSize')) continue
      if (key === 'content' && result.kind === 'text') continue
      if (key === 'textGrowth' && result.kind === 'text') continue
      if (key === 'strokeWidth' && (result.kind === 'path' || result.kind === 'rect' || result.kind === 'ellipse')) continue
      noteDropped(path, key)
    }
    return result
  }

  const pages: AxPage[] = document.pages.map((page, index) => {
    const path = `pages[${index}]`
    const pen = page as PenNode
    // `.pen` 的顶层节点可以不是容器（画布上直接放的一张占位矩形/图片）：`.ax` 的页
    // 按定义是容器，因此把该节点本身放进 tree（大小仍取节点尺寸），页背景留给子节点——
    // 否则这类「页」会被导成一个空页面，画布上白板一块。
    const isContainerPage = pen.type === 'frame' || pen.type === 'ref'
    const backgroundFill = isContainerPage ? paintToAx(pen.fill) : undefined
    const background = typeof backgroundFill === 'string' ? backgroundFill : undefined
    if (backgroundFill !== undefined && background === undefined) {
      warnings.push({ path, message: '未迁移字段 `fill(渐变页背景)`（.ax 暂不接受）' })
    }
    const pageSize = rectOf(pen)
    const tree = (isContainerPage
      ? (pen.children ?? []).map((child, childIndex) => convert(child, `${path}.tree[${childIndex}]`, pageSize))
      : [convert(page, `${path}.tree[0]`)])
      .filter((child): child is AxNode => child !== null)
    return {
      id: pen.id,
      ...(pen.name ? { name: pen.name } : {}),
      ...(pen.layout ? { layout: pen.layout } : {}),
      ...(pen.gap !== undefined ? { gap: tokenRef(pen.gap) as number | string } : {}),
      ...(Array.isArray(pen.padding) ? { padding: (pen.padding as Array<number | string>).slice() } : {}),
      ...(typeof pen.width === 'number' ? { width: pen.width } : {}),
      ...(typeof pen.height === 'number' ? { height: pen.height } : {}),
      ...(background ? { background } : {}),
      tree,
    }
  })

  const tokens: Record<string, AxToken> = {}
  for (const name of Object.keys(document.modeVariables.dark)) {
    const light = document.modeVariables.light[name] ?? document.modeVariables.dark[name] ?? ''
    const dark = document.modeVariables.dark[name] ?? light
    const { type, value } = tokenTypeOf(name, dark)
    const lightConverted = type === 'dimension' && /^-?\d+(\.\d+)?$/.test(light) ? `${light}px` : light
    tokens[name] = {
      $type: type,
      $value: light === dark ? value : { light: lightConverted, dark: value },
    }
  }

  // 升级面里「由实现侧数据取代的文案」逐组件记一条：这是升级的固有代价（组件节点不带
  // 子树），但必须是可数的——不能让人以为稿里原来的那几句话还在。
  for (const item of components.values()) {
    if (item.component === undefined || (item.replacedTexts ?? 0) === 0) continue
    warnings.push({
      path: item.name,
      message: `组件实例「${item.name}」×${item.count} 升级后内容由实现侧提供：实例子树里 ${item.replacedTexts} 条文案未进稿（真组件按 props/fixture 渲染）`,
    })
  }

  return {
    document: {
      ax: AX_FORMAT_VERSION,
      ...(name ?? document.fileName ? { name: (name ?? document.fileName).replace(/\.pen$/i, '') } : {}),
      tokens,
      // 词汇表按本稿实际用到的组件生成（空对象会让校验器直接否掉组件节点）。
      components: Object.fromEntries(usedComponents),
      pages,
    },
    warnings,
    components: [...components.values()].sort((left, right) => right.count - left.count),
  }
}
