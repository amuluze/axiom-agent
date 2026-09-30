/**
 * `.ax` 解析/校验/迁移与画布投影（docs/ax-format.md §3）。
 *
 * 三个出口：
 * 1. `parseAxDocument` —— 严格校验（九条硬规则）→ 归一化的 `AxDocument`，错误带节点路径；
 * 2. `serializeAxDocument` —— 幂等序列化（固定键序 + 2 空格），供 LLM 打补丁与 git diff；
 * 3. `projectAxToPenDocument` —— 投影成画布的视图模型（复用 `PenDocument` 与现有渲染器，
 *    避免为 `.ax` 再造一套渲染语义；P0 只投影 primitive，`component`/`part` 先降级为
 *    带名占位框并在诊断里标明，完整渲染属 P2）。
 */
import {
  AX_ALIGN,
  AX_COMPONENT_DECL_KEYS,
  AX_GRADIENT_KEYS,
  AX_GRADIENT_KINDS,
  AX_DOC_KEYS,
  AX_FORMAT_VERSION,
  AX_ALLOWED_KEYS,
  AX_IMAGE_MODES,
  AX_JUSTIFY,
  AX_LAYOUTS,
  AX_NODE_KINDS,
  AX_OVERLAY_ANCHORS,
  AX_PAGE_KEYS,
  AX_SCRIM_KEYS,
  AX_SHADOW_KEYS,
  AX_SIZE_KEYWORDS,
  AX_SUPPORTED_MAJOR,
  AX_TEXT_ALIGNS,
  AX_TOKEN_KEYS,
  AX_TOKEN_TYPES,
  AX_WRAPS,
  axBindingKind,
  isAxTokenRef,
} from './axSchema'
import type {
  AxBinding,
  AxGradient,
  AxImageFill,
  AxComponentDecl,
  AxDocument,
  AxLineHeight,
  AxNode,
  AxNodeKind,
  AxOverlayAnchor,
  AxPage,
  AxParseResult,
  AxShadow,
  AxToken,
  AxTokenType,
} from './axSchema'
import { axPartKinds, axPartSpecOf } from './axParts'
import { tokenToCss } from './penParser'
import type { DesignComponentSummary } from './componentInventoryHost'
import type { PenDocument, PenNode, PenNodeUnion, PenPaint, PenPaintGradient, PenShadow } from './penParser'

type Lang = 'zh' | 'en'

/** 数值一律是 px（本格式唯一约定）；token 引用必须带单位，否则整条声明会被 CSS 丢弃。 */
const DIMENSION_PATTERN = /^-?\d+(\.\d+)?(px|rem|em|%)$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 校验上下文：诊断收集 + token/组件词表查找 + 可选的组件注册表（写稿当场核对）。 */
interface Context {
  diagnostics: AxParseResult['diagnostics']
  tokens: Record<string, AxToken>
  components: Record<string, AxComponentDecl>
  /**
   * 组件注册表摘要（调用方注入，通常来自宿主接缝）。空表表示「无注册表可查」——
   * 画布路径与测试环境不注入，规则 1 只对本稿 `components` 声明校验；`design_query`
   * 读取路径注入后，本稿声明之外再对注册表核对（组件存在 / props 键 / 必填 / 值型），
   * 让「画布渲染期才会红框」的错误前移到写稿当场。
   */
  registry: Record<string, DesignComponentSummary>
  lang: Lang
}

const isError = (context: Context): boolean =>
  context.diagnostics.some((item) => item.level === 'error')

const fail = (context: Context, path: string, message: string): void => {
  context.diagnostics.push({ level: 'error', message, path })
}

const warn = (context: Context, path: string, message: string): void => {
  context.diagnostics.push({ level: 'warning', message, path })
}

const label = (context: Context, zh: string, en: string): string => (context.lang === 'en' ? en : zh)

/** 版本解析：`1.0` → 1；非数字版本号视为错误（fail-closed）。 */
const majorOf = (version: string): number | null => {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isNaN(major) ? null : major
}

/**
 * 旧版本迁移（单跳：`from` → 下一版）。1.0 → 1.1 是**拓宽**（`$mock` 除字符串外还接受
 * 结构化 JSON 值，供组件的 json 型 props 使用）：1.0 的稿逐字节合法，迁移只改版本号。
 * 1.1 → 1.2 同理：overlay 增加可选 `scrim`（遮罩语义），旧稿不含该键，迁移只改版本号。
 * 1.2 → 1.3 同理：六个原语种类增加可选 `shadow`（外阴影），旧稿不含该键，迁移只改版本号。
 */
export const AX_MIGRATIONS: Record<string, (raw: Record<string, unknown>) => Record<string, unknown>> = {
  '1.0': (raw) => ({ ...raw, ax: '1.1' }),
  '1.1': (raw) => ({ ...raw, ax: '1.2' }),
  '1.2': (raw) => ({ ...raw, ax: '1.3' }),
}

/** 按需迁移到当前版本；返回 null 表示无法迁移（调用方 fail-closed）。 */
const migrate = (raw: Record<string, unknown>): { value: Record<string, unknown>; from?: string } | null => {
  let current = raw
  let guard = 0
  while (typeof current.ax === 'string' && current.ax !== AX_FORMAT_VERSION) {
    if (guard++ > 32) return null
    const step = AX_MIGRATIONS[current.ax]
    if (!step) return null
    current = step(current)
  }
  return { value: current, from: raw.ax as string | undefined }
}

// ---------------------------------------------------------------- 键集校验

const checkKeys = (
  context: Context,
  path: string,
  record: Record<string, unknown>,
  allowed: readonly string[],
): boolean => {
  let ok = true
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue
    ok = false
    fail(context, path, label(
      context,
      `不认识的字段 \`${key}\`（本节点允许：${allowed.join('、')}）`,
      `Unknown field \`${key}\` (allowed: ${allowed.join(', ')})`,
    ))
  }
  return ok
}

// ---------------------------------------------------------------- token 校验

