/**
 * `tests/*.testspec.json` 协议的领域类型。文件只保存稳定 Locator、逻辑环境、逻辑变量与
 * typed 断言；tabId、AX ref、坐标、宿主绝对路径与 Secret 明文一律不属于这里的任何字段。
 *
 * 协议版本：v1 是最初契约；v2 增量加入测试点（`testPoints`）、用例到测试点的追溯
 * （`cases[].verifies`）与运行占位符 `${run.id}` / `${run.slug}`；v3 起 `testPoints`
 * 从可选变为必填（至少一个），让新文件的覆盖统计始终有分母。v1/v2 文件永久可读且
 * 不被改写（解析结果保留源版本），新文件与固化产物写 {@link TEST_SPEC_VERSION}。
 */

export const TEST_SPEC_KIND = 'axiom.test' as const

/**
 * 当前协议版本：新文件与固化产物写这个版本。
 *
 * v4 增量（多服务拓扑支持）：API 步骤的 `virtualHost`（Host 头覆盖）、`api.poll`
 * （显式轮询等待最终一致）、`api.delay`（跨时序边界的小睡）与五个新断言变体。
 * v5 增量（数据驱动）：`cases[].inputs` 数据行——同一用例按行展开，行内值以
 * `${vars.name}` 在步骤里引用（case 变量表在开始时预置）。
 * v6 增量（运行时凭据）：敏感请求头可用 `{ variable, prefix? }` 引用同 case 内
 * `sensitive: true` 的抽取（登录拿到的短期令牌直接用于后续 Bearer 头）。
 * v7 增量（条件清理）：步骤可用 `whenProduced` 在变量未产出时跳过（条件清理），
 * 断言新增 `statusIn`（多状态码任一命中）。
 * v8 增量（负断言）：`bodyNotContains`——响应正文不得包含给定文本（凭据泄漏、
 * 删除后消失等契约断言）。
 * v9 增量（fixture 文件引用）：JSON 请求体里的 `{ "file": "tests/fixtures/x.pem" }`
 * 由宿主在运行准备期读入工作区文件并替换为内容（证书/密钥等文本夹具）。
 * v1–v8 文件永久可读；新版本字段出现在旧版本文件里是解析错误。
 */
export const TEST_SPEC_VERSION = 9 as const

/**
 * 解析器接受的版本集合。v1/v2 必须长期保留——用户工作区里的既有文件不能因为产品升级
 * 就变成「需要修复」；版本号与接受面的绑定由 contracts/test-spec-version.json 守门。
 */
export const SUPPORTED_TEST_SPEC_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const
export type TestSpecVersion = (typeof SUPPORTED_TEST_SPEC_VERSIONS)[number]

export type TestValue = string | number | boolean | null

export interface ExtractedTestValue {
  value: TestValue
  sensitive: boolean
}

export interface ApiExtraction {
  jsonPointer?: string
  header?: string
  sensitive?: boolean
}

export interface UiExtraction {
  source: 'text' | 'value'
  sensitive?: boolean
}

/** Secret 只能经此引用进入请求头，明文由 Rust 在发请求前注入。 */
export interface SecretReference {
  secretId: string
}

/**
 * v6：运行时凭据引用。`variable` 必须由同 case 作用域内 `sensitive: true` 的抽取生产
 * （登录令牌等短期凭据），`prefix` 是纯字面前缀（如 `Bearer `）。值由 Runner 从变量表
 * 取出、随步骤请求交给 Rust 注入，证据按凭据脱敏；不写进测试文件。
 */
export interface VariableReference {
  variable: string
  prefix?: string
}

export type ApiHeaderValue = string | SecretReference | VariableReference

export interface UiLocator {
  testId?: string
  role?: string
  name?: string
  label?: string
  text?: string
  css?: string
  exact?: boolean
}

export type UiExpectation =
  | { exists: boolean }
  | { visible: boolean }
  | { enabled: boolean }
  | { textEquals: string }
  | { textContains: string }
  | { valueEquals: string }
  | { urlEquals: string }
  | { urlContains: string }
  | { count: number }

