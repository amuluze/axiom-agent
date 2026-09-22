import type { AgentTool } from '@/agent/core/types'
import { createReviewerSubAgentTool } from './createReviewerSubAgentTool'

/** `inspect_subagent`：委派只读审查子 Agent，对照 Domain Spec 审查 Task Spec。 */
export const createInspectSubAgentTool = (): AgentTool => createReviewerSubAgentTool({
  kind: 'inspect',
  toolName: 'inspect_subagent',
  // v6：子会话 system prompt 按 UI 语言解析 zh-CN/en 双语模板，并支持设置页按
  // 语言保存的用户覆写（promptLocalizationHost 执行期注入）。schema 不变。
  runtimeVersion: '6',
  label: '审查 Task Spec',
  promptSnippet: '委派一个只读审查子 Agent，对照 Domain Spec 与规范审查 Task Spec 的完备性、可验证性与歧义，返回通过/不通过与问题清单。',
  promptGuidelines: [
    '在 brainstorm/diagnose 产出 Task Spec 后调用，作为「spec 质量门禁」：通过才进入 plan，不通过则回到上一步完善 spec。',
    'task 里给出待审查的 spec 路径与背景；scope 收敛到 .specs/ 目录，避免子 Agent 全工作区扫描。',
    '子 Agent 只读，不能写文件、执行命令或请求审批。',
    '审查因预算中止返回 partial 或报错时：基于已有证据直接收口，或把 scope 收窄到未覆盖部分后重新委派；不要以同等规模重复委派（配额按父 run 累计）。',
  ],
  description:
    'Delegates a read-only inspection sub-agent that reviews a Task Spec against Domain Specs and conventions, returning a pass/fail verdict with a prioritized issue list. The sub-agent only uses read/ls/grep/find/web_search/web_fetch; scope is a hard runtime boundary resolved against the authorized workspace root.',
})
