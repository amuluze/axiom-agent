import { sha256Text } from '../../tools/workspaceToolUtils'
import { TEST_SPEC_LIMITS, type TestSpecIssue } from './parseTestSpec'
import type {
  ApiExpectation,
  TestCaseSpec,
  TestHooksSpec,
  TestPointSpec,
  TestSpec,
  TestSpecVersion,
  TestStepSpec,
  TestTargetSpec,
  TestValue,
  UiExpectation,
  UiStepSpec,
} from './types'
import { isApiDriverStep } from './stepActions'

/**
 * 编译产物里的 case：数据驱动行已展开为独立 case，附带 `seeds`（该行的输入值）。
 * `seeds` 是计划层事实——源文件里只有 `inputs` 数组，解析器从不产出 `seeds`。
 */
export type CompiledTestCase = TestCaseSpec & {
  readonly seeds?: Readonly<Record<string, TestValue>>
}

export interface CompiledTestPlan {
  specId: string
  name: string
  /** 源文件的协议版本：v1/v2 计划在报告与覆盖统计里必须可区分。 */
  specVersion: TestSpecVersion
  specHash: string
  target: TestTargetSpec
  environmentNames: readonly string[]
  hooks?: TestHooksSpec
  /** v2：测试点清单（用例经 `verifies` 指向它），随计划一起冻结供报告使用。 */
  testPoints?: readonly TestPointSpec[]
  cases: readonly CompiledTestCase[]
}

export interface CompileTestSpecOptions {
  /** 运行环境声明的逻辑变量名；文件引用了未声明的名字即拒绝。 */
  declaredEnvironmentNames: ReadonlySet<string>
}

export type CompileTestSpecResult =
  | { ok: true; plan: CompiledTestPlan }
  | { ok: false; issues: TestSpecIssue[] }

export type MaterializeTestPlanResult =
  | { ok: true; plan: CompiledTestPlan }
  | { ok: false; issues: TestSpecIssue[] }

export interface MaterializeTestPlanOptions {
  targetOverrides?: Partial<TestTargetSpec>
  /** 运行占位符取值；文件用了 `${run.*}` 却没给值 → fail-closed，不静默留空。 */
  run?: RunPlaceholderValues
}

const ENV_REF_PATTERN = /\$\{env\.([A-Z][A-Z0-9_]{0,63})\}/g
const VARIABLE_REF_PATTERN = /\$\{vars\.([A-Za-z][A-Za-z0-9_]{0,63})\}/g
const EXACT_VARIABLE_REF_PATTERN = /^\$\{vars\.([A-Za-z][A-Za-z0-9_]{0,63})\}$/
const RUN_REF_PATTERN = /\$\{run\.(id|slug)\}/g

/**
 * 运行占位符取值（宿主在 materialize 时注入）。`slug` 只含 `[a-z0-9-]`，同一 run 稳定、
 * 跨 run 不同——测试数据用它命名（唯一名称 / 主机名 / 邮箱），既能并行隔离又能按标记清理。
 */
export interface RunPlaceholderValues {
  id: string
  slug: string
}

export const RUN_SLUG_PREFIX = 'axiomrun-'

/** 由 run id 派生运行占位符取值。纯函数：同一 run id 永远得到同一组值。 */
export const deriveRunPlaceholders = (runId: string): RunPlaceholderValues => {
  const tail = runId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(-32)
  return { id: runId, slug: `${RUN_SLUG_PREFIX}${tail === '' ? 'run' : tail}` }
}

const ELEMENT_EXPECTATION_KEYS: readonly string[] = [
  'exists', 'visible', 'enabled', 'textEquals', 'textContains', 'valueEquals', 'count',
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 键排序后的 JSON 序列化：同一语义的 spec 无论键顺序如何都得到同一 hash。 */
export const canonicalJson = (value: unknown): string => JSON.stringify(sortKeys(value))

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]))
  }
  return value
}

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

const interpolateValue = (
  value: unknown,
  environment: Readonly<Record<string, string>>,
  run: RunPlaceholderValues | undefined,
): unknown => {
  if (typeof value === 'string') {
    const withEnvironment = value.replace(ENV_REF_PATTERN, (_match, name: string) => environment[name] ?? '')
    return withEnvironment.replace(RUN_REF_PATTERN, (match, key: 'id' | 'slug') =>
      run === undefined ? match : run[key])
  }
  if (Array.isArray(value)) return value.map((item) => interpolateValue(item, environment, run))
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      interpolateValue(child, environment, run),
    ]))
  }
  return value
}

