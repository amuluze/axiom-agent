import { compileTestSpec, deriveRunPlaceholders, materializeTestPlan, type CompiledTestPlan, type RunPlaceholderValues } from '@/agent/testing/spec/compileTestPlan'
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
  return materialized.plan
}

export const browserTargetOrigin = (url: string): string => {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('测试目标必须是 HTTP(S) 页面')
  return parsed.origin
}
