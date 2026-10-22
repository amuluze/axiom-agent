/**
 * `.ax` 格式的契约层（docs/ax-format.md §3）：类型、强制常量、每条硬规则对应的键集。
 *
 * 与 `penParser` 的分工：`.pen` 是**外部活规范**，解析器只能宽容（未知节点降级占位）；
 * `.ax` 是**我们自己的规范**，解析器一律严格——未知键、未知节点种类、缺失的单位
 * 声明都是**错误**，不做静默降级。这正是「把还原失败前移到设计阶段」的落点：
 * 写稿当场报错，而不是等生成实现时才发现。
 */
import type { PenDiagnostic } from './penParser'

/**
 * 格式版本。改任何**语义**（字段含义、默认值、节点种类）都要 +1 并补 `axMigrations`
 * 单跳迁移；只加可选字段走 minor。major 不匹配且无迁移 → 加载失败（fail-closed）。
 *
 * 1.2：overlay 增加可选 `scrim`（遮罩语义，见 AxScrim）——1.1 的稿逐字节合法。
 * 1.3：frame/text/icon/rect/ellipse/path 增加可选 `shadow`（外阴影，见 AxShadow）
 * ——1.2 的稿逐字节合法。
 * 1.4：新增顶层可选 `symbols`（文档内局部组件：props 契约 + body 原语子树，
 * 见 AxSymbolDef）与 `{$param}` 绑定（body 文案位引用参数）——1.3 的稿逐字节合法。
 * 1.5：组件声明增加可选 `slots`（具名插槽契约，见 AxSlotDecl）——1.4 的稿逐字节合法。
 * 1.6：symbol 的 props 契约支持枚举型（`{ enum: [...] }`），`{$param}` 随之可落在
 * 枚举位（首期仅 `icon` 的 `name`，见 `AX_PARAM_ENUM_POSITIONS`）——1.5 的稿逐字节合法。
 */
export const AX_FORMAT_VERSION = '1.6'

/** 枚举位白名单（1.6）：`symbols.<名>.body` 里这些位置接受 `{$param}`（页树不接受）。 */
export const AX_PARAM_ENUM_POSITIONS = ['icon.name'] as const

/** 枚举值域上限：值域是写进契约又被实例逐次消费的闭集，超限说明参数建模错了。 */
export const AX_SYMBOL_ENUM_MAX_VALUES = 32

/** 解析器已验证的格式主版本；超出即拒绝（与 .pen 的「记诊断继续渲染」不同）。 */
export const AX_SUPPORTED_MAJOR = 1

export const AX_NODE_KINDS = [
  'component',
  'part',
  'frame',
  'text',
  'icon',
  'rect',
  'ellipse',
  'path',
  'image',
  'overlay',
] as const

export type AxNodeKind = (typeof AX_NODE_KINDS)[number]

/** 尺寸三态 + px 数值 + token 引用（数值即 px，是本格式唯一约定，见 docs §3.3 规则 5）。 */
export type AxSize = number | string | 'fill_container' | 'fit_content'

/**
 * 结构化 mock 值：JSON 可表达的任意值。组件的 `json` 型 props（工具调用的 call/result、
 * 消息对象等）在实现侧就是对象，用字符串包一层 JSON 会把「结构」藏进字符串里——
 * 与规则 5/6（单位/三态显式）同一取向：结构要显式写在稿里。
 */
export type AxJsonValue =
  | string
  | number
  | boolean
  | null
  | AxJsonValue[]
  | { [key: string]: AxJsonValue }

/**
 * 文案/标签值：字面量，或显式声明其为 mock 展示文案 / 绑真实数据源 / 引用 symbol
 * 参数（规则 2；`$param` 只出现在 `symbols.<name>.body` 的文案位，1.4）。
 */
export interface AxBinding {
  /** mock 字面量：文案用字符串，组件 props 可以是结构化值（对象/数组）。 */
  $mock?: AxJsonValue
  $bind?: string
  /** symbol body 内的参数引用（名字必须是该 symbol 契约里声明的 string 型 prop）。 */
  $param?: string
}

