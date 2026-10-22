import { byteLength } from '../../core/bytes'
import { containsPlaintextCredential } from '../credentialPolicy'
import {
  SUPPORTED_TEST_SPEC_VERSIONS,
  TEST_SPEC_API_METHODS,
  TEST_SPEC_KIND,
  type ApiExtraction,
  type ApiExpectation,
  type ApiMethod,
  type ApiStepSpec,
  type SecretReference,
  type TestCaseSpec,
  type TestHooksSpec,
  type TestJsonValue,
  type TestPointKind,
  type TestPointSpec,
  type TestSpec,
  type TestSpecVersion,
  type TestStepSpec,
  type TestTargetSpec,
  type TestValue,
  type UiExpectation,
  type UiExtraction,
  type UiLocator,
  type UiStepSpec,
} from './types'

export interface TestSpecIssue {
  path: string
  message: string
}

export type ParseTestSpecResult =
  | { ok: true; spec: TestSpec }
  | { ok: false; issues: TestSpecIssue[] }

export const TEST_SPEC_LIMITS = {
  maxCases: 200,
  maxStepsPerCase: 200,
  maxStringLength: 4096,
  maxNameLength: 200,
  maxTimeoutMs: 120_000,
  maxBodyBytes: 256 * 1024,
  maxJsonDepth: 32,
  maxMapEntries: 64,
  maxExpectations: 32,
  maxTestPoints: 64,
  maxVerifiesPerCase: 16,
} as const

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const VARIABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const TEMPLATE_REF_PATTERN = /\$\{(?:env\.[A-Z][A-Z0-9_]{0,63}|vars\.[A-Za-z][A-Za-z0-9_]{0,63}|run\.(?:id|slug))\}/g
const TEMPLATE_PREFIX_PATTERN = /^\$\{(?:env\.[A-Z][A-Z0-9_]{0,63}|vars\.[A-Za-z][A-Za-z0-9_]{0,63}|run\.(?:id|slug))\}/
const SECRET_ID_PATTERN = /^apitest\.[a-z0-9][a-z0-9._-]{0,127}$/
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/
const SENSITIVE_HEADER_NAMES = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key'])
const JSON_POINTER_PATTERN = /^(\/([^~]|~[01])*)?$/
const BODY_METHODS: readonly ApiMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE']
const UI_LOCATOR_FIELDS = ['testId', 'role', 'name', 'label', 'text', 'css'] as const
const UI_EXPECTATION_KEYS = [
  'exists', 'visible', 'enabled', 'textEquals', 'textContains',
  'valueEquals', 'urlEquals', 'urlContains', 'count',
] as const
const API_EXPECTATION_KEYS = [
  'status', 'headerEquals', 'headerContains', 'bodyContains',
  'jsonPointerExists', 'jsonPointerEquals', 'maxElapsedMs',
] as const

/**
 * 步骤动作 → 该动作允许的字段集合。**导出**是为了让契约测试把「接受面」与版本号绑定：
 * 新增动作或给动作加字段都会改变这份声明，从而必须 bump `TEST_SPEC_VERSION`。
 */
export const TEST_SPEC_STEP_KEYS: Record<string, readonly string[]> = {
  'ui.navigate': ['id', 'action', 'url'],
  'ui.click': ['id', 'action', 'locator'],
  'ui.input': ['id', 'action', 'locator', 'value'],
  'ui.select': ['id', 'action', 'locator', 'value'],
  'ui.press': ['id', 'action', 'key'],
  'ui.wait': ['id', 'action', 'locator', 'expect', 'timeoutMs', 'extract'],
  'ui.assert': ['id', 'action', 'locator', 'expect', 'extract'],
  'ui.screenshot': ['id', 'action', 'name'],
  'api.request': ['id', 'action', 'method', 'url', 'query', 'headers', 'body', 'bodyMode', 'timeoutMs', 'redirect', 'expect', 'extract'],
}

/**
 * 顶层字段白名单，`readRecord` 直接消费这一份：新增顶层字段必须改这里，也就必然改变
 * 接受面声明（契约测试据此要求 bump 版本）。
 */
export const TEST_SPEC_TOP_LEVEL_KEYS = [
  'kind', 'version', 'id', 'name', 'target', 'hooks', 'testPoints', 'cases',
] as const

/**
 * 占位符形式声明（人读形式，契约测试用探针校验解析器真的接受/拒绝这些形式）。
 * `env.NAME` / `vars.name` 是 v1 起就有的；`run.id` / `run.slug` 是 v2 增量。
 */
export const TEST_SPEC_PLACEHOLDER_FORMS = ['env.NAME', 'vars.name', 'run.id', 'run.slug'] as const

/**
 * 解析上下文。`version` 是源文件声明的协议版本：解析器接受 v1/v2，但版本决定哪些
 * 增量字段合法（v1 文件出现 v2 字段属于错误，而不是被静默接受）。
 */
type Ctx = { issues: TestSpecIssue[]; version: TestSpecVersion }
type Reader<T> = (ctx: Ctx, value: unknown, path: string) => T | undefined

