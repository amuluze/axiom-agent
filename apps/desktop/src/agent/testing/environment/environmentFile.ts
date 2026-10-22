/**
 * 可版本化的测试环境档：`tests/environments/<name>.env.ax`。
 *
 * 分工与安全边界（对齐 safeline「结构事实进文件、凭据进环境变量」的做法）：
 * - **进文件**：逻辑变量、视口、非敏感 Header、是否允许回环/私网、允许的 Secret **名**、
 *   以及本地档的起停/就绪配方。这些都是可以进版本控制、团队成员共享的结构事实。
 * - **绝不进文件**：Secret 明文、宿主绝对路径（`/Users/...`）、目标产品产生的运行期事实。
 *   需要凭据时写 Secret 引用名（`apitest.*`），明文仍只由 Rust 侧注入。
 *
 * 两类环境（对应 `test_environments.kind`）：
 * - `local`：Axiom 按配方起停，因此**必须有就绪判据**，且必须能给出一条真实接口（第 3 级
 *   探针要真打一次接口；只有端口通不算就绪）。
 * - `remote`：只做只读校验，**不得**声明起停命令——共享环境上不该有 Axiom 发起的重启。
 *
 * 文件命名后缀刻意用 `.env.ax`：与 `*.testspec.json` 同构（后缀与顶层 discriminator 一致），
 * 扫描器因此永远不会误收旁落文件。
 *
 * 本模块是纯函数：不做 I/O、不认识文件系统，只把一段文本判成「合法环境档」或问题清单。
 */

import type { ApiMethod } from '../spec/types'
import { TEST_SPEC_API_METHODS } from '../spec/types'
import { containsPlaintextCredential } from '../credentialPolicy'

export const ENVIRONMENT_FILE_KIND = 'axiom.test-env' as const
export const ENVIRONMENT_FILE_VERSION = 1 as const

/** 环境档里唯一允许出现的两个逻辑变量名（与运行期投影 `testEnvironmentRuntimeConfig` 一一对应）。 */
export const ENVIRONMENT_VARIABLE_NAMES = ['WEB_BASE_URL', 'API_BASE_URL'] as const
export type EnvironmentVariableName = (typeof ENVIRONMENT_VARIABLE_NAMES)[number]

export type EnvironmentMode = 'local' | 'remote'

/**
 * 声明式就绪探针：**就绪必须由客观事实判定**，所以「什么算就绪」写在档里而不是代码里。
 * 缺省 `GET ${API_BASE_URL}/` 期望 200；产品把健康检查放在别处就显式声明。
 */
export interface EnvironmentProbe {
  method: ApiMethod
  /** 相对 `API_BASE_URL` 的路径，必须以 `/` 开头。 */
  path: string
  /** 期望状态码集合：命中即就绪；未命中时探针会报出实际状态码。 */
  expectStatus: readonly number[]
}

export interface EnvironmentRecipe {
  /** 启动命令，按顺序执行。 */
  start: readonly string[]
  /** 停止命令，按顺序执行。 */
  stop: readonly string[]
  /** 就绪探针命令：全部成功才算「命令级就绪」（第 1/2 级）。 */
  readiness: readonly string[]
  /** 单条命令与整体预算（毫秒）；同时作为接口探针的步骤超时预算。 */
  timeoutMs: number
  /** 接口就绪探针；缺省 GET `/` 期望 200。 */
  probe?: EnvironmentProbe
}

export interface EnvironmentFile {
  kind: typeof ENVIRONMENT_FILE_KIND
  version: typeof ENVIRONMENT_FILE_VERSION
  /** 环境记录 ID：导入时直接复用，因此重复导入同一份档会更新同一条环境。 */
  id: string
  name: string
  mode: EnvironmentMode
  /** 只允许 {@link ENVIRONMENT_VARIABLE_NAMES}；`API_BASE_URL` 是第 3 级探针的目标。 */
  vars: Partial<Record<EnvironmentVariableName, string>>
  viewport?: { width: number; height: number }
  headers: Readonly<Record<string, string>>
  allowPrivateNetwork: boolean
  /** 允许引用的 Secret **名**（`apitest.*`），值不在这里。 */
  secretNames: readonly string[]
  recipe?: EnvironmentRecipe
}

