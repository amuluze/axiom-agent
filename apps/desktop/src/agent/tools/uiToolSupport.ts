import type { JsonValue } from '@/agent/core/types'
import type {
  AgentEnvironment,
  BrowserCommandResponse,
  BrowserTabInfo,
  LocatorResolution,
  UiLocatorSpec,
} from '@/agent/environment/AgentEnvironment'
import { hasOnlyKeys, isJsonObject, sha256Text } from './workspaceToolUtils'

/**
 * 五个只读 UI 探索工具（`ui_snapshot` / `ui_find` / `ui_wait` / `ui_assert` /
 * `ui_screenshot`）的公共契约。工具只经 `AgentEnvironment.browser.command` 取宿主
 * `browser_command` 的只读动作（tabs / snapshot / find / wait / resolveLocator /
 * screenshot），不新增 Rust 能力，也不做页面写动作。
 */

/** 快照文本默认/最大内联字节预算：AX 全树可达 200 KiB，直接回灌会挤爆上下文。 */
export const DEFAULT_UI_SNAPSHOT_BYTES = 8 * 1024
export const MAX_UI_SNAPSHOT_BYTES = 64 * 1024

/** 与 Rust `browser_session.rs` 的 DEFAULT_FIND_LIMIT / MAX_FIND_LIMIT 一致。 */
export const DEFAULT_UI_FIND_LIMIT = 20
export const MAX_UI_FIND_LIMIT = 50

/** 与 Rust MAX_WAIT_DURATION_MS 一致：更长的等待应由模型拆步。 */
export const MAX_UI_WAIT_MS = 15_000

/** 单个定位字段/检索词/断言期望文本的长度上限，防止超长参数顶穿工具参数预算。 */
export const MAX_UI_TEXT_CHARS = 500

// ---------------------------------------------------------------------------
// UI 写探索（G1-3）共用契约
// ---------------------------------------------------------------------------

/**
 * 与 Rust `MAX_URL_CHARS` 一致：更长的 URL 由宿主权威拒绝，这里只是调用前快速失败，
 * 避免把注定失败的参数送进审批流程。
 */
export const MAX_UI_URL_CHARS = 2048

/** 与 Rust `MAX_TEXT_INPUT_CHARS` 一致（fill / selectOption / typeText 的文本上限）。 */
export const MAX_UI_INPUT_CHARS = 20_000

/**
 * `ref` 的最小值：`0` 在宿主侧表示「无 ref」，写动作必须显式指向一个已解析的节点。
 * ref 由宿主定位解析签发，**只在当前步骤内有效**——任何写动作完成后立即作废。
 */
export const MIN_UI_REF = 1

export const REF_INPUT_SCHEMA: JsonValue = {
  type: 'integer',
  minimum: MIN_UI_REF,
  description:
    'Element ref (backend node id) from a locator resolution in the current step. Refs expire '
    + 'immediately after any write action: re-snapshot / re-resolve before the next step.',
}

export const UI_KEY_INPUT_SCHEMA: JsonValue = {
  type: 'string',
  minLength: 1,
  description:
    'Key to press: Enter/Tab/Escape/Backspace/Delete/ArrowUp/ArrowDown/ArrowLeft/ArrowRight/'
    + 'Home/End/PageUp/PageDown/Space (case-insensitive) or a single character.',
}

/** Rust `key_definition` 支持的具名按键（小写比较），与 `browser_session.rs` 同集。 */
const NAMED_UI_KEYS: Record<string, true> = {
  enter: true, return: true, tab: true, escape: true, esc: true, backspace: true,
  delete: true, arrowup: true, arrowdown: true, arrowleft: true, arrowright: true,
  home: true, end: true, pageup: true, pagedown: true, space: true,
}