/** 收集仍然存在的运行占位符字面量：宿主没给 run 值时必须 fail-closed，不静默留空。 */
const collectRunRefs = (value: unknown, found: string[]): void => {
  if (typeof value === 'string') {
    for (const match of value.matchAll(RUN_REF_PATTERN)) found.push(match[0])
  } else if (Array.isArray(value)) {
    for (const item of value) collectRunRefs(item, found)
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) collectRunRefs(child, found)
  }
}

const resolveStepUrl = (
  step: TestStepSpec,
  target: TestTargetSpec,
  path: string,
): { step?: TestStepSpec; issue?: TestSpecIssue } => {
  if (step.action !== 'ui.navigate' && !isApiDriverStep(step)) {
    return { step }
  }
  if (!step.url.startsWith('/')) return { step }
  const base = step.action === 'ui.navigate' ? target.webBaseUrl : target.apiBaseUrl
  try {
    return { step: { ...step, url: new URL(step.url, base).toString() } }
  } catch {
    return { issue: { path: `${path}.url`, message: '运行环境无法生成有效的绝对地址' } }
  }
}

export const materializeTestPlan = (
  plan: CompiledTestPlan,
  environment: Readonly<Record<string, string>>,
  options: MaterializeTestPlanOptions = {},
): MaterializeTestPlanResult => {
  const missing = plan.environmentNames.filter((name) => environment[name] === undefined)
  if (missing.length > 0) {
    return { ok: false, issues: missing.map((name) => ({ path: '$', message: `运行环境缺少变量「${name}」` })) }
  }

  const run = options.run
  const target = {
    ...(interpolateValue(plan.target, environment, run) as TestTargetSpec),
    ...options.targetOverrides,
  }
  const issues: TestSpecIssue[] = []
  const cases = plan.cases.map((testCase, caseIndex): CompiledTestCase => ({
    ...testCase,
    ...(testCase.seeds
      ? { seeds: interpolateValue(testCase.seeds, environment, run) as Record<string, TestValue> }
      : {}),
    steps: testCase.steps.flatMap((sourceStep, stepIndex) => {
      const step = interpolateValue(sourceStep, environment, run) as TestStepSpec
      const resolved = resolveStepUrl(step, target, `$.cases[${caseIndex}].steps[${stepIndex}]`)
      if (resolved.issue) issues.push(resolved.issue)
      return resolved.step ? [resolved.step] : []
    }),
  }))
  let hooks: TestHooksSpec | undefined
  if (plan.hooks) {
    hooks = {}
    for (const name of ['beforeAll', 'beforeEach', 'afterEach', 'afterAll'] as const) {
      const sourceSteps = plan.hooks[name]
      if (!sourceSteps) continue
      hooks[name] = sourceSteps.flatMap((sourceStep, stepIndex) => {
        const step = interpolateValue(sourceStep, environment, run) as TestStepSpec
        const resolved = resolveStepUrl(step, target, `$.hooks.${name}[${stepIndex}]`)
        if (resolved.issue) issues.push(resolved.issue)
        return resolved.step ? [resolved.step] : []
      })
    }
  }
  // 未解析的运行占位符只剩一种可能：宿主没给 run 值。静默留成字面量会让测试数据带上
  // `${run.id}` 这样的垃圾串并照常「通过」，因此这里必须显式失败。
  const unresolved: string[] = []
  collectRunRefs({ target, cases, ...(hooks ? { hooks } : {}) }, unresolved)
  if (unresolved.length > 0) {
    issues.push({
      path: '$',
      message: `运行占位符 ${[...new Set(unresolved)].join('、')} 缺少取值：宿主未提供 run 标记`,
    })
  }
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, plan: deepFreeze({ ...plan, target, ...(hooks ? { hooks } : {}), cases }) }
}

const collectEnvRefs = (value: unknown, found: Set<string>): void => {
  if (typeof value === 'string') {
    for (const match of value.matchAll(ENV_REF_PATTERN)) found.add(match[1] ?? '')
  } else if (Array.isArray(value)) {
    for (const item of value) collectEnvRefs(item, found)
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) collectEnvRefs(child, found)
  }
}

const collectVariableRefs = (value: unknown, found: Set<string>): void => {
  if (typeof value === 'string') {
    for (const match of value.matchAll(VARIABLE_REF_PATTERN)) found.add(match[1] ?? '')
  } else if (Array.isArray(value)) {
    for (const item of value) collectVariableRefs(item, found)
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) collectVariableRefs(child, found)
  }
}