export type AxTextValue = string | AxBinding

/** 组件 props 值：字面量或绑定。 */
export type AxPropValue = string | number | boolean | AxBinding

/**
 * 渐变填充（`.pen` 实测用到 linear 与 angular；angular 映射 conic-gradient，
 * 第八轮已验证渲染语义）。`.ax` 用显式对象而不是 CSS 串：颜色必须是 token 引用
 * 或字面色，位置是 0–1 的比例，不把 CSS 语法写进设计稿。
 */
export interface AxGradientStop {
  color: string
  position: number
}

/** 图片填充（容器背景图）：只接受 `.ax` 同目录相对路径，与 `image` 节点同规则。 */
export interface AxImageFill {
  asset: string
  mode?: string
}

export interface AxGradient {
  kind: 'linear' | 'radial' | 'angular'
  rotation: number
  stops: AxGradientStop[]
}

/** 描边宽度：四边同宽，或逐边（分隔线用；与 .pen 的逐边形态同构）。 */
export interface AxPerSideStrokeWidth {
  top?: number | string
  right?: number | string
  bottom?: number | string
  left?: number | string
}

/** 行高**必须**显式声明单位语义（规则 5；.pen 里它是隐式倍数，是第八轮多处缺陷的根因）。 */
export interface AxLineHeight {
  unit: 'multiplier' | 'px'
  value: number
}

export interface AxNode {
  id: string
  kind: AxNodeKind
  /**
   * component：组件 / symbol 名（解析期必须收到字符串）。
   * icon（1.6）：图标名，或枚举位 `{$param}` 引用——仅 `symbols.<名>.body` 内的 icon
   * 允许后者；页树与其它节点仍是字符串（校验器 fail-closed）。
   */
  name?: string | AxSymbolParamRef
  variant?: string
  props?: Record<string, AxPropValue>
  /** 数据档案名（注册表 fixtures 键）：预览态用哪份数据。 */
  fixture?: string
  slot?: AxNode[]
  /** part（只写语义；度量由实现侧规范表给，规则 9） */
  part?: string
  label?: AxTextValue
  supporting?: AxTextValue
  icon?: string
  count?: number
  selected?: boolean
  state?: string
  /** 布局（frame/overlay） */
  layout?: 'horizontal' | 'vertical'
  gap?: number | string
  padding?: Array<number | string>
  width?: AxSize
  height?: AxSize
  justifyContent?: string
  alignItems?: string
  clip?: boolean
  theme?: 'light' | 'dark'
  children?: AxNode[]
  /** text */
  text?: AxTextValue
  fontSize?: number | string
  fontWeight?: number | string
  fontFamily?: string
  lineHeight?: AxLineHeight
  letterSpacing?: number | string
  textAlign?: string
  wrap?: AxWrap
  /** 绘制（frame/text/icon/rect/ellipse/path） */
  fill?: string | AxGradient | AxImageFill
  stroke?: string | AxGradient
  strokeWidth?: number | AxPerSideStrokeWidth
  /** 外阴影（1.3）：卡片/弹层的投影，见 AxShadow。 */
  shadow?: AxShadow
  /** 圆角：px 数值、token 引用（`$radius-8`），或四角 `[tl,tr,br,bl]`。 */
  cornerRadius?: number | string | Array<number | string>
  /** ellipse */
  innerRadius?: number
  /** path */
  geometry?: string
  viewBox?: [number, number, number, number]
  /** image */
  asset?: string
  mode?: string
  /** icon：尺寸用数字（与 frame/rect 的 width/height 不同键，无歧义） */
  size?: number
  /** overlay：唯一的定位通道（规则 4 允许绝对定位处） */
  anchor?: AxOverlayAnchor
  offset?: [number, number]
  /** overlay：整页遮罩（弹窗/抽屉背后的变暗层），由实现渲染成 backdrop，不用矩形手搭。 */
  scrim?: AxScrim
}