const validateTokens = (context: Context, raw: unknown): Record<string, AxToken> => {
  if (raw === undefined) return {}
  if (!isRecord(raw)) {
    fail(context, 'tokens', label(context, '`tokens` 必须是对象', '`tokens` must be an object'))
    return {}
  }
  const tokens: Record<string, AxToken> = {}
  for (const [name, value] of Object.entries(raw)) {
    const path = `tokens.${name}`
    if (!isRecord(value)) {
      fail(context, path, label(context, 'token 必须是 `{ $type, $value }` 对象', 'A token must be `{ $type, $value }`'))
      continue
    }
    checkKeys(context, path, value, AX_TOKEN_KEYS)
    const type = value.$type
    if (typeof type !== 'string' || !AX_TOKEN_TYPES.includes(type as AxTokenType)) {
      fail(context, path, label(
        context,
        `token 的 \`$type\` 必须是 ${AX_TOKEN_TYPES.join('/')} 之一`,
        `Token \`$type\` must be one of ${AX_TOKEN_TYPES.join('/')}`,
      ))
      continue
    }
    const modeValues = value.$value
    let light: string
    let dark: string
    // 数值形态也接（token 值写成裸数字很常见）：归一为字符串后再判单位，
    // 这样 `"13"` 与 `13` 都得到同一条可执行错误「必须带单位」，而不是
    // 先被形状检查拦成一句模型无法据以自修的话。
    if (typeof modeValues === 'string' || typeof modeValues === 'number') {
      light = String(modeValues)
      dark = light
    } else if (isRecord(modeValues)
      && (typeof modeValues.light === 'string' || typeof modeValues.light === 'number')
      && (typeof modeValues.dark === 'string' || typeof modeValues.dark === 'number')) {
      light = String(modeValues.light)
      dark = String(modeValues.dark)
    } else {
      fail(context, path, label(
        context,
        '`$value` 必须是字符串或 `{ light, dark }` 两档值',
        '`$value` must be a string or `{ light, dark }`',
      ))
      continue
    }
    // 规则 5：dimension token 必须带单位（裸数值会让 `font-size: var(--text-md)` 变无效声明）。
    if (type === 'dimension' && (!DIMENSION_PATTERN.test(light) || !DIMENSION_PATTERN.test(dark))) {
      fail(context, path, label(
        context,
        'dimension token 的值必须带单位（如 `6px`），裸数值在 CSS 里是无效声明',
        'A dimension token value must carry a unit (e.g. `6px`)',
      ))
      continue
    }
    tokens[name] = {
      $type: type as AxTokenType,
      $value: modeValues === light || typeof modeValues === 'number' ? light : { light, dark },
    }
  }
  return tokens
}

/**
 * 外阴影校验（1.3）：键白名单 + color 必填非空（token 或字面色）+ 偏移/模糊
 * 必为有限数值；blur 额外要求 ≥ 0（负模糊在 CSS 里无意义，会被浏览器钳到 0——
 * 与其静默钳制不如写稿当场报错）。种类门禁由各 kind 的允许键集承担（同 fill）。
 */
const checkShadow = (context: Context, path: string, value: unknown): void => {
  if (!isRecord(value)) {
    fail(context, path, label(
      context,
      'shadow 必须是对象（{ color, offsetX, offsetY, blur }）',
      'shadow must be an object ({ color, offsetX, offsetY, blur })',
    ))
    return
  }
  checkKeys(context, path, value, AX_SHADOW_KEYS)
  if (typeof value.color !== 'string' || value.color === '') {
    fail(context, `${path}.color`, label(
      context,
      'shadow 缺少 `color`（token 引用或字面色）',
      'shadow is missing `color` (a token reference or a color literal)',
    ))
  }
  for (const key of ['offsetX', 'offsetY', 'blur'] as const) {
    const offset = value[key]
    if (typeof offset !== 'number' || !Number.isFinite(offset)) {
      fail(context, `${path}.${key}`, label(
        context,
        `shadow.${key} 必须是数值（px）`,
        `shadow.${key} must be a number (px)`,
      ))
    } else if (key === 'blur' && offset < 0) {
      fail(context, `${path}.blur`, label(context, 'shadow.blur 不能为负', 'shadow.blur must not be negative'))
    }
  }
}

/** 渐变对象校验：kind 闭集、rotation 数值、stops 至少两个且颜色/位置合法。 */
const checkGradient = (context: Context, path: string, value: unknown): void => {
  if (typeof value === 'string') {
    checkTokenRef(context, path, value)
    return
  }
  if (!isRecord(value)) {
    fail(context, path, label(context, 'fill 必须是 token 引用、字面色、渐变或图片对象', 'fill must be a token, color, gradient, or image'))
    return
  }
  // 图片填充：与 image 节点同规则（同目录相对路径，远程/绝对拒绝）。
  if (value.asset !== undefined || value.mode !== undefined) {
    checkKeys(context, path, value, ['asset', 'mode'])
    if (typeof value.asset !== 'string' || value.asset === ''
      || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value.asset) || value.asset.startsWith('//') || value.asset.startsWith('/')) {
      fail(context, `${path}.asset`, label(
        context,
        '图片填充只接受 .ax 同目录的相对路径',
        'an image fill must be a relative path next to the .ax file',
      ))
    }
    if (value.mode !== undefined && !AX_IMAGE_MODES.includes(value.mode as never)) {
      fail(context, `${path}.mode`, label(context, `mode 必须是 ${AX_IMAGE_MODES.join('/')}`, `mode must be ${AX_IMAGE_MODES.join('/')}`))
    }
    return
  }
  checkKeys(context, path, value, AX_GRADIENT_KEYS)
  if (!AX_GRADIENT_KINDS.includes(value.kind as never)) {
    fail(context, `${path}.kind`, label(context, '渐变 kind 必须是 linear/radial/angular', 'gradient kind must be linear/radial/angular'))
  }
  if (typeof value.rotation !== 'number' || !Number.isFinite(value.rotation)) {
    fail(context, `${path}.rotation`, label(context, '渐变 rotation 必须是数值（度）', 'gradient rotation must be a number (deg)'))
  }
  if (!Array.isArray(value.stops) || value.stops.length < 2) {
    fail(context, `${path}.stops`, label(context, '渐变至少需要两个色标', 'a gradient needs at least two stops'))
    return
  }
  value.stops.forEach((stop, index) => {
    if (!isRecord(stop) || typeof stop.color !== 'string'
      || typeof stop.position !== 'number' || stop.position < 0 || stop.position > 1) {
      fail(context, `${path}.stops[${index}]`, label(
        context,
        '色标必须是 `{ color, position }`，position 取 0–1',
        'a stop must be `{ color, position }` with position in 0–1',
      ))
      return
    }
    checkTokenRef(context, `${path}.stops[${index}].color`, stop.color)
  })
}

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

