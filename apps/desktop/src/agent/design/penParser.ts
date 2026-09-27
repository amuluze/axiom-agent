/**
 * .pen 设计稿解析器（docs/design-canvas.md D2）。
 *
 * 只承诺渲染实测子集（frame/text/icon/ref/ellipse/rectangle + 主题 variables
 * + flex 布局 + solid/gradient 填充 + shadow/描边），未知节点类型降级为带名
 * 占位框（解析期记入 diagnostics）——应对 .pen 活规范演进，保底不崩溃。
 * 解析产物与渲染解耦：PenNode 是中间表示，CSS 映射在 PenNodeView。
 */

export type PenSize = number | 'fill_container' | 'fit_content'

export type PenThemeMode = 'light' | 'dark'

export interface PenPaintSolid {
  kind: 'solid'
  /** 原始值：'#hex' 字面色或 '$token' 引用（渲染期映射为 var(--token)）。 */
  value: string
}

export type PenGradientType = 'linear' | 'radial' | 'angular'

/** 渐变色标：color 已 tokenToCss（'var(--x)' 或字面色），position 为 0–1 比例。 */
export interface PenGradientStop {
  color: string
  position: number
}

export interface PenPaintGradient {
  kind: 'gradient'
  /** 已拼装的 CSS gradient（token 引用保留为 var(--token)）。 */
  css: string
  /** 渐变类型：angular 走 conic-gradient（进度环等，见 PEN_ANGULAR_CSS）。 */
  gradientType: PenGradientType
  /** .pen 的旋转角（度）。CSS 侧已折进 css：linear 用 180+rotation，angular 用 from rotation。 */
  rotation: number
  /** 色标原值：DOM 侧用 css，`path` 节点的 SVG 渐变需要重建 stop 列表。 */
  stops: PenGradientStop[]
}

export interface PenPaintImage {
  kind: 'image'
  /** 图片引用：.pen 同目录相对路径或远程 URL（渲染期拒绝远程，见 docs/design-canvas.md §8）。 */
  url: string
  /** 填充模式（fill/fit/stretch/tile），渲染期映射 background-size。 */
  mode?: string
}

export type PenPaint = PenPaintSolid | PenPaintGradient | PenPaintImage

export interface PenShadow {
  color: string
  x: number
  y: number
  blur: number
}

/** 逐边描边宽度（.pen 用 `{"bottom":1}` 这类对象表达分隔线，见 parseStrokeWidth）。 */
export interface PenPerSideStrokeWidth {
  top?: number | string
  right?: number | string
  bottom?: number | string
  left?: number | string
}

/** 未知节点类型的占位：保留原名供画布诊断展示。 */
export interface PenUnknownNode {
  type: 'unknown'
  id: string
  name?: string
  originalType: string
  width?: PenSize
  height?: PenSize
}

export interface PenNode {
  type: 'frame' | 'text' | 'icon' | 'ellipse' | 'rectangle' | 'ref' | 'path'
  id: string
  name?: string
  x?: number
  y?: number
  layoutPosition?: 'absolute'
  width?: PenSize
  height?: PenSize
  fill?: PenPaint
  stroke?: PenPaint
  strokeWidth?: number | PenPerSideStrokeWidth
  cornerRadius?: string | number
  layout?: 'vertical' | 'horizontal'
  gap?: number | string
  padding?: Array<number | string>
  justifyContent?: string
  alignItems?: string
  clip?: boolean
  opacity?: number
  shadow?: PenShadow
  /** text */
  content?: string
  fontSize?: number | string
  fontWeight?: number | string
  fontFamily?: string
  textAlign?: string
  textGrowth?: string
  lineHeight?: number | string
  letterSpacing?: number | string
  /** icon */
  icon?: string
  library?: string
  /** ellipse */
  innerRadius?: number
  /** path：SVG path data 与视图框（渲染为内联 SVG，见 PenNodeView 的 path 分支）。 */
  geometry?: string
  viewBox?: [number, number, number, number]
  /** ref 解析出的组件子树 + 节点级主题覆写 */
  children?: PenNodeUnion[]
  theme?: { mode?: PenThemeMode }
  /** ref 目标缺失时置位（渲染为占位框）。 */
  refMissing?: boolean
  /**
   * ref 实例的来源：组件定义 id 与**定义名**（形如 `component/xxx`）。实例身份在展开时
   * 本来会丢（组件根被克隆进页树、id 换成实例 id），这两项把它记回来——`.pen → .ax`
   * 的组件升级（`axComponentMap`）只认这个来源，不靠命名或几何去猜。
   */
  refComponentId?: string
  refComponentName?: string
}

