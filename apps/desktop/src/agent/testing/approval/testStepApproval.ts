import type { ApiStepSpec, UiLocator, UiStepSpec } from '../spec/types'

/**
 * 测试步骤的审批 actor（U1-5）。不伪造 Agent 的 toolCallId：审批绑定的是测试运行与步骤。
 */
export interface TestStepApprovalActor {
  kind: 'testStep'
  testRunId: string
  stepId: string
}

/** 审批卡片摘要：只描述动作与目标，不包含整页内容、输入的原文或任何 Secret。 */
export interface TestStepApprovalCard {
  actionLabel: string
  origin: string
  target: string
}

const describeLocator = (locator: UiLocator | undefined): string => {
  if (!locator) return '（页面级）'
  if (locator.testId) return `testId=${locator.testId}`
  if (locator.css) return `css=${locator.css}`
  const parts = [locator.role && `role=${locator.role}`, locator.name && `名称「${locator.name}」`, locator.text && `文本「${locator.text}」`]
    .filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : '（未指定）'
}

const describeAction = (step: UiStepSpec): string => {
  switch (step.action) {
    case 'ui.navigate':
      return `导航到 ${step.url}`
    case 'ui.click':
      return `点击 ${describeLocator(step.locator)}`
    case 'ui.input':
      // 输入值是测试数据，卡片只给出长度，避免把可能敏感的内容写进审批界面。
      return `在 ${describeLocator(step.locator)} 输入 ${[...step.value].length} 个字符`
    case 'ui.select':
      return `在 ${describeLocator(step.locator)} 选择选项`
    case 'ui.press':
      return `按下按键 ${step.key}`
    default:
      return step.action
  }
}

export const describeTestStepApproval = (step: UiStepSpec, origin: string): TestStepApprovalCard => ({
  actionLabel: describeAction(step),
  origin,
  target: describeLocator('locator' in step ? step.locator : undefined),
})

/**
 * API 步骤的审批卡摘要。只取 method/url：Agent 探索工具（`api_request`）经 Agent 层
 * 逐次审批复用同一张卡，不需要伪造 `id`/`action` 字段，卡片文案也不会与 Runner 漂移。
 */
export const describeApiTestStepApproval = (
  step: Pick<ApiStepSpec, 'method' | 'url'>,
): TestStepApprovalCard => {
  const url = new URL(step.url)
  return {
    actionLabel: `${step.method} ${url.pathname}`,
    origin: url.origin,
    target: `${url.hostname}${url.port ? `:${url.port}` : ''}`,
  }
}
