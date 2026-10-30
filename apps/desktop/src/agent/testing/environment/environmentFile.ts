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
/** v2 增量：自定义大写变量（多服务端点）、`secretOrigins` 白名单与多服务就绪探针。 */
export const ENVIRONMENT_FILE_VERSION = 2 as const
export const SUPPORTED_ENVIRONMENT_FILE_VERSIONS = [1, 2] as const
export type EnvironmentFileVersion = (typeof SUPPORTED_ENVIRONMENT_FILE_VERSIONS)[number]

/** v1 档仅允许的两个逻辑变量名；v2 起开放任意大写标识符（见 {@link ENV_VAR_NAME_PATTERN}）。 */
export const ENVIRONMENT_VARIABLE_NAMES = ['WEB_BASE_URL', 'API_BASE_URL'] as const
export type EnvironmentVariableName = (typeof ENVIRONMENT_VARIABLE_NAMES)[number]

/** v2 自定义变量名：与 spec `${env.NAME}` 的 NAME 形状一致（Rust 侧同判据）。 */
const ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

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

/**
 * v2 多服务就绪探针：多服务拓扑里「就绪」是**每个服务都就绪**——控制面活了但数据面
 * 没起来时照样跑不了用例。`var` 指向 `vars` 里声明的服务地址（缺省 `API_BASE_URL`），
 * 路径相对该地址解析。
 */
export interface EnvironmentServiceProbe extends EnvironmentProbe {
  /** 目标服务地址的变量名；必须已在本档 `vars` 中声明。 */
  var: string
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
  /** 接口就绪探针；缺省 GET `/` 期望 200。v1 兼容形态（相对 API_BASE_URL）。 */
  probe?: EnvironmentProbe
  /** v2：多服务探针清单，全部通过才算就绪；与 `probe` 互斥。 */
  probes?: readonly EnvironmentServiceProbe[]
}