/**
 * `.ax` 的组件实例节点：**只有 `.ax` 投影会产出**（`.pen` 解析器不会生成）。
 * 渲染期由注册表（`components/design/ax/registry`）解析成真实组件——这是「真组件渲染」
 * 与「设计 → 代码恒等映射」的载体。放在这里是因为画布视图模型是共用的一套。
 */
export interface PenComponentNode {
  type: 'component'
  id: string
  name: string
  variant?: string
  props?: Record<string, unknown>
  /** 数据档案名（对应注册表条目的 fixtures 键）。 */
  fixture?: string
  /** 插槽子节点：宿主保证可见可选中，但不由真组件消费（标注为未映射）。 */
  children?: PenNodeUnion[]
}

/** `.ax` 的语义部件节点（同样只由 `.ax` 投影产出）：渲染映射见 `agent/design/axParts`。 */
export interface PenPartNode {
  type: 'part'
  id: string
  part: string
  variant?: string
  label?: string
  supporting?: string
  icon?: string
  count?: number
  selected?: boolean
  state?: string
}

export type PenNodeUnion = PenNode | PenUnknownNode | PenComponentNode | PenPartNode

export interface PenDiagnostic {
  level: 'error' | 'warning'
  message: string
  /** 出错位置（`pages[0].tree[2].children[1]`）。.pen 解析不产出该字段；
   *  .ax 校验器用它给模型节点路径级的错误以便按路径自修。 */
  path?: string
}

export interface PenVariableEntry {
  value: string
  mode?: PenThemeMode
}

export interface PenDocument {
  fileName: string
  /** .pen spec 版本（如 "2.18"）；缺失时为 undefined。 */
  version?: string
  pages: PenNodeUnion[]
  components: Record<string, PenNode>
  /** token 名 → 按主题变体归一后的取值条目。 */
  variables: Record<string, PenVariableEntry[]>
  /** 各主题模式的全量 token 字面值（画布容器注入 + 节点级主题覆写用）。 */
  modeVariables: Record<PenThemeMode, Record<string, string>>
  diagnostics: PenDiagnostic[]
}

export interface PenParseResult {
  document: PenDocument | null
  error: string | null
}

const MAX_REF_DEPTH = 8

/** 渲染器已验证的 .pen spec 主版本（docs/design-canvas.md §9：渐进补齐，占位框保底）。 */
const SUPPORTED_SPEC_MAJOR = 2

/**
 * CSS 值安全判定：.pen 是不完全可信的输入（外部文件 / 模型产出），字面色与
 * token 值会原样进入 background/border/boxShadow 等可触发加载的属性——
 * url() 会发起远程请求（外链泄密面），expression()/javascript: 是历史
 * 可执行向量。命中即视为不安全，由调用方置空（docs/design-canvas.md §8
 * 「远程 URL 一律拒绝」的渲染器侧收口）。
 * 先剔除 CSS 注释再匹配：`u/**\/rl(x)` 在浏览器里等价 url(x)，否则构成绕过。
 */
