import type { AgentTool, AgentToolResult, JsonValue } from '../core/types'
import type {
  AgentEnvironment,
  LocatorCandidate,
  LocatorResolution,
  UiLocatorSpec,
} from '@/agent/environment/AgentEnvironment'
import { hasOnlyKeys, isJsonObject, sha256Text } from './workspaceToolUtils'
import {
  MAX_UI_TEXT_CHARS,
  TAB_ID_INPUT,
  UI_LOCATOR_SCHEMA,
  describeResolution,
  describeUiLocator,
  resolveUiTabId,
  toUiLocator,
  validateUiLocator,
} from './uiToolSupport'

const MAX_TAB_ID_CHARS = 200

/**
 * 断言覆盖的实际集合：只包含 `browser_command` 只读事实面可观测的判定——
 * 元素级用 `resolveLocator`（存在性/匹配数/enabled/可访问名/AX value），
 * 页面级用 `find`（页面可访问性文本）与 `tabs`（URL）。
 *
 * 刻意不提供 `visible`（可见性）与元素级文本断言：宿主 `LocatorCandidate` 不含
 * `hidden`/子树文本，只有确定性 Runner 的 `run_ui_read_step` 才带元素事实（需要
 * U1-2 运行目标授权）。宁可少一个断言面，也不给出与 Runner 语义不同的「可见」判定。
 */
type ElementAssertion =
  | { key: 'exists'; flag: boolean }
  | { key: 'enabled'; flag: boolean }
  | { key: 'count'; count: number }
  | { key: 'nameContains'; text: string }
  | { key: 'valueEquals'; text: string }

type PageLevelAssertion = { key: 'pageTextContains' | 'urlContains'; text: string }

type UiAssertion =
  | { scope: 'element'; kind: ElementAssertion }
  | { scope: 'page'; kind: PageLevelAssertion }

const ASSERTION_KEYS = [
  'exists',
  'count',
  'enabled',
  'nameContains',
  'valueEquals',
  'pageTextContains',
  'urlContains',
] as const

const readUiAssertion = (
  value: JsonValue | undefined,
): { ok: true; assertion: UiAssertion } | { ok: false; error: string } => {
  if (value === undefined || !isJsonObject(value)) {
    return { ok: false, error: 'expect must be an object with exactly one assertion field.' }
  }
  const keys = Object.keys(value)
  const key = keys[0] as (typeof ASSERTION_KEYS)[number]
  if (keys.length !== 1 || !(ASSERTION_KEYS as readonly string[]).includes(key)) {
    return { ok: false, error: `expect must contain exactly one of ${ASSERTION_KEYS.join(', ')}.` }
  }
  const raw = value[key]
  if (key === 'exists' || key === 'enabled') {
    if (typeof raw !== 'boolean') return { ok: false, error: `expect.${key} must be a boolean.` }
    return {
      ok: true,
      assertion: {
        scope: 'element',
        kind: key === 'exists' ? { key: 'exists', flag: raw } : { key: 'enabled', flag: raw },
      },
    }
  }
  if (key === 'count') {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      return { ok: false, error: 'expect.count must be an integer >= 0.' }
    }
    return { ok: true, assertion: { scope: 'element', kind: { key: 'count', count: raw } } }
  }
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_UI_TEXT_CHARS) {
    return {
      ok: false,
      error: `expect.${key} must be a non-empty string of at most ${MAX_UI_TEXT_CHARS} chars.`,
    }
  }
  if (key === 'pageTextContains' || key === 'urlContains') {
    return { ok: true, assertion: { scope: 'page', kind: { key, text: raw } } }
  }
  return {
    ok: true,
    assertion: {
      scope: 'element',
      kind: key === 'nameContains' ? { key: 'nameContains', text: raw } : { key: 'valueEquals', text: raw },
    },
  }
}

/** 折叠空白后比较，与宿主 AX 文本判定的口径一致（换行/缩进不参与比较）。 */
const collapseWhitespace = (value: string): string =>
  value.split(/\s+/u).filter(Boolean).join(' ')

interface AssertionJudgement {
  verdict: 'passed' | 'failed'
  expectation: string
  actual: string
}