/** 宿主按键白名单的快速失败镜像（权威判定仍在 Rust `key_definition`）。 */
export const validateUiKey = (value: JsonValue | undefined): string | null => {
  if (typeof value !== 'string' || !value) {
    return 'key must be a non-empty string.'
  }
  if (NAMED_UI_KEYS[value.toLowerCase()]) return null
  if ([...value].length === 1) return null
  return 'key must be one of Enter/Tab/Escape/Backspace/Delete/ArrowUp/ArrowDown/ArrowLeft/'
    + 'ArrowRight/Home/End/PageUp/PageDown/Space (case-insensitive) or a single character.'
}

/** 写动作目标元素的 ref 校验：整数 ≥1（省略即缺参，由各工具自行要求）。 */
export const validateUiRef = (value: JsonValue | undefined): string | null => {
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_UI_REF) {
    return `ref must be an integer >= ${MIN_UI_REF}.`
  }
  return null
}

/**
 * 写动作目标的二选一校验：必须**恰好**提供 `ref`（瞬态整数）或 `locator`（结构化
 * 定位器）之一。两者都给无法判定意图，两者都缺则没有目标；合法分支的取值校验分别
 * 复用 {@link validateUiRef} / {@link validateUiLocator}。
 */
export const validateUiTargetSelection = (
  ref: JsonValue | undefined,
  locator: JsonValue | undefined,
): string | null => {
  if (ref !== undefined && locator !== undefined) {
    return 'Provide exactly one of ref or locator, not both.'
  }
  if (ref === undefined && locator === undefined) {
    return 'Provide exactly one of ref or locator: ref is an ephemeral node id, locator is re-resolved in this step.'
  }
  return ref !== undefined ? validateUiRef(ref) : validateUiLocator(locator)
}

/**
 * 导航 URL 的快速失败镜像：绝对 http/https、无 userinfo、长度上限。权威校验仍在
 * Rust `validate_navigation_url`（它还会做 reqwest 解析与重定向策略）。
 */
export const validateUiUrl = (value: JsonValue | undefined): string | null => {
  if (typeof value !== 'string' || !value.trim()) {
    return 'url must be a non-empty string.'
  }
  if (value.length > MAX_UI_URL_CHARS) {
    return `url must be at most ${MAX_UI_URL_CHARS} chars.`
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return 'url must be an absolute URL (e.g. https://shop.test/cart).'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `url must use the http or https scheme (got ${parsed.protocol.replace(':', '')}).`
  }
  if (parsed.username || parsed.password) {
    return 'url must not carry userinfo credentials.'
  }
  return null
}

export const TAB_ID_INPUT: JsonValue = {
  type: 'string',
  description: 'Browser tab id. Omit to use the active tab of the Browser Rail.',
}

export const UI_LOCATOR_SCHEMA: JsonValue = {
  type: 'object',
  description:
    'Structured locator, resolved by the host in priority order testId → role+name → label → '
    + 'stable text → explicit CSS. At least one field is required; the host refuses blank fields '
    + 'and never picks the first candidate when several match.',
  properties: {
    testId: { type: 'string', description: 'data-testid match (DOM domain, highest priority).' },
    role: { type: 'string', description: 'Accessibility role (AX domain), e.g. button, textbox.' },
    name: { type: 'string', description: 'Accessible name (AX domain), usually combined with role.' },
    label: { type: 'string', description: 'Form label text (AX domain).' },
    text: { type: 'string', description: 'Stable visible text (AX domain).' },
    css: { type: 'string', description: 'Explicit CSS selector (DOM domain, advanced escape hatch).' },
    exact: { type: 'boolean', description: 'Require exact name/text equality instead of substring matching.' },
  },
  additionalProperties: false,
}

const UI_LOCATOR_KEYS = ['testId', 'role', 'name', 'label', 'text', 'css', 'exact']
const UI_LOCATOR_TEXT_FIELDS = ['testId', 'role', 'name', 'label', 'text', 'css'] as const