const extractionNames = (step: TestStepSpec): readonly string[] =>
  'extract' in step && step.extract ? Object.keys(step.extract) : []

/** v6：步骤里以 `{ variable }` 引用的运行时凭据（按变量名）。 */
const credentialHeaderVariables = (step: TestStepSpec): readonly string[] => {
  if (!isApiDriverStep(step)) return []
  const names: string[] = []
  for (const value of Object.values(step.headers ?? {})) {
    if (typeof value === 'object' && 'variable' in value) names.push(value.variable)
  }
  return names
}

/** v6：抽取是否标记为敏感（敏感值才能进请求头做运行时凭据）。 */
const sensitiveExtractionNames = (step: TestStepSpec): readonly string[] =>
  'extract' in step && step.extract
    ? Object.entries(step.extract)
      .filter(([, extraction]) => extraction.sensitive === true)
      .map(([name]) => name)
    : []

const requiresLocator = (expect: UiExpectation): boolean =>
  ELEMENT_EXPECTATION_KEYS.some((key) => key in expect)

/**
 * 元素断言必须有定位器，否则 Runner 无从判定；URL 断言作用于整页，无需定位器。
 * 相对地址的基址缺失同样在编译期拒绝，避免运行时才发现无法解析。
 */
const collectStructuralIssues = (
  steps: readonly TestStepSpec[],
  pathPrefix: string,
  target: TestTargetSpec,
): TestSpecIssue[] => {
  const issues: TestSpecIssue[] = []
  steps.forEach((step, stepIndex) => {
    const path = `${pathPrefix}[${stepIndex}]`
    if (isApiDriverStep(step)) {
      if (step.url.startsWith('/') && !target.apiBaseUrl) {
        issues.push({ path: `${path}.url`, message: '站内相对路径需要在 target.apiBaseUrl 中声明基址' })
      }
      return
    }
    if (step.action === 'api.delay') return
    if (step.action === 'ui.navigate' && step.url.startsWith('/') && !target.webBaseUrl) {
      issues.push({ path: `${path}.url`, message: '站内相对路径需要在 target.webBaseUrl 中声明基址' })
    }
    if (hasExpectation(step) && requiresLocator(step.expect) && !step.locator) {
      issues.push({ path: `${path}.locator`, message: '该断言作用于元素，必须提供定位器' })
    }
    if (hasExpectation(step) && 'urlEquals' in step.expect
      && step.expect.urlEquals.startsWith('/') && !step.expect.urlEquals.startsWith('//')
      && !target.webBaseUrl) {
      issues.push({
        path: `${path}.expect.urlEquals`,
        message: '站内相对 URL 断言需要在 target.webBaseUrl 中声明基址',
      })
    }
    if ('extract' in step && step.extract && !step.locator) {
      issues.push({ path: `${path}.locator`, message: 'UI 变量提取必须提供定位器' })
    }
  })
  return issues
}

const collectVariableIssues = (
  steps: readonly TestStepSpec[],
  pathPrefix: string,
  produced: Set<string>,
  sensitive: Set<string>,
  conditional: Set<string>,
  fileProduced: ReadonlySet<string>,
): TestSpecIssue[] => {
  const issues: TestSpecIssue[] = []
  steps.forEach((step, stepIndex) => {
    const path = `${pathPrefix}[${stepIndex}]`
    // v7 条件执行：守卫变量必须在本文件某处生产，否则条件永远不成立（死步骤）。
    const guard = 'whenProduced' in step ? step.whenProduced : undefined
    if (guard !== undefined && !fileProduced.has(guard)) {
      issues.push({
        path,
        message: `whenProduced 变量「${guard}」在本文件中没有任何步骤生产（条件永远不成立）`,
      })
    }
    const referenced = new Set<string>()
    collectVariableRefs(step, referenced)
    for (const name of credentialHeaderVariables(step)) referenced.add(name)
    for (const name of [...referenced].sort()) {
      // 守卫允许引用「本作用域可能未产出」的变量（条件清理）：缺省跳过，产出后执行。
      if (!produced.has(name) && name !== guard) {
        issues.push({ path, message: `变量「${name}」必须由当前作用域中的前序步骤生产` })
      } else if (conditional.has(name) && name !== guard) {
        // 条件产物的存在性不确定：没有同变量守卫的消费者会把缺失值物化为
        // 「undefined」继续发请求，必须在这里拒绝。
        issues.push({
          path,
          message: `变量「${name}」由条件步骤生产；引用它的步骤必须声明 whenProduced: "${name}"`,
        })
      }
    }
    // v6：运行时凭据头只接受 sensitive 抽取的变量——非敏感值会以明文进证据/报告，
    // 也让「这个值从哪来」失去可审计性。
    for (const name of credentialHeaderVariables(step)) {
      if (!sensitive.has(name)) {
        issues.push({
          path,
          message: `请求头变量「${name}」必须来自 sensitive 抽取（extract.${name}.sensitive = true）`,
        })
      }
    }
    for (const name of extractionNames(step)) {
      if (produced.has(name)) {
        issues.push({ path: `${path}.extract.${name}`, message: `变量「${name}」已由当前作用域的前序步骤生产` })
      } else {
        produced.add(name)
        if (guard !== undefined) conditional.add(name)
      }
    }
    for (const name of sensitiveExtractionNames(step)) sensitive.add(name)
  })
  return issues
}

