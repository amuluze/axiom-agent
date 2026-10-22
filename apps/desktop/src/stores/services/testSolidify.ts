/**
 * G1-6 探索转固化的 UI 编排层：
 * - {@link buildSolidifyPayload} 把固化草稿渲染成发给开发/测试会话的结构化中文消息；
 * - {@link prepareSolidifyDraft} 把一份会话轨迹跑成草稿，对「无轨迹 / 无探索步骤」给出
 *   明确结果而不是抛错；
 * - {@link solidifySpecId} 由会话标题派生一个文件名安全的 spec id；
 * - {@link loadSessionMessages} 是后台会话消息的读取接缝（激活会话直接读 store 投影）。
 *
 * 纯 TS 的抽取与固化逻辑在 `agent/testing/spec/**`；本模块只负责把它们接到 store /
 * 平台层，保持 `agent/testing/**` 不依赖 stores。
 */

import type { AgentMessage } from '@/agent/core/types'
import {
  solidifyDraft,
  type SolidifyDraft,
  type SolidifyIssue,
  type SolidifyOptions,
} from '@/agent/testing/spec/solidify'
import { extractExplorerSteps } from '@/agent/testing/spec/trajectory'
import type { TestStepSpec } from '@/agent/testing/spec/types'
import { getRepository } from '@/stores/repositoryCore'

/** `prepareSolidifyDraft` 的结果：`ok` 之外都是可读的空结果，绝不抛错。 */
export type SolidifyPrepareResult =
  | { status: 'ok'; stepCount: number; draft: SolidifyDraft }
  | { status: 'empty-trajectory'; stepCount: 0 }
  | { status: 'no-explorer-steps'; stepCount: 0 }

export const FALLBACK_SPEC_ID = 'explored-spec'

/**
 * 由会话标题派生文件名安全的 spec id。ASCII 标题压成 kebab；标题全是 CJK 等非
 * ASCII 字符时回落到 `spec-<sessionId 尾段>`，保证 `tests/<id>.testspec.json` 始终合法。
 */
export const solidifySpecId = (title: string, sessionId: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
    .replace(/-+$/u, '')
  if (slug !== '') return slug
  const tail = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(-40)
  return tail === '' ? FALLBACK_SPEC_ID : `spec-${tail}`
}

/** spec 内的步骤总数（跨全部用例）。 */
export const countDraftSteps = (draft: SolidifyDraft): number =>
  draft.spec.cases.reduce((total, testCase) => total + testCase.steps.length, 0)

const stepDetail = (step: TestStepSpec): string => {
  if (step.action === 'api.request') return `${step.method} ${step.url}`
  if (step.action === 'ui.navigate') return step.url
  if (step.action === 'ui.press') return step.key
  return ''
}

const describeStep = (step: TestStepSpec): string => {
  const detail = stepDetail(step)
  return detail === '' ? step.action : `${step.action} · ${detail}`
}

const describeIssue = (issue: SolidifyIssue): string => {
  const where = issue.stepIndex >= 0 ? `#${issue.stepIndex}` : 'spec'
  return `- ${where} ${issue.toolName} [${issue.code}] ${issue.message}`
}

export interface SolidifyPayloadOptions {
  /** 目标文件路径；默认 `tests/<spec.id>.testspec.json`。 */
  specPath?: string
}

/**
 * 把 `{ spec, issues }` 渲染成发给开发/测试会话的结构化中文消息。确定性：相同输入
 * 产出逐字节相同的字符串（含完整草稿 JSON），便于模型在一次 write 里落盘。
 */
export const buildSolidifyPayload = (
  draft: SolidifyDraft,
  options: SolidifyPayloadOptions = {},
): string => {
  const { spec, issues } = draft
  const specPath = options.specPath ?? `tests/${spec.id}.testspec.json`
  const stepCount = countDraftSteps(draft)
  const caseLines = spec.cases.flatMap((testCase) => [
    `- [${testCase.id}] ${testCase.name}`,
    ...(testCase.steps.length === 0
      ? ['  - 无步骤']
      : testCase.steps.map((step) => `  - ${step.id}: ${describeStep(step)}`)),
  ])
  const lines = [
    '请把以下探索轨迹固化为可重放的 Axiom 测试用例。',
    '',
    `- Spec ID: ${spec.id}`,
    `- 名称: ${spec.name}`,
    `- 目标文件: ${specPath}`,
    `- 用例数: ${spec.cases.length} · 步骤数: ${stepCount} · 待人工确认: ${issues.length}`,
    '',
    '用例与步骤：',
    ...(caseLines.length > 0 ? caseLines : ['- 无']),
    '',
    '待人工确认步骤（needsReview）：',
    ...(issues.length > 0 ? issues.map(describeIssue) : ['- 无']),
    '',
    `草稿 Spec（v${spec.version}，尚缺 testPoints/verifies，按第 3 条补齐后才是合法文件）：`,
    '```json',
    JSON.stringify(spec, null, 2),
    '```',
    '',
    '要求：',
    `1. 逐条补齐上述 needsReview 步骤的稳定 locator 与断言，不要使用探索期的瞬态 ref / tabId。`,
    `2. 不要改动 kind/version（当前 v${spec.version}）与既有稳定步骤的语义，只补全缺失的定位与断言。`,
    '3. 为文件补 `testPoints[]`（id/kind/title/acceptance），并为每个用例补 `verifies` 指向测试点；覆盖统计只认真实追溯，孤儿测试点与悬空引用都会被判「需要修复」。',
    `4. 把补全后的 spec 组装为 ${specPath}，调用 write 工具写入（每次写入都需要用户审批）。`,
    '5. 写完后在会话里说明改动点，便于再次运行验证。',
  ]
  return lines.join('\n')
}

/**
 * 会话轨迹 → 固化草稿。空轨迹与「无任何探索工具调用」各自返回明确状态，不抛错；
 * 其余情况走 `extractExplorerSteps` → `solidifyDraft`。
 */
export const prepareSolidifyDraft = async (
  messages: readonly AgentMessage[],
  options: SolidifyOptions,
): Promise<SolidifyPrepareResult> => {
  if (messages.length === 0) return { status: 'empty-trajectory', stepCount: 0 }
  const steps = extractExplorerSteps(messages)
  if (steps.length === 0) return { status: 'no-explorer-steps', stepCount: 0 }
  const draft = await solidifyDraft(steps, options)
  return { status: 'ok', stepCount: steps.length, draft }
}

/** 读取任意会话已落盘的消息（激活会话可直接用 store 投影，走此接缝仅有 I/O 成本）。 */
export const loadSessionMessages = async (sessionId: string): Promise<readonly AgentMessage[]> => {
  const snapshot = await getRepository().loadSession(sessionId)
  return snapshot.messages
}
