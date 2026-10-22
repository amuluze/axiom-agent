/**
 * 报告出口（T3-5）：JSON（本工具自己的格式）与 JUnit XML（能直接喂给标准 CI）。
 *
 * **脱敏纪律**：XML 只写「判定 + 名称 + 耗时 + 已脱敏的失败消息 + 证据 hash」，**绝不写
 * `detailsJson`**——那里的请求/响应头与 body 会进 CI 日志并被长期留存。证据去 Artifact 里看，
 * 要有权限的界面才拿得到。
 */
import type { TestRunDetailRecord, TestRunStatus } from '@/platform/testRuns'

export interface ExportedTestRunReport {
  /** v2：报告字段随 T0-2/T3-2 增补（`failure_origin`、环境事实、批次），旧读取方按版本判分支。 */
  schemaVersion: 2
  exportedAt: string
  run: TestRunDetailRecord
}

export const serializeTestRunReport = (
  report: TestRunDetailRecord,
  exportedAt: Date = new Date(),
): string => JSON.stringify({
  schemaVersion: 2,
  exportedAt: exportedAt.toISOString(),
  run: report,
} satisfies ExportedTestRunReport, null, 2)

/**
 * XML 1.0 不允许的 C0 控制字符会让整份文件失效（标准 CI 直接拒收），先剔除再转义。
 * 这里**有意**在正则里匹配控制字符——biome 的 `noControlCharactersInRegex` 在本仓库是预警项。
 */
const stripInvalidXmlChars = (text: string): string =>
  text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')

const escapeXml = (text: string): string =>
  stripInvalidXmlChars(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const seconds = (startedAt: number | null, finishedAt: number | null): string => {
  if (startedAt === null) return '0'
  const elapsed = Math.max(0, (finishedAt ?? startedAt) - startedAt)
  return (elapsed / 1000).toFixed(3)
}

/** 状态 → JUnit 元素。`skipped` 是"确实没跑"，被拒/取消/中断一律算**不通过**，不能伪装成跳过。 */
const junitOutcome = (status: TestRunStatus): 'passed' | 'failure' | 'error' | 'skipped' => {
  switch (status) {
    case 'passed':
      return 'passed'
    case 'failed':
      return 'failure'
    case 'rejected':
      return 'failure'
    case 'skipped':
      return 'skipped'
    default:
      return 'error'
  }
}

const failureType = (origin: string | null, status: TestRunStatus): string => {
  if (origin !== null && origin.length > 0) return origin
  if (status === 'failed') return 'assertion'
  if (status === 'rejected') return 'approval'
  return 'driver'
}

/**
 * JUnit XML。用例逐个展开为 `<testcase>`，失败类型用宿主客观归因（`environment`/`approval`/
 * `driver`/`assertion`）——CI 侧可以直接按类型分流"先修环境"还是"改断言"。
 */
export const toJUnitXml = (report: TestRunDetailRecord): string => {
  const { summary, cases } = report
  const flatten = cases.flatMap((testCase) => testCase.steps.map((step) => ({ testCase, step })))
  const counts = { failure: 0, error: 0, skipped: 0 }
  const body = flatten.map(({ testCase, step }) => {
    const outcome = junitOutcome(step.status)
    if (outcome !== 'passed') counts[outcome] += 1
    const name = `${testCase.caseName} / ${step.stepId}`
    const attributes = [
      `name="${escapeXml(name)}"`,
      `classname="${escapeXml(summary.specPath)}"`,
      `time="${seconds(step.startedAt, step.finishedAt)}"`,
    ].join(' ')
    const message = escapeXml(stepMessage(step))
    const child = outcome === 'passed'
      ? ''
      : `\n      <${outcome} message="${message}" type="${escapeXml(failureType(testCase.failureOrigin, step.status))}"/>`
    const evidence = step.evidenceContentHash === null || step.evidenceContentHash === undefined
      ? ''
      : `\n      <system-out>证据 SHA-256: ${escapeXml(step.evidenceContentHash)}</system-out>`
    return `    <testcase ${attributes}>${child}${evidence}\n    </testcase>`
  }).join('\n')

  const timestamp = summary.startedAt === null ? '' : ` timestamp="${new Date(summary.startedAt).toISOString()}"`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="axiom" tests="${flatten.length}" failures="${counts.failure}" errors="${counts.error}" skipped="${counts.skipped}" time="${seconds(summary.startedAt, summary.finishedAt)}">`,
    `  <testsuite name="${escapeXml(summary.specPath)}" tests="${flatten.length}" failures="${counts.failure}" errors="${counts.error}" skipped="${counts.skipped}" time="${seconds(summary.startedAt, summary.finishedAt)}"${timestamp}>`,
    body,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n')
}

/** `detailsJson` 只取 `message` 一个字段：其它字段（header/body/expected 原文）留在 Artifact 里。 */
const stepMessage = (step: TestRunDetailRecord['cases'][number]['steps'][number]): string => {
  if (step.detailsJson === null) return step.status
  try {
    const parsed: unknown = JSON.parse(step.detailsJson)
    // 边界数据：先 runtime 收窄再读字段，不拿断言替编译器背书。
    if (typeof parsed === 'object' && parsed !== null && 'message' in parsed
      && typeof parsed.message === 'string' && parsed.message.length > 0) {
      return parsed.message
    }
  } catch {
    // 解析失败不该让导出失败：退回状态名。
  }
  return step.status
}

const download = (content: string, mediaType: string, filename: string): void => {
  const blob = new Blob([content], { type: mediaType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export const downloadTestRunReport = (report: TestRunDetailRecord): void => {
  download(serializeTestRunReport(report), 'application/json;charset=utf-8', `axiom-test-run-${report.summary.id}.json`)
}

export const downloadTestRunJUnit = (report: TestRunDetailRecord): void => {
  download(toJUnitXml(report), 'application/xml;charset=utf-8', `axiom-test-run-${report.summary.id}.xml`)
}