/**
 * v7：文件级「可能产出」的变量名集合——所有 hook/case 步骤的抽取键 ∪ 数据行键。
 * 只在校验 `whenProduced` 守卫时使用（守卫要引用的是某条用例产物，而非当前作用域）。
 */
const collectFileProducedNames = (spec: TestSpec): Set<string> => {
  const names = new Set<string>()
  const addSteps = (steps: readonly TestStepSpec[] | undefined): void => {
    for (const step of steps ?? []) {
      for (const name of extractionNames(step)) names.add(name)
    }
  }
  const hooks = spec.hooks
  addSteps(hooks?.beforeAll)
  addSteps(hooks?.beforeEach)
  addSteps(hooks?.afterEach)
  addSteps(hooks?.afterAll)
  for (const testCase of spec.cases) {
    addSteps(testCase.steps)
    for (const name of Object.keys(testCase.inputs?.[0] ?? {})) names.add(name)
  }
  return names
}

const collectStepIssues = (spec: TestSpec): TestSpecIssue[] => {
  const issues: TestSpecIssue[] = []
  const hookEntries = Object.entries(spec.hooks ?? {}) as Array<[keyof TestHooksSpec, TestStepSpec[]]>
  for (const [name, steps] of hookEntries) {
    issues.push(...collectStructuralIssues(steps, `$.hooks.${name}`, spec.target))
  }
  spec.cases.forEach((testCase, caseIndex) => {
    issues.push(...collectStructuralIssues(testCase.steps, `$.cases[${caseIndex}].steps`, spec.target))
  })

  const fileProduced = collectFileProducedNames(spec)
  const suiteVariables = new Set<string>()
  const suiteSensitive = new Set<string>()
  const suiteConditional = new Set<string>()
  if (spec.hooks?.beforeAll) {
    issues.push(...collectVariableIssues(
      spec.hooks.beforeAll,
      '$.hooks.beforeAll',
      suiteVariables,
      suiteSensitive,
      suiteConditional,
      fileProduced,
    ))
  }
  spec.cases.forEach((testCase, caseIndex) => {
    // v5：数据行键在该 case 作用域开始时预置（beforeEach 也能用），与 extract 共用命名空间。
    const caseVariables = new Set(suiteVariables)
    const caseSensitive = new Set(suiteSensitive)
    const caseConditional = new Set(suiteConditional)
    for (const name of Object.keys(testCase.inputs?.[0] ?? {})) caseVariables.add(name)
    if (spec.hooks?.beforeEach) {
      issues.push(...collectVariableIssues(
        spec.hooks.beforeEach,
        '$.hooks.beforeEach',
        caseVariables,
        caseSensitive,
        caseConditional,
        fileProduced,
      ))
    }
    issues.push(...collectVariableIssues(
      testCase.steps,
      `$.cases[${caseIndex}].steps`,
      caseVariables,
      caseSensitive,
      caseConditional,
      fileProduced,
    ))
    if (spec.hooks?.afterEach) {
      issues.push(...collectVariableIssues(
        spec.hooks.afterEach,
        '$.hooks.afterEach',
        caseVariables,
        caseSensitive,
        caseConditional,
        fileProduced,
      ))
    }
  })
  if (spec.hooks?.afterAll) {
    issues.push(...collectVariableIssues(
      spec.hooks.afterAll,
      '$.hooks.afterAll',
      new Set(suiteVariables),
      new Set(suiteSensitive),
      new Set(suiteConditional),
      fileProduced,
    ))
  }
  const targetVariables = new Set<string>()
  collectVariableRefs(spec.target, targetVariables)
  for (const name of [...targetVariables].sort()) {
    issues.push({ path: '$.target', message: `目标配置不能引用运行变量「${name}」` })
  }
  return issues
}