/**
 * 外阴影（1.3）：对齐 `.pen` 的 effect 子集与画布渲染器既有的 `box-shadow` 通道。
 * `color` 是 token 引用或字面色（渲染经 tokenToCss）；偏移与模糊是 **px 数值**
 * （规则 5 单位显式：数值即 px，token 引用后续按需放开——视图模型 PenShadow
 * 的几何是纯数值，放开 token 会引入投影层解析）。`.pen` 的 `spread` 与内阴影
 * 实测设计稿未用到（docs/ax-format.md 第八轮），不引入。
 */
export interface AxShadow {
  color: string
  offsetX: number
  offsetY: number
  blur: number
}

/**
 * overlay 的遮罩语义（1.2）：`fill` 是遮罩的绘制值（半透明色最常见，也接受
 * 渐变/图片填充——校验与 frame 的 fill 同一口径）。遮罩**铺满父级**（页面级
 * 浮层即整页），内容子节点按 anchor/offset 摆在遮罩之上；同一页可以叠多个
 * 带 scrim 的 overlay（抽屉 + 弹窗并存）。
 */
export interface AxScrim {
  fill: string | AxGradient | AxImageFill
}

export type AxWrap = 'nowrap' | 'width' | 'width-height'

export const AX_OVERLAY_ANCHORS = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const

export type AxOverlayAnchor = (typeof AX_OVERLAY_ANCHORS)[number]

export interface AxPage {
  id: string
  name?: string
  /**
   * 页容器的布局方向（缺省 horizontal，与 .pen 一致）。**必须保留**：`.pen` 的页根
   * 是 frame，主区与侧栏是横向兄弟；丢了这个字段，投影会把它们竖着堆（P0 遗漏项）。
   */
  layout?: 'horizontal' | 'vertical'
  /** 页容器的间距/内边距（与节点同形：px 数值或 token 引用）。`.pen` 的页根是完整
   *  frame，实测状态展示区带 gap/padding——不保留就不是「严格还原」。 */
  gap?: number | string
  padding?: Array<number | string>
  /** 同一 UI 的多状态归组（规则 3）。 */
  group?: string
  state?: Record<string, string>
  width?: number
  height?: number
  background?: string
  tree: AxNode[]
}

/** 本稿用到的组件词汇表声明：校验 `component.name` 与 props 键（规则 1）。 */
export interface AxComponentDecl {
  variant?: string[]
  props?: Record<string, string>
  /**
   * 具名插槽契约（1.5）：插槽名 → 内容注入的组件 prop 名。首版只有 children 形态
   * （内容是 AxNode[]，宿主/codegen 以 ReactNode 直传该 prop），不做作用域插槽；
   * 节点侧 `slot` 数组的内容归属 `default` 插槽（AX_DEFAULT_SLOT_NAME）。
   */
  slots?: Record<string, AxSlotDecl>
}

/** 单个具名插槽的契约（1.5）：`prop` 是组件接收插槽内容的 prop 名（如 `children`）。 */
export interface AxSlotDecl {
  prop: string
}

/**
 * 文档内局部组件（symbol，1.4）：props 契约 + body 原语子树。实例是 `component`
 * 节点（`name` 命中 `symbols` 时走本路径，优先于注册表词汇），props 值在投影与
 * codegen 时替换 body 文案位的 `{$param}` 引用。
 *
 * v1 边界（校验器强制）：参数只落在文案位且契约类型仅 string；body 禁 component
 * （无嵌套 symbol、不含注册表组件）与 overlay；实例无 variant/slot/fixture；
 * 所有声明的 props 在实例上必填（无默认值）。body 属原语侧的具名复用——带度量，
 * 不违反规则 9（其准确边界是「part 不带度量、定位不带坐标、原语带度量」）。
 */
/**
 * 枚举位参数引用（1.6）：只在 `symbols.<名>.body` 的 `AX_PARAM_ENUM_POSITIONS` 位置出现。
 * 实例传字面量，校验器按契约值域 fail-closed；投影期替换为字面量、codegen 发射为
 * 联合字面量属性上的引用。
 */