/** `validate()` 的定位器形状校验：键集、类型、非空白、长度上限。 */
export const validateUiLocator = (value: JsonValue | undefined): string | null => {
  if (value === undefined) return 'locator must be an object.'
  if (!isJsonObject(value) || !hasOnlyKeys(value, UI_LOCATOR_KEYS)) {
    return 'locator must be an object with only testId, role, name, label, text, css, and exact.'
  }
  let criterionCount = 0
  for (const field of UI_LOCATOR_TEXT_FIELDS) {
    const raw = value[field]
    if (raw === undefined) continue
    if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_UI_TEXT_CHARS) {
      return `locator.${field} must be a non-empty string of at most ${MAX_UI_TEXT_CHARS} chars.`
    }
    criterionCount += 1
  }
  if (value.exact !== undefined && typeof value.exact !== 'boolean') {
    return 'locator.exact must be a boolean.'
  }
  if (criterionCount === 0) {
    return 'locator needs at least one of testId, role, name, label, text, or css.'
  }
  return null
}

export const toUiLocator = (value: JsonValue): UiLocatorSpec => {
  if (!isJsonObject(value)) return {}
  const locator: UiLocatorSpec = {}
  for (const field of UI_LOCATOR_TEXT_FIELDS) {
    const raw = value[field]
    if (typeof raw === 'string' && raw.trim()) locator[field] = raw.trim()
  }
  if (typeof value.exact === 'boolean') locator.exact = value.exact
  return locator
}

/**
 * 定位器的 JSON 投影：`UiLocatorSpec` 的可选字段（`string | undefined`）不满足
 * `JsonValue` 的索引签名，而工具 `details` 必须落在 `JsonValue` 内，故显式复制已定义字段。
 */
export const uiLocatorJson = (locator: UiLocatorSpec): JsonValue => {
  const json: { [key: string]: JsonValue } = {}
  for (const field of UI_LOCATOR_TEXT_FIELDS) {
    const raw = locator[field]
    if (typeof raw === 'string') json[field] = raw
  }
  if (locator.exact !== undefined) json.exact = locator.exact
  return json
}

/** 供结果文案表述定位器（不回显页面内容）。 */
export const describeUiLocator = (locator: UiLocatorSpec): string => {
  const parts: string[] = []
  if (locator.testId) parts.push(`testId=${locator.testId}`)
  if (locator.role) parts.push(`role=${locator.role}`)
  if (locator.name) parts.push(`name=「${locator.name}」`)
  if (locator.label) parts.push(`label=「${locator.label}」`)
  if (locator.text) parts.push(`text=「${locator.text}」`)
  if (locator.css) parts.push(`css=${locator.css}`)
  return parts.length > 0 ? parts.join(' ') : '(空定位器)'
}

/** 定位结果的可读摘要（只给数量与候选角色，不把整页内容塞进结果）。 */
export const describeResolution = (resolution: LocatorResolution): string => {
  if (resolution.status === 'notFound') return '零匹配'
  if (resolution.status === 'unique') {
    const candidate = resolution.candidate
    return `唯一命中（role=${candidate.role}${candidate.name ? ` name=「${candidate.name}」` : ''}）`
  }
  return `歧义：${resolution.total} 个候选（${resolution.candidates.map((candidate) => candidate.role).join(', ')}）`
}

/**
 * 写动作的 locator 预处理：经只读通道 `resolveLocator` 解析出唯一候选的 ref。
 * 只有 `unique` 才放行写动作；`notFound` 与 `ambiguous` 都以可读错误收口——工具与宿主
 * 都不允许「取第一个候选」，否则写动作会落到一个未经确认的元素上。
 */
export const resolveUniqueUiRef = async (
  environment: AgentEnvironment,
  tabId: string,
  locator: UiLocatorSpec,
): Promise<number> => {
  const label = describeUiLocator(locator)
  const response: BrowserCommandResponse = await environment.browser.command({
    action: 'resolveLocator',
    tabId,
    locator,
  })
  if (response.type !== 'locatorResolved') {
    throw new Error(`浏览器返回了非定位结果：${response.type}`)
  }
  const resolution = response.resolution
  if (resolution.status === 'notFound') {
    throw new Error(`无法唯一定位：定位器 ${label} 零匹配。先 ui_snapshot 确认页面状态，再换定位器重试。`)
  }
  if (resolution.status === 'ambiguous') {
    throw new Error(
      `无法唯一定位：定位器 ${label} 歧义（${resolution.total} 个候选）。`
      + '改用唯一命中的定位器（testId 或 role+name）后重试——宿主不会替你取第一个候选。',
    )
  }
  return resolution.candidate.ref
}