const issue = (ctx: Ctx, path: string, message: string): undefined => {
  ctx.issues.push({ path, message })
  return undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 对象必须只包含声明字段（fail-closed）；错误在源文件键顺序下逐个报告，保证输出稳定。 */
const readRecord = (
  ctx: Ctx,
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> | undefined => {
  if (!isRecord(value)) return issue(ctx, path, '必须是对象')
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) issue(ctx, `${path}.${key}`, `未知字段「${key}」`)
  }
  return value
}

const readText = (
  ctx: Ctx,
  value: unknown,
  path: string,
  maxLength: number = TEST_SPEC_LIMITS.maxStringLength,
  allowEmpty = false,
): string | undefined => {
  if (typeof value !== 'string') return issue(ctx, path, '必须是字符串')
  if (!allowEmpty && value.trim() === '') return issue(ctx, path, '不能为空')
  if (value.length > maxLength) return issue(ctx, path, `长度不能超过 ${maxLength} 字符`)
  return value
}

const readName = (ctx: Ctx, value: unknown, path: string): string | undefined =>
  readText(ctx, value, path, TEST_SPEC_LIMITS.maxNameLength)

const readId = (ctx: Ctx, value: unknown, path: string): string | undefined => {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    return issue(ctx, path, 'ID 必须以小写字母开头，仅含小写字母、数字与连字符，长度 1–64')
  }
  return value
}

/**
 * 运行占位符（v2 增量）：`${run.id}` 是本次运行的 run id，`${run.slug}` 是由它派生的、
 * 仅含 `[a-z0-9-]` 的唯一短标记（用于构造唯一名称 / 主机名 / 邮箱等测试数据，便于按
 * 标记清理）。非全局模式：这里只做「是否出现」判定，避免 `lastIndex` 状态串味。
 */
const RUN_REF_TEST_PATTERN = /\$\{run\.(?:id|slug)\}/

const readTemplate = (ctx: Ctx, value: unknown, path: string, allowEmpty = false): string | undefined => {
  const text = readText(ctx, value, path, TEST_SPEC_LIMITS.maxStringLength, allowEmpty)
  if (text === undefined) return undefined
  if (containsPlaintextCredential(text)) {
    return issue(ctx, path, '不允许出现明文凭据；请改用 Secret 引用（apitest.*）')
  }
  if (text.replace(TEMPLATE_REF_PATTERN, '').includes(`\${`)) {
    return issue(ctx, path, `只允许 \${env.NAME}、\${vars.name} 或 \${run.id} / \${run.slug} 形式的占位符`)
  }
  if (ctx.version < 2 && RUN_REF_TEST_PATTERN.test(text)) {
    return issue(ctx, path, `v1 文件不支持 \${run.id} / \${run.slug} 运行占位符；请把 version 升到 2`)
  }
  return text
}

/**
 * 接受 ${env.NAME} 前缀的逻辑地址、以单个 / 开头的站内相对路径，或不含占位符的
 * http(s) 绝对地址。拒绝 userinfo，防止测试文件内嵌凭据。
 */
const readUrl = (
  ctx: Ctx,
  value: unknown,
  path: string,
  options: { allowFragment?: boolean } = {},
): string | undefined => {
  const text = readTemplate(ctx, value, path)
  if (text === undefined) return undefined
  if (TEMPLATE_PREFIX_PATTERN.test(text)) return text
  if (text.startsWith('/') && !text.startsWith('//')) return text
  const comparable = text.replace(TEMPLATE_REF_PATTERN, 'value')
  try {
    const parsed = new URL(comparable)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return issue(ctx, path, '只允许 http(s) 地址')
    }
    if (parsed.username || parsed.password) return issue(ctx, path, '地址不能内嵌用户名或密码')
    // Rust API 执行面拒绝 fragment；TS 接受面必须一致，不能等运行到步骤才失败。
    if (options.allowFragment === false && parsed.hash !== '') {
      return issue(ctx, path, 'API 地址不能包含 fragment（#...）')
    }
    return text
  } catch {
    return issue(ctx, path, `地址格式无效；请使用 \${env.NAME} 前缀或 / 开头的相对路径`)
  }
}

const readInteger = (
  ctx: Ctx,
  value: unknown,
  path: string,
  min: number,
  max: number,
): number | undefined => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return issue(ctx, path, '必须是整数')
  if (value < min || value > max) return issue(ctx, path, `必须在 ${min} 到 ${max} 之间`)
  return value
}

const readBoolean = (ctx: Ctx, value: unknown, path: string): boolean | undefined =>
  typeof value === 'boolean' ? value : issue(ctx, path, '必须是布尔值')

const readTimeout = (ctx: Ctx, value: unknown, path: string): number | undefined =>
  readInteger(ctx, value, path, 1, TEST_SPEC_LIMITS.maxTimeoutMs)

const readScalar = (ctx: Ctx, value: unknown, path: string): TestValue | undefined => {
  if (typeof value === 'string') return readTemplate(ctx, value, path, true)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return issue(ctx, path, '只允许字符串、有限数字、布尔值或 null')
}

const readList = <T>(
  ctx: Ctx,
  value: unknown,
  path: string,
  bounds: { min: number; max: number },
  read: Reader<T>,
): T[] | undefined => {
  if (!Array.isArray(value)) return issue(ctx, path, '必须是数组')
  if (value.length < bounds.min) return issue(ctx, path, `至少需要 ${bounds.min} 项`)
  if (value.length > bounds.max) return issue(ctx, path, `不能超过 ${bounds.max} 项`)
  const items: T[] = []
  let valid = true
  value.forEach((item, index) => {
    const parsed = read(ctx, item, `${path}[${index}]`)
    if (parsed === undefined) valid = false
    else items.push(parsed)
  })
  return valid ? items : undefined
}