const stringifyVariable = (value: TestValue): string => value === null ? 'null' : String(value)

const normalizeUiExpectation = (expect: UiExpectation): UiExpectation => {
  const [key, value] = Object.entries(expect)[0] ?? []
  if (key === undefined) return expect
  if (['textEquals', 'textContains', 'valueEquals', 'urlEquals', 'urlContains'].includes(key)) {
    return { [key]: stringifyVariable(value as TestValue) } as UiExpectation
  }
  return expect
}

/** `urlEquals` 的站内相对路径按运行目标解析；比较的是页面绝对 URL，不是文件里的相对串。 */
const resolveUiExpectationUrl = (
  expect: UiExpectation,
  target: TestTargetSpec,
): UiExpectation => {
  if (!('urlEquals' in expect) || !target.webBaseUrl) return expect
  const value = expect.urlEquals
  if (!value.startsWith('/') || value.startsWith('//')) return expect
  try {
    return { urlEquals: new URL(value, target.webBaseUrl).toString() }
  } catch {
    return expect
  }
}

const normalizeApiExpectations = (expectations: ApiExpectation[]): ApiExpectation[] => {
  return expectations.map((expectation) => {
    const [key, value] = Object.entries(expectation)[0] ?? []
    if (key === 'bodyContains') return { bodyContains: stringifyVariable(value as TestValue) }
    if ((key === 'headerEquals' || key === 'headerContains') && isRecord(value)) {
      return { [key]: { ...value, value: stringifyVariable(value.value as TestValue) } } as ApiExpectation
    }
    return expectation
  })
}

const interpolateRuntimeValue = (
  value: unknown,
  variables: Readonly<Record<string, TestValue>>,
  preserveScalar: boolean,
): unknown => {
  if (typeof value === 'string') {
    const read = (name: string): TestValue => {
      if (!Object.hasOwn(variables, name)) {
        throw new Error(`运行时变量「${name}」未产出`)
      }
      return variables[name]
    }
    const exact = value.match(EXACT_VARIABLE_REF_PATTERN)
    if (exact) {
      const variable = read(exact[1] ?? '')
      return preserveScalar ? variable : stringifyVariable(variable)
    }
    return value.replace(VARIABLE_REF_PATTERN, (_match, name: string) => stringifyVariable(read(name)))
  }
  if (Array.isArray(value)) return value.map((item) => interpolateRuntimeValue(item, variables, preserveScalar))
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      interpolateRuntimeValue(child, variables, preserveScalar),
    ]))
  }
  return value
}

