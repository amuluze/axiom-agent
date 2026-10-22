import { parseTestSpec } from '@/agent/testing/spec/parseTestSpec'
import type { TestCaseSpec, TestStepSpec, UiExpectation } from '@/agent/testing/spec/types'
import { readWorkspaceText } from '@/platform/workspace'

/**
 * 选中用例文件的明细投影（TestingView 用例表 / KPI 卡数据源）。
 *
 * 索引（testSpecIndex.ts）只存计数不存正文——把整份 spec 塞进索引会让扫描
 * 变成全量解析。这里在选中单个文件时按需读取并解析（与索引同一 1000 行上限），
 * fail-soft：读取/解析失败返回 null，表格退化为索引计数展示。
 */

export type SpecCaseType = 'ui' | 'api' | 'mixed'

export interface SpecCaseRow {
  id: string
  name: string
  type: SpecCaseType
  stepCount: number
  assertCount: number
  /** 首个断言步骤的人话描述（表格副行「断言：…」）；无断言步骤为 null。 */
  assertSummary: string | null
}

export interface SpecDetail {
  name: string
  version: number
  cases: SpecCaseRow[]
  assertCount: number
  uiCaseCount: number
  apiCaseCount: number
  mixedCaseCount: number
}

/** ui.expect / api.expect 的单条断言 → 中文短描述（表格副行与报告失败卡共用）。 */
export const describeUiExpectation = (expect: UiExpectation): string => {
  if ('exists' in expect) return expect.exists ? '元素存在' : '元素不存在'
  if ('visible' in expect) return expect.visible ? '元素可见' : '元素不可见'
  if ('enabled' in expect) return expect.enabled ? '元素可用' : '元素禁用'
  if ('textEquals' in expect) return `文本等于「${expect.textEquals}」`
  if ('textContains' in expect) return `文本包含「${expect.textContains}」`
  if ('valueEquals' in expect) return `值等于「${expect.valueEquals}」`
  if ('urlEquals' in expect) return `URL 等于 ${expect.urlEquals}`
  if ('urlContains' in expect) return `URL 包含 ${expect.urlContains}`
  if ('count' in expect) return `元素数量为 ${expect.count}`
  return '断言'
}

const describeStep = (step: TestStepSpec): string | null => {
  if (step.action === 'ui.assert') return describeUiExpectation(step.expect)
  if (step.action === 'ui.wait') return `等待：${describeUiExpectation(step.expect)}`
  if (step.action === 'api.request') {
    const expectations = step.expect ?? []
    if (expectations.length === 0) return `${step.method} ${step.url}`
    const status = expectations.find((item): item is { status: number } => 'status' in item)
    return status
      ? `${step.method} ${step.url} → ${status.status}（${expectations.length} 项断言）`
      : `${step.method} ${step.url}（${expectations.length} 项断言）`
  }
  return null
}

/**
 * 一个步骤贡献的断言数：`ui.assert` / `ui.wait` 各 1，API 请求按 expect 条目数计。
 * 测试页 KPI 与用例表必须用同一口径，否则纯 API 用例会显示 0 断言。
 */
export const assertionCountOf = (step: TestStepSpec): number => {
  if (step.action === 'ui.assert' || step.action === 'ui.wait') return 1
  if (step.action === 'api.request') return step.expect?.length ?? 0
  return 0
}

const toCaseRow = (testCase: TestCaseSpec): SpecCaseRow => {
  const actions = testCase.steps.map((step) => step.action)
  const hasApi = actions.includes('api.request')
  const hasUi = actions.some((action) => action !== 'api.request')
  const assertSteps = testCase.steps.filter((step) => assertionCountOf(step) > 0)
  const firstAssert = assertSteps[0]
  return {
    id: testCase.id,
    name: testCase.name,
    type: hasApi && hasUi ? 'mixed' : hasApi ? 'api' : 'ui',
    stepCount: testCase.steps.length,
    assertCount: assertSteps.reduce((total, step) => total + assertionCountOf(step), 0),
    assertSummary: firstAssert ? describeStep(firstAssert) : null,
  }
}

export const loadSpecDetail = async (
  path: string,
  workspacePath?: string,
): Promise<SpecDetail | null> => {
  try {
    const read = await readWorkspaceText(path, 0, 1_000, workspacePath)
    const parsed = parseTestSpec(read.content)
    if (!parsed.ok) return null
    const cases = parsed.spec.cases.map(toCaseRow)
    return {
      name: parsed.spec.name,
      version: parsed.spec.version,
      cases,
      assertCount: cases.reduce((total, item) => total + item.assertCount, 0),
      uiCaseCount: cases.filter((item) => item.type === 'ui').length,
      apiCaseCount: cases.filter((item) => item.type === 'api').length,
      mixedCaseCount: cases.filter((item) => item.type === 'mixed').length,
    }
  } catch {
    return null
  }
}
