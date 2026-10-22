/**
 * 探索轨迹 → TestSpec 草稿。
 *
 * 这一层把「一次探索做过什么」翻译成「一份可重放的测试应该断言什么」：丢弃瞬态
 * ref/tabId 与物理环境，把能稳定映射的步骤直译，把无法稳定表达的步骤保留成占位
 * 步骤并在 {@link SolidifyIssue} 里标 `needsReview`（不写进 TestSpec——协议里没有
 * 这个字段）。返回前用 `compileTestSpec` 干跑一次：结构合法的轨迹必须产出可编译的
 * 草稿，编译失败的问题并入 issues（`compile-failed`）供 UI 展示。
 */

import { compileTestSpec } from './compileTestPlan'
import type { ExplorerStep } from './trajectory'
import {
  TEST_SPEC_KIND,
  TEST_SPEC_VERSION,
  type ApiMethod,
  type ApiStepSpec,
  type SecretReference,
  type TestJsonValue,
  type TestSpec,
  type TestStepSpec,
  type TestTargetSpec,
  type TestValue,
  type UiExpectation,
  type UiLocator,
  type UiStepSpec,
} from './types'

export type SolidifyIssueCode =
  /** 写动作只给了瞬态 `ref`，无法得到跨运行稳定的 locator。 */
  | 'locator-unavailable'
  /** `ui_wait` 的页面级文本等待在 TestSpec 里是元素级 `textContains`。 */
  | 'page-text-assertion'
  /** 探索断言在 v1 协议里没有等价表达（`nameContains` / `pageTextContains`）。 */
  | 'unsupported-assertion'
  /** API 步骤没有显式 `expect`（自动反推的断言也必须人工确认）。 */
  | 'api-assertion-missing'
  /** 探索步骤本身执行失败——不能固化成一个「预期通过」的断言。 */
  | 'step-failed'
  /** 找不到配对的工具结果（轨迹被截断）。 */
  | 'result-missing'
  /** 入参形状无法映射（缺必填字段）。 */
  | 'invalid-input'
  /** 草稿整体未通过 `compileTestSpec` 校验。 */
  | 'compile-failed'

export interface SolidifyIssue {
  /** 对应的探索步骤下标；spec 级问题为 -1。 */
  stepIndex: number
  toolName: string
  code: SolidifyIssueCode
  message: string
}

export interface SolidifyDraft {
  spec: TestSpec
  issues: SolidifyIssue[]
}

export interface SolidifyOptions {
  id: string
  name: string
  target: TestTargetSpec
  /** 测试环境声明的逻辑变量名；草稿里出现未声明的 `${env.*}` 会被编译期拒绝。 */
  environmentNames?: string[]
}

const DEFAULT_CASE_ID = 'main'
const DEFAULT_CASE_NAME = '探索固化'

const LOCATOR_FIELDS = ['testId', 'role', 'name', 'label', 'text', 'css'] as const
const API_METHODS: Record<string, true> = {
  GET: true, HEAD: true, POST: true, PUT: true, PATCH: true, DELETE: true, OPTIONS: true,
}
const BODY_MODES: Record<string, true> = { json: true, text: true, form: true }

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

const readText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

const readFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/**
 * 占位定位器：`ref` 路径无法推导稳定 locator 时先给一个形状合法、肉眼可辨的占位，
 * 保证草稿能过编译；它必然同时带一条 `locator-unavailable`。
 */
const placeholderLocator = (): UiLocator => ({ role: 'unknown', name: '待补充定位器' })

const readLocator = (value: unknown): UiLocator | undefined => {
  const record = asRecord(value)
  const locator: UiLocator = {}
  for (const field of LOCATOR_FIELDS) {
    const text = readText(record[field])
    if (text !== undefined) locator[field] = text
  }
  if (typeof record.exact === 'boolean') locator.exact = record.exact
  return LOCATOR_FIELDS.some((field) => locator[field] !== undefined) ? locator : undefined
}

const readSecretOrString = (value: unknown): string | SecretReference | undefined => {
  if (typeof value === 'string') return value
  const record = asRecord(value)
  const secretId = readString(record.secretId)
  return secretId === undefined ? undefined : { secretId }
}

const readQuery = (value: unknown): Record<string, TestValue> | undefined => {
  const record = asRecord(value)
  const query: Record<string, TestValue> = {}
  for (const [name, entry] of Object.entries(record)) {
    if (entry === null || typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      query[name] = entry
    }
  }
  return Object.keys(query).length === 0 ? undefined : query
}

