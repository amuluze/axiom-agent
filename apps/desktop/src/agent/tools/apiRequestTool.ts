import type { AgentTool, AgentToolResult, JsonValue } from '../core/types'
import type { AgentEnvironment, ApiTestStepResult } from '@/agent/environment/AgentEnvironment'
import type { TestAutomationPolicy } from '@/config/runtimePolicy'
import { byteLength } from '@/agent/core/bytes'
import { describeApiTestStepApproval } from '@/agent/testing/approval/testStepApproval'
import type { ApiMethod, ApiStepSpec, SecretReference } from '@/agent/testing/spec/types'
import { hasOnlyKeys, isJsonObject, optionalInteger } from './workspaceToolUtils'

/**
 * `api_request`：把「发一个 API 测试步骤」接到 A1 Rust API Driver 上（G1-4）。
 *
 * 本工具**不实现第二套 HTTP 客户端**：请求组装、DNS/地址判定、Secret 注入、重定向策略、
 * 取消与脱敏证据全部由 Rust `issue_api_test_step_lease` / `run_api_test_step` /
 * `cancel_api_test_run` 权威执行，Agent 层只做参数快速失败与结果映射。因此这里的所有上限
 * 与名单都是 Rust 常量的**调用前镜像**（镜像只用于少走一轮注定失败的审批，权威判定仍在 Rust）。
 */

/** 镜像 Rust `api_test_policy.rs::MAX_API_URL_BYTES`。 */
export const MAX_API_URL_CHARS = 4096

/** 镜像 Rust `api_test.rs::MAX_TIMEOUT_MS`（0 与超上限都会被拒绝，默认 30000）。 */
export const MAX_API_TIMEOUT_MS = 120_000

/** 镜像 Rust `api_test.rs::MAX_REQUEST_BODY_BYTES`。 */
export const MAX_API_REQUEST_BODY_BYTES = 256 * 1024

/** 镜像 Rust `validate_action` 的字段数量上限（query / headers / form 各 64）。 */
export const MAX_API_ENTRIES = 64

/** 单个名称与值的字符上限（防止超长参数顶穿工具参数预算）。 */
const MAX_API_NAME_CHARS = 256
const MAX_API_VALUE_CHARS = 4096

/** Secret 引用 id 是短标识（`apitest.*`），不是自由文本。 */
const MAX_SECRET_ID_CHARS = 200

const MAX_ENVIRONMENT_ID_CHARS = 200

/** 宿主支持的方法表（Rust `validate_action` 同集）；键序也是 schema enum 的顺序。 */
const API_METHOD_TABLE: Record<string, true> = {
  GET: true, HEAD: true, POST: true, PUT: true, PATCH: true, DELETE: true, OPTIONS: true,
}

/** 允许携带请求体的方法（Rust 对其它方法带 body 直接拒绝）。 */
const BODY_METHOD_TABLE: Record<string, true> = { POST: true, PUT: true, PATCH: true, DELETE: true }

const BODY_MODE_TABLE: Record<string, true> = { json: true, text: true, form: true }
const REDIRECT_TABLE: Record<string, true> = { manual: true, 'same-origin': true }

/**
 * 表内命中即收窄成 `ApiMethod`：`Record<string, true>` 的成员判定不参与联合收窄，
 * 故显式声明为类型守卫（而不是在调用点断言）。
 */
const isApiMethod = (value: string): value is ApiMethod => Object.hasOwn(API_METHOD_TABLE, value)

/**
 * 敏感请求头的快速失败镜像（Rust `is_sensitive_header`）：这些名字**必须**走 Secret 引用，
 * 内联明文会被宿主拒绝。镜像只提前给出同样的结论，避免白跑一次审批。
 */
const SENSITIVE_HEADER_TABLE: Record<string, true> = {
  authorization: true,
  'proxy-authorization': true,
  cookie: true,
  'set-cookie': true,
  'x-api-key': true,
}

/** 由宿主设置的请求头（Rust `is_forbidden_request_header`，模型不得提供）。 */
const FORBIDDEN_HEADER_TABLE: Record<string, true> = {
  host: true, 'content-length': true, 'transfer-encoding': true, connection: true,
}

