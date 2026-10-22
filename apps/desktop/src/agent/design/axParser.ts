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
  AX_DEFAULT_SLOT_NAME,
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
  AX_SLOT_DECL_KEYS,
  AX_PARAM_ENUM_POSITIONS,
  AX_SYMBOL_DEF_KEYS,
  AX_SYMBOL_ENUM_MAX_VALUES,
  AX_SYMBOL_ID_SEP,
  axParamRefOf,
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
  AxComponentDecl,
  AxLineHeight,
  AxNode,
  AxNodeKind,
  AxPage,
  AxParseResult,
  AxSlotDecl,
  AxSymbolDef,
  AxToken,
  AxTokenType,
} from './axSchema'
import { axPartKinds, axPartSpecOf } from './axParts'
import type { AxAnchorPlacement } from './axAnchors'
import { absoluteOriginOf, anchorPlacementOf } from './axAnchors'
import { serializeAxDocument } from './axSerialize'
// 锚点几何与序列化已拆为独立模块；本文件仍是 `.ax` 格式的公共入口，保持原有导出面。
export { absoluteOriginOf, anchorPlacementOf, serializeAxDocument }
export type { AxAnchorPlacement }
import type { DesignComponentSummary } from './componentInventoryHost'

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
   * 文档内局部组件（1.4）：`component.name` 解析**先于此**（重名即校验错误，无覆盖
   * 语义）。空表 = 存量稿无 `symbols` 键，行为与 1.3 逐字节一致。
   */
  symbols: Record<string, AxSymbolDef>
  /**
   * 组件注册表摘要（调用方注入，通常来自宿主接缝）。空表表示「无注册表可查」——
   * `design_query` 读取路径与画布都注入（画布取项目组件目录，目录不可用时回落内置
   * 摘要），只有测试环境可能不传。注入后本稿声明之外再对注册表核对（组件存在 /
   * props 键 / 必填 / 值型），让「画布渲染期才会红框」的错误前移到写稿当场。
   */
  registry: Record<string, DesignComponentSummary>
  lang: Lang
}

/**
 * 节点校验的作用域：`document` = 页树（`{$param}` 报错）；`symbolBody` = symbol 的
 * body 子树（`{$param}` 合法、component/overlay 报错）。children/slot 递归继承父作用域。
 */
type ValidateScope = 'document' | 'symbolBody'

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
 * 1.3 → 1.4 同理：新增顶层可选 `symbols`（局部组件）与 `{$param}` 绑定，旧稿不含，
 * 迁移只改版本号。
 * 1.4 → 1.5 同理：组件声明增加可选 `slots`（具名插槽契约），旧稿不含，迁移只改版本号。
 */