export interface AxSymbolParamRef {
  $param: string
}

/** 枚举型参数契约（1.6）：闭集值域，实例值必须命中其一。 */
export interface AxSymbolEnumProp {
  enum: readonly string[]
}

/** symbol 参数契约：`'string'`（文案位替换）或枚举型（枚举位替换，1.6）。 */
export type AxSymbolProp = 'string' | AxSymbolEnumProp

/**
 * component / symbol 名（窄化访问，1.6）：枚举位 `{$param}` 只允许出现在 symbol body
 * 的 icon 上，校验器在写入期已拒绝了其它形态——这里拿到引用即非法稿。
 */
export const axNodeNameOf = (node: AxNode): string | undefined =>
  typeof node.name === 'string' ? node.name : undefined

/** 枚举位引用读取（1.6）：非枚举位引用（含字面量字符串）返回 undefined。 */
export const axParamRefOf = (value: unknown): AxSymbolParamRef | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const param = (value as AxSymbolParamRef).$param
  return typeof param === 'string' ? { $param: param } : undefined
}

export interface AxSymbolDef {
  props?: Record<string, AxSymbolProp>
  body: AxNode[]
}

export interface AxToken {
  $type: AxTokenType
  $value: string | { light: string; dark: string }
}

export const AX_TOKEN_TYPES = ['color', 'dimension', 'fontFamily', 'fontWeight', 'number'] as const
export type AxTokenType = (typeof AX_TOKEN_TYPES)[number]

export interface AxDocument {
  ax: string
  name?: string
  tokens: Record<string, AxToken>
  components: Record<string, AxComponentDecl>
  /** 文档内局部组件（1.4 起）。可选：存量稿无此键；序列化时为空则不落键（往返字节稳定）。 */
  symbols?: Record<string, AxSymbolDef>
  pages: AxPage[]
}

/** 诊断与 .pen 同形（含可选 `path`），画布诊断条与工具结果共用一套渲染。 */
export type AxDiagnostic = PenDiagnostic

export interface AxParseResult {
  document: AxDocument | null
  error: string | null
  diagnostics: AxDiagnostic[]
}

/**
 * 每种节点的**允许键集**。严格白名单是规则 4 与规则 9 的强制手段：
 * - 非 overlay 节点没有 `anchor`/`offset`，也没有 `x`/`y`——绝对定位无处可写；
 * - `part` 没有 `width`/`height`/`padding`/`fontSize`/`cornerRadius`——度量不进设计稿。
 * 键集之外的任何键都是错误（不再有「未知字段静默忽略」）。
 */
export const AX_ALLOWED_KEYS: Record<AxNodeKind, readonly string[]> = {
  component: ['id', 'kind', 'name', 'variant', 'props', 'fixture', 'slot'],
  part: ['id', 'kind', 'part', 'variant', 'label', 'supporting', 'icon', 'count', 'selected', 'state'],
  frame: [
    'id', 'kind', 'layout', 'gap', 'padding', 'width', 'height',
    'justifyContent', 'alignItems', 'clip', 'theme', 'children',
    // 容器同样可以带背景/描边/圆角（.pen 实测 frame 大量使用；第八轮已验证渲染语义）。
    'fill', 'stroke', 'strokeWidth', 'cornerRadius',
    // 外阴影（1.3）：与 fill 同一的六个种类。
    'shadow',
  ],
  text: [
    'id', 'kind', 'text', 'fontSize', 'fontWeight', 'fontFamily', 'lineHeight',
    'letterSpacing', 'textAlign', 'wrap', 'fill', 'width', 'height', 'theme', 'shadow',
  ],
  icon: ['id', 'kind', 'name', 'size', 'fill', 'shadow', 'theme'],
  rect: [
    'id', 'kind', 'width', 'height', 'fill', 'stroke', 'strokeWidth',
    'cornerRadius', 'shadow', 'theme',
  ],
  ellipse: [
    'id', 'kind', 'width', 'height', 'fill', 'stroke', 'strokeWidth',
    'cornerRadius', 'shadow', 'innerRadius', 'theme',
  ],
  path: ['id', 'kind', 'geometry', 'viewBox', 'fill', 'stroke', 'shadow', 'width', 'height', 'theme'],
  image: ['id', 'kind', 'asset', 'mode', 'width', 'height', 'cornerRadius', 'theme'],
  overlay: ['id', 'kind', 'anchor', 'offset', 'scrim', 'children'],
}