/** RFC 7230 token：镜像 Rust `HeaderName::from_bytes`（权威校验仍在 Rust）。 */
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u

/** 镜像 Rust `api_test_policy.rs` 的私网拒绝文案：用于把策略拒绝讲成可操作的下一步。 */
const PRIVATE_NETWORK_BLOCKED_MARKER = '未授权访问回环或私网地址'

const API_INPUT_KEYS = [
  'method', 'url', 'query', 'headers', 'body', 'bodyMode', 'timeoutMs', 'redirect', 'environmentId',
]

interface ApiRequestInput {
  method: ApiMethod
  url: string
  query?: Record<string, string | number | boolean | null>
  headers?: Record<string, string | SecretReference>
  body?: JsonValue
  bodyMode?: 'json' | 'text' | 'form'
  timeoutMs?: number
  redirect?: 'manual' | 'same-origin'
  environmentId?: string
}

/** 输入里的标量（`null` 是合法 JSON 标量，也是合法查询参数值）。 */
const isScalar = (value: JsonValue): value is string | number | boolean | null =>
  value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const readQuery = (value: JsonValue): ApiRequestInput['query'] => {
  if (!isJsonObject(value)) return undefined
  const query: Record<string, string | number | boolean | null> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (isScalar(entry)) query[name] = entry
  }
  return query
}

const readHeaders = (value: JsonValue): ApiRequestInput['headers'] => {
  if (!isJsonObject(value)) return undefined
  const headers: Record<string, string | SecretReference> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string') headers[name] = entry
    else if (isJsonObject(entry) && typeof entry.secretId === 'string') {
      headers[name] = { secretId: entry.secretId }
    }
  }
  return headers
}

/**
 * 读取（已通过 `validate` 的）参数并收窄成领域形状：非法项被丢弃而不是抛错（`validate`
 * 已拒绝过它们），形状完全不符才视为内部契约违背。这样 `execute`/`approvalPresentation`
 * 不需要对模型输入做类型断言。
 */
const asApiRequestInput = (input: JsonValue): ApiRequestInput => {
  if (!isJsonObject(input)) throw new Error('Invalid api_request arguments.')
  const { method, url } = input
  if (typeof method !== 'string' || typeof url !== 'string') {
    throw new Error('Invalid api_request arguments.')
  }
  const normalizedMethod = method.trim().toUpperCase()
  if (!isApiMethod(normalizedMethod)) {
    throw new Error('Invalid api_request arguments.')
  }
  const { body } = input
  return {
    method: normalizedMethod,
    url,
    ...(input.query === undefined ? {} : { query: readQuery(input.query) }),
    ...(input.headers === undefined ? {} : { headers: readHeaders(input.headers) }),
    ...(body === undefined ? {} : { body }),
    ...(input.bodyMode === 'json' || input.bodyMode === 'text' || input.bodyMode === 'form'
      ? { bodyMode: input.bodyMode }
      : {}),
    ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.redirect === 'manual' || input.redirect === 'same-origin' ? { redirect: input.redirect } : {}),
    ...(typeof input.environmentId === 'string' ? { environmentId: input.environmentId } : {}),
  }
}

const validateUrl = (value: JsonValue | undefined): string | null => {
  if (typeof value !== 'string' || !value.trim()) return 'url must be a non-empty string.'
  if (value.length > MAX_API_URL_CHARS) return `url must be at most ${MAX_API_URL_CHARS} chars.`
  // fragment 与内嵌凭据都由 Rust `parse_api_url` 拒绝（请求目标必须显式可读）。
  if (value.includes('#')) return 'url must not contain a fragment (#...).'
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return 'url must be an absolute URL (e.g. https://api.example.com/v1/orders).'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `url must use the http or https scheme (got ${parsed.protocol.replace(':', '')}).`
  }
  if (parsed.username || parsed.password) return 'url must not carry userinfo credentials.'
  return null
}

const EXTERNAL_TARGET_BLOCKED_HINT = '外部 HTTPS 测试环境需在内测档启用'
const LOCAL_HOSTNAME_SUFFIXES = ['.localhost', '.local']