const UNSAFE_CSS_VALUE_PATTERN = /url\s*\(|expression\s*\(|javascript\s*:/i

export const isUnsafeCssValue = (value: string): boolean =>
  UNSAFE_CSS_VALUE_PATTERN.test(value.replace(/\/\*[\s\S]*?\*\//g, ''))

/** 图片填充的远程引用判定：带 scheme（https:/data:/blob:…）或协议相对 // 均视为远程。 */
export const isRemoteImageUrl = (url: string): boolean =>
  /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith('//')

const normalizePaint = (raw: unknown): PenPaint | undefined => {
  if (typeof raw === 'string') return { kind: 'solid', value: raw }
  if (Array.isArray(raw)) {
    // 填充列表：取首个未禁用的条目。
    for (const item of raw) {
      if (item && typeof item === 'object' && item.enabled === false) continue
      const inner = item && typeof item === 'object' && 'value' in item ? item.value : item
      const paint = normalizePaint(inner)
      if (paint) return paint
    }
    return undefined
  }
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  if (record.enabled === false) return undefined
  if (record.type === 'image') {
    // 图片填充：url 原样保留，远程拒绝与资产加载在渲染期完成（异步通道）。
    if (typeof record.url !== 'string' || !record.url) return undefined
    return {
      kind: 'image',
      url: record.url,
      mode: typeof record.mode === 'string' ? record.mode : undefined,
    }
  }
  if (record.type === 'solid') return normalizePaint(record.value)
  if (record.type === 'gradient') {
    const colors = Array.isArray(record.colors) ? record.colors : []
    const stops: PenGradientStop[] = colors
      .filter((stop) => stop && typeof stop === 'object')
      .map((stop) => ({
        color: tokenToCss(String(stop.color)),
        position: Number(stop.position) || 0,
      }))
    if (stops.length === 0) return undefined
    const stopList = stops
      .map((stop) => `${stop.color} ${Math.round(stop.position * 100)}%`)
      .join(', ')
    const rotation = Number(record.rotation) || 0
    const gradientType: PenGradientType =
      record.gradientType === 'radial'
        ? 'radial'
        : record.gradientType === 'angular'
          ? 'angular'
          : 'linear'
    // angular（实测 axiom.pen 的预算进度环）是 conic-gradient：此前落进 linear
    // 分支，进度环被画成一条线性色带。rotation 直接作为 conic 的起始角。
    const css =
      gradientType === 'radial'
        ? `radial-gradient(circle, ${stopList})`
        : gradientType === 'angular'
          ? `conic-gradient(from ${rotation}deg, ${stopList})`
          : `linear-gradient(${180 + rotation}deg, ${stopList})`
    return { kind: 'gradient', css, gradientType, rotation, stops }
  }
  return normalizePaint(record.value)
}

/**
 * 描边宽度归一：数值视为 px；对象形态是**逐边**描边（实测 axiom.pen 27 处
 * `{"bottom":1}` / `{"top":1}`、website.pen 另有 `{"left":2}` 与双边组合），
 * 设计稿用它画分隔线而不是分隔矩形（见反馈弹窗组件的 context 注记）。此前对象
 * 被丢弃后回落到 `?? 1`，四边全描——分隔线变成方框；只有单边为 0 的组合无从
 * 表达。逐边对象必须原样保留，渲染层按 side 输出 border-top/right/bottom/left。
 */
const SIDES = ['top', 'right', 'bottom', 'left'] as const

const normalizeStrokeWidth = (
  raw: unknown,
): number | PenPerSideStrokeWidth | undefined => {
  if (typeof raw === 'number') return raw
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const sides: PenPerSideStrokeWidth = {}
  for (const side of SIDES) {
    const value = record[side]
    if (typeof value === 'number' || typeof value === 'string') sides[side] = value
  }
  return Object.keys(sides).length > 0 ? sides : undefined
}

const normalizeShadow = (raw: unknown): PenShadow | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const offset = (record.offset ?? {}) as Record<string, unknown>
  return {
    color: String(record.color ?? 'rgba(0,0,0,0.25)'),
    x: Number(offset.x) || 0,
    y: Number(offset.y) || 0,
    blur: Number(record.blur) || 0,
  }
}

/**
 * padding 归一：数组原样（只留 number/string 项）；标量（数字或单个 token）
 * 按四边展开。实测 axiom.pen 存在 41 处标量 padding——此前非数组被静默丢弃
 * （渲染缺 padding），且经 ref descendants 覆写透传的非数组值会让渲染层
 * `.map` 崩溃（画布整树卸载），统一在此收敛。
 */
const normalizePadding = (raw: unknown): Array<number | string> | undefined => {
  if (Array.isArray(raw)) {
    const values = raw.filter(
      (item): item is number | string => typeof item === 'number' || typeof item === 'string',
    )
    return values.length > 0 ? values : undefined
  }
  if (typeof raw === 'number' || typeof raw === 'string') return [raw, raw, raw, raw]
  return undefined
}

/**
 * '$token' → 'var(--token)'；字面值原样返回。非字符串输入（坏数据兜底）渲染为
 * 空值，不抛错。含 url(/expression(/javascript: 的值渲染为空值——阻止 .pen
 * 经 CSS 属性发起远程加载（docs/design-canvas.md §8）。
 */
export const tokenToCss = (value: string): string => {
  if (typeof value !== 'string') return ''
  if (isUnsafeCssValue(value)) return ''
  return value.startsWith('$') ? `var(--${value.slice(1)})` : value
}

/**
 * token 值 → CSS 自定义属性值。
 *
 * .pen 的 `number` 型 token 是**长度**：实测 axiom.pen 的 37 个 number token
 * （text-3xs…text-3xl、space-1…space-104、radius-4…radius-pill）只被
 * gap(835)/padding(1268)/cornerRadius(539)/fontSize(1032) 消费，website.pen 同理。
 * 注入成裸数值会让 `font-size: var(--text-md)` 解析为 `font-size: 13`——CSS 里
 * 这是无效声明，整条被丢弃：字号回落到继承值、gap/padding 变 0、圆角为 0，
 * 画布于是「所有文字同号、元素之间没有间距」。颜色与字符串 token 原样保留。
 */
const tokenCssValue = (value: string): string =>
  /^-?\d+(\.\d+)?$/.test(value.trim()) ? `${value.trim()}px` : value

const normalizeVariableEntries = (
  raw: unknown,
  onUnsafeValue?: (value: string) => void,
): PenVariableEntry[] => {
  // token 值会作为 CSS 自定义属性注入画布容器，经 var(--token) 同样能进入
  // background 等加载型属性——与 tokenToCss 同口径置空不安全值。
  const sanitize = (value: string): string => {
    if (isUnsafeCssValue(value)) {
      onUnsafeValue?.(value)
      return ''
    }
    return value
  }
  if (typeof raw === 'string' || typeof raw === 'number') {
    return [{ value: sanitize(String(raw)) }]
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((item) => item && typeof item === 'object' && item.value !== undefined)
      .map((item) => ({
        value: sanitize(String(item.value)),
        mode:
          item.theme?.mode === 'light' || item.theme?.mode === 'dark'
            ? (item.theme.mode as PenThemeMode)
            : undefined,
      }))
  }
  if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).value !== undefined) {
    // 直接下钻 value：包一层数组会把「对象形态的 entries 数组」变成嵌套数组，
    // 在下方 Array 分支被过滤成空，主题 token 全部丢失（画布 token 失效）。
    return normalizeVariableEntries((raw as Record<string, unknown>).value, onUnsafeValue)
  }
  return []
}

/**
 * descendants 覆写的复合字段按 parseNode 同源规则归一后再并入：
 * 覆写直接裸 spread 会把未解析形状（如裸字符串 `fill: "$text"`）种进已解析
 * 节点，渲染层 `paintToCss` 取 `.value` 即抛 TypeError——无错误边界时整树
 * 卸载（黑屏）。fill/stroke 走 normalizePaint，effect/shadow 走 normalizeShadow。
 */
const normalizeDescendantOverride = (override: Record<string, unknown>): Record<string, unknown> => {
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(override)) {
    if (key === 'fill' || key === 'stroke') {
      normalized[key] = normalizePaint(value)
    } else if (key === 'effect' || key === 'shadow') {
      normalized.shadow = normalizeShadow(value)
    } else if (key === 'padding') {
      normalized.padding = normalizePadding(value)
    } else {
      normalized[key] = value
    }
  }
  return normalized
}