/** 元素级断言要求唯一命中：零匹配与歧义都是「无法判定」而非「不成立」。 */
const uniqueCandidate = (resolution: LocatorResolution, locatorLabel: string): LocatorCandidate => {
  if (resolution.status === 'notFound') {
    throw new Error(`无法判定：定位器 ${locatorLabel} 零匹配。先 ui_snapshot 确认页面状态，再换定位器重试。`)
  }
  if (resolution.status === 'ambiguous') {
    throw new Error(
      `无法判定：定位器 ${locatorLabel} 歧义（${resolution.total} 个候选）。`
      + '改用唯一命中的定位器（testId 或 role+name）后重试——宿主不会替你取第一个候选。',
    )
  }
  return resolution.candidate
}

const judgeElementAssertion = (
  assertion: ElementAssertion,
  resolution: LocatorResolution,
  locatorLabel: string,
): AssertionJudgement => {
  if (assertion.key === 'exists') {
    if (resolution.status === 'ambiguous') {
      throw new Error(
        `无法判定存在性：定位器 ${locatorLabel} 歧义（${resolution.total} 个候选）。`
        + '歧义既不是存在也不是不存在的证据。',
      )
    }
    const exists = resolution.status === 'unique'
    return {
      verdict: exists === assertion.flag ? 'passed' : 'failed',
      expectation: `exists=${assertion.flag}`,
      actual: exists ? `匹配到元素（${describeResolution(resolution)}）` : '零匹配',
    }
  }
  if (assertion.key === 'count') {
    const actualCount = resolution.status === 'notFound'
      ? 0
      : resolution.status === 'unique' ? 1 : resolution.total
    return {
      verdict: actualCount === assertion.count ? 'passed' : 'failed',
      expectation: `count=${assertion.count}`,
      actual: `匹配数 ${actualCount}${resolution.status === 'ambiguous' ? '（已计入全部候选）' : ''}`,
    }
  }
  const candidate = uniqueCandidate(resolution, locatorLabel)
  if (assertion.key === 'enabled') {
    const enabled = !candidate.disabled
    return {
      verdict: enabled === assertion.flag ? 'passed' : 'failed',
      expectation: `enabled=${assertion.flag}`,
      actual: `宿主报告的 enabled=${enabled}（role=${candidate.role}）`,
    }
  }
  if (assertion.key === 'nameContains') {
    const name = collapseWhitespace(candidate.name)
    return {
      verdict: name.includes(collapseWhitespace(assertion.text)) ? 'passed' : 'failed',
      expectation: `nameContains「${assertion.text}」`,
      actual: `可访问名「${candidate.name || '(空)'}」`,
    }
  }
  const value = candidate.value ?? ''
  return {
    verdict: value === assertion.text ? 'passed' : 'failed',
    expectation: `valueEquals「${assertion.text}」`,
    actual: `AX value「${value || '(空)'}」`,
  }
}

/** 解析定位器 → 单次取样 → 判定。零匹配/歧义由 `uniqueCandidate` 等分支以错误收口。 */
const judgeElementScope = async (
  environment: AgentEnvironment,
  request: { tabId: string; locator: UiLocatorSpec; assertion: ElementAssertion },
  signal: AbortSignal,
): Promise<{ judgement: AssertionJudgement; resolution: LocatorResolution }> => {
  const resolved = await environment.browser.command({
    action: 'resolveLocator',
    tabId: request.tabId,
    locator: request.locator,
  })
  if (resolved.type !== 'locatorResolved') {
    throw new Error(`浏览器返回了非定位结果：${resolved.type}`)
  }
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  return {
    judgement: judgeElementAssertion(
      request.assertion,
      resolved.resolution,
      describeUiLocator(request.locator),
    ),
    resolution: resolved.resolution,
  }
}