const readDuplicateCheck = (ctx: Ctx, ids: readonly (string | undefined)[], paths: readonly string[]): void => {
  const seen = new Set<string>()
  ids.forEach((id, index) => {
    if (id === undefined) return
    if (seen.has(id)) issue(ctx, paths[index] ?? '$', `ID「${id}」重复`)
    seen.add(id)
  })
}

const readLocator: Reader<UiLocator> = (ctx, value, path) => {
  const record = readRecord(ctx, value, path, [...UI_LOCATOR_FIELDS, 'exact'])
  if (!record) return undefined
  const locator: UiLocator = {}
  for (const field of UI_LOCATOR_FIELDS) {
    if (record[field] === undefined) continue
    const text = readText(ctx, record[field], `${path}.${field}`)
    if (text !== undefined) locator[field] = text
  }
  if (record.exact !== undefined) {
    const exact = readBoolean(ctx, record.exact, `${path}.exact`)
    if (exact !== undefined) locator.exact = exact
  }
  if (!UI_LOCATOR_FIELDS.some((field) => locator[field] !== undefined)) {
    return issue(ctx, path, '定位器至少需要一个定位字段（testId/role/name/label/text/css）')
  }
  return locator
}

const readUiExpectation: Reader<UiExpectation> = (ctx, value, path) => {
  const record = readRecord(ctx, value, path, UI_EXPECTATION_KEYS)
  if (!record) return undefined
  const keys = Object.keys(record)
  if (keys.length !== 1) return issue(ctx, path, '每个断言必须且只能包含一个断言字段')
  const [key] = keys
  const field = `${path}.${key}`
  switch (key) {
    case 'exists': {
      const flag = readBoolean(ctx, record.exists, field)
      return flag === undefined ? undefined : { exists: flag }
    }
    case 'visible': {
      const flag = readBoolean(ctx, record.visible, field)
      return flag === undefined ? undefined : { visible: flag }
    }
    case 'enabled': {
      const flag = readBoolean(ctx, record.enabled, field)
      return flag === undefined ? undefined : { enabled: flag }
    }
    case 'textEquals': {
      const text = readTemplate(ctx, record.textEquals, field, true)
      return text === undefined ? undefined : { textEquals: text }
    }
    case 'textContains': {
      const text = readTemplate(ctx, record.textContains, field)
      return text === undefined ? undefined : { textContains: text }
    }
    case 'valueEquals': {
      const text = readTemplate(ctx, record.valueEquals, field, true)
      return text === undefined ? undefined : { valueEquals: text }
    }
    case 'urlEquals': {
      const url = readUrl(ctx, record.urlEquals, field)
      return url === undefined ? undefined : { urlEquals: url }
    }
    case 'urlContains': {
      const text = readTemplate(ctx, record.urlContains, field)
      return text === undefined ? undefined : { urlContains: text }
    }
    case 'count': {
      const count = readInteger(ctx, record.count, field, 0, 10_000)
      return count === undefined ? undefined : { count }
    }
    default:
      return issue(ctx, path, `未知断言「${key}」`)
  }
}

const readJsonPointer = (ctx: Ctx, value: unknown, path: string): string | undefined => {
  const pointer = readText(ctx, value, path, TEST_SPEC_LIMITS.maxStringLength, true)
  if (pointer === undefined) return undefined
  return JSON_POINTER_PATTERN.test(pointer) ? pointer : issue(ctx, path, '必须是合法的 JSON Pointer（RFC 6901）')
}

const readHeaderAssertion = (
  ctx: Ctx,
  value: unknown,
  path: string,
): { name: string; value: string } | undefined => {
  const record = readRecord(ctx, value, path, ['name', 'value'])
  if (!record) return undefined
  const name = readText(ctx, record.name, `${path}.name`, 128)
  const headerValue = readTemplate(ctx, record.value, `${path}.value`, true)
  if (name === undefined || headerValue === undefined) return undefined
  if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
    return issue(ctx, `${path}.name`, '敏感响应头不能用于断言（避免实际值进入证据）')
  }
  return HEADER_NAME_PATTERN.test(name) ? { name, value: headerValue } : issue(ctx, `${path}.name`, '响应头名称格式无效')
}