export type ApiExpectation =
  | { status: number }
  | { headerEquals: { name: string; value: string } }
  | { headerContains: { name: string; value: string } }
  | { headerExists: { name: string } }
  | { headerAbsent: { name: string } }
  | { bodyContains: string }
  /** v8：响应正文不得包含该文本。 */
  | { bodyNotContains: string }
  | { jsonPointerExists: string }
  | { jsonPointerEquals: { pointer: string; value: TestValue } }
  | { jsonPointerLengthEquals: { pointer: string; value: number } }
  | { jsonPointerNumberAtLeast: { pointer: string; value: number } }
  | { jsonPointerNumberAtMost: { pointer: string; value: number } }
  | { maxElapsedMs: number }
  /** v7：状态码任一命中即通过（幂等删除 200/204/404 等）。 */
  | { statusIn: number[] }

export type ApiMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'

/** API 方法白名单：`*.testspec.json` 与环境档探针共用同一份（协议事实只声明一次）。 */
export const TEST_SPEC_API_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const

export type UiStepSpec =
  | { id: string; action: 'ui.navigate'; url: string }
  | { id: string; action: 'ui.click'; locator: UiLocator }
  | { id: string; action: 'ui.input'; locator: UiLocator; value: string }
  | { id: string; action: 'ui.select'; locator: UiLocator; value: string }
  | { id: string; action: 'ui.press'; key: string }
  | { id: string; action: 'ui.wait'; locator?: UiLocator; expect: UiExpectation; timeoutMs?: number; extract?: Record<string, UiExtraction> }
  | { id: string; action: 'ui.assert'; locator?: UiLocator; expect: UiExpectation; extract?: Record<string, UiExtraction> }
  | { id: string; action: 'ui.screenshot'; name?: string }

export interface ApiStepSpec {
  id: string
  action: 'api.request'
  method: ApiMethod
  url: string
  query?: Record<string, TestValue>
  headers?: Record<string, ApiHeaderValue>
  body?: TestJsonValue
  bodyMode?: 'json' | 'text' | 'form'
  timeoutMs?: number
  redirect?: 'manual' | 'same-origin'
  /**
   * v4：显式声明的 Host 头覆盖（`host[:port]`，不含 scheme/path/userinfo）。面向按
   * Host 路由的反代/网关类目标系统：请求的网络目的地仍由 url 决定（出网策略、DNS
   * 与 TLS 校验不变），Host 头只影响服务端路由。进入租约摘要与脱敏证据；普通
   * `headers` 通道继续禁止直接设置 host。
   */
  virtualHost?: string
  expect?: ApiExpectation[]
  extract?: Record<string, ApiExtraction>
}

/**
 * v4：显式轮询步骤——等待最终一致（配置下发、路由重建、日志回流这类秒级窗口）。
 * 「无隐式重试」约束的是把重试藏进执行器；轮询在这里是**步骤自身声明的语义**：
 * 在 timeoutMs 窗口内按 intervalMs 重复同一幂等请求，期望全部通过即成功，
 * 断言失败与传输错误都视为「尚未就绪」继续轮询，窗口耗尽按最后一次尝试结算。
 * 宿主侧单租约单审批覆盖整个轮询（迭代是命令内部行为）。
 */
export interface ApiPollStepSpec {
  id: string
  action: 'api.poll'
  /** 轮询只允许幂等读方法。 */
  method: 'GET' | 'HEAD'
  url: string
  query?: Record<string, TestValue>
  headers?: Record<string, ApiHeaderValue>
  /** 整体轮询窗口；缺省 30s，上限与 api.request 的 timeoutMs 相同。 */
  timeoutMs?: number
  /** 轮询间隔，缺省 2000ms；同时是单次尝试的请求超时基准。 */
  intervalMs?: number
  redirect?: 'manual' | 'same-origin'
  virtualHost?: string
  /** 就绪条件：必填且至少一条。 */
  expect: ApiExpectation[]
  /** 仅在满足 expect 的那次尝试上执行提取。 */
  extract?: Record<string, ApiExtraction>
}