/**
 * 开发档的「本地目标」口径：镜像 Rust `network_policy.rs::is_allowed_plain_http_host` 的
 * **回环/本地主机名子集**——`localhost`、`*.localhost`、`*.local`（mDNS）与回环 IP 字面量
 * （`127.0.0.0/8`、`::1`）。私网字面量（RFC1918/链路本地）、未指定 `0.0.0.0` 与 IPv6 折算
 * 形式（`::ffff:127.0.0.1` 等）**不在**本口径内：它们属于 Rust 私网授权门的语义，开发档
 * （仅本地 loopback）一律拒绝。少放行只会多拒、不会错放，故不复制 Rust 的折算逻辑。
 */
const isLocalTargetHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || LOCAL_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true
  }
  if (host === '::1') return true
  const octets = host.split('.')
  if (octets.length !== 4 || octets[0] !== '127') return false
  return octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
}

/**
 * H1-5 开发档的工具门（`testAutomation.externalTargets === false`）：只放行回环/本地目标。
 * 这是**独立于 Rust 权威策略**的一层——开发 feature flag 阶段连公网 HTTPS 也不放行，
 * Rust 侧策略（私网授权、公网明文恒拒）继续对每个请求生效，二者互不替代。
 */
const validateTargetScope = (url: string, externalTargets: boolean): string | null => {
  if (externalTargets) return null
  // `validateUrl` 已确认是绝对 http(s) URL，这里的解析不会抛。
  const { hostname } = new URL(url)
  const host = hostname.replace(/^\[|\]$/gu, '')
  if (isLocalTargetHost(host)) return null
  return `开发档（feature flag）只允许访问本地回环目标，${hostname} 是外部/公网主机：`
    + `${EXTERNAL_TARGET_BLOCKED_HINT}。本地开发请改用回环地址`
    + '（localhost / 127.0.0.1 / [::1] / *.local）或本地 fixture 服务；不要改用 IP 直连、代理绕过。'
}

const validateQuery = (value: JsonValue | undefined): string | null => {
  if (value === undefined) return null
  if (!isJsonObject(value)) return 'query must be an object of scalar values.'
  const entries = Object.entries(value)
  if (entries.length > MAX_API_ENTRIES) return `query must have at most ${MAX_API_ENTRIES} entries.`
  for (const [name, entry] of entries) {
    if (!name.trim() || name.length > MAX_API_NAME_CHARS) {
      return `query parameter names must be non-empty and at most ${MAX_API_NAME_CHARS} chars.`
    }
    if (!isScalar(entry)) {
      return `query value for ${name} must be a string, number, boolean or null.`
    }
    if (typeof entry === 'string' && entry.length > MAX_API_VALUE_CHARS) {
      return `query value for ${name} must be at most ${MAX_API_VALUE_CHARS} chars.`
    }
  }
  return null
}

const validateHeaderEntry = (name: string, entry: JsonValue): string | null => {
  if (typeof entry === 'string') {
    if (Object.hasOwn(SENSITIVE_HEADER_TABLE, name.toLowerCase())) {
      return `sensitive header ${name} must use an apitest.* secret reference ({"secretId": "..."}), not a plain value.`
    }
    if (entry.length > MAX_API_VALUE_CHARS || /[\r\n\0]/u.test(entry)) {
      return `header ${name} value must be a single line of at most ${MAX_API_VALUE_CHARS} chars.`
    }
    return null
  }
  if (!isJsonObject(entry) || !hasOnlyKeys(entry, ['secretId'])
    || typeof entry.secretId !== 'string' || !entry.secretId.trim()
    || entry.secretId.length > MAX_SECRET_ID_CHARS) {
    return `header ${name} must be a string or a {"secretId": "apitest.*"} reference.`
  }
  return null
}

const validateHeaders = (value: JsonValue | undefined): string | null => {
  if (value === undefined) return null
  if (!isJsonObject(value)) return 'headers must be an object of strings or {"secretId": "..."} references.'
  const entries = Object.entries(value)
  if (entries.length > MAX_API_ENTRIES) return `headers must have at most ${MAX_API_ENTRIES} entries.`
  for (const [name, entry] of entries) {
    if (!HTTP_TOKEN_PATTERN.test(name) || name.length > MAX_API_NAME_CHARS) {
      return `header name ${name} is not a valid HTTP header name.`
    }
    if (Object.hasOwn(FORBIDDEN_HEADER_TABLE, name.toLowerCase())) {
      return `header ${name} is set by the host and cannot be provided.`
    }
    const entryError = validateHeaderEntry(name, entry)
    if (entryError) return entryError
  }
  return null
}

