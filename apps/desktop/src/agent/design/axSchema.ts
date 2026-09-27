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
 */
export const AX_FORMAT_VERSION = '1.2'

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

/** 文案/标签值：字面量，或显式声明其为 mock 展示文案 / 绑真实数据源（规则 2）。 */
export interface AxBinding {
  /** mock 字面量：文案用字符串，组件 props 可以是结构化值（对象/数组）。 */
  $mock?: AxJsonValue
  $bind?: string
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
  /** component */
  name?: string
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
  ],
  text: [
    'id', 'kind', 'text', 'fontSize', 'fontWeight', 'fontFamily', 'lineHeight',
    'letterSpacing', 'textAlign', 'wrap', 'fill', 'width', 'height', 'theme',
  ],
  icon: ['id', 'kind', 'name', 'size', 'fill', 'theme'],
  rect: [
    'id', 'kind', 'width', 'height', 'fill', 'stroke', 'strokeWidth',
    'cornerRadius', 'theme',
  ],
  ellipse: [
    'id', 'kind', 'width', 'height', 'fill', 'stroke', 'strokeWidth',
    'cornerRadius', 'innerRadius', 'theme',
  ],
  path: ['id', 'kind', 'geometry', 'viewBox', 'fill', 'stroke', 'width', 'height', 'theme'],
  image: ['id', 'kind', 'asset', 'mode', 'width', 'height', 'cornerRadius', 'theme'],
  overlay: ['id', 'kind', 'anchor', 'offset', 'scrim', 'children'],
}

export const AX_DOC_KEYS = ['ax', 'name', 'tokens', 'components', 'pages'] as const
export const AX_PAGE_KEYS = [
  'id', 'name', 'layout', 'gap', 'padding', 'group', 'state',
  'width', 'height', 'background', 'tree',
] as const
export const AX_TOKEN_KEYS = ['$type', '$value'] as const
export const AX_COMPONENT_DECL_KEYS = ['variant', 'props'] as const
/** scrim 对象的允许键：遮罩只有绘制值（半透明色/渐变/图片填充）。 */
export const AX_SCRIM_KEYS = ['fill'] as const

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
 * 绑定值形态（`{$mock}` / `{$bind}`，二者互斥且必须有一个）。
 * `$bind` 只接受字符串（数据源路径），`$mock` 接受任意 JSON 值——组件的 json 型 props
 * 需要结构化 mock（1.1 起）；文案节点另由 `checkTextValue` 收紧为字符串 mock。
 */
export const axBindingKind = (value: unknown): 'mock' | 'bind' | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 1) return null
  const key = keys[0]
  if (key === '$mock' && isAxJsonValue(record[key])) return 'mock'
  if (key === '$bind' && typeof record[key] === 'string') return 'bind'
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