const readApiExpectation: Reader<ApiExpectation> = (ctx, value, path) => {
  const record = readRecord(ctx, value, path, API_EXPECTATION_KEYS)
  if (!record) return undefined
  const keys = Object.keys(record)
  if (keys.length !== 1) return issue(ctx, path, '每个断言必须且只能包含一个断言字段')
  const [key] = keys
  const field = `${path}.${key}`
  switch (key) {
    case 'status': {
      const status = readInteger(ctx, record.status, field, 100, 599)
      return status === undefined ? undefined : { status }
    }
    case 'headerEquals': {
      const assertion = readHeaderAssertion(ctx, record.headerEquals, field)
      return assertion === undefined ? undefined : { headerEquals: assertion }
    }
    case 'headerContains': {
      const assertion = readHeaderAssertion(ctx, record.headerContains, field)
      return assertion === undefined ? undefined : { headerContains: assertion }
    }
    case 'bodyContains': {
      const text = readTemplate(ctx, record.bodyContains, field)
      return text === undefined ? undefined : { bodyContains: text }
    }
    case 'jsonPointerExists': {
      const pointer = readJsonPointer(ctx, record.jsonPointerExists, field)
      return pointer === undefined ? undefined : { jsonPointerExists: pointer }
    }
    case 'jsonPointerEquals': {
      const pair = readRecord(ctx, record.jsonPointerEquals, field, ['pointer', 'value'])
      if (!pair) return undefined
      const pointer = readJsonPointer(ctx, pair.pointer, `${field}.pointer`)
      const expected = readScalar(ctx, pair.value, `${field}.value`)
      return pointer === undefined || expected === undefined
        ? undefined
        : { jsonPointerEquals: { pointer, value: expected } }
    }
    case 'maxElapsedMs': {
      const elapsed = readTimeout(ctx, record.maxElapsedMs, field)
      return elapsed === undefined ? undefined : { maxElapsedMs: elapsed }
    }
    default:
      return issue(ctx, path, `未知断言「${key}」`)
  }
}

const readVariableName = (ctx: Ctx, value: string, path: string): string | undefined =>
  VARIABLE_NAME_PATTERN.test(value)
    ? value
    : issue(ctx, path, '变量名必须以字母开头，仅含字母、数字与下划线，长度 1–64')

const readExtractionMap = <T>(
  ctx: Ctx,
  value: unknown,
  path: string,
  read: Reader<T>,
): Record<string, T> | undefined => {
  const map = readPlainMap(ctx, value, path)
  if (!map) return undefined
  const entries = Object.entries(map)
  if (entries.length === 0) return issue(ctx, path, '至少需要一个提取变量')
  if (entries.length > TEST_SPEC_LIMITS.maxMapEntries) return issue(ctx, path, '提取变量过多')
  const result: Record<string, T> = {}
  let valid = true
  for (const [name, source] of entries) {
    if (readVariableName(ctx, name, `${path}.${name}`) === undefined) {
      valid = false
      continue
    }
    const parsed = read(ctx, source, `${path}.${name}`)
    if (parsed === undefined) valid = false
    else result[name] = parsed
  }
  return valid ? result : undefined
}

const readApiExtraction: Reader<ApiExtraction> = (ctx, value, path) => {
  const record = readRecord(ctx, value, path, ['jsonPointer', 'header', 'sensitive'])
  if (!record) return undefined
  const sourceCount = Number(record.jsonPointer !== undefined) + Number(record.header !== undefined)
  if (sourceCount !== 1) return issue(ctx, path, '必须且只能指定 jsonPointer 或 header')
  const sensitive = record.sensitive === undefined
    ? undefined
    : readBoolean(ctx, record.sensitive, `${path}.sensitive`)
  if (record.sensitive !== undefined && sensitive === undefined) return undefined
  if (record.jsonPointer !== undefined) {
    const jsonPointer = readJsonPointer(ctx, record.jsonPointer, `${path}.jsonPointer`)
    return jsonPointer === undefined ? undefined : { jsonPointer, ...(sensitive !== undefined ? { sensitive } : {}) }
  }
  const header = readText(ctx, record.header, `${path}.header`, 128)
  if (header === undefined) return undefined
  if (!HEADER_NAME_PATTERN.test(header)) return issue(ctx, `${path}.header`, '响应头名称格式无效')
  if (SENSITIVE_HEADER_NAMES.has(header.toLowerCase())) {
    return issue(ctx, `${path}.header`, '敏感响应头不能进入运行变量表')
  }
  return { header, ...(sensitive !== undefined ? { sensitive } : {}) }
}

const readUiExtraction: Reader<UiExtraction> = (ctx, value, path) => {
  const record = readRecord(ctx, value, path, ['source', 'sensitive'])
  if (!record) return undefined
  if (record.source !== 'text' && record.source !== 'value') {
    return issue(ctx, `${path}.source`, '只允许 text 或 value')
  }
  const sensitive = record.sensitive === undefined
    ? undefined
    : readBoolean(ctx, record.sensitive, `${path}.sensitive`)
  if (record.sensitive !== undefined && sensitive === undefined) return undefined
  return { source: record.source, ...(sensitive !== undefined ? { sensitive } : {}) }
}

/** Secret 引用只允许出现在请求头值中；body 与 query 里出现 secretId 视为越界。 */
const readHeaderValue = (ctx: Ctx, value: unknown, path: string): string | SecretReference | undefined => {
  if (!isRecord(value)) return readTemplate(ctx, value, path)
  const record = readRecord(ctx, value, path, ['secretId'])
  if (!record) return undefined
  if (typeof record.secretId !== 'string' || !SECRET_ID_PATTERN.test(record.secretId)) {
    return issue(ctx, `${path}.secretId`, 'Secret ID 必须以 apitest. 开头')
  }
  return { secretId: record.secretId }
}