const readHeaders = (value: unknown): Record<string, string | SecretReference> | undefined => {
  const record = asRecord(value)
  const headers: Record<string, string | SecretReference> = {}
  for (const [name, entry] of Object.entries(record)) {
    const header = readSecretOrString(entry)
    if (header !== undefined) headers[name] = header
  }
  return Object.keys(headers).length === 0 ? undefined : headers
}

/** 递归收窄成 `TestJsonValue`；`undefined` 表示该子树无法表达（整段 body 会被丢弃）。 */
const toJsonValue = (value: unknown): TestJsonValue | undefined => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const items: TestJsonValue[] = []
    for (const item of value) {
      const converted = toJsonValue(item)
      if (converted === undefined) return undefined
      items.push(converted)
    }
    return items
  }
  if (typeof value === 'object' && value !== null) {
    const out: { [key: string]: TestJsonValue } = {}
    for (const [key, entry] of Object.entries(value)) {
      const converted = toJsonValue(entry)
      if (converted === undefined) return undefined
      out[key] = converted
    }
    return out
  }
  return undefined
}

const stepId = (index: number, toolName: string): string =>
  `step-${index + 1}-${toolName.replace(/_/gu, '-')}`

const firstLine = (content: string): string => content.split('\n')[0]?.trim() ?? ''

const pushIssue = (
  issues: SolidifyIssue[],
  stepIndex: number,
  toolName: string,
  code: SolidifyIssueCode,
  message: string,
): void => {
  issues.push({ stepIndex, toolName, code, message })
}

/** 元素级断言/写动作的定位器兜底：有 locator 直用，否则给占位并记 needsReview。 */
const resolveLocatorOrPlaceholder = (
  step: ExplorerStep,
  index: number,
  rawLocator: unknown,
  issues: SolidifyIssue[],
  message: string,
): UiLocator => {
  const locator = readLocator(rawLocator)
  if (locator) return locator
  pushIssue(issues, index, step.toolName, 'locator-unavailable', message)
  return placeholderLocator()
}

const readUiAssertion = (
  expectRecord: Record<string, unknown>,
): { key: string; value: unknown } | undefined => {
  for (const key of [
    'exists', 'count', 'enabled', 'nameContains', 'valueEquals', 'pageTextContains', 'urlContains',
  ]) {
    if (key in expectRecord) return { key, value: expectRecord[key] }
  }
  return undefined
}

/**
 * 从观测结果提取可反推的 HTTP 状态：仅在步骤成功且结果带数字 `statusCode` 时给出。
 * 失败步骤绝不反推——否则会把一次失败（如 500）固化成「预期通过」。
 */
const deriveApiStatus = (step: ExplorerStep): number | undefined => {
  if (!step.result || step.result.isError) return undefined
  return readFiniteNumber(asRecord(step.result.details).statusCode)
}