export interface EnvironmentFile {
  kind: typeof ENVIRONMENT_FILE_KIND
  version: EnvironmentFileVersion
  /** 环境记录 ID：导入时直接复用，因此重复导入同一份档会更新同一条环境。 */
  id: string
  name: string
  mode: EnvironmentMode
  /**
   * v1 只允许 {@link ENVIRONMENT_VARIABLE_NAMES}；v2 起开放任意大写标识符——多服务
   * 拓扑的每个端点一个变量（`SERVER_BASE_URL` / `DETECTOR_MGMT_URL` / …）。
   * `API_BASE_URL` 仍是缺省探针目标与相对路径基址。
   */
  vars: Readonly<Record<string, string>>
  viewport?: { width: number; height: number }
  headers: Readonly<Record<string, string>>
  allowPrivateNetwork: boolean
  /** 允许引用的 Secret **名**（`apitest.*`），值不在这里。 */
  secretNames: readonly string[]
  /**
   * v2：Secret 允许发往的额外 origin 白名单（`http(s)://host[:port]`）。多服务拓扑里
   * 数据面/管理面各有凭据；不在这里声明的 origin 依旧只能走 API Base URL 同源边界。
   */
  secretOrigins?: readonly string[]
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
  maxVars: 64,
  maxSecretOrigins: 16,
  maxProbes: 8,
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
  version: EnvironmentFileVersion
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return issue(ctx, path, '必须是对象')
  }
  const vars: Record<string, string> = {}
  let valid = true
  for (const name of Object.keys(value as Record<string, unknown>)) {
    // v1 只认两个保留名（fail-closed：出现自定义名要报「升版本」而不是静默接受）；
    // v2 开放任意大写标识符（多服务端点，如 DETECTOR_MGMT_URL）。
    const nameValid = ctx.version >= 2
      ? ENV_VAR_NAME_PATTERN.test(name)
      : (ENVIRONMENT_VARIABLE_NAMES as readonly string[]).includes(name)
    if (!nameValid) {
      issue(
        ctx,
        `${path}.${name}`,
        ctx.version >= 2
          ? '变量名必须是大写字母开头，仅含大写字母、数字与下划线，长度 1–64'
          : `v1 档只允许 ${ENVIRONMENT_VARIABLE_NAMES.join('/')}；自定义变量请把 version 升到 2`,
      )
      valid = false
      continue
    }
    const text = readText(ctx, (value as Record<string, unknown>)[name], `${path}.${name}`, ENVIRONMENT_FILE_LIMITS.maxStringLength)
    if (text === undefined) valid = false
    else vars[name] = text
  }
  if (Object.keys(vars).length > ENVIRONMENT_FILE_LIMITS.maxVars) {
    issue(ctx, path, `变量数量不能超过 ${ENVIRONMENT_FILE_LIMITS.maxVars}`)
    return undefined
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

/** v2：Secret 目标白名单条目必须是严格 origin（无路径/查询/凭据），Rust 侧同判据。 */
const readSecretOrigins: Reader<readonly string[]> = (ctx, value, path) => {
  const origins = readStringList(ctx, value, path, ENVIRONMENT_FILE_LIMITS.maxSecretOrigins, true)
  if (origins === undefined) return undefined
  let valid = true
  origins.forEach((origin, index) => {
    let parsed: URL | null = null
    try {
      parsed = new URL(origin)
    } catch {
      parsed = null
    }
    const shapeValid = parsed !== null
      && parsed.username === ''
      && parsed.password === ''
      && (parsed.pathname === '/' || parsed.pathname === '')
      && parsed.search === ''
      && parsed.hash === ''
    if (!shapeValid) {
      issue(ctx, `${path}[${index}]`, 'Secret 目标必须是 origin（http(s)://host[:port]），不能带路径、查询或凭据')
      valid = false
    }
  })
  return valid ? [...new Set(origins)].sort() : undefined
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
/** v2 多服务探针：带 `var` 指向的服务级探针（其余字段与单探针同构）。 */
const readServiceProbe: Reader<EnvironmentServiceProbe> = (ctx, value, path) => {
  const record = readRecord(ctx, value, path, ['var', 'method', 'path', 'expectStatus'])
  if (!record) return undefined
  const target = record.var === undefined
    ? 'API_BASE_URL'
    : typeof record.var === 'string' && ENV_VAR_NAME_PATTERN.test(record.var)
      ? record.var
      : issue(ctx, `${path}.var`, 'var 必须是已在 vars 中声明的变量名')
  // 只把探针字段交给单探针读取器：`var` 是服务级扩展，整体传进去会触发「未知字段」。
  const base = readProbe(ctx, {
    method: record.method,
    path: record.path,
    expectStatus: record.expectStatus,
  }, path)
  if (target === undefined || base === undefined) return undefined
  return { ...base, var: target }
}
const readList = <T>(
  ctx: Ctx,
  value: unknown,
  path: string,
  bounds: { min: number; max: number },
  read: (ctx: Ctx, value: unknown, path: string) => T | undefined,
): T[] | undefined => {
  if (!Array.isArray(value)) return issue(ctx, path, '必须是数组')
  if (value.length < bounds.min || value.length > bounds.max) {
    return issue(ctx, path, `数量必须在 ${bounds.min} 到 ${bounds.max} 之间`)
  }
  const items: T[] = []
  let valid = true
  value.forEach((item, index) => {
    const parsed = read(ctx, item, `${path}[${index}]`)
    if (parsed === undefined) valid = false
    else items.push(parsed)
  })
  return valid ? items : undefined
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
  const ctx: Ctx = { issues: [], version: 2 }
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
  const record = readRecord(ctx, value, path, ['start', 'stop', 'readiness', 'timeoutMs', 'probe', 'probes'])
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
  let probes: readonly EnvironmentServiceProbe[] | undefined
  if (record.probes !== undefined) {
    if (ctx.version < 2) {
      issue(ctx, `${path}.probes`, '多服务探针是 v2 增量；请把 version 升到 2')
    } else {
      const list = readList(ctx, record.probes, `${path}.probes`, { min: 1, max: ENVIRONMENT_FILE_LIMITS.maxProbes }, readServiceProbe)
      if (list !== undefined) probes = list
    }
  }
  if (record.probe !== undefined && record.probes !== undefined) {
    issue(ctx, path, 'probe 与 probes 互斥：多服务形态请只用 probes')
  }
  if (start === undefined || stop === undefined || readiness === undefined || timeoutMs === undefined) {
    return undefined
  }
  if (record.probe !== undefined && probe === undefined) return undefined
  if (record.probes !== undefined && probes === undefined) return undefined
  if (start.length === 0 && readiness.length === 0) {
    return issue(ctx, path, '配方至少要给出启动命令或就绪命令')
  }
  return {
    start,
    stop,
    readiness,
    timeoutMs,
    ...(probe ? { probe } : {}),
    ...(probes ? { probes } : {}),
  }
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
  const supported = SUPPORTED_ENVIRONMENT_FILE_VERSIONS as readonly number[]
  if (typeof document.version !== 'number' || !supported.includes(document.version)) {
    return {
      ok: false,
      issues: [{ path: '$.version', message: `不支持的版本，当前支持 ${SUPPORTED_ENVIRONMENT_FILE_VERSIONS.join(' / ')}` }],
    }
  }
  const version = document.version as EnvironmentFileVersion

  const ctx: Ctx = { issues: [], version }
  const record = readRecord(ctx, document, '$', [
    'kind', 'version', 'id', 'name', 'mode', 'vars', 'viewport', 'headers',
    'allowPrivateNetwork', 'secretNames', 'secretOrigins', 'recipe',
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
  let secretOrigins: readonly string[] | undefined
  if (document.secretOrigins !== undefined) {
    if (version < 2) {
      issue(ctx, '$.secretOrigins', 'secretOrigins 是 v2 增量；请把 version 升到 2')
    } else {
      secretOrigins = readSecretOrigins(ctx, document.secretOrigins, '$.secretOrigins')
    }
  }
  const recipe = document.recipe === undefined ? undefined : readRecipe(ctx, document.recipe, '$.recipe')

  // 多服务探针的 var 必须指向本档已声明的变量：指向不存在的服务地址只能得到
  // 永远 not_ready 的探针，错误应在导入时暴露。同一个服务只允许一条探针——步骤 ID
  // 与审批 actor 按 var 派生，重复会让两个探针共用同一个 ID。
  if (recipe?.probes !== undefined && vars !== undefined) {
    const seenProbeVars = new Set<string>()
    for (const [index, probe] of recipe.probes.entries()) {
      if (vars[probe.var] === undefined) {
        issue(ctx, `$.recipe.probes[${index}].var`, `探针指向的变量「${probe.var}」未在 vars 中声明`)
      } else if (seenProbeVars.has(probe.var)) {
        issue(ctx, `$.recipe.probes[${index}].var`, `服务「${probe.var}」已有探针，不要重复声明`)
      }
      seenProbeVars.add(probe.var)
    }
  }

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
    || (document.secretOrigins !== undefined && secretOrigins === undefined)
    || (document.recipe !== undefined && recipe === undefined)) {
    return { ok: false, issues: ctx.issues }
  }

  return {
    ok: true,
    file: {
      kind: ENVIRONMENT_FILE_KIND,
      version,
      id,
      name,
      mode,
      vars,
      ...(viewport ? { viewport } : {}),
      headers,
      allowPrivateNetwork,
      secretNames,
      ...(secretOrigins ? { secretOrigins } : {}),
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
  /** v2：自定义大写变量（排除两个保留名）与 Secret 额外 origin 白名单。 */
  extraVarsJson?: string
  secretOriginsJson?: string
}

export const environmentRecordDraftFromFile = (file: EnvironmentFile): EnvironmentRecordDraft => {
  const { WEB_BASE_URL: webBaseUrl, API_BASE_URL: apiBaseUrl, ...extraVars } = file.vars
  const extraEntries = Object.entries(extraVars)
  return {
    id: file.id,
    name: file.name,
    kind: file.mode,
    recipeJson: file.recipe ? JSON.stringify(file.recipe) : null,
    ...(webBaseUrl === undefined ? {} : { webBaseUrl }),
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
    ...(file.viewport ? { viewportWidth: file.viewport.width, viewportHeight: file.viewport.height } : {}),
    allowPrivateNetwork: file.allowPrivateNetwork,
    headersJson: JSON.stringify(file.headers),
    secretIdsJson: JSON.stringify([...file.secretNames].sort()),
    ...(extraEntries.length > 0
      ? { extraVarsJson: JSON.stringify(Object.fromEntries(extraEntries.sort(([a], [b]) => a.localeCompare(b)))) }
      : {}),
    ...(file.secretOrigins && file.secretOrigins.length > 0
      ? { secretOriginsJson: JSON.stringify(file.secretOrigins) }
      : {}),
  }
}