/**
 * 写工具幂等键的「目标选择子」：ref 用其整数，locator 用规范化内容的 SHA-256
 * （定位字段合计可逾 1 KB，明文进键会顶穿 runtime 的 512 bytes 上限）。
 */
export const uiTargetKeyPart = async (input: JsonValue): Promise<string> => {
  if (!isJsonObject(input)) return 'none'
  if (typeof input.ref === 'number') return `ref=${input.ref}`
  if (!isJsonObject(input.locator)) return 'none'
  const locator = toUiLocator(input.locator)
  return `locator=${await sha256Text(JSON.stringify([
    locator.testId ?? null,
    locator.role ?? null,
    locator.name ?? null,
    locator.label ?? null,
    locator.text ?? null,
    locator.css ?? null,
    locator.exact ?? null,
  ]))}`
}

/**
 * 解析目标标签页：显式 tabId 直接使用（有效性由后续动作权威判定），省略时取
 * Browser Rail 的当前活动标签页。无活动标签页时返回可读错误而不是猜一个。
 */
export const resolveUiTabId = async (
  environment: AgentEnvironment,
  requested: string | undefined,
): Promise<string> => {
  if (requested) return requested
  const response: BrowserCommandResponse = await environment.browser.command({ action: 'tabs' })
  if (response.type !== 'tabs') {
    throw new Error(`浏览器返回了非标签页结果：${response.type}`)
  }
  const tabs: BrowserTabInfo[] = response.tabs
  const active = tabs.find((tab) => tab.active)
  if (!active) {
    throw new Error('当前没有活动的浏览器标签页：请先在 Browser Rail 打开目标页面，或显式传入 tabId。')
  }
  return active.tabId
}

// ---------------------------------------------------------------------------
// UI 写探索（G1-3）共用文案与响应校验
// ---------------------------------------------------------------------------

/** 五个写工具共用的 ref 时效规则（工具描述与 guideline 必须明写，故收在单处）。 */
export const UI_WRITE_REF_STALENESS_RULE =
  'ref 只在当前步骤内有效：任何写动作（导航/点击/输入/选择/按键）完成后旧 ref 立即作废，'
  + '下一步必须重新 ui_snapshot 并重新解析定位，不要跨步骤复用 ref，也不要凭上一轮的行序推断页面结构。'

/** 写动作成功后追加的提示行（页面已变，证据全部过期）。 */
export const UI_WRITE_AFTER_NOTE =
  '写动作已生效，页面状态可能已改变：本步骤的 ref/快照/断言结论全部作废，下一步先 ui_snapshot 再继续。'

/** 审批卡与结果文案里的目标标签页表述（只给 tabId，不回显页面内容）。 */
export const describeUiTab = (tabId: string | undefined): string =>
  tabId ? `标签页 ${tabId}` : '当前活动标签页'

/**
 * 写动作的响应形状校验：写动作一律返回 `done`，导航返回 `navigated`；其它形状说明
 * 宿主与通道契约失配，必须显式失败而不是把未知结果当成成功。返回值已收窄到期望变体。
 */
export const expectUiWriteResponse = <Expected extends 'done' | 'navigated'>(
  response: BrowserCommandResponse,
  expected: Expected,
): Extract<BrowserCommandResponse, { type: Expected }> => {
  if (response.type !== expected) {
    throw new Error(`浏览器返回了非预期的写动作结果：${response.type}（期望 ${expected}）`)
  }
  return response as Extract<BrowserCommandResponse, { type: Expected }>
}