const mapApiRequestStep = (
  step: ExplorerStep,
  index: number,
  issues: SolidifyIssue[],
  input: Record<string, unknown>,
): ApiStepSpec | undefined => {
  const id = stepId(index, step.toolName)
  const method = readString(input.method)
  const url = readString(input.url)
  if (method === undefined || API_METHODS[method] !== true || url === undefined) {
    pushIssue(issues, index, step.toolName, 'invalid-input', '缺少合法的 method/url，无法固化为 API 步骤。')
    return undefined
  }
  const bodyMode = readString(input.bodyMode)
  const redirect = readString(input.redirect)
  const timeoutMs = readFiniteNumber(input.timeoutMs)
  const body = input.body === undefined ? undefined : toJsonValue(input.body)
  const query = readQuery(input.query)
  const headers = readHeaders(input.headers)

  const spec: ApiStepSpec = {
    id,
    action: 'api.request',
    method: method as ApiMethod,
    url,
    ...(query ? { query } : {}),
    ...(headers ? { headers } : {}),
    ...(body === undefined ? {} : { body }),
    ...(bodyMode !== undefined && BODY_MODES[bodyMode] === true ? { bodyMode: bodyMode as ApiStepSpec['bodyMode'] } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(redirect === 'manual' || redirect === 'same-origin' ? { redirect } : {}),
  }

  const status = deriveApiStatus(step)
  if (status !== undefined) {
    spec.expect = [{ status }]
    pushIssue(
      issues,
      index,
      step.toolName,
      'api-assertion-missing',
      `探索时未显式给出 expect：已按观测到的 HTTP 状态反推保守断言（status=${status}），请人工确认后补全。`,
    )
  } else {
    pushIssue(
      issues,
      index,
      step.toolName,
      'api-assertion-missing',
      'API 步骤缺少 expect，草稿未写断言：请补上状态码或响应体断言。',
    )
  }
  return spec
}

const mapStep = (
  step: ExplorerStep,
  index: number,
  issues: SolidifyIssue[],
): TestStepSpec | undefined => {
  const input = asRecord(step.input)
  const id = stepId(index, step.toolName)

  switch (step.toolName) {
    case 'ui_navigate': {
      const url = readString(input.url)
      if (url === undefined) {
        pushIssue(issues, index, step.toolName, 'invalid-input', 'ui_navigate 缺少 url，无法固化。')
        return undefined
      }
      return { id, action: 'ui.navigate', url }
    }
    case 'ui_click': {
      const locator = resolveLocatorOrPlaceholder(
        step, index, input.locator, issues,
        'ui_click 只有瞬态 ref，无法得到稳定 locator：已生成占位定位器，请改为 testId/role+name 等结构化定位。',
      )
      return { id, action: 'ui.click', locator }
    }
    case 'ui_input': {
      const locator = resolveLocatorOrPlaceholder(
        step, index, input.locator, issues,
        'ui_input 只有瞬态 ref，无法得到稳定 locator：已生成占位定位器，请改为结构化定位。',
      )
      return { id, action: 'ui.input', locator, value: typeof input.text === 'string' ? input.text : '' }
    }
    case 'ui_select': {
      const locator = resolveLocatorOrPlaceholder(
        step, index, input.locator, issues,
        'ui_select 只有瞬态 ref，无法得到稳定 locator：已生成占位定位器，请改为结构化定位。',
      )
      return { id, action: 'ui.select', locator, value: typeof input.text === 'string' ? input.text : '' }
    }
    case 'ui_press': {
      const key = readString(input.key)
      if (key === undefined) {
        pushIssue(issues, index, step.toolName, 'invalid-input', 'ui_press 缺少 key，无法固化。')
        return undefined
      }
      return { id, action: 'ui.press', key }
    }
    case 'ui_wait': {
      const timeoutMs = readFiniteNumber(input.durationMs)
      const text = readText(input.text)
      if (text !== undefined) {
        pushIssue(
          issues, index, step.toolName, 'page-text-assertion',
          `ui_wait 的 text「${text}」是页面级等待，TestSpec 的 textContains 是元素级断言：已生成占位定位器，请补上承载该文本的元素定位。`,
        )
        const wait: Extract<UiStepSpec, { action: 'ui.wait' }> = {
          id,
          action: 'ui.wait',
          locator: placeholderLocator(),
          expect: { textContains: text },
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }
        return wait
      }
      pushIssue(
        issues, index, step.toolName, 'locator-unavailable',
        'ui_wait 只给了时长，TestSpec 没有纯等待原语：已生成占位定位器与 exists 断言，请补一个真实的等待条件。',
      )
      const wait: Extract<UiStepSpec, { action: 'ui.wait' }> = {
        id,
        action: 'ui.wait',
        locator: placeholderLocator(),
        expect: { exists: true },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }
      return wait
    }
    case 'ui_assert': {
      const expectRecord = asRecord(input.expect)
      const assertion = readUiAssertion(expectRecord)
      if (!assertion) {
        pushIssue(issues, index, step.toolName, 'invalid-input', 'ui_assert 的 expect 没有可识别字段，无法固化。')
        return undefined
      }
      return mapUiAssertStep(step, index, issues, id, input, assertion.key, assertion.value)
    }
    case 'ui_screenshot':
      return { id, action: 'ui.screenshot' }
    case 'api_request':
      return mapApiRequestStep(step, index, issues, input)
  }
}

const mapUiAssertStep = (
  step: ExplorerStep,
  index: number,
  issues: SolidifyIssue[],
  id: string,
  input: Record<string, unknown>,
  key: string,
  value: unknown,
): UiStepSpec | undefined => {
  const elementExpectation = (
    expect: UiExpectation,
    message: string,
  ): UiStepSpec => {
    const locator = resolveLocatorOrPlaceholder(step, index, input.locator, issues, message)
    return { id, action: 'ui.assert', locator, expect }
  }

  switch (key) {
    case 'exists':
      return typeof value === 'boolean'
        ? elementExpectation({ exists: value }, 'ui_assert 的元素断言缺少 locator：已生成占位定位器。')
        : undefined
    case 'enabled':
      return typeof value === 'boolean'
        ? elementExpectation({ enabled: value }, 'ui_assert 的元素断言缺少 locator：已生成占位定位器。')
        : undefined
    case 'count':
      return typeof value === 'number' && Number.isFinite(value)
        ? elementExpectation({ count: value }, 'ui_assert 的元素断言缺少 locator：已生成占位定位器。')
        : undefined
    case 'valueEquals':
      return typeof value === 'string'
        ? elementExpectation({ valueEquals: value }, 'ui_assert 的元素断言缺少 locator：已生成占位定位器。')
        : undefined
    case 'urlContains':
      if (typeof value !== 'string') return undefined
      // 页面级断言不接 locator。
      return { id, action: 'ui.assert', expect: { urlContains: value } }
    case 'nameContains': {
      if (typeof value !== 'string') return undefined
      pushIssue(
        issues, index, step.toolName, 'unsupported-assertion',
        `ui_assert 的 nameContains「${value}」在 v1 协议里无等价断言：已用 textContains 近似，请人工校正语义。`,
      )
      const locator = resolveLocatorOrPlaceholder(
        step, index, input.locator, issues,
        'ui_assert 的 nameContains 近似映射需要 locator：已生成占位定位器。',
      )
      return { id, action: 'ui.assert', locator, expect: { textContains: value } }
    }
    case 'pageTextContains': {
      if (typeof value !== 'string') return undefined
      pushIssue(
        issues, index, step.toolName, 'unsupported-assertion',
        `ui_assert 的 pageTextContains「${value}」是页面级文本断言，v1 协议无等价表达：已生成占位元素断言，请人工改写。`,
      )
      const locator = resolveLocatorOrPlaceholder(
        step, index, input.locator, issues,
        'ui_assert 的 pageTextContains 近似映射需要 locator：已生成占位定位器。',
      )
      return { id, action: 'ui.assert', locator, expect: { textContains: value } }
    }
    default:
      pushIssue(issues, index, step.toolName, 'unsupported-assertion', `ui_assert 的断言「${key}」无法固化。`)
      return undefined
  }
}

const buildSteps = (steps: readonly ExplorerStep[], issues: SolidifyIssue[]): TestStepSpec[] => {
  const built: TestStepSpec[] = []
  steps.forEach((step, index) => {
    if (step.result?.isError) {
      pushIssue(
        issues, index, step.toolName, 'step-failed',
        `探索步骤执行失败，未固化其断言（避免把失败当成预期通过）：${firstLine(step.result.content)}`,
      )
    } else if (!step.result) {
      pushIssue(
        issues, index, step.toolName, 'result-missing',
        '未找到配对的工具结果（轨迹可能被截断），请人工确认该步骤的期望。',
      )
    }
    const mapped = mapStep(step, index, issues)
    if (mapped) built.push(mapped)
  })
  return built
}

/**
 * 把探索轨迹固化成 TestSpec 草稿。确定性：相同输入产出逐字节相同的 spec 与同序 issues。
 */
export const solidifyDraft = async (
  steps: readonly ExplorerStep[],
  options: SolidifyOptions,
): Promise<SolidifyDraft> => {
  const issues: SolidifyIssue[] = []
  const builtSteps = buildSteps(steps, issues)

  const spec: TestSpec = {
    kind: TEST_SPEC_KIND,
    version: TEST_SPEC_VERSION,
    id: options.id,
    name: options.name,
    target: options.target,
    cases: [{
      id: DEFAULT_CASE_ID,
      name: DEFAULT_CASE_NAME,
      steps: builtSteps,
    }],
  }

  const compiled = await compileTestSpec(spec, {
    declaredEnvironmentNames: new Set(options.environmentNames ?? []),
  })
  if (!compiled.ok) {
    for (const issue of compiled.issues) {
      pushIssue(issues, -1, 'spec', 'compile-failed', `${issue.path}: ${issue.message}`)
    }
  }

  return { spec, issues }
}