export interface EnvironmentFileIssue {
  path: string
  message: string
}

export type ParseEnvironmentFileResult =
  | { ok: true; file: EnvironmentFile }
  | { ok: false; issues: EnvironmentFileIssue[] }

export const ENVIRONMENT_FILE_LIMITS = {
  maxIdLength: 64,
  maxNameLength: 120,
  maxStringLength: 4096,
  maxHeaders: 64,
  maxHeaderNameLength: 128,
  maxHeaderValueLength: 4096,
  maxSecretNames: 64,
  maxRecipeCommands: 32,
  maxTimeoutMs: 1_800_000,
} as const

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const SECRET_ID_PATTERN = /^apitest\.[a-z0-9][a-z0-9._-]{0,127}$/
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/
/** 与 Rust 侧 `validate_test_environment` 的拒绝名单逐字一致。 */
const SENSITIVE_HEADER_NAMES = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key'])
/** 宿主绝对路径：把「我这台机器」的位置写进可版本控制文件，换台机器就失效。 */
const HOST_PATH_PATTERN = /^(?:\/Users\/|\/home\/|\/var\/folders\/|\/private\/var\/|[A-Za-z]:\\)/u

interface Ctx {
  issues: EnvironmentFileIssue[]
}

type Reader<T> = (ctx: Ctx, value: unknown, path: string) => T | undefined

const issue = (ctx: Ctx, path: string, message: string): undefined => {
  ctx.issues.push({ path, message })
  return undefined
}

/**
 * 对象必须只包含声明字段（fail-closed），错误按源文件键顺序稳定输出。
 * 边界处的对象判别就地写：这里不引入可复用的 `Record` 守卫——「是个对象」并不证明
 * 任何字段，字段级契约一律由下面的 reader 逐个校验。
 */
const readRecord = (
  ctx: Ctx,
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return issue(ctx, path, '必须是对象')
  const record = value as Record<string, unknown>
  let valid = true
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      issue(ctx, `${path}.${key}`, `未知字段「${key}」`)
      valid = false
    }
  }
  // 未知字段视为整块非法：只报「未知字段」而不让后续判断（缺 API_BASE_URL、缺就绪命令
  // 之类）再叠一条误导性的错误，用户按提示改一处即可。
  return valid ? record : undefined
}

/**
 * 所有字符串值的统一体检：明文凭据与宿主绝对路径都在这里拦下。
 * 规则保持窄口径（显式前缀 + 少量宿主路径前缀），避免把合法命令里的系统路径误判。
 */
const readText = (
  ctx: Ctx,
  value: unknown,
  path: string,
  maxLength: number,
  allowEmpty = false,
): string | undefined => {
  if (typeof value !== 'string') return issue(ctx, path, '必须是字符串')
  if (!allowEmpty && value.trim() === '') return issue(ctx, path, '不能为空')
  if (value.length > maxLength) return issue(ctx, path, `长度不能超过 ${maxLength} 字符`)
  if (containsPlaintextCredential(value)) {
    return issue(ctx, path, '不允许出现明文凭据；请改用 Secret 引用（apitest.*）')
  }
  if (HOST_PATH_PATTERN.test(value)) {
    return issue(ctx, path, '不允许出现宿主绝对路径；环境档需要能在其它机器上复用')
  }
  return value
}

const readId = (ctx: Ctx, value: unknown, path: string): string | undefined => {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    return issue(ctx, path, 'ID 必须以小写字母开头，仅含小写字母、数字与连字符，长度 1–64')
  }
  return value
}

const readInteger = (ctx: Ctx, value: unknown, path: string, min: number, max: number): number | undefined => {
  if (typeof value !== 'number' || !Number.isInteger(value)) return issue(ctx, path, '必须是整数')
  if (value < min || value > max) return issue(ctx, path, `必须在 ${min} 到 ${max} 之间`)
  return value
}