/** token 引用必须命中已声明的 token（fail-closed，避免渲染期静默变空值）。 */
const checkTokenRef = (context: Context, path: string, value: unknown): void => {
  if (!isAxTokenRef(value)) return
  const name = value.slice(1)
  if (!Object.hasOwn(context.tokens, name)) {
    fail(context, path, label(
      context,
      `引用了未声明的 token \`${value}\``,
      `Reference to undeclared token \`${value}\``,
    ))
  }
}

/** 尺寸：px 数值、token 引用、或三态关键字（规则 6：不接受带兜底参数的变体写法）。 */
const checkSize = (context: Context, path: string, value: unknown): void => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(context, path, label(context, '尺寸必须是有限数值', 'Size must be finite'))
    return
  }
  if (typeof value === 'string') {
    if ((AX_SIZE_KEYWORDS as readonly string[]).includes(value)) return
    if (isAxTokenRef(value)) {
      checkTokenRef(context, path, value)
      return
    }
    fail(context, path, label(
      context,
      `尺寸只接受 px 数值、token 引用或 ${AX_SIZE_KEYWORDS.join('/')}（收到 \`${value}\`）`,
      `Size accepts a px number, token ref, or ${AX_SIZE_KEYWORDS.join('/')} (got \`${value}\`)`,
    ))
    return
  }
  fail(context, path, label(context, '尺寸必须是数值或字符串', 'Size must be a number or string'))
}

const checkSpacing = (context: Context, path: string, value: unknown): void => {
  if (typeof value === 'number') return
  if (typeof value === 'string') {
    checkTokenRef(context, path, value)
    return
  }
  fail(context, path, label(context, '间距必须是 px 数值或 token 引用', 'Spacing must be a px number or token ref'))
}

/** 文案值：字面量或 `{$mock}`/`{$bind}`（规则 2：数据与 mock 必须显式区分）。 */
const checkTextValue = (context: Context, path: string, value: unknown): void => {
  if (typeof value === 'string') return
  const kind = axBindingKind(value)
  if (kind === 'bind') return
  // 结构化 mock 只属于组件 props（json 型）：文案节点上出现即报错——否则渲染期
  // 只会得到一个空串，静默丢掉整段文案（收紧在这里，而不是渲染器里兜底）。
  if (kind === 'mock' && typeof (value as AxBinding).$mock === 'string') return
  fail(context, path, label(
    context,
    '文案必须是字符串，或 `{ $mock: <字符串> }`（展示文案）/ `{ $bind: … }`（绑数据源）',
    'A text value must be a string, `{ $mock: <string> }`, or `{ $bind: … }`',
  ))
}

/** props 值：字面量（字符串/数值/布尔）或 `{$mock}`/`{$bind}` 绑定。 */
const checkPropValue = (context: Context, path: string, value: unknown): void => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return
  if (axBindingKind(value)) return
  fail(context, path, label(
    context,
    'props 值必须是字符串/数值/布尔，或 `{ $mock: … }`/`{ $bind: … }`',
    'A prop value must be a string/number/boolean or a `{ $mock }`/`{ $bind }` binding',
  ))
}

const checkLineHeight = (context: Context, path: string, value: unknown): void => {
  if (!isRecord(value)) {
    fail(context, path, label(
      context,
      'lineHeight 必须是 `{ unit, value }`（unit 为 multiplier 或 px）',
      'lineHeight must be `{ unit, value }` (unit: multiplier | px)',
    ))
    return
  }
  checkKeys(context, path, value, ['unit', 'value'])
  const { unit, value: number } = value as Partial<AxLineHeight>
  if (unit !== 'multiplier' && unit !== 'px') {
    fail(context, path, label(context, 'lineHeight.unit 必须是 multiplier 或 px', 'lineHeight.unit must be multiplier or px'))
  }
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    fail(context, path, label(context, 'lineHeight.value 必须是数值', 'lineHeight.value must be a number'))
  }
}

// ---------------------------------------------------------------- 注册表核对（可选）

/**
 * 节点选中的 fixture 打底的 props 键：presentational 的合并口径是「fixture 打底 +
 * 节点覆盖」，因此「缺必填 props」的判定必须把 fixture 提供的键算作已满足。
 * fixture 选择与渲染侧 `axFixtureOf` 的回退顺序一致（指定 → default → 首个）。
 */
const registryFixtureKeysOf = (
  entry: DesignComponentSummary,
  fixture: string | undefined,
): string[] => {
  const table = entry.fixtureProps ?? {}
  if (fixture !== undefined && Object.hasOwn(table, fixture)) return table[fixture] ?? []
  const first = Object.keys(table)[0]
  return first !== undefined ? table[first] ?? [] : []
}

/** props 字面量解析：可判型的字面量（含 `$mock` 的值）返回之；`$bind` 返回 undefined。 */
const propLiteralOf = (value: unknown): unknown => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  const kind = axBindingKind(value)
  return kind === 'mock' ? (value as AxBinding).$mock : undefined
}

/** 值型核对：与渲染侧注册表 `matchesType` 同口径（json = 对象/数组，含 null 拒绝）。 */
const literalMatchesPropType = (type: string, literal: unknown): boolean => {
  switch (type) {
    case 'string':
      return typeof literal === 'string'
    case 'number':
      return typeof literal === 'number' && Number.isFinite(literal)
    case 'boolean':
      return typeof literal === 'boolean'
    case 'json':
      return typeof literal === 'object' && literal !== null
    default:
      return false
  }
}

/** 注册表契约里某组件的 props 键清单（错误信息引导自修用）。 */
const registryPropKeysOf = (entry: DesignComponentSummary): string[] =>
  entry.props.map((prop) => prop.name)