/** 请求体的调用前字节上限（与 Rust 编码结果同阶；form 的百分号编码由 Rust 权威判定）。 */
const encodedBodyBytes = (body: JsonValue, bodyMode: string | undefined): number =>
  bodyMode === 'text' && typeof body === 'string' ? byteLength(body) : byteLength(JSON.stringify(body))

const validateBody = (
  body: JsonValue | undefined,
  bodyMode: string | undefined,
  method: string,
): string | null => {
  if (body === undefined) return null
  if (!Object.hasOwn(BODY_METHOD_TABLE, method)) {
    return `body is only allowed for POST, PUT, PATCH and DELETE (method is ${method}).`
  }
  if (bodyMode === 'text' && typeof body !== 'string') {
    return 'body must be a string when bodyMode is text.'
  }
  if (bodyMode === 'form') {
    if (!isJsonObject(body)) return 'body must be a scalar object when bodyMode is form.'
    const entries = Object.entries(body)
    if (entries.length > MAX_API_ENTRIES) {
      return `form body must have at most ${MAX_API_ENTRIES} fields.`
    }
    for (const [name, entry] of entries) {
      if (!isScalar(entry)) return `form field ${name} must be a string, number, boolean or null.`
    }
  }
  if (encodedBodyBytes(body, bodyMode) > MAX_API_REQUEST_BODY_BYTES) {
    return `body must be at most ${MAX_API_REQUEST_BODY_BYTES} bytes when encoded.`
  }
  return null
}

const validateApiRequestInput = (input: JsonValue, externalTargets: boolean): string | null => {
  if (!isJsonObject(input) || !hasOnlyKeys(input, API_INPUT_KEYS)) {
    return `Arguments must be an object with only ${API_INPUT_KEYS.join(', ')}.`
  }
  const method = typeof input.method === 'string' ? input.method.trim().toUpperCase() : ''
  if (!isApiMethod(method)) {
    return `method must be one of ${Object.keys(API_METHOD_TABLE).join(', ')}.`
  }
  const urlError = validateUrl(input.url)
  if (urlError) return urlError
  if (typeof input.url === 'string') {
    const targetError = validateTargetScope(input.url, externalTargets)
    if (targetError) return targetError
  }
  if (input.bodyMode !== undefined
    && (typeof input.bodyMode !== 'string' || !Object.hasOwn(BODY_MODE_TABLE, input.bodyMode))) {
    return `bodyMode must be one of ${Object.keys(BODY_MODE_TABLE).join(', ')}.`
  }
  if (input.redirect !== undefined
    && (typeof input.redirect !== 'string' || !Object.hasOwn(REDIRECT_TABLE, input.redirect))) {
    return `redirect must be one of ${Object.keys(REDIRECT_TABLE).join(', ')}.`
  }
  if (!optionalInteger(input.timeoutMs, 1, MAX_API_TIMEOUT_MS)) {
    return `timeoutMs must be an integer between 1 and ${MAX_API_TIMEOUT_MS}.`
  }
  if (input.environmentId !== undefined
    && (typeof input.environmentId !== 'string' || !input.environmentId.trim()
      || input.environmentId.length > MAX_ENVIRONMENT_ID_CHARS)) {
    return `environmentId must be a non-empty string of at most ${MAX_ENVIRONMENT_ID_CHARS} chars.`
  }
  const bodyMode = typeof input.bodyMode === 'string' ? input.bodyMode : undefined
  return validateQuery(input.query)
    ?? validateHeaders(input.headers)
    ?? validateBody(input.body, bodyMode, method)
}

const VERDICT_LABELS: Record<ApiTestStepResult['verdict'], string> = {
  passed: 'passed（宿主判定通过）',
  failed: 'failed（宿主判定断言未通过）',
  not_evaluated: 'not_evaluated（未评估：没有可用于判定的响应）',
}