/**
 * `AxNode` 接口的全部键名。它和 `AX_ALLOWED_KEYS` 是**两份**事实源（接口给类型、白名单给
 * 校验），过去只在 review 里靠肉眼对齐——接口新增字段忘了进白名单，合法字段会被判错；
 * 白名单写了接口没有的键，则类型与校验说的不是一回事。本常量把它们锁在一起：
 * 下面的类型级穷尽断言让「接口加字段但没登记」在 `tsc` 阶段就报错，配套测试再断言
 * 每个 kind 的键集是本常量的子集、且所有 kind 的并集与之相等。
 */
export const AX_NODE_KEY_NAMES = [
  'id', 'kind', 'name', 'variant', 'props', 'fixture', 'slot', 'part', 'label', 'supporting',
  'icon', 'count', 'selected', 'state', 'layout', 'gap', 'padding', 'width', 'height',
  'justifyContent', 'alignItems', 'clip', 'theme', 'children', 'text', 'fontSize', 'fontWeight',
  'fontFamily', 'lineHeight', 'letterSpacing', 'textAlign', 'wrap', 'fill', 'stroke',
  'strokeWidth', 'shadow', 'cornerRadius', 'innerRadius', 'geometry', 'viewBox', 'asset', 'mode',
  'size', 'anchor', 'offset', 'scrim',
] as const satisfies readonly (keyof AxNode)[]

/** 编译期穷尽断言：`AxNode` 新增字段未登记进 `AX_NODE_KEY_NAMES` 即类型错误。 */
type MissingAxNodeKeys = Exclude<keyof AxNode, (typeof AX_NODE_KEY_NAMES)[number]>
const _axNodeKeysExhaustive: MissingAxNodeKeys extends never ? true : never = true
void _axNodeKeysExhaustive

export const AX_DOC_KEYS = ['ax', 'name', 'tokens', 'components', 'symbols', 'pages'] as const
export const AX_PAGE_KEYS = [
  'id', 'name', 'layout', 'gap', 'padding', 'group', 'state',
  'width', 'height', 'background', 'tree',
] as const
export const AX_TOKEN_KEYS = ['$type', '$value'] as const
export const AX_COMPONENT_DECL_KEYS = ['variant', 'props', 'slots'] as const
/** slot 契约对象的允许键（1.5）：内容注入的组件 prop 名。 */
export const AX_SLOT_DECL_KEYS = ['prop'] as const
/**
 * 节点 `slot` 数组的内容归属插槽名（1.5）：首版节点侧只开放 default 具名插槽的
 * children 形态写作；decl.slots 未声明该名时节点带 slot 内容即校验错误（fail-closed）。
 */
export const AX_DEFAULT_SLOT_NAME = 'default'
/** symbol 定义对象的允许键（1.4）：props 契约 + body 子树。 */
export const AX_SYMBOL_DEF_KEYS = ['props', 'body'] as const
/**
 * symbol 实例展开节点的 id 分隔符（投影层派生，authored id 禁用）：投影把实例 body
 * 物化成 `${实例id}~s:${bodyId}`，反查（designSelectionContext）据此前缀取回实例的
 * authored 节点——点选 symbol 内部即选中整个实例。与 `~overlay`/`~scrim` 同属保留
 * 约定：后两者是「后缀剥离」，本分隔符是「前缀注入」。
 */