/** 注册表是否参与校验：调用方未注入清单（画布/测试路径）时整体跳过，行为与既往一致。 */
const registryActive = (context: Context): boolean => Object.keys(context.registry).length > 0

/**
 * 组件声明块的注册表核对：名字必须命中注册表，decl.props 键必须在注册表契约内。
 * decl.props 是节点 props 的白名单来源，在这里拦住比逐节点报一遍更省诊断。
 */
const checkRegistryComponentDecl = (context: Context, name: string, decl: AxComponentDecl): void => {
  if (!registryActive(context)) return
  const entry = context.registry[name]
  if (!entry) {
    fail(context, `components.${name}`, label(
      context,
      `组件 \`${name}\` 不在组件注册表中（可用：${Object.keys(context.registry).sort().join('、')}）`,
      `Component \`${name}\` is not in the component registry (available: ${Object.keys(context.registry).sort().join(', ')})`,
    ))
    return
  }
  const validKeys = registryPropKeysOf(entry)
  for (const key of Object.keys(decl.props ?? {})) {
    if (!validKeys.includes(key)) {
      fail(context, `components.${name}.props.${key}`, label(
        context,
        `组件 \`${name}\` 的注册表契约没有 props \`${key}\`（可用：${validKeys.join('、') || '（无）'}）`,
        `The registry contract of \`${name}\` has no prop \`${key}\` (available: ${validKeys.join(', ') || 'none'})`,
      ))
    }
  }
}

/**
 * 组件节点的注册表核对（decl 核对之后）：补上 decl.props 缺省时的键核对空档、
 * 必填 props（fixture 打底的键视为已满足）与可解析字面量的值型核对。
 */
const checkRegistryComponentNode = (context: Context, path: string, node: AxNode): void => {
  if (!registryActive(context)) return
  const name = node.name ?? ''
  const entry = context.registry[name]
  if (!entry) return
  const validKeys = registryPropKeysOf(entry)
  const props = node.props ?? {}
  // decl.props 存在时节点键已由「节点 ⊆ decl ⊆ 注册表」两级覆盖；decl 省略 props
  // 映射时节点键没有任何校验覆盖——这里补上。
  const declCoversProps = Object.hasOwn(context.components, name)
    && context.components[name]?.props !== undefined
  if (!declCoversProps) {
    for (const key of Object.keys(props)) {
      if (!validKeys.includes(key)) {
        fail(context, `${path}.props.${key}`, label(
          context,
          `组件 \`${name}\` 的注册表契约没有 props \`${key}\`（可用：${validKeys.join('、') || '（无）'}）`,
          `The registry contract of \`${name}\` has no prop \`${key}\` (available: ${validKeys.join(', ') || 'none'})`,
        ))
      }
    }
  }
  const fixtureKeys = registryFixtureKeysOf(entry, node.fixture)
  for (const prop of entry.props) {
    if (prop.required && !Object.hasOwn(props, prop.name) && !fixtureKeys.includes(prop.name)) {
      fail(context, `${path}.props.${prop.name}`, label(
        context,
        `组件 \`${name}\` 缺少必填 props \`${prop.name}\`（${prop.description}；fixture 打底可满足时无须写出）`,
        `Component \`${name}\` is missing required prop \`${prop.name}\` (${prop.description}; props provided by the fixture need not be authored)`,
      ))
    }
  }
  for (const [key, value] of Object.entries(props)) {
    const spec = entry.props.find((prop) => prop.name === key)
    if (!spec) continue
    const literal = propLiteralOf(value)
    // $bind 是数据源路径，设计期类型未知；不可判型的值交给 checkPropValue 的形状校验。
    if (literal === undefined) continue
    if (!literalMatchesPropType(spec.type, literal)) {
      fail(context, `${path}.props.${key}`, label(
        context,
        `props \`${key}\` 应为 ${spec.type}${spec.type === 'json' ? '（结构化对象，直接写进 $mock，不要包成 JSON 字符串）' : ''}`,
        `Prop \`${key}\` must be ${spec.type}${spec.type === 'json' ? ' (a structured object inside $mock, never a JSON string)' : ''}`,
      ))
    }
  }
}

// ---------------------------------------------------------------- 节点校验