const judgePageLevelAssertion = async (
  environment: AgentEnvironment,
  assertion: PageLevelAssertion,
  tabId: string,
): Promise<AssertionJudgement> => {
  if (assertion.key === 'pageTextContains') {
    const found = await environment.browser.command({
      action: 'find',
      tabId,
      text: assertion.text,
      limit: 1,
    })
    if (found.type !== 'found') throw new Error(`浏览器返回了非检索结果：${found.type}`)
    return {
      verdict: found.total > 0 ? 'passed' : 'failed',
      expectation: `pageTextContains「${assertion.text}」`,
      actual: found.total > 0
        ? `页面可访问性文本有 ${found.total} 行包含该串（要看命中行时调 ui_find，本工具不回显页面内容）`
        : '页面可访问性文本没有匹配行（该串可能只在属性/图片里，或页面尚未渲染出来）',
    }
  }
  const tabs = await environment.browser.command({ action: 'tabs' })
  if (tabs.type !== 'tabs') throw new Error(`浏览器返回了非标签页结果：${tabs.type}`)
  const tab = tabs.tabs.find((candidate) => candidate.tabId === tabId)
  if (!tab) {
    throw new Error(`标签页 ${tabId} 不存在（可能已关闭）：重新确认浏览器当前打开的标签页。`)
  }
  return {
    verdict: tab.url.includes(assertion.text) ? 'passed' : 'failed',
    expectation: `urlContains「${assertion.text}」`,
    actual: `当前 URL：${tab.url}`,
  }
}

