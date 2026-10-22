/**
 * 框架自检（零副作用、不连接环境）：
 *  1. 每个 *.runner.ts 必须有同名 *.cases.yaml / *.spec.yaml，且 runner 真的加载了用例；
 *  2. cases.yaml 必须匹配 src/types/cases.ts 的 zod 契约；
 *  3. spec.groups ↔ cases 双向引用、verifies 指向已声明规则、每条规则至少被一个用例覆盖。
 * 作为提交门禁：`npm run validate`（typecheck + check-suite + list-tests）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { parse } from 'yaml'
import type { z } from 'zod'
import {
  AgentRunCasesSchema,
  ShellCasesSchema,
  SpecDocSchema,
  TestingCasesSchema,
  WorkspaceCasesSchema,
} from '../src/types/cases.ts'

const ROOT = resolve(import.meta.dirname, '..')
const SUITES = [resolve(ROOT, 'integration'), resolve(ROOT, 'e2e')]
// 声明式期望清单：套件被整体删除或目录清空时必须报错。
// 只遍历已存在的 runner 会让「审批套件缺失」静默通过（历史空目录教训）。
const EXPECTED_SUITES = [
  'integration/shell',
  'integration/workspace',
  'integration/testing',
  'e2e/agent-run',
] as const
const SCHEMAS: z.ZodTypeAny[] = [ShellCasesSchema, WorkspaceCasesSchema, AgentRunCasesSchema, TestingCasesSchema]

let failures = 0
const fail = (message: string): void => {
  failures += 1
  console.error(`  ✗ ${message}`)
}
const ok = (message: string): void => console.log(`  ✓ ${message}`)

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else yield full
  }
}

const runners = SUITES.flatMap((dir) => [...walk(dir)].filter((file) => file.endsWith('.runner.ts')))
if (runners.length === 0) fail('integration/ 与 e2e/ 下没有任何 *.runner.ts')

for (const suite of EXPECTED_SUITES) {
  const prefix = `${resolve(ROOT, suite)}${sep}`
  if (!runners.some((runner) => runner.startsWith(prefix))) {
    fail(`声明套件缺少 runner：${suite}（套件被删除或目录为空）`)
  } else {
    ok(`声明套件存在：${suite}`)
  }
}

for (const runner of runners) {
  const stem = runner.replace(/\.runner\.ts$/u, '')
  const base = basename(stem)
  console.log(`\n[check-suite] ${base}`)
  const casesPath = `${stem}.cases.yaml`
  const specPath = `${stem}.spec.yaml`

  const casesExists = isFile(casesPath)
  const specExists = isFile(specPath)
  if (!casesExists) fail(`缺少 ${rel(casesPath)}`)
  if (!specExists) fail(`缺少 ${rel(specPath)}`)
  if (!casesExists || !specExists) continue

  if (!readFileSync(runner, 'utf8').includes(`${base}.cases.yaml`)) {
    fail(`runner 没有加载 ${base}.cases.yaml`)
  } else ok('runner 加载了同名 cases.yaml')

  const raw = parse(readFileSync(casesPath, 'utf8')) as unknown
  const matched = SCHEMAS.map((schema) => schema.safeParse(raw)).find((result) => result.success)
  if (!matched || !matched.success) {
    fail(`${rel(casesPath)} 不匹配 src/types/cases.ts 的任何契约`)
    continue
  }
  const cases = (matched.data as { cases: { id: string; verifies: string[] }[] }).cases
  ok(`cases.yaml 通过契约校验（${cases.length} 条）`)

  const spec = SpecDocSchema.parse(parse(readFileSync(specPath, 'utf8')))
  const caseIds = cases.map((item) => item.id)
  const duplicate = caseIds.filter((id, index) => caseIds.indexOf(id) !== index)
  duplicate.length > 0 ? fail(`重复的 case id：${duplicate.join(', ')}`) : ok('case id 唯一')

  const groupIds = new Set(spec.groups.flatMap((group) => group.cases))
  const notGrouped = caseIds.filter((id) => !groupIds.has(id))
  const unknown = [...groupIds].filter((id) => !caseIds.includes(id))
  if (notGrouped.length > 0) fail(`未被任何 spec group 引用的用例：${notGrouped.join(', ')}`)
  if (unknown.length > 0) fail(`spec group 引用了不存在的用例：${unknown.join(', ')}`)
  if (notGrouped.length === 0 && unknown.length === 0) ok('groups ↔ cases 双向一致')

  const ruleIds = new Set(spec.business_rules.map((rule) => rule.id))
  const badVerifies = cases.flatMap((item) => item.verifies).filter((id) => !ruleIds.has(id))
  const uncovered = spec.business_rules
    .map((rule) => rule.id)
    .filter((id) => !cases.some((item) => item.verifies.includes(id)))
  if (badVerifies.length > 0) fail(`verifies 指向未声明的规则：${badVerifies.join(', ')}`)
  if (uncovered.length > 0) fail(`未被任何用例覆盖的规则：${uncovered.join(', ')}`)
  if (badVerifies.length === 0 && uncovered.length === 0) ok('rules ↔ cases 覆盖完整')
}

console.log(failures === 0 ? '\n[check-suite] 全部套件一致。' : `\n[check-suite] ${failures} 处不一致。`)
process.exitCode = failures === 0 ? 0 : 1

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function rel(path: string): string {
  return path.slice(ROOT.length + 1)
}