const validateNode = (context: Context, path: string, raw: unknown): AxNode | null => {
  if (!isRecord(raw)) {
    fail(context, path, label(context, '节点必须是对象', 'A node must be an object'))
    return null
  }
  const kind = raw.kind
  if (typeof kind !== 'string' || !AX_NODE_KINDS.includes(kind as AxNodeKind)) {
    fail(context, path, label(
      context,
      `未知节点种类 \`${String(kind)}\`（.ax 只有闭集：${AX_NODE_KINDS.join('、')}）`,
      `Unknown node kind \`${String(kind)}\` (closed set: ${AX_NODE_KINDS.join(', ')})`,
    ))
    return null
  }
  const nodeKind = kind as AxNodeKind
  checkKeys(context, path, raw, AX_ALLOWED_KEYS[nodeKind])
  if (typeof raw.id !== 'string' || raw.id === '') {
    fail(context, path, label(context, '节点缺少 `id`', 'Node is missing `id`'))
    return null
  }
  const node = { ...raw, kind: nodeKind } as AxNode

  if (nodeKind === 'component') {
    // 规则 1：组件必须来自词汇表（本稿 `components` 声明；注入注册表时再对注册表
    // 核对——「画布渲染期才红框」的错误在写稿当场暴露）。
    if (typeof node.name !== 'string' || node.name === '') {
      fail(context, path, label(context, 'component 缺少 `name`', 'component is missing `name`'))
    } else if (!Object.hasOwn(context.components, node.name)) {
      fail(context, path, label(
        context,
        `组件 \`${node.name}\` 未在本稿 \`components\` 词汇表声明`,
        `Component \`${node.name}\` is not declared in this file's \`components\` vocabulary`,
      ))
    } else {
      const decl = context.components[node.name]
      if (decl && node.variant !== undefined && decl.variant && !decl.variant.includes(node.variant)) {
        fail(context, path, label(
          context,
          `组件 \`${node.name}\` 没有变体 \`${node.variant}\`（可用：${decl.variant.join('、')}）`,
          `Component \`${node.name}\` has no variant \`${node.variant}\``,
        ))
      }
      for (const [key, value] of Object.entries(node.props ?? {})) {
        if (!decl) break
        if (decl.props && !Object.hasOwn(decl.props, key)) {
          fail(context, `${path}.props.${key}`, label(
            context,
            `组件 \`${node.name}\` 没有 props \`${key}\``,
            `Component \`${node.name}\` has no prop \`${key}\``,
          ))
          continue
        }
        checkPropValue(context, `${path}.props.${key}`, value)
      }
      // 注册表核对在本稿词汇表校验之后：本稿名都命中时才查注册表，避免同一处
      // 错误被两级校验各报一遍。
      if (Object.hasOwn(context.registry, node.name)) {
        checkRegistryComponentNode(context, path, node)
      }
    }
    // `slot` 只在稿里显式写了才落进节点：无条件补 `slot: []` 会让「序列化 → 解析 →
    // 序列化」多出一个键（幂等被打破），也会让同一份稿读两次得到不同的对象形状。
    if (raw.slot !== undefined) node.slot = validateNodes(context, `${path}.slot`, raw.slot)
    return node
  }

  if (nodeKind === 'part') {
    // 规则 9 + 部件词表闭集：part 只写语义（度量键不在允许键集里），且 kind/variant/
    // 字段都必须命中词表——与组件词表同口径，杜绝「画得出来但实现里没有」的部件。
    const spec = axPartSpecOf(typeof node.part === 'string' ? node.part : undefined)
    if (typeof node.part !== 'string' || node.part === '') {
      fail(context, path, label(context, 'part 缺少 `part`（部件词表键）', 'part is missing `part`'))
    } else if (!spec) {
      fail(context, `${path}.part`, label(
        context,
        `未知部件 \`${node.part}\`（词表：${axPartKinds().join('、')}）`,
        `Unknown part \`${node.part}\` (vocabulary: ${axPartKinds().join(', ')})`,
      ))
    } else {
      if (node.variant !== undefined && !spec.variants.includes(node.variant)) {
        fail(context, `${path}.variant`, label(
          context,
          `部件 \`${node.part}\` 没有变体 \`${node.variant}\`（可用：${spec.variants.join('、') || '（无）'}）`,
          `Part \`${node.part}\` has no variant \`${node.variant}\``,
        ))
      }
      for (const field of ['label', 'supporting', 'icon', 'count', 'selected', 'state'] as const) {
        if (node[field] !== undefined && !spec.fields.includes(field)) {
          fail(context, `${path}.${field}`, label(
            context,
            `部件 \`${node.part}\` 不接受字段 \`${field}\`（可用：${spec.fields.join('、') || '（无）'}）`,
            `Part \`${node.part}\` does not accept \`${field}\``,
          ))
        }
      }
    }
    if (node.label !== undefined) checkTextValue(context, `${path}.label`, node.label)
    if (node.supporting !== undefined) checkTextValue(context, `${path}.supporting`, node.supporting)
    if (node.count !== undefined && typeof node.count !== 'number') {
      fail(context, `${path}.count`, label(context, 'count 必须是数值', 'count must be a number'))
    }
    if (node.selected !== undefined && typeof node.selected !== 'boolean') {
      fail(context, `${path}.selected`, label(context, 'selected 必须是布尔值', 'selected must be a boolean'))
    }
    return node
  }

  if (nodeKind === 'overlay') {
    if (node.anchor !== undefined && !AX_OVERLAY_ANCHORS.includes(node.anchor)) {
      fail(context, `${path}.anchor`, label(
        context,
        `anchor 必须是 ${AX_OVERLAY_ANCHORS.join('/')} 之一`,
        `anchor must be one of ${AX_OVERLAY_ANCHORS.join('/')}`,
      ))
    }
    if (node.offset !== undefined
      && (!Array.isArray(node.offset) || node.offset.length !== 2
        || node.offset.some((item) => typeof item !== 'number'))) {
      fail(context, `${path}.offset`, label(context, 'offset 必须是 [x, y] 数值对', 'offset must be [x, y]'))
    }
    if (node.scrim !== undefined) {
      // 遮罩语义（1.2）：形状与 fill 校验同 frame 的 fill 口径（半透明色最常见）。
      // fill 缺失显式报错——没有绘制值的遮罩只会渲染成不可见的空层。
      const scrim = node.scrim as unknown
      if (!isRecord(scrim)) {
        fail(context, `${path}.scrim`, label(
          context,
          'scrim 必须是对象（{ fill }）',
          'scrim must be an object ({ fill })',
        ))
      } else {
        checkKeys(context, `${path}.scrim`, scrim, AX_SCRIM_KEYS)
        if (scrim.fill === undefined) {
          fail(context, `${path}.scrim.fill`, label(
            context,
            'scrim 缺少 `fill`（遮罩的绘制值，如半透明色）',
            'scrim is missing `fill` (the scrim paint, e.g. a translucent color)',
          ))
        } else {
          checkGradient(context, `${path}.scrim.fill`, scrim.fill)
        }
      }
    }
    node.children = validateNodes(context, `${path}.children`, raw.children)
    return node
  }

  if (nodeKind === 'frame') {
    if (node.layout !== undefined && !AX_LAYOUTS.includes(node.layout)) {
      fail(context, `${path}.layout`, label(context, `layout 必须是 ${AX_LAYOUTS.join('/')}`, `layout must be ${AX_LAYOUTS.join('/')}`))
    }
    if (node.gap !== undefined) checkSpacing(context, `${path}.gap`, node.gap)
    if (node.padding !== undefined) {
      if (!Array.isArray(node.padding) || node.padding.some((item) => typeof item !== 'number' && typeof item !== 'string')) {
        fail(context, `${path}.padding`, label(context, 'padding 必须是数组（1/2/4 项）', 'padding must be an array (1/2/4 entries)'))
      } else {
        node.padding.forEach((item, index) => {
          checkSpacing(context, `${path}.padding[${index}]`, item)
        })
      }
    }
    if (node.justifyContent !== undefined && !AX_JUSTIFY.includes(node.justifyContent as never)) {
      warn(context, `${path}.justifyContent`, label(
        context,
        `justifyContent \`${node.justifyContent}\` 不在 ${AX_JUSTIFY.join('/')} 内，渲染器可能忽略`,
        `justifyContent \`${node.justifyContent}\` is outside ${AX_JUSTIFY.join('/')}`,
      ))
    }
    if (node.alignItems !== undefined && !AX_ALIGN.includes(node.alignItems as never)) {
      warn(context, `${path}.alignItems`, label(
        context,
        `alignItems \`${node.alignItems}\` 不在 ${AX_ALIGN.join('/')} 内，渲染器可能忽略`,
        `alignItems \`${node.alignItems}\` is outside ${AX_ALIGN.join('/')}`,
      ))
    }
    node.children = validateNodes(context, `${path}.children`, raw.children)
  }

  if (nodeKind === 'text') {
    if (node.text === undefined) {
      fail(context, path, label(context, 'text 节点缺少 `text`', 'text node is missing `text`'))
    } else {
      checkTextValue(context, `${path}.text`, node.text)
    }
    if (node.wrap === undefined) {
      // 规则 6：wrap 三态必须显式（.pen 缺省语义不明是第八轮的坑）。
      fail(context, `${path}.wrap`, label(
        context,
        'wrap 必须显式声明（nowrap/width/width-height）',
        'wrap must be explicit (nowrap/width/width-height)',
      ))
    } else if (!AX_WRAPS.includes(node.wrap)) {
      fail(context, `${path}.wrap`, label(context, `wrap 必须是 ${AX_WRAPS.join('/')}`, `wrap must be ${AX_WRAPS.join('/')}`))
    }
    if (node.textAlign !== undefined && !AX_TEXT_ALIGNS.includes(node.textAlign as never)) {
      fail(context, `${path}.textAlign`, label(context, `textAlign 必须是 ${AX_TEXT_ALIGNS.join('/')}`, `textAlign must be ${AX_TEXT_ALIGNS.join('/')}`))
    }
    if (node.lineHeight !== undefined) checkLineHeight(context, `${path}.lineHeight`, node.lineHeight)
    if (node.fontFamily !== undefined) checkTokenRef(context, `${path}.fontFamily`, node.fontFamily)
    if (node.fontSize !== undefined) checkSize(context, `${path}.fontSize`, node.fontSize)
    if (node.letterSpacing !== undefined) checkSize(context, `${path}.letterSpacing`, node.letterSpacing)
  }

  if (nodeKind === 'icon') {
    if (typeof node.name !== 'string' || node.name === '') {
      fail(context, path, label(context, 'icon 缺少 `name`', 'icon is missing `name`'))
    }
    if (node.size !== undefined && typeof node.size !== 'number') {
      fail(context, `${path}.size`, label(context, 'icon 的 size 必须是数值（px）', 'icon size must be a number (px)'))
    }
  }

  if (nodeKind === 'image') {
    if (typeof node.asset !== 'string' || node.asset === '') {
      fail(context, path, label(context, 'image 缺少 `asset`', 'image is missing `asset`'))
    } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(node.asset) || node.asset.startsWith('//') || node.asset.startsWith('/')) {
      fail(context, `${path}.asset`, label(
        context,
        'asset 只接受 .ax 同目录的相对路径（远程/绝对路径拒绝）',
        'asset must be a relative path next to the .ax file',
      ))
    }
    if (node.mode !== undefined && !AX_IMAGE_MODES.includes(node.mode as never)) {
      fail(context, `${path}.mode`, label(context, `mode 必须是 ${AX_IMAGE_MODES.join('/')}`, `mode must be ${AX_IMAGE_MODES.join('/')}`))
    }
  }

  if (nodeKind === 'path') {
    if (typeof node.geometry !== 'string' || node.geometry.trim() === '') {
      fail(context, path, label(context, 'path 缺少 `geometry`', 'path is missing `geometry`'))
    }
    if (node.viewBox !== undefined
      && (!Array.isArray(node.viewBox) || node.viewBox.length !== 4 || node.viewBox.some((item) => typeof item !== 'number'))) {
      fail(context, `${path}.viewBox`, label(context, 'viewBox 必须是 [x, y, w, h]', 'viewBox must be [x, y, w, h]'))
    }
  }

  if (nodeKind === 'ellipse' && node.innerRadius !== undefined) {
    if (typeof node.innerRadius !== 'number' || node.innerRadius <= 0 || node.innerRadius >= 1) {
      fail(context, `${path}.innerRadius`, label(
        context,
        'innerRadius 必须在 (0, 1) 之间（0.58 表示内圈占 58%）',
        'innerRadius must be within (0, 1)',
      ))
    }
  }

  if (node.strokeWidth !== undefined) {
    const width = node.strokeWidth
    if (typeof width !== 'number') {
      if (!isRecord(width) || Object.entries(width).some(([side, value]) => (
        !['top', 'right', 'bottom', 'left'].includes(side)
        || (typeof value !== 'number' && typeof value !== 'string')
      ))) {
        fail(context, `${path}.strokeWidth`, label(
          context,
          'strokeWidth 必须是数值，或逐边对象 `{ top/right/bottom/left }`',
          'strokeWidth must be a number or a per-side object',
        ))
      }
    }
  }

  if (node.cornerRadius !== undefined) {
    const radius = node.cornerRadius
    if (Array.isArray(radius)) {
      radius.forEach((item, index) => {
        checkSpacing(context, `${path}.cornerRadius[${index}]`, item)
      })
    } else if (typeof radius !== 'number') {
      checkSpacing(context, `${path}.cornerRadius`, radius)
    }
  }

  if (nodeKind === 'rect' || nodeKind === 'ellipse' || nodeKind === 'frame' || nodeKind === 'text' || nodeKind === 'image' || nodeKind === 'path') {
    if (node.width !== undefined) checkSize(context, `${path}.width`, node.width)
    if (node.height !== undefined) checkSize(context, `${path}.height`, node.height)
  }

  for (const key of ['fill', 'stroke'] as const) {
    const value = node[key]
    if (value !== undefined) checkGradient(context, `${path}.${key}`, value)
  }

  if (node.shadow !== undefined) checkShadow(context, `${path}.shadow`, node.shadow)

  return node
}

