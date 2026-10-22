import { describeEnvironmentFacts } from '@/agent/testing/environment/envFacts'
import { isFailureOrigin, type FailureOrigin } from '@/agent/testing/runner/runState'
import type { TestPointCoverageRow } from './testCoverage'

/** 归因的中文标签（写进给模型的消息；UI 侧走 i18n）。 */
const ORIGIN_LABELS: Record<FailureOrigin, string> = {
  environment: '环境（传输层/探针）',
  approval: '审批被拒',
  driver: '步骤或驱动故障',
  assertion: '断言不成立',
}
import type { TestRunDetailRecord } from '@/platform/testRuns'

const detailMessage = (detailsJson: string | null): string | null => {
  if (!detailsJson) return null
  try {
    const parsed: unknown = JSON.parse(detailsJson)
    if (typeof parsed !== 'object' || parsed === null || !('message' in parsed)) return null
    const message = (parsed as { message?: unknown }).message
    return typeof message === 'string' ? message.slice(0, 1_000) : null
  } catch {
    return null
  }
}

const successfulStatuses = new Set(['passed', 'skipped'])

const TEST_POINT_STATE_LABELS: Record<TestPointCoverageRow['state'], string> = {
  passed: '通过',
  failed: '未通过',
  'not-run': '未运行',
}

/**
 * `context.testPoints` 来自 `computeTestCoverage`（同一份追溯判定）：让修复方知道
 * "这条用例声称覆盖了哪些功能点、哪些根本没跑到"，而不是只看到一串步骤。
 */
export const buildTestFailureSummary = (
  report: TestRunDetailRecord,
  context: { testPoints?: readonly TestPointCoverageRow[] } = {},
): string => {
  const failedSteps = report.cases.flatMap((testCase) => testCase.steps
    .filter((step) => !successfulStatuses.has(step.status))
    .map((step) => {
      const details = [
        detailMessage(step.detailsJson),
        step.evidenceContentHash ? `证据 SHA-256: ${step.evidenceContentHash}` : null,
      ].filter((value): value is string => Boolean(value))
      return `- ${testCase.caseName} / ${step.stepId} [${step.status}] ${step.action}${details.length > 0 ? `\n  ${details.join('\n  ')}` : ''}`
    }))
  const environmentLine = describeEnvironmentFacts(report.summary.envFactsJson)
  // 归因统计：让修复方一眼分清「先修环境」还是「改断言」，而不是自己去猜失败类型。
  const originCounts = new Map<FailureOrigin, number>()
  for (const testCase of report.cases) {
    const origin = testCase.failureOrigin
    if (!isFailureOrigin(origin)) continue
    originCounts.set(origin, (originCounts.get(origin) ?? 0) + 1)
  }
  const originLine = originCounts.size === 0
    ? null
    : `- 失败归因：${[...originCounts.entries()].map(([origin, count]) => `${ORIGIN_LABELS[origin]} ×${count}`).join('、')}`
  const testPoints = context.testPoints ?? []
  const testPointLines = testPoints.length === 0 ? [] : [
    `- 测试点覆盖：${testPoints.map((point) => {
      const cases = point.caseIds.length === 0 ? '无用例追溯' : `用例 ${point.caseIds.join('、')}`
      return `${point.testPointId} [${TEST_POINT_STATE_LABELS[point.state]}]（${cases}）`
    }).join(' · ')}`,
  ]
  // 测试点只统计 verifies 追溯到的用例；hook 失败或未追溯用例失败可能让运行整体失败
  // 但测试点仍是全绿。报告必须点明这个分叉，避免修复方据此判定产品无缺陷。
  const splitBrainLine = testPoints.length > 0
    && testPoints.every((point) => point.state === 'passed')
    && report.summary.status !== 'passed'
    ? [`- 注意：测试点覆盖为全绿，但本次运行状态为「${report.summary.status}」：失败可能来自 hook 或未追溯用例，不要据此判定产品无缺陷。`]
    : []
  const lines = [
    '请根据以下 Axiom 自动化测试失败报告定位并修复产品代码或测试用例。',
    '',
    `- Run ID: ${report.summary.id}`,
    `- Spec: ${report.summary.specPath}`,
    `- Spec Hash: ${report.summary.specHash}`,
    `- Status: ${report.summary.status}`,
    `- Environment ID: ${report.summary.environmentId ?? '未指定'}`,
    ...(environmentLine === null ? [] : [`- ${environmentLine}`]),
    ...(originLine === null ? [] : [originLine]),
    ...testPointLines,
    ...splitBrainLine,
    '',
    '失败步骤：',
    ...(failedSteps.length > 0 ? failedSteps.slice(0, 50) : ['- 未记录失败步骤，请结合运行状态与用例检查。']),
  ]
  if (failedSteps.length > 50) lines.push(`- 另有 ${failedSteps.length - 50} 个失败步骤未展开，请在测试页查看完整报告。`)
  return lines.join('\n')
}