const TRANSPORT_LABELS: Record<ApiTestStepResult['transport'], string> = {
  received: 'received（已收到响应）',
  timeout: 'timeout（超时）',
  blocked: 'blocked（被宿主网络策略拒绝，请求未发出）',
  network_error: 'network_error（网络层失败）',
  canceled: 'canceled（已取消）',
}

const describeScope = (request: ApiRequestInput): string =>
  request.environmentId
    ? `测试环境 ${request.environmentId}`
    : '无测试环境（不注入环境 Header、不授权任何 Secret、不授权回环/私网）'

/** 把宿主权威结果映射成可读中文摘要；正文与 Secret 永不回灌（证据是 Rust 侧脱敏 Artifact）。 */
const describeApiStepResult = (request: ApiRequestInput, result: ApiTestStepResult): string => {
  const status = result.statusCode === null ? '—' : String(result.statusCode)
  const lines = [
    `${request.method} ${request.url} → ${VERDICT_LABELS[result.verdict]}`,
    `状态码：${status} · 耗时：${result.elapsedMs} ms · transport：${TRANSPORT_LABELS[result.transport]}`,
    `宿主说明：${result.message}`,
    `执行范围：${describeScope(request)}。`,
  ]
  if (result.transport === 'blocked') {
    lines.push(
      '策略拒绝由宿主权威给出、不可绕过：公网明文 HTTP 恒拒，跨源重定向被阻止，'
      + '回环/私网地址（含 DNS 解析结果）必须先授权；这不是「接口不存在」。',
    )
  }
  if (result.message.includes(PRIVATE_NETWORK_BLOCKED_MARKER)) {
    lines.push(
      '目标解析到回环或私网地址而当前测试环境未授权私网访问：请让用户在「测试环境」面板里为该环境勾选'
      + '「允许访问回环/私网 API」（allow_private_network）后重试；不要改用 IP 直连、代理或其它地址绕过。',
    )
  }
  if (result.verdict !== 'not_evaluated') {
    lines.push(
      `证据：宿主脱敏后的请求/响应 Artifact（sha256 ${result.evidenceContentHash}），响应正文不回灌会话。`,
    )
  }
  const extractedCount = Object.keys(result.extracted).length
  if (extractedCount > 0) {
    lines.push(`另从响应中提取了 ${extractedCount} 个变量（值已交给测试运行变量表，不回灌会话）。`)
  }
  return lines.join('\n')
}

/**
 * `api_request`：经宿主 API Driver 发出一个 `api.request` 步骤（G1-4）。
 *
 * 与 UI 探索工具的分界：本工具不碰页面，发出的是**真实外网请求**。四条边界必须明写：
 * 逐次审批（`requiresApproval`，一次调用一次批准）、发布档目标门（H1-5：开发 feature flag
 * 只放行回环/本地目标，见 `testAutomation.externalTargets`）、网络策略由宿主权威执行
 * （回环/私网需环境授权，不存在绕过参数）、结果只回灌脱敏摘要（响应正文落 Artifact）。
 *
 * 目标门由 `validate` 在**审批之前**执行，故开发档里公网目标连审批卡都不会弹（不是批准后
 * 才被拒绝）；它不替代宿主策略：生产档（`externalTargets: true`）放行公网目标，但 Rust
 * 仍逐请求判定私网授权与公网明文 HTTP。
 *
 * `recoveryPolicy: 'never'`：本工具覆盖 GET…DELETE，而 POST/PUT/PATCH/DELETE 不允许自动
 * 重放（设计 §9.3），策略又是工具级静态字段、无法按 method 分化，故取安全侧——崩溃恢复不
 * 自动补发任何请求，由模型在下一轮显式重新调用（届时重新审批）。
 */