export const AX_MIGRATIONS: Record<string, (raw: Record<string, unknown>) => Record<string, unknown>> = {
  '1.0': (raw) => ({ ...raw, ax: '1.1' }),
  '1.1': (raw) => ({ ...raw, ax: '1.2' }),
  '1.2': (raw) => ({ ...raw, ax: '1.3' }),
  '1.3': (raw) => ({ ...raw, ax: '1.4' }),
  '1.4': (raw) => ({ ...raw, ax: '1.5' }),
  '1.5': (raw) => ({ ...raw, ax: '1.6' }),
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

/**
 * 文案值：字面量或 `{$mock}`/`{$bind}`（规则 2：数据与 mock 必须显式区分）。
 * `allowParam`（symbol body 文案位）额外接受 `{$param: 名称}`（1.4）。
 */
const checkTextValue = (context: Context, path: string, value: unknown, allowParam = false): void => {
  if (typeof value === 'string') return
  const kind = axBindingKind(value)
  if (kind === 'bind') return
  if (kind === 'param') {
    if (allowParam) return
    fail(context, path, label(
      context,
      '`{$param}` 只能出现在 symbol body 的文案位（页树文案请写字面量或 $mock/$bind）',
      '`{$param}` is only valid in a symbol body text position',
    ))
    return
  }
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
  const kind = axBindingKind(value)
  if (kind === 'param') {
    fail(context, path, label(
      context,
      '`{$param}` 只属于 symbol body 的文案位，不能作为 props 值（实例直接写字面量或 $mock/$bind）',
      '`{$param}` only appears in symbol body text positions, never as a prop value',
    ))
    return
  }
  if (kind) return
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
 * 1.5 起连带核对 decl.slots：插槽名必须在注册表插槽契约内，且注入 prop 不得与
 * 注册表 props 键撞名（撞名 = 同名 prop 两种来源，宿主注入顺序即静默覆盖）。
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
  const registrySlots = entry.slots ?? {}
  for (const [slotName, slot] of Object.entries(decl.slots ?? {})) {
    if (!Object.hasOwn(registrySlots, slotName)) {
      fail(context, `components.${name}.slots.${slotName}`, label(
        context,
        `组件 \`${name}\` 的注册表插槽契约没有插槽 \`${slotName}\`（可用：${Object.keys(registrySlots).join('、') || '（无）'}）`,
        `The registry slot contract of \`${name}\` has no slot \`${slotName}\` (available: ${Object.keys(registrySlots).join(', ') || 'none'})`,
      ))
      continue
    }
    if (validKeys.includes(slot.prop)) {
      fail(context, `components.${name}.slots.${slotName}.prop`, label(
        context,
        `插槽 \`${slotName}\` 的注入 prop \`${slot.prop}\` 与组件 props 契约撞名（同名字段两种来源，注入会被静默覆盖）`,
        `Slot \`${slotName}\` injects prop \`${slot.prop}\`, which collides with the props contract (the injection would be silently overridden)`,
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
  const name = typeof node.name === 'string' ? node.name : ''
  const entry = context.registry[name]
  if (!entry) return
  const validKeys = registryPropKeysOf(entry)
  const props = { ...node.props, ...(node.variant !== undefined ? { variant: node.variant } : {}) }
  // decl.props 存在时节点键已由「节点 ⊆ decl ⊆ 注册表」两级覆盖；decl 省略 props
  // 映射时节点键没有任何校验覆盖——这里补上。
  const declCoversProps = Object.hasOwn(context.components, name)
    && context.components[name]?.props !== undefined
  if (node.variant !== undefined && !validKeys.includes('variant')) {
    fail(context, `${path}.variant`, label(context, `组件 ${name} 没有 variant 属性契约`, `Component ${name} has no variant prop contract`))
  }
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

const validateNode = (context: Context, path: string, raw: unknown, scope: ValidateScope = 'document'): AxNode | null => {
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
    // 核对——「画布渲染期才红框」的错误在写稿当场暴露）。1.4 起 `symbols` 的局部
    // 组件优先解析（与 components/注册表重名在校验期即报错，无覆盖语义）。
    if (scope === 'symbolBody') {
      fail(context, path, label(
        context,
        'symbol body 不允许 component 节点（1.4 首版：无嵌套 symbol、不含注册表组件，body 只写 part/原语）',
        'symbol bodies do not allow component nodes (v1: no nesting, no registry components; author parts/primitives only)',
      ))
      return node
    }
    if (typeof node.name !== 'string' || node.name === '') {
      fail(context, path, label(context, 'component 缺少 `name`', 'component is missing `name`'))
    } else if (Object.hasOwn(context.symbols, node.name)) {
      // symbol 实例：参数全必填（无默认值）、值为 string 文案、禁 variant/fixture/slot
      // （实例不能改变组件形状，要改形状去改 symbol 的 body）。
      const def = context.symbols[node.name]
      const contract = def?.props ?? {}
      if (node.variant !== undefined) {
        fail(context, `${path}.variant`, label(
          context,
          `symbol \`${node.name}\` 实例不支持 variant（1.4 首版；差异请另立 symbol）`,
          `symbol \`${node.name}\` instances do not take variants (v1; author a separate symbol)`,
        ))
      }
      if (node.fixture !== undefined) {
        fail(context, `${path}.fixture`, label(
          context,
          `symbol \`${node.name}\` 实例不支持 fixture（fixture 是注册表组件的预览数据档案）`,
          `symbol \`${node.name}\` instances do not take fixtures`,
        ))
      }
      if (raw.slot !== undefined) {
        fail(context, `${path}.slot`, label(
          context,
          `symbol \`${node.name}\` 实例不支持 slot（实例不能改变组件形状；要改请编辑 symbol body）`,
          `symbol \`${node.name}\` instances do not take slots (edit the symbol body instead)`,
        ))
      }
      for (const [key, value] of Object.entries(node.props ?? {})) {
        if (!Object.hasOwn(contract, key)) {
          fail(context, `${path}.props.${key}`, label(
            context,
            `symbol \`${node.name}\` 没有参数 \`${key}\`（可用：${Object.keys(contract).join('、') || '（无）'}）`,
            `Symbol \`${node.name}\` has no param \`${key}\` (available: ${Object.keys(contract).join(', ') || 'none'})`,
          ))
          continue
        }
        checkPropValue(context, `${path}.props.${key}`, value)
        // 字面量/$mock 必须是字符串（$bind 直通）；枚举型契约再核对值域（1.6）。
        const literal = propLiteralOf(value)
        if (literal !== undefined && typeof literal !== 'string') {
          fail(context, `${path}.props.${key}`, label(
            context,
            `参数 \`${key}\` 是 string 型，值必须是字符串（数值/布尔/对象不接受）`,
            `Param \`${key}\` value must be a string`,
          ))
        }
        const contractType = contract[key]
        if (typeof literal === 'string' && contractType !== undefined && contractType !== 'string') {
          const domain = Array.isArray(contractType.enum) ? contractType.enum : []
          if (!domain.includes(literal)) {
            fail(context, `${path}.props.${key}`, label(
              context,
              `枚举参数 \`${key}\` 的值 \`${literal}\` 不在值域（可用：${domain.join('、')}）`,
              `Enum param \`${key}\` value \`${literal}\` is outside the domain (${domain.join(', ')})`,
            ))
          }
        }
      }
      for (const key of Object.keys(contract)) {
        if (node.props === undefined || !Object.hasOwn(node.props, key)) {
          fail(context, `${path}.props.${key}`, label(
            context,
            `symbol \`${node.name}\` 的参数 \`${key}\` 必填（实例无参数默认值）`,
            `Param \`${key}\` of symbol \`${node.name}\` is required at every instance (no defaults)`,
          ))
        }
      }
      return node
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
      // 1.5：decl 存在时节点 slot 内容必须命中 decl.slots 的 default 具名插槽
      // （fail-closed）。没有契约的插槽内容只会落到宿主的未映射容器或 codegen 的
      // unresolved——与「画布渲染期才红框」的同类错误一样，写稿当场报。
      if (raw.slot !== undefined && (decl?.slots === undefined
        || !Object.hasOwn(decl.slots, AX_DEFAULT_SLOT_NAME))) {
        fail(context, `${path}.slot`, label(
          context,
          `组件 \`${node.name}\` 的插槽契约未声明 \`${AX_DEFAULT_SLOT_NAME}\` 插槽（在 \`components.${node.name}.slots\` 里声明后方可写 slot 内容）`,
          `Component \`${node.name}\` does not declare a \`${AX_DEFAULT_SLOT_NAME}\` slot (declare it under \`components.${node.name}.slots\` before authoring slot content)`,
        ))
      }
      // 注册表核对在本稿词汇表校验之后：本稿名都命中时才查注册表，避免同一处
      // 错误被两级校验各报一遍。
      if (Object.hasOwn(context.registry, node.name)) {
        checkRegistryComponentNode(context, path, node)
      }
    }
    // `slot` 只在稿里显式写了才落进节点：无条件补 `slot: []` 会让「序列化 → 解析 →
    // 序列化」多出一个键（幂等被打破），也会让同一份稿读两次得到不同的对象形状。
    if (raw.slot !== undefined) node.slot = validateNodes(context, `${path}.slot`, raw.slot, scope)
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
    if (node.label !== undefined) checkTextValue(context, `${path}.label`, node.label, scope === 'symbolBody')
    if (node.supporting !== undefined) checkTextValue(context, `${path}.supporting`, node.supporting, scope === 'symbolBody')
    if (node.count !== undefined && typeof node.count !== 'number') {
      fail(context, `${path}.count`, label(context, 'count 必须是数值', 'count must be a number'))
    }
    if (node.selected !== undefined && typeof node.selected !== 'boolean') {
      fail(context, `${path}.selected`, label(context, 'selected 必须是布尔值', 'selected must be a boolean'))
    }
    return node
  }

  if (nodeKind === 'overlay') {
    if (scope === 'symbolBody') {
      fail(context, path, label(
        context,
        'symbol body 不允许 overlay（锚点定位依赖父级尺寸，脱离实例上下文无从计算；1.4 首版明确不做）',
        'symbol bodies do not allow overlay nodes (v1: anchor semantics need the instance parent size)',
      ))
    }
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
    node.children = validateNodes(context, `${path}.children`, raw.children, scope)
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
    node.children = validateNodes(context, `${path}.children`, raw.children, scope)
  }

  if (nodeKind === 'text') {
    if (node.text === undefined) {
      fail(context, path, label(context, 'text 节点缺少 `text`', 'text node is missing `text`'))
    } else {
      checkTextValue(context, `${path}.text`, node.text, scope === 'symbolBody')
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
    const iconRef = axParamRefOf(node.name)
    if (iconRef) {
      if (scope !== 'symbolBody') {
        fail(context, path, label(
          context,
          `枚举位 \`{$param}\` 只能出现在 symbol body 的 ${AX_PARAM_ENUM_POSITIONS.join('、')}`,
          `Enum-position \`{$param}\` is only valid inside a symbol body (${AX_PARAM_ENUM_POSITIONS.join(', ')})`,
        ))
      }
    } else if (typeof node.name !== 'string' || node.name === '') {
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

const validateNodes = (context: Context, path: string, raw: unknown, scope: ValidateScope = 'document'): AxNode[] => {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    fail(context, path, label(context, '`children` 必须是数组', '`children` must be an array'))
    return []
  }
  const nodes: AxNode[] = []
  const seen = new Set<string>()
  raw.forEach((child, index) => {
    const childPath = `${path}[${index}]`
    const node = validateNode(context, childPath, child, scope)
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
  const context: Context = { diagnostics: [], tokens: {}, components: {}, symbols: {}, registry, lang: options.lang ?? 'zh' }
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
  // symbols 在 components 之后、pages 之前校验：实例名字解析依赖 symbols 表，
  // 重名核对又需要已就绪的 components/registry。
  context.symbols = validateSymbols(context, current.symbols)
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
  // body id 的全稿核对放在页树校验之后（需要页树 id 全集）；仅含 symbols 的稿执行。
  checkSymbolBodyIds(context, pages, context.symbols)
  if (isError(context)) return { document: null, diagnostics: context.diagnostics, error: null }
  return {
    document: {
      ax: AX_FORMAT_VERSION,
      ...(typeof current.name === 'string' ? { name: current.name } : {}),
      tokens: context.tokens,
      components: context.components,
      ...(Object.keys(context.symbols).length > 0 ? { symbols: context.symbols } : {}),
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
    if (value.slots !== undefined) {
      // 1.5 具名插槽契约：`{ 插槽名: { prop: 组件 prop 名 } }`。prop 必须是合法
      // 标识符——宿主与 codegen 都要把它发射成 props 字段/JSX 属性名。
      if (!isRecord(value.slots)) {
        fail(context, `${path}.slots`, label(
          context,
          'slots 必须是 `{ 插槽名: { prop: 组件 prop 名 } }` 映射',
          'slots must be a map of `{ slotName: { prop } }`',
        ))
      } else {
        const slots: Record<string, AxSlotDecl> = {}
        for (const [slotName, slot] of Object.entries(value.slots)) {
          const slotPath = `${path}.slots.${slotName}`
          if (!isRecord(slot)) {
            fail(context, slotPath, label(
              context,
              '插槽契约必须是 `{ prop: 组件 prop 名 }` 对象',
              'A slot contract must be a `{ prop }` object',
            ))
            continue
          }
          checkKeys(context, slotPath, slot, AX_SLOT_DECL_KEYS)
          if (typeof slot.prop !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(slot.prop)) {
            fail(context, `${slotPath}.prop`, label(
              context,
              '插槽的 `prop` 必须是组件 prop 名（合法标识符，如 children）',
              'A slot `prop` must be a component prop name (a valid identifier, e.g. children)',
            ))
            continue
          }
          slots[slotName] = { prop: slot.prop }
        }
        if (Object.keys(slots).length > 0) decl.slots = slots
      }
    }
    components[name] = decl
    // 注册表核对无条件调用：「不在注册表」本身就是它的第一个报错分支。
    checkRegistryComponentDecl(context, name, decl)
  }
  return components
}

/** 遍历节点树（children + slot），与 `designSelectionContext.axNodeOf` 的走法同构。 */
const walkAxNodes = (nodes: readonly AxNode[], visit: (node: AxNode) => void): void => {
  for (const node of nodes) {
    visit(node)
    if (node.children) walkAxNodes(node.children, visit)
    if (node.slot) walkAxNodes(node.slot, visit)
  }
}

/** 收集 body 引用的参数名：文案位（text/label/supporting）与枚举位（icon.name，1.6）。 */
const collectParamRefs = (nodes: readonly AxNode[]): { copy: Set<string>; enums: Set<string> } => {
  const copy = new Set<string>()
  const enums = new Set<string>()
  walkAxNodes(nodes, (node) => {
    for (const value of [node.text, node.label, node.supporting]) {
      if (value !== undefined && typeof value !== 'string' && axBindingKind(value) === 'param') {
        copy.add((value as AxBinding).$param ?? '')
      }
    }
    const ref = axParamRefOf(node.name)
    if (ref) enums.add(ref.$param)
  })
  return { copy, enums }
}

/**
 * `symbols`（文档内局部组件，1.4）校验：def 形状 → body 走 `validateNodes`（symbolBody
 * 作用域：component/overlay 报错、文案位接受 `{$param}`）→ 参数与契约双向核对 →
 * 与 components/注册表重名 fail-closed（无覆盖语义，「组件名 → 真实源码路径」的恒等
 * 承诺不容本地遮蔽）。body id 的全稿唯一性核对在页树校验之后做（需要页树 id 全集），
 * 见 `checkSymbolBodyIds`。
 */
const validateSymbols = (context: Context, raw: unknown): Record<string, AxSymbolDef> => {
  if (raw === undefined) return {}
  if (!isRecord(raw)) {
    fail(context, 'symbols', label(context, '`symbols` 必须是对象', '`symbols` must be an object'))
    return {}
  }
  const symbols: Record<string, AxSymbolDef> = {}
  for (const [name, value] of Object.entries(raw)) {
    const path = `symbols.${name}`
    if (!isRecord(value)) {
      fail(context, path, label(context, 'symbol 定义必须是对象（{ props, body }）', 'A symbol definition must be an object ({ props, body })'))
      continue
    }
    checkKeys(context, path, value, AX_SYMBOL_DEF_KEYS)
    const def: AxSymbolDef = { body: [] }
    if (value.props !== undefined) {
      if (!isRecord(value.props)) {
        fail(context, `${path}.props`, label(context, 'props 必须是「名称 → 类型」映射（string 或 { enum: [...] }）', 'props must map names to string or { enum: [...] }'))
      } else {
        for (const [key, type] of Object.entries(value.props as Record<string, unknown>)) {
          if (type === 'string') continue
          if (!isRecord(type) || !Array.isArray(type.enum)) {
            fail(context, `${path}.props.${key}`, label(
              context,
              `参数 \`${key}\` 的类型必须是 'string' 或 { enum: [...] }`,
              `Param \`${key}\` must be typed 'string' or { enum: [...] }`,
            ))
            continue
          }
          const domain = type.enum
          if (domain.length === 0 || domain.length > AX_SYMBOL_ENUM_MAX_VALUES
            || domain.some((item) => typeof item !== 'string' || item === '')
            || new Set(domain).size !== domain.length) {
            fail(context, `${path}.props.${key}`, label(
              context,
              `枚举参数 \`${key}\` 值域须为非空、去重、≤${AX_SYMBOL_ENUM_MAX_VALUES} 项的字符串数组`,
              `Enum param \`${key}\` needs a non-empty, duplicate-free string array (max ${AX_SYMBOL_ENUM_MAX_VALUES})`,
            ))
          }
        }
        def.props = value.props as AxSymbolDef['props']
      }
    }
    if (!Array.isArray(value.body) || value.body.length === 0) {
      fail(context, `${path}.body`, label(
        context,
        'body 必须是非空节点数组（symbol 至少画一个节点）',
        'body must be a non-empty node array',
      ))
    } else {
      def.body = validateNodes(context, `${path}.body`, value.body, 'symbolBody')
    }
    symbols[name] = def
    // 重名核对：与 components 声明/注册表（注入时）冲突即报错——实例名字解析虽以
    // symbols 优先，但「同名字两个来源」本身就是把歧义写进稿里，fail-closed。
    if (Object.hasOwn(context.components, name)) {
      fail(context, path, label(
        context,
        `symbol \`${name}\` 与本稿 \`components\` 词汇表重名（组件名只能有一个来源，请改名）`,
        `symbol \`${name}\` collides with the \`components\` vocabulary (rename one of them)`,
      ))
    }
    if (Object.hasOwn(context.registry, name)) {
      fail(context, path, label(
        context,
        `symbol \`${name}\` 与组件注册表重名（注册表组件名保留，本地 symbol 请改名）`,
        `symbol \`${name}\` collides with a registry component (rename the symbol)`,
      ))
    }
    // 参数 ↔ 契约双向核对：引用未声明 = 实例永远填不上；声明未引用 = 实例传了也
    // 不生效（静默无效 prop 正是本格式要消灭的失败模式）。
    const declared = new Set(Object.keys(def.props ?? {}))
    const { copy, enums } = collectParamRefs(def.body)
    for (const used of new Set([...copy, ...enums])) {
      if (!declared.has(used)) {
        fail(context, `${path}.body`, label(
          context,
          `参数 \`${used}\` 未在契约声明（可用：${[...declared].join('、') || '（无）'}）`,
          `Param \`${used}\` is used but not declared (available: ${[...declared].join(', ') || 'none'})`,
        ))
      }
    }
    for (const key of declared) {
      if (enums.has(key) && def.props?.[key] === 'string') {
        fail(context, `${path}.props.${key}`, label(
          context,
          `参数 \`${key}\` 用在枚举位（${AX_PARAM_ENUM_POSITIONS.join('、')}），契约须写 { enum: [...] }`,
          `Param \`${key}\` is used in an enum position; declare { enum: [...] }`,
        ))
      }
      if (copy.has(key) && def.props?.[key] !== 'string') {
        fail(context, `${path}.props.${key}`, label(
          context,
          `参数 \`${key}\` 用在文案位，契约须写 'string'`,
          `Param \`${key}\` is used in a text position; declare 'string'`,
        ))
      }
      if (!copy.has(key) && !enums.has(key)) {
        fail(context, `${path}.props.${key}`, label(
          context,
          `参数 \`${key}\` 已声明但 body 未引用（实例传入不会生效；引用它或删除声明）`,
          `Param \`${key}\` is declared but never referenced in the body`,
        ))
      }
    }
  }
  return symbols
}

/**
 * body id 的全稿核对（仅含 symbols 的稿执行，存量稿不受影响）：body id 用于投影期派生
 * （`${实例id}~s:${bodyId}`）与 `design_query` 的 nodeId 寻址——必须在该 symbol 内唯一、
 * 不含保留分隔符、且不与页树/其它 symbol 的节点 id 重复，否则派生 id 冲突或寻址歧义。
 */
const checkSymbolBodyIds = (
  context: Context,
  pages: readonly AxPage[],
  symbols: Record<string, AxSymbolDef>,
): void => {
  if (Object.keys(symbols).length === 0) return
  const pageNodeIds = new Set<string>()
  for (const page of pages) walkAxNodes(page.tree, (node) => pageNodeIds.add(node.id))
  const bodyIdOwners = new Map<string, string>()
  for (const [name, def] of Object.entries(symbols)) {
    const seen = new Set<string>()
    walkAxNodes(def.body, (node) => {
      const path = `symbols.${name}.body`
      if (node.id.includes(AX_SYMBOL_ID_SEP)) {
        fail(context, path, label(
          context,
          `节点 id \`${node.id}\` 含保留分隔符 \`${AX_SYMBOL_ID_SEP}\`（投影期用于派生实例展开 id）`,
          `Node id \`${node.id}\` contains the reserved separator \`${AX_SYMBOL_ID_SEP}\``,
        ))
      }
      if (seen.has(node.id)) {
        fail(context, path, label(
          context,
          `节点 id \`${node.id}\` 在 symbol \`${name}\` 的 body 内重复`,
          `Node id \`${node.id}\` is duplicated inside symbol \`${name}\`'s body`,
        ))
      }
      seen.add(node.id)
      const owner = bodyIdOwners.get(node.id)
      if (owner !== undefined && owner !== name) {
        fail(context, path, label(
          context,
          `节点 id \`${node.id}\` 与 symbol \`${owner}\` 的 body id 重复（body id 需全稿唯一，保证 nodeId 寻址无歧义）`,
          `Node id \`${node.id}\` collides with symbol \`${owner}\`'s body id`,
        ))
      } else {
        bodyIdOwners.set(node.id, name)
      }
      if (pageNodeIds.has(node.id)) {
        fail(context, path, label(
          context,
          `节点 id \`${node.id}\` 与页树节点 id 重复（body id 需全稿唯一，保证 nodeId 寻址无歧义）`,
          `Node id \`${node.id}\` collides with a page-tree node id`,
        ))
      }
    })
  }
}

// ---------------------------------------------------------------- 画布投影

// 投影实现已拆到 `axProjection.ts`；本文件仍是 `.ax` 格式的公共入口，保持原有导出面。
export {
  axSymbolParamValueOf,
  axTextOf,
  expandSymbolInstances,
  projectAxToPenDocument,
} from './axProjection'
