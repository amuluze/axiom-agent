import { byteLength } from '@/agent/core/bytes'
import { compileTestSpec, deriveRunPlaceholders, materializeTestPlan, type CompiledTestPlan, type RunPlaceholderValues } from '@/agent/testing/spec/compileTestPlan'
import {
  FIXTURE_REFERENCE_MAX_BYTES,
  FIXTURE_REFERENCE_MAX_FILES,
  collectFixtureReferences,
  resolveFixtureReferences,
} from '@/agent/testing/spec/fixtureFiles'
import { parseTestSpec } from '@/agent/testing/spec/parseTestSpec'
import type { TestTargetSpec } from '@/agent/testing/spec/types'
import { readWorkspaceText } from '@/platform/workspace'

export interface PrepareUiTestRunInput {
  path: string
  workspacePath: string
  environment?: Readonly<Record<string, string>>
  targetOverrides?: Partial<TestTargetSpec>
  /**
   * 运行标记取值（文件里的 `${run.id}` / `${run.slug}`）。缺省时沿用 run id 派生——
   * 调用方只需给 runId；文件用了占位符却没有取值时 materialize 会 fail-closed。
   */
  runId?: string
  run?: RunPlaceholderValues
}

const issuesMessage = (issues: readonly { path: string; message: string }[]): string =>
  issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n')

export const prepareUiTestRun = async (input: PrepareUiTestRunInput): Promise<CompiledTestPlan> => {
  const read = await readWorkspaceText(input.path, 0, 1_000, input.workspacePath)
  if (read.truncated) throw new Error('测试文件超过运行读取上限')
  const parsed = parseTestSpec(read.content)
  if (!parsed.ok) throw new Error(issuesMessage(parsed.issues))
  const environment = input.environment ?? {}
  const compiled = await compileTestSpec(parsed.spec, {
    declaredEnvironmentNames: new Set(Object.keys(environment)),
  })
  if (!compiled.ok) throw new Error(issuesMessage(compiled.issues))
  const run = input.run ?? (input.runId === undefined ? undefined : deriveRunPlaceholders(input.runId))
  const materialized = materializeTestPlan(compiled.plan, environment, {
    targetOverrides: input.targetOverrides,
    ...(run ? { run } : {}),
  })
  if (!materialized.ok) throw new Error(issuesMessage(materialized.issues))

  // v9：fixture 文件引用在运行准备期一次读入（工作区相对路径，tests/fixtures/ 由解析器限定）。
  const files = collectFixtureReferences(materialized.plan)
  if (files.length === 0) return materialized.plan
  if (files.length > FIXTURE_REFERENCE_MAX_FILES) {
    throw new Error(`fixture 引用文件过多（${files.length}），单次运行最多 ${FIXTURE_REFERENCE_MAX_FILES} 个`)
  }
  const contents = new Map<string, string>()
  let totalBytes = 0
  for (const file of files) {
    const fixture = await readWorkspaceText(file, 0, 1_000, input.workspacePath)
    if (fixture.truncated) {
      throw new Error(`fixture 文件「${file}」超过读取上限（1000 行 / 128 KiB）`)
    }
    totalBytes += byteLength(fixture.content)
    if (totalBytes > FIXTURE_REFERENCE_MAX_BYTES) {
      throw new Error(`fixture 文件总大小超过 ${FIXTURE_REFERENCE_MAX_BYTES} 字节`)
    }
    contents.set(file, fixture.content)
  }
  return resolveFixtureReferences(materialized.plan, contents)
}

export const browserTargetOrigin = (url: string): string => {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('测试目标必须是 HTTP(S) 页面')
  return parsed.origin
}