const validateNodes = (context: Context, path: string, raw: unknown): AxNode[] => {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    fail(context, path, label(context, '`children` 必须是数组', '`children` must be an array'))
    return []
  }
  const nodes: AxNode[] = []
  const seen = new Set<string>()
  raw.forEach((child, index) => {
    const childPath = `${path}[${index}]`
    const node = validateNode(context, childPath, child)
    if (!node) return
    if (seen.has(node.id)) {
      fail(context, childPath, label(context, `节点 id \`${node.id}\` 在本页重复`, `Duplicate node id \`${node.id}\``))
      return
    }
    seen.add(node.id)
    nodes.push(node)
  })
  return nodes
}

const validatePage = (context: Context, path: string, raw: unknown): AxPage | null => {
  if (!isRecord(raw)) {
    fail(context, path, label(context, '页必须是对象', 'A page must be an object'))
    return null
  }
  checkKeys(context, path, raw, AX_PAGE_KEYS)
  if (typeof raw.id !== 'string' || raw.id === '') {
    fail(context, path, label(context, '页缺少 `id`', 'Page is missing `id`'))
    return null
  }
  if (raw.layout !== undefined && !AX_LAYOUTS.includes(raw.layout as never)) {
    fail(context, `${path}.layout`, label(context, `layout 必须是 ${AX_LAYOUTS.join('/')}`, `layout must be ${AX_LAYOUTS.join('/')}`))
  }
  if (raw.state !== undefined) {
    if (!isRecord(raw.state) || Object.values(raw.state).some((value) => typeof value !== 'string')) {
      fail(context, `${path}.state`, label(
        context,
        'state 必须是 `{ 轴: 取值 }` 的字符串映射',
        'state must be a string map `{ axis: value }`',
      ))
    }
  }
  for (const key of ['width', 'height'] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]))) {
      fail(context, `${path}.${key}`, label(context, `${key} 必须是数值（px）`, `${key} must be a number (px)`))
    }
  }
  if (raw.gap !== undefined) checkSpacing(context, `${path}.gap`, raw.gap)
  if (raw.padding !== undefined) {
    if (!Array.isArray(raw.padding)
      || raw.padding.some((item) => typeof item !== 'number' && typeof item !== 'string')) {
      fail(context, `${path}.padding`, label(context, 'padding 必须是数组（1/2/4 项）', 'padding must be an array (1/2/4 entries)'))
    } else {
      raw.padding.forEach((item, index) => {
        checkSpacing(context, `${path}.padding[${index}]`, item)
      })
    }
  }
  if (raw.background !== undefined) checkTokenRef(context, `${path}.background`, raw.background)
  return {
    ...(raw as unknown as AxPage),
    tree: validateNodes(context, `${path}.tree`, raw.tree),
  }
}

