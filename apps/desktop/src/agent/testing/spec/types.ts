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

/** 当前协议版本：新文件与固化产物写这个版本。 */
export const TEST_SPEC_VERSION = 3 as const

/**
 * 解析器接受的版本集合。v1/v2 必须长期保留——用户工作区里的既有文件不能因为产品升级
 * 就变成「需要修复」；版本号与接受面的绑定由 contracts/test-spec-version.json 守门。
 */
export const SUPPORTED_TEST_SPEC_VERSIONS = [1, 2, 3] as const

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
  | { bodyContains: string }
  | { jsonPointerExists: string }
  | { jsonPointerEquals: { pointer: string; value: TestValue } }
  | { maxElapsedMs: number }

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
  headers?: Record<string, string | SecretReference>
  body?: TestJsonValue
  bodyMode?: 'json' | 'text' | 'form'
  timeoutMs?: number
  redirect?: 'manual' | 'same-origin'
  expect?: ApiExpectation[]
  extract?: Record<string, ApiExtraction>
}

export type TestStepSpec = UiStepSpec | ApiStepSpec

export type TestJsonValue =
  | string
  | number
  | boolean
  | null
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