const readJsonValue = (ctx: Ctx, value: unknown, path: string, depth = 0): TestJsonValue | undefined => {
  if (depth > TEST_SPEC_LIMITS.maxJsonDepth) return issue(ctx, path, '嵌套层级过深')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : issue(ctx, path, '数字必须有限')
  if (typeof value === 'string') return readTemplate(ctx, value, path)
  if (Array.isArray(value)) {
    return readList(ctx, value, path, { min: 0, max: 10_000 }, (c, item, itemPath) =>
      readJsonValue(c, item, itemPath, depth + 1))
  }
  if (!isRecord(value)) return issue(ctx, path, '不支持的 JSON 值')
  if ('secretId' in value) return issue(ctx, path, 'Secret 引用只能用于请求头')
  const entries = Object.entries(value)
  if (entries.length > TEST_SPEC_LIMITS.maxMapEntries) {
    return issue(ctx, path, `对象键数不能超过 ${TEST_SPEC_LIMITS.maxMapEntries}`)
  }
  const result: Record<string, TestJsonValue> = {}
  let valid = true
  for (const [key, child] of entries) {
    const parsed = readJsonValue(ctx, child, `${path}.${key}`, depth + 1)
    if (parsed === undefined) valid = false
    else result[key] = parsed
  }
  return valid ? result : undefined
}

const isApiMethod = (value: unknown): value is ApiMethod =>
  typeof value === 'string' && (TEST_SPEC_API_METHODS as readonly string[]).includes(value)

const isBodyMethod = (method: ApiMethod): boolean => BODY_METHODS.includes(method)

const readPlainMap = (ctx: Ctx, value: unknown, path: string): Record<string, unknown> | undefined =>
  isRecord(value) ? value : issue(ctx, path, '必须是对象')

