/**
 * v9 fixture 文件引用：收集计划里的 `{ file }` 引用，并在运行准备期把宿主读到的
 * 工作区文件内容替换进去。纯模块（无 I/O）——读取由调用方（testRunPreparation）
 * 经工作区读取通道完成，这里只做遍历、校验与不可变替换。
 */
import type { CompiledTestPlan } from './compileTestPlan'
import type { FixtureFileReference, TestJsonValue } from './types'

/** 单次运行允许引用的 fixture 文件数量上限。 */
export const FIXTURE_REFERENCE_MAX_FILES = 16
/** 单次运行读取的 fixture 总字节上限（2000 行证书/密钥绰绰有余）。 */
export const FIXTURE_REFERENCE_MAX_BYTES = 128 * 1024

export const isFixtureFileReference = (value: unknown): value is FixtureFileReference => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (Object.keys(value).length !== 1) return false
  return typeof (value as { file?: unknown }).file === 'string'
}

const walkJson = (value: TestJsonValue, visit: (reference: FixtureFileReference) => void): void => {
  if (isFixtureFileReference(value)) {
    visit(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) walkJson(child, visit)
  }
}

const stepBodies = (plan: CompiledTestPlan): TestJsonValue[] => {
  const bodies: TestJsonValue[] = []
  const addSteps = (steps: readonly { action: string; body?: TestJsonValue }[] | undefined): void => {
    for (const step of steps ?? []) {
      if (step.body !== undefined) bodies.push(step.body)
    }
  }
  addSteps(plan.hooks?.beforeAll)
  addSteps(plan.hooks?.beforeEach)
  addSteps(plan.hooks?.afterEach)
  addSteps(plan.hooks?.afterAll)
  for (const testCase of plan.cases) addSteps(testCase.steps)
  return bodies
}

/** 计划引用到的 fixture 文件（去重、按路径排序，保证读取顺序稳定）。 */
export const collectFixtureReferences = (plan: CompiledTestPlan): string[] => {
  const files = new Set<string>()
  for (const body of stepBodies(plan)) {
    walkJson(body, (reference) => files.add(reference.file))
  }
  return [...files].sort()
}

const substitute = (value: TestJsonValue, contents: ReadonlyMap<string, string>): TestJsonValue => {
  if (isFixtureFileReference(value)) {
    const content = contents.get(value.file)
    if (content === undefined) throw new Error(`fixture 文件「${value.file}」缺少内容`)
    return content
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, contents))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, substitute(child, contents)]))
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

/**
 * 用文件内容替换计划中的文件引用，返回新的冻结计划。任何引用缺内容都 fail-closed
 * （调用方应先确保所有被引用文件都已成功读取）。
 */
export const resolveFixtureReferences = (
  plan: CompiledTestPlan,
  contents: ReadonlyMap<string, string>,
): CompiledTestPlan => {
  const cases = plan.cases.map((testCase) => ({
    ...testCase,
    steps: testCase.steps.map((step) => (
      'body' in step && step.body !== undefined ? { ...step, body: substitute(step.body, contents) } : step
    )),
  }))
  const hooks = plan.hooks === undefined
    ? undefined
    : Object.fromEntries(Object.entries(plan.hooks).map(([name, steps]) => [
      name,
      (steps as readonly { body?: TestJsonValue }[]).map((step) => (
        step.body !== undefined ? { ...step, body: substitute(step.body, contents) } : step
      )),
    ]))
  return deepFreeze({ ...plan, ...(hooks ? { hooks } : {}), cases }) as CompiledTestPlan
}