export const AX_SYMBOL_ID_SEP = '~s:'
/** scrim 对象的允许键：遮罩只有绘制值（半透明色/渐变/图片填充）。 */
export const AX_SCRIM_KEYS = ['fill'] as const

/** shadow 对象的允许键（color 必填 + 三个 px 数值）。 */
export const AX_SHADOW_KEYS = ['color', 'offsetX', 'offsetY', 'blur'] as const

/** 布局方向取值（`layout` 缺省为 horizontal，与 .pen 一致）。 */
export const AX_LAYOUTS = ['horizontal', 'vertical'] as const
export const AX_GRADIENT_KINDS = ['linear', 'radial', 'angular'] as const
export const AX_GRADIENT_KEYS = ['kind', 'rotation', 'stops'] as const
export const AX_JUSTIFY = ['start', 'center', 'end', 'space_between', 'space_around'] as const
export const AX_ALIGN = ['start', 'center', 'end'] as const
export const AX_TEXT_ALIGNS = ['left', 'center', 'right'] as const
export const AX_WRAPS: readonly AxWrap[] = ['nowrap', 'width', 'width-height']
export const AX_IMAGE_MODES = ['fill', 'fit', 'stretch', 'tile'] as const

/** `$name` 引用（与 .pen 的 token 引用同形，渲染期映射为 var(--name)）。 */
export const isAxTokenRef = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('$') && value.length > 1

/** JSON 可表达的值（结构化 mock 与 props 字面量的共用判定）。 */
export const isAxJsonValue = (value: unknown): value is AxJsonValue => {
  if (value === null) return true
  const kind = typeof value
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return true
  if (Array.isArray(value)) return value.every(isAxJsonValue)
  if (kind === 'object') return Object.values(value as Record<string, unknown>).every(isAxJsonValue)
  return false
}

/**
 * 绑定值形态（`{$mock}` / `{$bind}` / `{$param}`，互斥且必须有一个）。
 * `$bind` 只接受字符串（数据源路径），`$mock` 接受任意 JSON 值——组件的 json 型 props
 * 需要结构化 mock（1.1 起）；`$param` 只接受字符串（参数名，1.4，仅 symbol body 内
 * 合法，由校验器按所在位置收紧）；文案节点另由 `checkTextValue` 收紧为字符串 mock。
 */
export const axBindingKind = (value: unknown): 'mock' | 'bind' | 'param' | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 1) return null
  const key = keys[0]
  if (key === '$mock' && isAxJsonValue(record[key])) return 'mock'
  if (key === '$bind' && typeof record[key] === 'string') return 'bind'
  if (key === '$param' && typeof record[key] === 'string') return 'param'
  return null
}

/** 绑定的 mock 取值（非 mock 绑定返回 undefined）。 */
export const axMockValueOf = (value: unknown): AxJsonValue | undefined =>
  axBindingKind(value) === 'mock' ? (value as AxBinding).$mock : undefined

/** 尺寸三态关键字。 */
export const AX_SIZE_KEYWORDS = ['fill_container', 'fit_content'] as const

/**
 * 绝对定位包装层的 id 后缀：浮层在 `.ax` 里是「overlay（携带锚点/残差）包住原节点」，
 * 包装层用 `${源 id}~overlay`，**被包住的节点保留源 id**。
 *
 * 约定要点：后缀必须落在包装层上而不是内层——若内层带后缀，往返（导出 `.pen` 再导入）
 * 会在每轮再加一层后缀（曾实测 id 逐轮变长成 `X~content~content`）。
 */
export const AX_OVERLAY_ID_SUFFIX = '~overlay'

/** 是否为由绝对定位包装产生的 overlay 层（源节点 id + 后缀）。 */
export const isAxOverlayWrapperId = (id: string): boolean => id.endsWith(AX_OVERLAY_ID_SUFFIX)

/** 包装层对应的源节点 id。 */
export const axOverlaySourceId = (id: string): string =>
  isAxOverlayWrapperId(id) ? id.slice(0, -AX_OVERLAY_ID_SUFFIX.length) : id