const readStringList = (
  ctx: Ctx,
  value: unknown,
  path: string,
  max: number,
  allowEmpty = false,
): string[] | undefined => {
  if (!Array.isArray(value)) return issue(ctx, path, '必须是数组')
  if (!allowEmpty && value.length === 0) return issue(ctx, path, '至少需要 1 项')
  if (value.length > max) return issue(ctx, path, `不能超过 ${max} 项`)
  const items: string[] = []
  let valid = true
  value.forEach((item, index) => {
    const text = readText(ctx, item, `${path}[${index}]`, ENVIRONMENT_FILE_LIMITS.maxStringLength)
    if (text === undefined) valid = false
    else items.push(text)
  })
  return valid ? items : undefined
}

const readVariables: Reader<EnvironmentFile['vars']> = (ctx, value, path) => {
  const record = readRecord(ctx, value, path, ENVIRONMENT_VARIABLE_NAMES)
  if (!record) return undefined
  const vars: Partial<Record<EnvironmentVariableName, string>> = {}
  let valid = true
  for (const name of ENVIRONMENT_VARIABLE_NAMES) {
    if (record[name] === undefined) continue
    const text = readText(ctx, record[name], `${path}.${name}`, ENVIRONMENT_FILE_LIMITS.maxStringLength)
    if (text === undefined) valid = false
    else vars[name] = text
  }
  return valid ? vars : undefined
}

const readViewport: Reader<NonNullable<EnvironmentFile['viewport']>> = (ctx, value, path) => {
  const record = readRecord(ctx, value, path, ['width', 'height'])
  if (!record) return undefined
  const width = readInteger(ctx, record.width, `${path}.width`, 320, 3840)
  const height = readInteger(ctx, record.height, `${path}.height`, 240, 2160)
  if (width === undefined || height === undefined) return undefined
  return { width, height }
}

const readHeaders: Reader<EnvironmentFile['headers']> = (ctx, value, path) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return issue(ctx, path, '必须是对象')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > ENVIRONMENT_FILE_LIMITS.maxHeaders) {
    return issue(ctx, path, `不能超过 ${ENVIRONMENT_FILE_LIMITS.maxHeaders} 个请求头`)
  }
  const headers: Record<string, string> = {}
  let valid = true
  for (const [name, raw] of entries) {
    const headerPath = `${path}.${name}`
    if (!HEADER_NAME_PATTERN.test(name)) {
      issue(ctx, headerPath, '请求头名称无效')
      valid = false
      continue
    }
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
      issue(ctx, headerPath, '敏感请求头必须走 Secret 引用，不能写进环境档')
      valid = false
      continue
    }
    const text = readText(ctx, raw, headerPath, ENVIRONMENT_FILE_LIMITS.maxHeaderValueLength)
    if (text === undefined) valid = false
    else headers[name] = text
  }
  return valid ? headers : undefined
}

const readSecretNames: Reader<EnvironmentFile['secretNames']> = (ctx, value, path) => {
  const names = readStringList(ctx, value, path, ENVIRONMENT_FILE_LIMITS.maxSecretNames, true)
  if (names === undefined) return undefined
  let valid = true
  names.forEach((name, index) => {
    if (!SECRET_ID_PATTERN.test(name)) {
      issue(ctx, `${path}[${index}]`, '只允许写 Secret 名（apitest.*），不能写明文')
      valid = false
    }
  })
  if (!valid) return undefined
  return [...new Set(names)]
}

const readProbe: Reader<EnvironmentProbe> = (ctx, value, path) => {
  const record = readRecord(ctx, value, path, ['method', 'path', 'expectStatus'])
  if (!record) return undefined
  const method = record.method === undefined
    ? 'GET'
    : typeof record.method === 'string' && (TEST_SPEC_API_METHODS as readonly string[]).includes(record.method)
      ? (record.method as ApiMethod)
      : issue(ctx, `${path}.method`, `method 必须是 ${TEST_SPEC_API_METHODS.join('/')} 之一`)
  const probePath = record.path === undefined ? '/' : readText(ctx, record.path, `${path}.path`, 512)
  const resolvedPath = probePath !== undefined && !probePath.startsWith('/')
    ? issue(ctx, `${path}.path`, '探针路径必须以 / 开头（相对 API Base URL）')
    : probePath
  const expectStatus = record.expectStatus === undefined
    ? [200]
    : Array.isArray(record.expectStatus)
      && record.expectStatus.length > 0
      && record.expectStatus.length <= 8
      && record.expectStatus.every((status) => Number.isInteger(status) && status >= 100 && status <= 599)
      ? (record.expectStatus as number[])
      : issue(ctx, `${path}.expectStatus`, 'expectStatus 必须是 1–8 个 100–599 的整数')
  if (method === undefined || resolvedPath === undefined || expectStatus === undefined) return undefined
  return { method, path: resolvedPath, expectStatus }
}