/**
 * v4：无副作用的小睡（跨秒级时序边界，如令牌签发与撤销同秒的窗口）。Runner 本地
 * 等待，不发请求、不消耗审批；可被运行停止打断。
 */
export interface ApiDelayStepSpec {
  id: string
  action: 'api.delay'
  durationMs: number
}

/**
 * v7：步骤条件执行。`whenProduced` 指定的变量在运行时变量表中不存在时，该步骤记
 * `skipped` 而不是失败——用于「只在资源真的创建成功后才清理」这类条件清理。
 */
export interface StepGuard {
  whenProduced?: string
}

export type TestStepSpec = (UiStepSpec | ApiStepSpec | ApiPollStepSpec | ApiDelayStepSpec) & StepGuard

/** API 驱动实际执行的步骤（api.delay 无副作用，在 Runner 本地完成，不进驱动）。 */
export type ApiDriverStep = ApiStepSpec | ApiPollStepSpec

/**
 * v9：fixture 文件引用。只允许出现在 JSON 请求体里，由宿主在运行准备期读取
 * `tests/fixtures/` 下的工作区文件并替换为 UTF-8 文本内容；路径禁止绝对路径与 `..`。
 */
export interface FixtureFileReference {
  file: string
}

export type TestJsonValue =
  | string
  | number
  | boolean
  | null
  | FixtureFileReference
  | TestJsonValue[]
  | { [key: string]: TestJsonValue }

/** 测试点类别：新功能覆盖，或对受影响既有功能的回归覆盖。 */
export type TestPointKind = 'new_feature' | 'regression'

/**
 * 测试点（v2 起）：用例必须经 `verifies` 追溯到测试点，报告据此计算功能覆盖而不是只数
 * 执行条数。v3 起清单必填；`acceptance` 写清可客观判定的预期，空泛描述会在编写阶段
 * 就被要求改写。
 */
export interface TestPointSpec {
  id: string
  kind: TestPointKind
  title: string
  acceptance: string
}

export interface TestCaseSpec {
  id: string
  name: string
  steps: TestStepSpec[]
  /** v2 起：该用例证明哪些测试点；必须命中同文件 `testPoints[].id`，且每个测试点都要被认领。 */
  verifies?: string[]
  /**
   * v5：案例级输入表（数据驱动）。每一项是一条数据行，编译期按行展开成独立 case：
   * 行内键在步骤里以 `${vars.name}` 引用（与运行期 extract 共用一个变量命名空间，
   * case 开始时预置；因此 extract 不得再产出同名变量）。所有行必须共享同一组键；
   * 值只能是标量，字符串里允许 `${env.*}` / `${run.*}`，不允许 `${vars.*}`。
   */
  inputs?: readonly Readonly<Record<string, TestValue>>[]
}

export interface TestHooksSpec {
  beforeAll?: TestStepSpec[]
  beforeEach?: TestStepSpec[]
  afterEach?: TestStepSpec[]
  afterAll?: TestStepSpec[]
}

export interface TestTargetSpec {
  webBaseUrl?: string
  apiBaseUrl?: string
  viewport?: { width: number; height: number }
}

/**
 * 测试用例文件的领域形状（v1/v2/v3 共用）。`version` 保留源文件版本：旧文件不会因为
 * 解析器升级而被改写；`testPoints` / `cases[].verifies` 只在 v2+ 文件里出现，v3 起
 * `testPoints` 必填。
 */
export interface TestSpec {
  kind: typeof TEST_SPEC_KIND
  version: TestSpecVersion
  id: string
  name: string
  target: TestTargetSpec
  hooks?: TestHooksSpec
  /** v2 起：测试点清单；v3 必填。用例经 `verifies` 指向它。 */
  testPoints?: TestPointSpec[]
  cases: TestCaseSpec[]
}