/** 解析 ref 的 descendants 覆写：按节点 id 深度合并；enabled:false 摘除子树。 */
const applyDescendants = (
  node: PenNodeUnion,
  overrides: Record<string, Record<string, unknown>>,
): PenNodeUnion | null => {
  const override = overrides[node.id]
  let merged: PenNodeUnion = node
  if (override) {
    if (override.enabled === false) return null
    merged = { ...node, ...normalizeDescendantOverride(override) } as PenNodeUnion
  }
  const penNode = merged as PenNode
  if (!penNode.children) return merged
  const children = penNode.children
    .map((child) => applyDescendants(child, overrides))
    .filter((child): child is PenNodeUnion => child !== null)
  return { ...merged, children } as PenNodeUnion
}

interface ParseContext {
  document: PenDocument
  refStack: Set<string>
}

const parseNode = (raw: unknown, context: ParseContext, depth: number): PenNodeUnion | null => {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (record.enabled === false) return null
  const type = String(record.type ?? '')
  const id = String(record.id ?? '')

  if (type === 'ref') {
    const refId = String(record.ref ?? '')
    const component = context.document.components[refId]
    if (!component || depth > MAX_REF_DEPTH || context.refStack.has(refId)) {
      if (!component) {
        context.document.diagnostics.push({
          level: 'warning',
          message: `ref 指向未定义组件：${refId || '(空)'}`,
        })
      }
      return {
        type: 'ref',
        id,
        name: typeof record.name === 'string' ? record.name : undefined,
        refMissing: true,
      }
    }
    context.refStack.add(refId)
    try {
      const overrides = (record.descendants ?? {}) as Record<string, Record<string, unknown>>
      const resolved = applyDescendants(structuredClone(component), overrides)
      if (!resolved) return null
      // ref 层的布局属性覆写组件根节点（ref 自身属性优先）。
      const root = resolved as PenNode
      // 实例来源要先记：下面的 `root.name` 覆写会盖掉组件定义名（稿里的实例常自带名字），
      // 记晚了就拿不到「这是哪个组件」——`.pen → .ax` 的组件升级靠它。
      root.refComponentId = refId
      root.refComponentName = typeof component.name === 'string' ? component.name : undefined
      root.id = id
      if (record.name !== undefined) root.name = String(record.name)
      if (record.width !== undefined) root.width = record.width as PenSize
      if (record.height !== undefined) root.height = record.height as PenSize
      if (record.layoutPosition !== undefined) {
        root.layoutPosition = record.layoutPosition as 'absolute'
      }
      if (typeof record.x === 'number') root.x = record.x
      if (typeof record.y === 'number') root.y = record.y
      if (record.theme && typeof record.theme === 'object') {
        root.theme = record.theme as PenNode['theme']
      }
      return resolved
    } finally {
      context.refStack.delete(refId)
    }
  }

  if (
    // `group` 是 2.15 及更早的节点类型：参考实现的 2.15→2.16 迁移把它改写成
    // frame 并清掉布局属性（group 自 2.16 起不再有布局），clip 归 false。
    // 老文件（第三方 .pen）里仍会出现，降级成占位框会整块丢掉内容。
    type === 'group' ||
    type === 'frame' ||
    type === 'text' ||
    type === 'icon' ||
    type === 'ellipse' ||
    type === 'rectangle' ||
    type === 'path'
  ) {
    const node: PenNode = { type: type === 'group' ? 'frame' : type, id }
    if (typeof record.name === 'string') node.name = record.name
    if (typeof record.x === 'number') node.x = record.x
    if (typeof record.y === 'number') node.y = record.y
    if (record.layoutPosition === 'absolute') node.layoutPosition = 'absolute'
    if (record.width !== undefined) node.width = record.width as PenSize
    if (record.height !== undefined) node.height = record.height as PenSize
    node.fill = normalizePaint(record.fill)
    node.stroke = normalizePaint(record.stroke)
    for (const paint of [node.fill, node.stroke]) {
      if (paint?.kind === 'image' && isRemoteImageUrl(paint.url)) {
        // 渲染期同样拒绝（PenNodeView），这里先记诊断让画布可见。
        // 只放行 .pen 同目录相对路径：远程/协议相对/内嵌 data: 一律拒绝。
        context.document.diagnostics.push({
          level: 'warning',
          message: `外部图片引用已拒绝（仅支持 .pen 同目录相对路径）：${paint.url.slice(0, 80)}`,
        })
      }
    }
    const strokeWidth = normalizeStrokeWidth(record.strokeWidth)
    if (strokeWidth !== undefined) node.strokeWidth = strokeWidth
    if (record.cornerRadius !== undefined) {
      node.cornerRadius = record.cornerRadius as string | number
    }
    // group（2.15 及更早）没有布局语义：迁移会连同 gap/padding/对齐一起清掉，
    // 子节点按各自 x/y 绝对摆放。裁剪同样归 false（见上方 group 分支注释）。
    if (type !== 'group') {
      if (record.layout === 'vertical' || record.layout === 'horizontal') {
        node.layout = record.layout
      }
      if (record.gap !== undefined) node.gap = record.gap as number | string
      const padding = normalizePadding(record.padding)
      if (padding) node.padding = padding
      if (typeof record.justifyContent === 'string') node.justifyContent = record.justifyContent
      if (typeof record.alignItems === 'string') node.alignItems = record.alignItems
      if (record.clip === true) node.clip = true
    }
    if (typeof record.opacity === 'number') node.opacity = record.opacity
    node.shadow = normalizeShadow(record.effect)
    if (type === 'text') {
      node.content = String(record.content ?? '')
      if (record.fontSize !== undefined) node.fontSize = record.fontSize as number | string
      if (record.fontWeight !== undefined) {
        node.fontWeight = record.fontWeight as number | string
      }
      if (typeof record.fontFamily === 'string') node.fontFamily = record.fontFamily
      if (typeof record.textAlign === 'string') node.textAlign = record.textAlign
      if (typeof record.textGrowth === 'string') node.textGrowth = record.textGrowth
      if (record.lineHeight !== undefined) node.lineHeight = record.lineHeight as number | string
      if (record.letterSpacing !== undefined) {
        node.letterSpacing = record.letterSpacing as number | string
      }
    }
    if (type === 'icon') {
      node.icon = typeof record.icon === 'string' ? record.icon : undefined
      node.library = typeof record.library === 'string' ? record.library : undefined
    }
    if (type === 'ellipse' && typeof record.innerRadius === 'number') {
      node.innerRadius = record.innerRadius
    }
    if (type === 'path') {
      if (typeof record.geometry === 'string' && record.geometry.trim() !== '') {
        node.geometry = record.geometry
      }
      // viewBox 实测为数组 [x,y,w,h]（website.pen 的品牌 mark 为 [0,0,512,512]）；
      // 字符串形态（"0 0 512 512"）兼容读取，两者都归一为四元组。
      const box = Array.isArray(record.viewBox)
        ? record.viewBox
        : typeof record.viewBox === 'string'
          ? record.viewBox.trim().split(/[\s,]+/)
          : []
      const numbers = box.map((value) => Number(value))
      if (numbers.length === 4 && numbers.every((value) => Number.isFinite(value))) {
        node.viewBox = numbers as [number, number, number, number]
      }
    }
    if (record.theme && typeof record.theme === 'object') {
      node.theme = record.theme as PenNode['theme']
    }
    if (Array.isArray(record.children)) {
      node.children = record.children
        .map((child) => parseNode(child, context, depth + 1))
        .filter((child): child is PenNodeUnion => child !== null)
    }
    // group（2.15 及更早）的定位语义是「子节点各按 x/y 摆放」——组内子节点带坐标、
    // 不带 layoutPosition，按 frame 的默认横向流式排版会把它们挤成一行。
    if (type === 'group' && node.children) {
      for (const child of node.children) {
        if (child.type === 'unknown' || child.type === 'component' || child.type === 'part') continue
        if (typeof child.x === 'number' && typeof child.y === 'number') {
          // 未显式声明的子节点补 absolute（已是 absolute 的保持不变）。
          child.layoutPosition = 'absolute'
        }
      }
    }
    return node
  }

  // 未知节点类型（spec 演进 / 不支持特性如 script/browser）：占位框保底。
  if (type) {
    context.document.diagnostics.push({
      level: 'warning',
      message: `不支持的节点类型「${type}」已降级为占位框`,
    })
    return {
      type: 'unknown',
      id,
      name: typeof record.name === 'string' ? record.name : undefined,
      originalType: type,
      width: record.width as PenSize | undefined,
      height: record.height as PenSize | undefined,
    }
  }
  return null
}