export const createApiRequestTool = (
  environment: AgentEnvironment,
  testAutomation: TestAutomationPolicy,
): AgentTool => ({
  name: 'api_request',
  label: 'api_request',
  promptSnippet: '经宿主 API Driver 发出一个 API 测试请求（探索用，逐次审批）。',
  promptGuidelines: [
    '这是探索工具，不是回归引擎：确认接口行为后请把结论写进 *.testspec.json 的 api.request 步骤固化；每次调用都要用户逐次批准，不要用循环批量打接口。',
    '凭据只能以 Secret 引用交给宿主注入（headers: {"Authorization": {"secretId": "apitest.xxx"}}）：敏感请求头（authorization/cookie/x-api-key 等）内联明文会被拒绝，未在当前环境授权的 secretId 同样会被拒绝，不要改名绕行。',
    '网络策略由宿主权威执行：公网 HTTPS 允许、公网明文 HTTP 恒拒、回环/私网地址（含 DNS 解析结果）必须先在测试环境里授权私网访问；被拒绝不等于接口不存在，不要改用 IP 直连、代理或其它地址重试。',
    '发布档还会在调用前收窄目标：开发档（feature flag）只允许本地回环目标（localhost / 127.0.0.1 / [::1] / *.local），公网目标会以可读错误被拒（外部 HTTPS 需在内测档启用）——这不是接口不存在，不要改用 IP 直连或代理绕行；本地开发请指向本地 fixture 服务。',
    '省略 environmentId 表示「无测试环境」：宿主不会注入环境 Header、不授权任何 Secret、不允许回环/私网——需要其中任何一项时都必须由用户提供测试环境 id。',
    '判定与证据都由宿主给出：非 2xx 不是工具错误（期望状态由测试文件里的断言决定），响应正文与 Secret 不回灌会话，不要凭摘要臆造响应内容。',
    '不要把密钥、令牌或用户隐私写进 url/query/body：它们会进入会话记录与审计。',
  ],
  runtimeVersion: '5',
  recoveryPolicy: 'never',
  executionMode: 'sequential',
  requiresApproval: true,
  description:
    'Send one api.request step through the host API driver (one-time lease → run → cancel on abort) '
    + 'and return the host-authoritative verdict. Per-call user approval is required, and the host '
    + 're-validates everything in Rust: public HTTPS may run, plaintext HTTP to public hosts is always '
    + 'refused, and loopback/private targets (including DNS-resolved addresses) need an explicit '
    + 'test-environment grant. The active release stage additionally narrows the target before approval: '
    + 'in the development feature-flag stage (testAutomation.externalTargets = false) only loopback/local '
    + 'hosts (localhost, 127.0.0.0/8, ::1, *.local) are accepted and external/public targets are rejected '
    + 'with a readable error — external HTTPS opens in the internal-test stage. Header values may be plain '
    + 'strings or {"secretId": "apitest.*"} references '
    + 'resolved host-side — sensitive header names must use a reference, never an inline credential. The '
    + 'response body is not returned to the session: only the redacted summary plus an evidence Artifact '
    + 'hash. Omit environmentId to run with no environment (no environment headers, no authorized secrets, '
    + 'public HTTPS only); private targets require an environment id. Non-2xx is not a tool error — the '
    + 'host computes the verdict and the model cannot override it. Exploratory only: solidify findings '
    + 'into a *.testspec.json file instead of relying on this tool for regression.',
  inputSchema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        enum: Object.keys(API_METHOD_TABLE),
        description: 'HTTP method (case-insensitive; the host accepts exactly these).',
      },
      url: {
        type: 'string',
        minLength: 1,
        description: 'Absolute http/https URL without userinfo credentials and without a fragment. '
          + `At most ${MAX_API_URL_CHARS} chars.`,
      },
      query: {
        type: 'object',
        description: 'Scalar query parameters appended to the URL by the host. '
          + `At most ${MAX_API_ENTRIES} entries.`,
      },
      headers: {
        type: 'object',
        description: 'Request headers; each value is a plain string or a host-resolved secret reference '
          + '{"secretId": "apitest.xxx"}. Sensitive names (authorization, cookie, x-api-key…) must use a '
          + `reference. At most ${MAX_API_ENTRIES} entries.`,
      },
      body: {
        description: 'Request body: any JSON value, or a string when bodyMode is "text". Only POST, PUT, '
          + `PATCH and DELETE accept a body. At most ${MAX_API_REQUEST_BODY_BYTES} bytes when encoded.`,
      },
      bodyMode: {
        type: 'string',
        enum: Object.keys(BODY_MODE_TABLE),
        description: 'How the host encodes the body: json (default), text (string body), or form '
          + '(scalar object encoded as application/x-www-form-urlencoded).',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_API_TIMEOUT_MS,
        description: `Per-request timeout in ms (default 30000, max ${MAX_API_TIMEOUT_MS}).`,
      },
      redirect: {
        type: 'string',
        enum: Object.keys(REDIRECT_TABLE),
        description: 'Redirect policy: manual (default, never follow) or same-origin (follow same-origin '
          + 'redirects only; cross-origin redirects are blocked).',
      },
      environmentId: {
        type: 'string',
        description: 'Test environment id configured for this workspace. Omit to run with no environment; '
          + 'required for environment headers, apitest.* secrets and loopback/private targets.',
      },
    },
    required: ['method', 'url'],
    additionalProperties: false,
  },
  validate: (input) => {
    const error = validateApiRequestInput(input, testAutomation.externalTargets)
    if (error || !isJsonObject(input) || typeof input.method !== 'string') {
      return { ok: false, error: error ?? 'Invalid api_request arguments.' }
    }
    // method 归一化为大写：宿主只接受上面七个大写形式，归一化省掉一轮注定失败的审批。
    return { ok: true, value: { ...input, method: input.method.trim().toUpperCase() } }
  },
  approvalPresentation: (input) => {
    const { method, url, query, headers, body, bodyMode } = asApiRequestInput(input)
    const card = describeApiTestStepApproval({ method, url })
    const scope = [
      query ? `${Object.keys(query).length} 个查询参数` : '无查询参数',
      headers ? `${Object.keys(headers).length} 个自定义请求头` : '无自定义请求头',
    ]
    if (body !== undefined) {
      scope.push(`含请求体（${encodedBodyBytes(body, bodyMode)} bytes 以内，编码后以宿主为准）`)
    }
    return {
      title: `发送 ${card.actionLabel}？`,
      description: `Axiom 将向 ${card.origin}（主机 ${card.target}）发出一次真实 API 请求：${scope.join('、')}。`
        + '地址与请求头值/请求体原文不会展示在这里；凭据必须以 apitest.* Secret 引用交给宿主注入。'
        + '网络策略由宿主权威执行（公网 HTTPS 允许、明文 HTTP 恒拒、回环/私网需测试环境授权），'
        + '响应正文不回灌会话，只写脱敏证据 Artifact。',
    }
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    const request = asApiRequestInput(input)
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const step: ApiStepSpec = {
      id: context.toolCallId,
      action: 'api.request',
      method: request.method,
      url: request.url,
      ...(request.query ? { query: request.query } : {}),
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.bodyMode ? { bodyMode: request.bodyMode } : {}),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.redirect ? { redirect: request.redirect } : {}),
    }
    const result = await environment.api.runStep({
      runId: context.runId,
      stepId: context.toolCallId,
      ...(request.environmentId ? { environmentId: request.environmentId } : {}),
      step,
    }, context.signal)
    // 只有本次 Agent run 的取消会驱动宿主取消（取消键就是上面的 runId），因此
    // canceled 且非 rejected 必然来自本次 abort：按 Runtime 的取消语义抛出。
    // 原生内容确认框的取消由平台层映射为 runnerVerdict='rejected' 的 canceled，
    // 那是用户对本次请求的拒绝，应作为工具结果返回而不是伪造 run abort。
    if (result.transport === 'canceled') {
      if (result.runnerVerdict === 'rejected') {
        return {
          content: '用户取消了本次 API 请求（原生确认）。',
          details: {
            request: { method: request.method, url: request.url },
            verdict: 'rejected',
            runnerVerdict: 'rejected',
            transport: 'canceled',
            statusCode: null,
            elapsedMs: 0,
            evidenceContentHash: null,
            extractedCount: 0,
            environmentId: request.environmentId ?? null,
          },
        }
      }
      throw new DOMException('Aborted', 'AbortError')
    }
    return {
      content: describeApiStepResult(request, result),
      details: {
        request: { method: request.method, url: request.url },
        verdict: result.verdict,
        runnerVerdict: result.runnerVerdict,
        transport: result.transport,
        statusCode: result.statusCode,
        elapsedMs: result.elapsedMs,
        evidenceContentHash: result.evidenceContentHash,
        extractedCount: Object.keys(result.extracted).length,
        environmentId: request.environmentId ?? null,
      },
    }
  },
})