export const materializeTestStepVariables = (
  step: TestStepSpec,
  variables: Readonly<Record<string, TestValue>>,
  target: TestTargetSpec = {},
): TestStepSpec => {
  const materialized = interpolateRuntimeValue(step, variables, true) as TestStepSpec
  if (isApiDriverStep(materialized)) {
    const headers = materialized.headers && Object.fromEntries(Object.entries(materialized.headers).map(([name, value]) => [
      name,
      typeof value === 'object' ? value : stringifyVariable(value as TestValue),
    ]))
    const body = materialized.action === 'api.request' && materialized.bodyMode === 'text' && materialized.body !== undefined
      ? stringifyVariable(materialized.body as TestValue)
      : materialized.action === 'api.request'
        ? materialized.body
        : undefined
    const url = stringifyVariable(materialized.url as TestValue)
    return deepFreeze({
      ...materialized,
      url: url.startsWith('/') && target.apiBaseUrl ? new URL(url, target.apiBaseUrl).toString() : url,
      ...(headers ? { headers } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(materialized.expect ? { expect: normalizeApiExpectations(materialized.expect) } : {}),
    })
  }
  if (materialized.action === 'ui.navigate') {
    const url = stringifyVariable(materialized.url as TestValue)
    return deepFreeze({
      ...materialized,
      url: url.startsWith('/') && target.webBaseUrl ? new URL(url, target.webBaseUrl).toString() : url,
    })
  }
  if (materialized.action === 'ui.input' || materialized.action === 'ui.select') {
    return deepFreeze({ ...materialized, value: stringifyVariable(materialized.value as TestValue) })
  }
  if (materialized.action === 'ui.assert' || materialized.action === 'ui.wait') {
    const expect = normalizeUiExpectation(materialized.expect)
    return deepFreeze({ ...materialized, expect: resolveUiExpectationUrl(expect, target) })
  }
  return deepFreeze(materialized)
}

const hasExpectation = (step: UiStepSpec): step is Extract<UiStepSpec, { expect: UiExpectation }> =>
  step.action === 'ui.wait' || step.action === 'ui.assert'

/**
 * 语义编译：校验环境引用与断言/定位器/基址的配对关系，然后深拷贝并冻结出不可变 plan，
 * 计算 specHash。输入 spec 之后的修改不影响已编译的 plan。
 */
export const compileTestSpec = async (
  spec: TestSpec,
  options: CompileTestSpecOptions,
): Promise<CompileTestSpecResult> => {
  const referenced = new Set<string>()
  collectEnvRefs(spec.target, referenced)
  collectEnvRefs(spec.hooks, referenced)
  collectEnvRefs(spec.cases, referenced)

  const issues: TestSpecIssue[] = []
  for (const name of [...referenced].sort()) {
    if (!options.declaredEnvironmentNames.has(name)) {
      issues.push({ path: '$', message: `引用了未声明的环境变量「${name}」` })
    }
  }
  issues.push(...collectStepIssues(spec))
  // 目标是环境级事实（整个环境共用），运行占位符是运行级事实，两者混用只会得到
  // 「每次运行都指向不同地址」这种不可复现的配置。
  const targetRunRefs: string[] = []
  collectRunRefs(spec.target, targetRunRefs)
  if (targetRunRefs.length > 0) {
    issues.push({
      path: '$.target',
      message: `目标配置不能引用运行占位符（${[...new Set(targetRunRefs)].join('、')}）`,
    })
  }
  if (issues.length > 0) return { ok: false, issues }

  // v5：数据行按行展开成独立 case（id/name 带行号，verifies 原样复制，行值进 seeds）。
  const expandedCases: CompiledTestCase[] = []
  const expandedPaths: string[] = []
  /** 源 case → 计划 case 基座：只复制协议字段，不把 `inputs` 带进计划（行值改由 seeds 承载）。 */
  const caseBase = (source: TestCaseSpec): TestCaseSpec => ({
    id: source.id,
    name: source.name,
    steps: source.steps,
    ...(source.verifies ? { verifies: source.verifies } : {}),
  })
  spec.cases.forEach((testCase, caseIndex) => {
    const inputs = testCase.inputs
    if (inputs === undefined) {
      expandedCases.push(structuredClone(caseBase(testCase)))
      expandedPaths.push(`$.cases[${caseIndex}]`)
      return
    }
    inputs.forEach((row, variantIndex) => {
      expandedCases.push({
        ...structuredClone({
          ...caseBase(testCase),
          id: inputs.length > 1 ? `${testCase.id}-v${variantIndex + 1}` : testCase.id,
          name: inputs.length > 1
            ? `${testCase.name.slice(0, 180)} · ${variantIndex + 1}/${inputs.length}`
            : testCase.name,
        }),
        ...(Object.keys(row).length > 0 ? { seeds: structuredClone(row) } : {}),
      })
      expandedPaths.push(`$.cases[${caseIndex}].inputs[${variantIndex}]`)
    })
  })
  // 展开后的 ID 可能撞上用户手写的 `x-v2` 之类；重复在报告里会互相覆盖。
  const seenIds = new Set<string>()
  expandedCases.forEach((testCase, index) => {
    if (seenIds.has(testCase.id)) {
      issues.push({ path: `${expandedPaths[index]}.id`, message: `展开后的用例 ID「${testCase.id}」重复` })
    }
    seenIds.add(testCase.id)
  })
  if (expandedCases.length > TEST_SPEC_LIMITS.maxCases) {
    issues.push({
      path: '$.cases',
      message: `数据行展开后共 ${expandedCases.length} 个用例，超过上限 ${TEST_SPEC_LIMITS.maxCases}`,
    })
  }
  if (issues.length > 0) return { ok: false, issues }

  const specHash = await sha256Text(canonicalJson(spec))
  const plan: CompiledTestPlan = {
    specId: spec.id,
    name: spec.name,
    specVersion: spec.version,
    specHash,
    target: structuredClone(spec.target),
    environmentNames: [...referenced].sort(),
    ...(spec.hooks ? { hooks: structuredClone(spec.hooks) } : {}),
    ...(spec.testPoints ? { testPoints: structuredClone(spec.testPoints) } : {}),
    cases: expandedCases,
  }
  return { ok: true, plan: deepFreeze(plan) }
}