export const createUiAssertTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'ui_assert',
  label: 'ui_assert',
  promptSnippet: '对浏览器页面做只读断言判定（存在性/匹配数/enabled/名称/AX value/页面文本/URL）。',
  promptGuidelines: [
    '断言对象是宿主可观测事实：元素级断言（exists/count/enabled/nameContains/valueEquals）用结构化 locator 解析，页面级断言（pageTextContains/urlContains）不接 locator。',
    '判定是单次取样、不等待：需要等页面稳定时先用 ui_wait 再断言，不要把断言当轮询器反复原样重试。',
    '判定不成立返回 verdict=failed 的正常结果（不是工具故障）；定位零匹配或歧义会以错误返回，因为那时没有任何可信结论——换定位器后再断言。',
    '不提供可见性与元素级文本断言：那是确定性 Runner 的元素取样事实。需要时用 ui_snapshot 的结构与 ui_find 的行命中自行判断，不要声称断言过可见性。',
  ],
  runtimeVersion: '1',
  recoveryPolicy: 'idempotent',
  idempotencyKey: async (input) => {
    if (!isJsonObject(input)) return 'ui_assert:invalid'
    const tabId = typeof input.tabId === 'string' ? input.tabId : ''
    const locator = isJsonObject(input.locator)
      ? JSON.stringify([
        input.locator.testId ?? null,
        input.locator.role ?? null,
        input.locator.name ?? null,
        input.locator.label ?? null,
        input.locator.text ?? null,
        input.locator.css ?? null,
        input.locator.exact ?? null,
      ])
      : ''
    const expect = isJsonObject(input.expect) ? JSON.stringify(input.expect) : ''
    // 定位器字段与期望文本合计可逾 1 KB：明文进键会顶穿 runtime 的 512 bytes 上限
    // （见 toolExecution.ts）。这里只保留内容摘要，保幂等语义又不写明文进审计键。
    return `ui_assert:${tabId}:${await sha256Text(`${locator}\n${expect}`)}`
  },
  description:
    'Read-only assertion against one Browser Rail tab, judged by the host from observational facts. '
    + 'expect takes exactly one field: exists (boolean, locator match), count (integer, number of locator '
    + 'matches), enabled (boolean, AX disabled flag of the unique match), nameContains (string, accessible '
    + 'name of the unique match), valueEquals (string, AX value of the unique match), pageTextContains '
    + '(string, any page accessibility-tree line), urlContains (string, current tab URL). Element-level '
    + 'assertions require locator; pageTextContains and urlContains reject it. A false expectation returns '
    + 'normally with verdict=failed; zero matches or an ambiguous locator return an error because no '
    + 'trustworthy verdict exists. Visibility and element-scoped text are deliberately not asserted here: '
    + 'those facts only exist in the deterministic Runner element sampling.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: TAB_ID_INPUT,
      locator: UI_LOCATOR_SCHEMA,
      expect: {
        type: 'object',
        description: 'Exactly one expectation field.',
        anyOf: [
          {
            type: 'object',
            properties: { exists: { type: 'boolean', description: 'Locator matches an element.' } },
            required: ['exists'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { count: { type: 'integer', minimum: 0, description: 'Expected number of locator matches.' } },
            required: ['count'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { enabled: { type: 'boolean', description: 'Unique match is enabled (AX disabled flag).' } },
            required: ['enabled'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { nameContains: { type: 'string', description: 'Substring of the unique match accessible name.' } },
            required: ['nameContains'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { valueEquals: { type: 'string', description: 'Exact AX value of the unique match.' } },
            required: ['valueEquals'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { pageTextContains: { type: 'string', description: 'Any page accessibility-tree line contains this substring.' } },
            required: ['pageTextContains'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { urlContains: { type: 'string', description: 'Current tab URL contains this substring.' } },
            required: ['urlContains'],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ['expect'],
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['tabId', 'locator', 'expect'])) {
      return { ok: false, error: 'Arguments must be an object with only tabId, locator, and expect.' }
    }
    if (input.tabId !== undefined
      && (typeof input.tabId !== 'string' || !input.tabId.trim() || input.tabId.length > MAX_TAB_ID_CHARS)) {
      return { ok: false, error: `tabId must be a non-empty string of at most ${MAX_TAB_ID_CHARS} chars.` }
    }
    const parsed = readUiAssertion(input.expect)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    if (parsed.assertion.scope === 'element') {
      const locatorError = validateUiLocator(input.locator)
      if (locatorError) return { ok: false, error: locatorError }
    } else if (input.locator !== undefined) {
      return {
        ok: false,
        error: 'pageTextContains and urlContains are page-level expectations and take no locator; '
          + 'drop the locator or use an element-level expectation (exists/count/enabled/nameContains/valueEquals).',
      }
    }
    return { ok: true, value: input }
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    if (!isJsonObject(input)) throw new Error('Invalid ui_assert arguments.')
    const parsed = readUiAssertion(input.expect)
    if (!parsed.ok) throw new Error(parsed.error)
    const tabId = await resolveUiTabId(
      environment,
      typeof input.tabId === 'string' ? input.tabId.trim() : undefined,
    )
    const locator: UiLocatorSpec = parsed.assertion.scope === 'element' && input.locator !== undefined
      ? toUiLocator(input.locator)
      : {}
    const outcome: { judgement: AssertionJudgement; resolution: LocatorResolution | undefined } =
      parsed.assertion.scope === 'element'
        ? await judgeElementScope(
          environment,
          { tabId, locator, assertion: parsed.assertion.kind },
          context.signal,
        )
        : {
          judgement: await judgePageLevelAssertion(environment, parsed.assertion.kind, tabId),
          resolution: undefined,
        }
    const { judgement, resolution } = outcome
    const lines = [
      `ui_assert 判定：${judgement.verdict === 'passed' ? '通过' : '不通过'}`,
      ...(resolution ? [`定位：${describeUiLocator(locator)} → ${describeResolution(resolution)}`] : []),
      `期望：${judgement.expectation}`,
      `实际：${judgement.actual}`,
    ]
    if (judgement.verdict === 'failed') {
      lines.push('判定不通过：先 ui_snapshot 看当前页面状态，再决定改定位器还是改期望；不要原样重试同一断言。')
    }
    const expected: JsonValue = parsed.assertion.kind.key === 'exists' || parsed.assertion.kind.key === 'enabled'
      ? parsed.assertion.kind.flag
      : parsed.assertion.kind.key === 'count' ? parsed.assertion.kind.count : parsed.assertion.kind.text
    const details: { [key: string]: JsonValue } = {
      tabId,
      assertion: parsed.assertion.kind.key,
      expected,
      verdict: judgement.verdict,
      ...(resolution
        ? {
            locator: describeUiLocator(locator),
            resolution: resolution.status === 'ambiguous'
              ? { status: 'ambiguous', total: resolution.total }
              : { status: resolution.status },
          }
        : {}),
    }
    return { content: lines.join('\n'), details }
  },
})