// ---------------------------------------------------------------- 出口

/**
 * 解析 `.ax`。与 `.pen` 的关键差别：**任何一条硬规则不通过都不产出文档**——
 * `.pen` 走「能渲染的部分照常渲染 + 诊断」，`.ax` 走 fail-closed（错稿不进画布，
 * 模型按带路径的诊断自修）。
 *
 * `componentInventory` 注入组件注册表摘要（`design_query` 读取路径经宿主接缝取）：
 * 在九条硬规则之外追加注册表核对——组件名不在注册表、decl/节点 props 键不在契约内、
 * 必填缺失、可解析字面量值型不符，都是 error（渲染期红框的同类错误，前移到读取时）。
 * 空表/不传 = 无注册表可查（画布与测试路径），行为与既往逐字节一致。
 */
export const parseAxDocument = (
  source: string,
  options: { lang?: Lang; componentInventory?: readonly DesignComponentSummary[] } = {},
): AxParseResult => {
  const registry: Record<string, DesignComponentSummary> = {}
  for (const entry of options.componentInventory ?? []) registry[entry.name] = entry
  const context: Context = { diagnostics: [], tokens: {}, components: {}, registry, lang: options.lang ?? 'zh' }
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (error) {
    return {
      document: null,
      diagnostics: context.diagnostics,
      error: label(context, 'JSON 解析失败：', 'JSON parse failed: ')
        + (error instanceof Error ? error.message : String(error)),
    }
  }
  if (!isRecord(raw)) {
    return { document: null, diagnostics: context.diagnostics, error: label(context, '不是有效的 .ax 文档（顶层必须是对象）', 'Not a valid .ax document (top level must be an object)') }
  }
  const version = raw.ax
  if (typeof version !== 'string' || version === '') {
    return {
      document: null,
      diagnostics: context.diagnostics,
      error: label(context, '缺少格式版本头 `ax`（例如 "ax": "1.0"）', 'Missing format header `ax` (e.g. "ax": "1.0")'),
    }
  }
  const major = majorOf(version)
  if (major === null) {
    return { document: null, diagnostics: context.diagnostics, error: label(context, `无法解析格式版本 \`${version}\``, `Unparsable format version \`${version}\``) }
  }
  if (major > AX_SUPPORTED_MAJOR) {
    return {
      document: null,
      diagnostics: context.diagnostics,
      error: label(
        context,
        `设计稿格式 v${version} 高于本版本支持的 ${AX_FORMAT_VERSION}，拒绝加载（请升级 Axiom 或改用受支持版本）`,
        `Design format v${version} is newer than the supported ${AX_FORMAT_VERSION}`,
      ),
    }
  }
  let current = raw
  if (version !== AX_FORMAT_VERSION) {
    const migrated = migrate(raw)
    if (!migrated) {
      return {
        document: null,
        diagnostics: context.diagnostics,
        error: label(
          context,
          `格式 v${version} 没有到 v${AX_FORMAT_VERSION} 的迁移路径，拒绝加载`,
          `No migration path from v${version} to v${AX_FORMAT_VERSION}`,
        ),
      }
    }
    current = migrated.value
  }
  checkKeys(context, '(root)', current, AX_DOC_KEYS)
  context.tokens = validateTokens(context, current.tokens)
  context.components = validateComponents(context, current.components)
  const pages: AxPage[] = []
  const pageIds = new Set<string>()
  const rawPages = current.pages
  if (!Array.isArray(rawPages) || rawPages.length === 0) {
    fail(context, 'pages', label(
      context,
      '`pages` 必须是非空数组（空设计稿请至少放一个页 frame，或让设计助手按骨架约定生成）',
      '`pages` must be a non-empty array (add at least one page frame, or ask the design assistant for a skeleton)',
    ))
  } else {
    rawPages.forEach((page, index) => {
      const pagePath = `pages[${index}]`
      const parsed = validatePage(context, pagePath, page)
      if (!parsed) return
      if (pageIds.has(parsed.id)) {
        fail(context, pagePath, label(context, `页 id \`${parsed.id}\` 重复`, `Duplicate page id \`${parsed.id}\``))
        return
      }
      pageIds.add(parsed.id)
      pages.push(parsed)
    })
  }
  if (isError(context)) return { document: null, diagnostics: context.diagnostics, error: null }
  return {
    document: {
      ax: AX_FORMAT_VERSION,
      ...(typeof current.name === 'string' ? { name: current.name } : {}),
      tokens: context.tokens,
      components: context.components,
      pages,
    },
    error: null,
    diagnostics: context.diagnostics,
  }
}