/**
 * 从记录里的 `recipe_json` 还原配方（就绪探针用）。**复用同一个读取器**：`recipe_json`
 * 就是环境档导入时写下的那段文本，这里再写第二套校验只会让两份判定分叉。
 */
export const parseEnvironmentRecipeJson = (
  json: string,
): { ok: true; recipe: EnvironmentRecipe } | { ok: false; reason: string } => {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { ok: false, reason: '环境配方不是合法 JSON' }
  }
  const ctx: Ctx = { issues: [] }
  const recipe = readRecipe(ctx, raw, '$.recipe')
  if (recipe === undefined || ctx.issues.length > 0) {
    const first = ctx.issues[0]
    return {
      ok: false,
      reason: first === undefined ? '环境配方无效' : `环境配方无效：${first.path} ${first.message}`,
    }
  }
  return { ok: true, recipe }
}

const readRecipe: Reader<EnvironmentRecipe> = (ctx, value, path) => {
  const record = readRecord(ctx, value, path, ['start', 'stop', 'readiness', 'timeoutMs', 'probe'])
  if (!record) return undefined
  const readCommands = (name: 'start' | 'stop' | 'readiness', allowEmpty: boolean): string[] | undefined =>
    record[name] === undefined
      ? []
      : readStringList(ctx, record[name], `${path}.${name}`, ENVIRONMENT_FILE_LIMITS.maxRecipeCommands, allowEmpty)
  const start = readCommands('start', true)
  const stop = readCommands('stop', true)
  const readiness = readCommands('readiness', false)
  const timeoutMs = record.timeoutMs === undefined
    ? 120_000
    : readInteger(ctx, record.timeoutMs, `${path}.timeoutMs`, 1_000, ENVIRONMENT_FILE_LIMITS.maxTimeoutMs)
  const probe = record.probe === undefined ? undefined : readProbe(ctx, record.probe, `${path}.probe`)
  if (start === undefined || stop === undefined || readiness === undefined || timeoutMs === undefined) {
    return undefined
  }
  if (record.probe !== undefined && probe === undefined) return undefined
  if (start.length === 0 && readiness.length === 0) {
    return issue(ctx, path, '配方至少要给出启动命令或就绪命令')
  }
  return { start, stop, readiness, timeoutMs, ...(probe ? { probe } : {}) }
}

/**
 * 解析环境档文本。输入视为不可信数据；问题按遍历顺序稳定输出，便于 UI 与测试断言。
 * fail-closed：未知字段、未知版本、未知变量名、明文凭据、宿主路径都是错误而不是警告。
 */