/** 解析 .pen 文档：JSON 失败返回 error；节点级问题走 diagnostics 容错降级。 */
export const parsePenDocument = (source: string, fileName: string): PenParseResult => {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (error) {
    return {
      document: null,
      error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Record<string, unknown>).children)) {
    return { document: null, error: '不是有效的 .pen 文档（缺少 children 数组）' }
  }
  const record = raw as Record<string, unknown>
  const document: PenDocument = {
    fileName,
    pages: [],
    components: {},
    variables: {},
    modeVariables: { light: {}, dark: {} },
    diagnostics: [],
  }

  // 版本记录（docs/design-canvas.md §9）：spec 是活规范，主版本超出已验证
  // 范围时记诊断告警——渲染仍继续，未知结构由占位框兑底。
  if (record.version !== undefined) {
    const version = String(record.version)
    document.version = version
    const major = Number.parseInt(version.split('.')[0] ?? '', 10)
    if (!Number.isNaN(major) && major > SUPPORTED_SPEC_MAJOR) {
      document.diagnostics.push({
        level: 'warning',
        message: `设计稿版本 v${version} 超出渲染器已验证范围（${SUPPORTED_SPEC_MAJOR}.x），未知结构将降级为占位框`,
      })
    }
  }

  for (const [name, variable] of Object.entries(
    (record.variables ?? {}) as Record<string, unknown>,
  )) {
    let unsafeCount = 0
    const entries = normalizeVariableEntries(variable, () => {
      unsafeCount += 1
    })
    if (unsafeCount > 0) {
      document.diagnostics.push({
        level: 'warning',
        message: `token「${name}」含远程加载/可执行 CSS 值，已置空（×${unsafeCount}）`,
      })
    }
    if (entries.length === 0) continue
    document.variables[name] = entries
    const base = entries.find((entry) => entry.mode === undefined)
    for (const mode of ['light', 'dark'] as const) {
      const scoped = entries.find((entry) => entry.mode === mode)
      document.modeVariables[mode][name] = tokenCssValue((scoped ?? base ?? entries[0]).value)
    }
  }

  const componentContext: ParseContext = { document, refStack: new Set() }
  for (const child of record.children as unknown[]) {
    if (!child || typeof child !== 'object') continue
    const childRecord = child as Record<string, unknown>
    if (childRecord.reusable === true) {
      const parsed = parseNode(child, componentContext, 0)
      if (parsed && parsed.type !== 'unknown') {
        document.components[String(childRecord.id ?? '')] = parsed as PenNode
      }
    }
  }

  const pageContext: ParseContext = { document, refStack: new Set() }
  for (const child of record.children as unknown[]) {
    // reusable 组件已在上一循环登记，不作为页面渲染。
    if ((child as Record<string, unknown> | null)?.reusable === true) continue
    const parsed = parseNode(child, pageContext, 0)
    if (parsed) document.pages.push(parsed)
  }

  return { document, error: null }
}

/** 按 id 在整份文档（页树 + 组件池）中查找节点；画布点选与查询工具共用 id 坐标系。 */
export const findPenNode = (
  document: PenDocument,
  nodeId: string,
): PenNodeUnion | undefined => {
  for (const page of document.pages) {
    if (page.id === nodeId) return page
    const hit = findInNodes('children' in page ? page.children : undefined, nodeId)
    if (hit) return hit
  }
  for (const component of Object.values(document.components)) {
    if (component.id === nodeId) return component
    const hit = findInNodes('children' in component ? component.children : undefined, nodeId)
    if (hit) return hit
  }
  return undefined
}

const findInNodes = (
  nodes: readonly PenNodeUnion[] | undefined,
  nodeId: string,
): PenNodeUnion | undefined => {
  if (!nodes) return undefined
  for (const node of nodes) {
    if (node.id === nodeId) return node
    const hit = findInNodes('children' in node ? node.children : undefined, nodeId)
    if (hit) return hit
  }
  return undefined
}