const validateComponents = (context: Context, raw: unknown): Record<string, AxComponentDecl> => {
  if (raw === undefined) return {}
  if (!isRecord(raw)) {
    fail(context, 'components', label(context, '`components` 必须是对象', '`components` must be an object'))
    return {}
  }
  const components: Record<string, AxComponentDecl> = {}
  for (const [name, value] of Object.entries(raw)) {
    const path = `components.${name}`
    if (!isRecord(value)) {
      fail(context, path, label(context, '组件声明必须是对象', 'A component declaration must be an object'))
      continue
    }
    checkKeys(context, path, value, AX_COMPONENT_DECL_KEYS)
    const decl: AxComponentDecl = {}
    if (value.variant !== undefined) {
      if (!Array.isArray(value.variant) || value.variant.some((item) => typeof item !== 'string')) {
        fail(context, `${path}.variant`, label(context, 'variant 必须是字符串数组', 'variant must be a string array'))
      } else {
        decl.variant = value.variant as string[]
      }
    }
    if (value.props !== undefined) {
      if (!isRecord(value.props) || Object.values(value.props).some((item) => typeof item !== 'string')) {
        fail(context, `${path}.props`, label(context, 'props 必须是 `{ 名称: 类型说明 }` 字符串映射', 'props must be a string map'))
      } else {
        decl.props = value.props as Record<string, string>
      }
    }
    components[name] = decl
    // 注册表核对无条件调用：「不在注册表」本身就是它的第一个报错分支。
    checkRegistryComponentDecl(context, name, decl)
  }
  return components
}

// ---------------------------------------------------------------- 序列化

/** 每种节点的键序（幂等序列化 = 稳定 diff = LLM 可精确打补丁）。 */
const KEY_ORDER: readonly string[] = [
  'id', 'kind', 'name', 'part', 'variant', 'props', 'fixture', 'slot', 'label', 'supporting', 'icon', 'size',
  'count', 'selected', 'state', 'text', 'layout', 'gap', 'padding', 'width', 'height',
  'justifyContent', 'alignItems', 'clip', 'theme', 'fontSize', 'fontWeight', 'fontFamily',
  'lineHeight', 'letterSpacing', 'textAlign', 'wrap', 'fill', 'stroke', 'strokeWidth',
  'cornerRadius', 'innerRadius', 'shadow', 'geometry', 'viewBox', 'asset', 'mode', 'anchor', 'offset',
  'scrim', 'children', 'tree',
]

const orderedRecord = (record: Record<string, unknown>): Record<string, unknown> => {
  const ordered: Record<string, unknown> = {}
  for (const key of KEY_ORDER) {
    if (Object.hasOwn(record, key) && record[key] !== undefined) ordered[key] = record[key]
  }
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(ordered, key) && record[key] !== undefined) ordered[key] = record[key]
  }
  return ordered
}

/** 节点键序：`slot`/`children` 递归排序，其余按 KEY_ORDER（幂等序列化的唯一实现）。 */
const orderedNode = (node: AxNode): Record<string, unknown> => {
  const { children, slot, ...rest } = node as AxNode & { children?: AxNode[]; slot?: AxNode[] }
  return orderedRecord({
    ...(rest as Record<string, unknown>),
    ...(slot ? { slot: slot.map(orderedNode) } : {}),
    ...(children ? { children: children.map(orderedNode) } : {}),
  })
}

/** 幂等序列化：同样输入必得同样字节（测试断言 parse→serialize→parse 等值）。 */
export const serializeAxDocument = (document: AxDocument): string => {
  const payload = {
    ax: document.ax,
    ...(document.name !== undefined ? { name: document.name } : {}),
    tokens: Object.fromEntries(
      Object.entries(document.tokens).map(([name, token]) => [name, orderedRecord(token as unknown as Record<string, unknown>)]),
    ),
    components: Object.fromEntries(
      Object.entries(document.components).map(([name, decl]) => [name, orderedRecord(decl as unknown as Record<string, unknown>)]),
    ),
    pages: document.pages.map((page) => ({
      ...orderedRecord({
        id: page.id,
        name: page.name,
        // 页级布局字段与节点同源：漏写会让写盘的 .ax 丢 layout/gap/padding，
        // 读回来变成默认横向布局、渲染塌陷（`design_import` 产物即受此影响）。
        layout: page.layout,
        gap: page.gap,
        padding: page.padding,
        group: page.group,
        state: page.state,
        width: page.width,
        height: page.height,
        background: page.background,
      }),
      tree: page.tree.map(orderedNode),
    })),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

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
          name: node.name ?? '',
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

  const pages: PenNodeUnion[] = document.pages.map((page, index) => {
    const pagePath = `pages[${index}]`
    const pageSize = page.width !== undefined && page.height !== undefined
      ? { width: page.width, height: page.height }
      : undefined
    const tree = (page.tree ?? [])
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
      pages,
      components: {},
      variables: {},
      modeVariables,
      diagnostics: diagnostics.map((item) => ({ level: item.level, message: item.message, path: item.path })),
    },
    diagnostics,
  }
}