export const parseEnvironmentFile = (source: string): ParseEnvironmentFileResult => {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return { ok: false, issues: [{ path: '$', message: 'JSON 解析失败' }] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: [{ path: '$.kind', message: `必须为 "${ENVIRONMENT_FILE_KIND}"` }] }
  }
  // 边界处一次性断言：顶层形状（对象）已就地判别，字段级契约一律由下面的 reader 逐个校验。
  const document = raw as Record<string, unknown>
  if (document.kind !== ENVIRONMENT_FILE_KIND) {
    return { ok: false, issues: [{ path: '$.kind', message: `必须为 "${ENVIRONMENT_FILE_KIND}"` }] }
  }
  if (document.version !== ENVIRONMENT_FILE_VERSION) {
    return {
      ok: false,
      issues: [{ path: '$.version', message: `不支持的版本，当前支持 ${ENVIRONMENT_FILE_VERSION}` }],
    }
  }

  const ctx: Ctx = { issues: [] }
  const record = readRecord(ctx, document, '$', [
    'kind', 'version', 'id', 'name', 'mode', 'vars', 'viewport', 'headers',
    'allowPrivateNetwork', 'secretNames', 'recipe',
  ])
  const id = readId(ctx, document.id, '$.id')
  const name = readText(ctx, document.name, '$.name', ENVIRONMENT_FILE_LIMITS.maxNameLength)
  const mode = document.mode === 'local' || document.mode === 'remote'
    ? document.mode
    : issue(ctx, '$.mode', '只允许 local 或 remote')
  const vars = document.vars === undefined ? {} : readVariables(ctx, document.vars, '$.vars')
  const viewport = document.viewport === undefined ? undefined : readViewport(ctx, document.viewport, '$.viewport')
  const headers = document.headers === undefined ? {} : readHeaders(ctx, document.headers, '$.headers')
  const allowPrivateNetwork = document.allowPrivateNetwork === undefined
    ? false
    : document.allowPrivateNetwork === true
      ? true
      : issue(ctx, '$.allowPrivateNetwork', '必须是布尔值')
  const secretNames = document.secretNames === undefined ? [] : readSecretNames(ctx, document.secretNames, '$.secretNames')
  const recipe = document.recipe === undefined ? undefined : readRecipe(ctx, document.recipe, '$.recipe')

  if (mode === 'local') {
    // 起停与就绪判据是 local 档的全部意义；缺了就只能在共享环境上瞎点。
    if (recipe === undefined && document.recipe === undefined) {
      issue(ctx, '$.recipe', 'local 档必须给出发起停与就绪配方')
    } else if (recipe !== undefined && recipe.readiness.length === 0) {
      issue(ctx, '$.recipe.readiness', 'local 档必须给出就绪命令')
    }
    if (vars !== undefined && vars.API_BASE_URL === undefined) {
      issue(ctx, '$.vars.API_BASE_URL', 'local 档必须给出真实接口地址（第 3 级探针要真打一次接口）')
    }
  }
  if (mode === 'remote' && recipe !== undefined) {
    if (recipe.start.length > 0) issue(ctx, '$.recipe.start', 'remote 档不得声明启动命令（共享环境只做只读校验）')
    if (recipe.stop.length > 0) issue(ctx, '$.recipe.stop', 'remote 档不得声明停止命令（共享环境只做只读校验）')
  }

  if (ctx.issues.length > 0 || record === undefined || id === undefined || name === undefined
    || mode === undefined || vars === undefined || headers === undefined || secretNames === undefined
    || allowPrivateNetwork === undefined || (document.viewport !== undefined && viewport === undefined)
    || (document.recipe !== undefined && recipe === undefined)) {
    return { ok: false, issues: ctx.issues }
  }

  return {
    ok: true,
    file: {
      kind: ENVIRONMENT_FILE_KIND,
      version: ENVIRONMENT_FILE_VERSION,
      id,
      name,
      mode,
      vars,
      ...(viewport ? { viewport } : {}),
      headers,
      allowPrivateNetwork,
      secretNames,
      ...(recipe ? { recipe } : {}),
    },
  }
}

/** 环境档 → 运行环境记录的可存储形态（导入路径唯一的映射点，避免两处各自拼字段）。 */
export interface EnvironmentRecordDraft {
  id: string
  name: string
  kind: EnvironmentMode
  recipeJson: string | null
  webBaseUrl?: string
  apiBaseUrl?: string
  viewportWidth?: number
  viewportHeight?: number
  allowPrivateNetwork: boolean
  headersJson: string
  secretIdsJson: string
}

export const environmentRecordDraftFromFile = (file: EnvironmentFile): EnvironmentRecordDraft => ({
  id: file.id,
  name: file.name,
  kind: file.mode,
  recipeJson: file.recipe ? JSON.stringify(file.recipe) : null,
  ...(file.vars.WEB_BASE_URL === undefined ? {} : { webBaseUrl: file.vars.WEB_BASE_URL }),
  ...(file.vars.API_BASE_URL === undefined ? {} : { apiBaseUrl: file.vars.API_BASE_URL }),
  ...(file.viewport ? { viewportWidth: file.viewport.width, viewportHeight: file.viewport.height } : {}),
  allowPrivateNetwork: file.allowPrivateNetwork,
  headersJson: JSON.stringify(file.headers),
  secretIdsJson: JSON.stringify([...file.secretNames].sort()),
})