const readApiStep = (ctx: Ctx, record: Record<string, unknown>, path: string, id: string): ApiStepSpec | undefined => {
  const method = isApiMethod(record.method)
    ? record.method
    : issue(ctx, `${path}.method`, `method 必须是 ${TEST_SPEC_API_METHODS.join('/')} 之一`)
  const url = readUrl(ctx, record.url, `${path}.url`, { allowFragment: false })
  const timeoutMs = record.timeoutMs === undefined ? undefined : readTimeout(ctx, record.timeoutMs, `${path}.timeoutMs`)
  const redirect = record.redirect === undefined
    ? undefined
    : record.redirect === 'manual' || record.redirect === 'same-origin'
      ? record.redirect
      : issue(ctx, `${path}.redirect`, '只允许 manual 或 same-origin')
  const bodyMode = record.bodyMode === undefined
    ? undefined
    : record.bodyMode === 'json' || record.bodyMode === 'text' || record.bodyMode === 'form'
      ? record.bodyMode
      : issue(ctx, `${path}.bodyMode`, '只允许 json、text 或 form')

  let query: Record<string, TestValue> | undefined
  if (record.query !== undefined) {
    const map = readPlainMap(ctx, record.query, `${path}.query`)
    if (map) {
      const entries = Object.entries(map)
      if (entries.length > TEST_SPEC_LIMITS.maxMapEntries) issue(ctx, `${path}.query`, '查询参数过多')
      const parsed: Record<string, TestValue> = {}
      let valid = true
      for (const [key, child] of entries) {
        const scalar = readScalar(ctx, child, `${path}.query.${key}`)
        if (scalar === undefined) valid = false
        else parsed[key] = scalar
      }
      if (valid) query = parsed
    }
  }

  let headers: Record<string, string | SecretReference> | undefined
  if (record.headers !== undefined) {
    const map = readPlainMap(ctx, record.headers, `${path}.headers`)
    if (map) {
      const entries = Object.entries(map)
      if (entries.length > TEST_SPEC_LIMITS.maxMapEntries) issue(ctx, `${path}.headers`, '请求头过多')
      const parsed: Record<string, string | SecretReference> = {}
      let valid = true
      for (const [key, child] of entries) {
        if (!HEADER_NAME_PATTERN.test(key)) {
          valid = false
          issue(ctx, `${path}.headers.${key}`, '请求头名称格式无效')
          continue
        }
        if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) && !isRecord(child)) {
          valid = false
          issue(ctx, `${path}.headers.${key}`, '敏感请求头必须使用 apitest.* Secret 引用')
          continue
        }
        const headerValue = readHeaderValue(ctx, child, `${path}.headers.${key}`)
        if (headerValue === undefined) valid = false
        else if (typeof headerValue === 'string' && SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) {
          valid = false
          issue(ctx, `${path}.headers.${key}`, '敏感请求头必须使用 apitest.* Secret 引用')
        } else parsed[key] = headerValue
      }
      if (valid) headers = parsed
    }
  }

  let body: TestJsonValue | undefined
  if (record.body !== undefined) {
    if (method !== undefined && !isBodyMethod(method)) {
      issue(ctx, `${path}.body`, '只有 POST/PUT/PATCH/DELETE 允许 body')
    } else if (bodyMode === 'text') {
      if (typeof record.body !== 'string') issue(ctx, `${path}.body`, 'bodyMode 为 text 时 body 必须是字符串')
      else body = readTemplate(ctx, record.body, `${path}.body`)
    } else if (bodyMode === 'form') {
      const map = readPlainMap(ctx, record.body, `${path}.body`)
      if (map) {
        const parsed: Record<string, TestValue> = {}
        let valid = true
        const entries = Object.entries(map)
        if (entries.length > TEST_SPEC_LIMITS.maxMapEntries) {
          valid = false
          issue(ctx, `${path}.body`, '表单字段过多')
        }
        for (const [key, child] of entries) {
          const scalar = readScalar(ctx, child, `${path}.body.${key}`)
          if (scalar === undefined) valid = false
          else parsed[key] = scalar
        }
        if (valid && byteLength(JSON.stringify(parsed)) <= TEST_SPEC_LIMITS.maxBodyBytes) body = parsed
        else if (valid) issue(ctx, `${path}.body`, `请求体不能超过 ${TEST_SPEC_LIMITS.maxBodyBytes} 字节`)
      }
    } else {
      const parsedBody = readJsonValue(ctx, record.body, `${path}.body`)
      if (parsedBody !== undefined && byteLength(JSON.stringify(parsedBody)) > TEST_SPEC_LIMITS.maxBodyBytes) {
        issue(ctx, `${path}.body`, `请求体不能超过 ${TEST_SPEC_LIMITS.maxBodyBytes} 字节`)
      } else body = parsedBody
    }
  }

  let expect: ApiExpectation[] | undefined
  if (record.expect !== undefined) {
    expect = readList(ctx, record.expect, `${path}.expect`, { min: 1, max: TEST_SPEC_LIMITS.maxExpectations }, readApiExpectation)
  }

  const extract = record.extract === undefined
    ? undefined
    : readExtractionMap(ctx, record.extract, `${path}.extract`, readApiExtraction)

  if (method === undefined || url === undefined || (record.query !== undefined && query === undefined)
    || (record.headers !== undefined && headers === undefined)
    || (record.body !== undefined && body === undefined)
    || (record.timeoutMs !== undefined && timeoutMs === undefined)
    || (record.expect !== undefined && expect === undefined)
    || (record.extract !== undefined && extract === undefined)
    || redirect === undefined && record.redirect !== undefined
    || bodyMode === undefined && record.bodyMode !== undefined) {
    return undefined
  }
  return {
    id,
    action: 'api.request',
    method,
    url,
    ...(query ? { query } : {}),
    ...(headers ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(bodyMode ? { bodyMode } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(redirect ? { redirect } : {}),
    ...(expect ? { expect } : {}),
    ...(extract ? { extract } : {}),
  }
}

const readUiStep = (ctx: Ctx, record: Record<string, unknown>, path: string, id: string, action: string): UiStepSpec | undefined => {
  switch (action) {
    case 'ui.navigate': {
      const url = readUrl(ctx, record.url, `${path}.url`)
      return url === undefined ? undefined : { id, action: 'ui.navigate', url }
    }
    case 'ui.click': {
      const locator = readLocator(ctx, record.locator, `${path}.locator`)
      return locator === undefined ? undefined : { id, action: 'ui.click', locator }
    }
    case 'ui.input': {
      const locator = readLocator(ctx, record.locator, `${path}.locator`)
      const value = readTemplate(ctx, record.value, `${path}.value`, true)
      return locator === undefined || value === undefined ? undefined : { id, action: 'ui.input', locator, value }
    }
    case 'ui.select': {
      const locator = readLocator(ctx, record.locator, `${path}.locator`)
      const value = readTemplate(ctx, record.value, `${path}.value`, true)
      return locator === undefined || value === undefined ? undefined : { id, action: 'ui.select', locator, value }
    }
    case 'ui.press': {
      const key = readText(ctx, record.key, `${path}.key`, 32)
      return key === undefined ? undefined : { id, action: 'ui.press', key }
    }
    case 'ui.wait': {
      const locator = record.locator === undefined ? undefined : readLocator(ctx, record.locator, `${path}.locator`)
      const expect = readUiExpectation(ctx, record.expect, `${path}.expect`)
      const timeoutMs = record.timeoutMs === undefined ? undefined : readTimeout(ctx, record.timeoutMs, `${path}.timeoutMs`)
      const extract = record.extract === undefined
        ? undefined
        : readExtractionMap(ctx, record.extract, `${path}.extract`, readUiExtraction)
      if (expect === undefined || (record.locator !== undefined && locator === undefined)
        || (record.timeoutMs !== undefined && timeoutMs === undefined)
        || (record.extract !== undefined && extract === undefined)) return undefined
      return {
        id,
        action: 'ui.wait',
        expect,
        ...(locator ? { locator } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(extract ? { extract } : {}),
      }
    }
    case 'ui.assert': {
      const locator = record.locator === undefined ? undefined : readLocator(ctx, record.locator, `${path}.locator`)
      const expect = readUiExpectation(ctx, record.expect, `${path}.expect`)
      const extract = record.extract === undefined
        ? undefined
        : readExtractionMap(ctx, record.extract, `${path}.extract`, readUiExtraction)
      if (expect === undefined || (record.locator !== undefined && locator === undefined)
        || (record.extract !== undefined && extract === undefined)) return undefined
      return { id, action: 'ui.assert', expect, ...(locator ? { locator } : {}), ...(extract ? { extract } : {}) }
    }
    case 'ui.screenshot': {
      const name = record.name === undefined ? undefined : readText(ctx, record.name, `${path}.name`, 64)
      if (record.name !== undefined && name === undefined) return undefined
      return { id, action: 'ui.screenshot', ...(name !== undefined ? { name } : {}) }
    }
    default:
      return undefined
  }
}

const readStep: Reader<TestStepSpec> = (ctx, value, path) => {
  if (!isRecord(value)) return issue(ctx, path, '必须是对象')
  const action = value.action
  if (typeof action !== 'string' || TEST_SPEC_STEP_KEYS[action] === undefined) {
    return issue(ctx, `${path}.action`, `未知动作「${String(action)}」`)
  }
  const record = readRecord(ctx, value, path, TEST_SPEC_STEP_KEYS[action] ?? [])
  if (!record) return undefined
  const id = readId(ctx, record.id, `${path}.id`)
  if (id === undefined) return undefined
  if (action === 'api.request') return readApiStep(ctx, record, path, id)
  return readUiStep(ctx, record, path, id, action)
}

const TEST_POINT_KINDS: readonly TestPointKind[] = ['new_feature', 'regression']

const readTestPoint: Reader<TestPointSpec> = (ctx, value, path) => {
  const record = readRecord(ctx, value, path, ['id', 'kind', 'title', 'acceptance'])
  if (!record) return undefined
  const id = readId(ctx, record.id, `${path}.id`)
  const kind = typeof record.kind === 'string' && (TEST_POINT_KINDS as readonly string[]).includes(record.kind)
    ? (record.kind as TestPointKind)
    : issue(ctx, `${path}.kind`, '只允许 new_feature 或 regression')
  const title = readName(ctx, record.title, `${path}.title`)
  const acceptance = readName(ctx, record.acceptance, `${path}.acceptance`)
  if (id === undefined || kind === undefined || title === undefined || acceptance === undefined) return undefined
  return { id, kind, title, acceptance }
}

const readTestPoints: Reader<TestPointSpec[]> = (ctx, value, path) => {
  if (ctx.version < 2) return issue(ctx, path, 'v1 文件不支持测试点；请把 version 升到 2')
  const points = readList(ctx, value, path, { min: 1, max: TEST_SPEC_LIMITS.maxTestPoints }, readTestPoint)
  if (points === undefined) return undefined
  readDuplicateCheck(
    ctx,
    points.map((point) => point.id),
    points.map((_, index) => `${path}[${index}].id`),
  )
  return points
}

const readVerifies: Reader<string[]> = (ctx, value, path) => {
  if (ctx.version < 2) return issue(ctx, path, 'v1 文件不支持测试点追溯；请把 version 升到 2')
  const ids = readList(ctx, value, path, { min: 1, max: TEST_SPEC_LIMITS.maxVerifiesPerCase }, readId)
  if (ids === undefined) return undefined
  readDuplicateCheck(ctx, ids, ids.map((_, index) => `${path}[${index}]`))
  return ids
}

const readCase: Reader<TestCaseSpec> = (ctx, value, path) => {
  const record = readRecord(ctx, value, path, ['id', 'name', 'steps', 'verifies'])
  if (!record) return undefined
  const id = readId(ctx, record.id, `${path}.id`)
  const name = readName(ctx, record.name, `${path}.name`)
  const steps = readList(ctx, record.steps, `${path}.steps`, { min: 1, max: TEST_SPEC_LIMITS.maxStepsPerCase }, readStep)
  if (steps === undefined || id === undefined || name === undefined) return undefined
  readDuplicateStepIds(ctx, steps, `${path}.steps`)
  const verifies = record.verifies === undefined ? undefined : readVerifies(ctx, record.verifies, `${path}.verifies`)
  if (record.verifies !== undefined && verifies === undefined) return undefined
  return { id, name, steps, ...(verifies ? { verifies } : {}) }
}

const readDuplicateStepIds = (ctx: Ctx, steps: readonly TestStepSpec[], stepsPath: string): void => {
  readDuplicateCheck(
    ctx,
    steps.map((step) => step.id),
    steps.map((_, index) => `${stepsPath}[${index}].id`),
  )
}

const readHooks: Reader<TestHooksSpec> = (ctx, value, path) => {
  const record = readRecord(ctx, value, path, ['beforeAll', 'beforeEach', 'afterEach', 'afterAll'])
  if (!record) return undefined
  const hooks: TestHooksSpec = {}
  let valid = true
  for (const name of ['beforeAll', 'beforeEach', 'afterEach', 'afterAll'] as const) {
    if (record[name] === undefined) continue
    const steps = readList(
      ctx,
      record[name],
      `${path}.${name}`,
      { min: 1, max: TEST_SPEC_LIMITS.maxStepsPerCase },
      readStep,
    )
    if (steps === undefined) {
      valid = false
      continue
    }
    readDuplicateStepIds(ctx, steps, `${path}.${name}`)
    hooks[name] = steps
  }
  return valid ? hooks : undefined
}

const readTarget: Reader<TestTargetSpec> = (ctx, value, path) => {
  const record = readRecord(ctx, value, path, ['webBaseUrl', 'apiBaseUrl', 'viewport'])
  if (!record) return undefined
  const target: TestTargetSpec = {}
  if (record.webBaseUrl !== undefined) {
    const url = readUrl(ctx, record.webBaseUrl, `${path}.webBaseUrl`)
    if (url !== undefined) target.webBaseUrl = url
  }
  if (record.apiBaseUrl !== undefined) {
    const url = readUrl(ctx, record.apiBaseUrl, `${path}.apiBaseUrl`, { allowFragment: false })
    if (url !== undefined) target.apiBaseUrl = url
  }
  if (record.viewport !== undefined) {
    const viewport = readRecord(ctx, record.viewport, `${path}.viewport`, ['width', 'height'])
    if (viewport) {
      const width = readInteger(ctx, viewport.width, `${path}.viewport.width`, 320, 3840)
      const height = readInteger(ctx, viewport.height, `${path}.viewport.height`, 240, 2160)
      if (width !== undefined && height !== undefined) target.viewport = { width, height }
    }
  }
  return target
}

const isSupportedVersion = (value: unknown): value is TestSpecVersion =>
  typeof value === 'number' && (SUPPORTED_TEST_SPEC_VERSIONS as readonly number[]).includes(value)

/**
 * 追溯交叉校验：用例 `verifies` 必须命中本文件声明的测试点，且每个测试点都必须被至少
 * 一个用例认领。悬空引用与孤儿测试点都判为「需要修复」——覆盖统计只认真实追溯，不接受
 * 「声明了测试点但没有任何用例证明它」的假覆盖。
 */
const collectTraceabilityIssues = (
  testPoints: readonly TestPointSpec[] | undefined,
  cases: readonly TestCaseSpec[],
): TestSpecIssue[] => {
  const issues: TestSpecIssue[] = []
  const declared = new Set((testPoints ?? []).map((point) => point.id))
  const claimed = new Set<string>()
  cases.forEach((testCase, caseIndex) => {
    for (const id of testCase.verifies ?? []) {
      if (!declared.has(id)) {
        issues.push({ path: `$.cases[${caseIndex}].verifies`, message: `引用了不存在的测试点「${id}」` })
        continue
      }
      claimed.add(id)
    }
  })
  for (const [pointIndex, point] of (testPoints ?? []).entries()) {
    if (!claimed.has(point.id)) {
      issues.push({ path: `$.testPoints[${pointIndex}]`, message: `测试点「${point.id}」没有任何用例认领` })
    }
  }
  return issues
}

/**
 * 校验 `tests/*.testspec.json`（v1/v2/v3）。输入视为不可信数据，不修改原对象；问题按遍历顺序
 * 稳定输出，便于 UI 与测试断言。顶层 discriminator 不匹配时直接拒绝，避免把其它
 * `.ax` 文件误当作测试文件解析；**版本决定增量字段与必填项**——v1 文件里出现 v2 字段
 * 是错误而不是被宽容接受，v3 缺少 `testPoints` 同样是错误，否则「版本」就不再表达差异。
 */
export const parseTestSpec = (source: string): ParseTestSpecResult => {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return { ok: false, issues: [{ path: '$', message: 'JSON 解析失败' }] }
  }
  return validateTestSpec(raw)
}

export const validateTestSpec = (raw: unknown): ParseTestSpecResult => {
  if (!isRecord(raw) || raw.kind !== TEST_SPEC_KIND) {
    return { ok: false, issues: [{ path: '$.kind', message: `必须为 "${TEST_SPEC_KIND}"` }] }
  }
  if (!isSupportedVersion(raw.version)) {
    return {
      ok: false,
      issues: [{
        path: '$.version',
        message: `不支持的版本，当前支持 ${SUPPORTED_TEST_SPEC_VERSIONS.join(' / ')}`,
      }],
    }
  }
  const version = raw.version
  const ctx: Ctx = { issues: [], version }
  const record = readRecord(ctx, raw, '$', TEST_SPEC_TOP_LEVEL_KEYS)
  const id = readId(ctx, raw.id, '$.id')
  const name = readName(ctx, raw.name, '$.name')
  const target = record ? readTarget(ctx, raw.target ?? {}, '$.target') : undefined
  const hooks = raw.hooks === undefined ? undefined : readHooks(ctx, raw.hooks, '$.hooks')
  const testPoints = raw.testPoints === undefined ? undefined : readTestPoints(ctx, raw.testPoints, '$.testPoints')
  const cases = readList(ctx, raw.cases, '$.cases', { min: 1, max: TEST_SPEC_LIMITS.maxCases }, readCase)
  if (cases) {
    readDuplicateCheck(
      ctx,
      cases.map((testCase) => testCase.id),
      cases.map((_, index) => `$.cases[${index}].id`),
    )
    ctx.issues.push(...collectTraceabilityIssues(testPoints, cases))
  }
  // v3 的增量是「测试点必须存在」：v2 仍允许旧文件省略它（覆盖会停在「未运行」并由
  // 审计/创作检查提示），新文件从 v3 起不再接受没有分母的形态。
  if (version >= 3 && raw.testPoints === undefined) {
    ctx.issues.push({ path: '$.testPoints', message: 'v3 文件必须声明至少一个测试点' })
  }
  if (ctx.issues.length > 0 || id === undefined || name === undefined || target === undefined || cases === undefined
    || (raw.hooks !== undefined && hooks === undefined)
    || (raw.testPoints !== undefined && testPoints === undefined)) {
    return { ok: false, issues: ctx.issues }
  }
  return {
    ok: true,
    spec: {
      kind: TEST_SPEC_KIND,
      version,
      id,
      name,
      target,
      ...(hooks ? { hooks } : {}),
      ...(testPoints ? { testPoints } : {}),
      cases,
    },
  }
}
