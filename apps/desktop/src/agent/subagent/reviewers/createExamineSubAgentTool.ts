import type { AgentTool } from '@/agent/core/types'
import { createReviewerSubAgentTool } from './createReviewerSubAgentTool'

/** `examine_subagent`：委派只读审查子 Agent，对照 Task Spec 检查实施方案 Plan。 */
export const createExamineSubAgentTool = (): AgentTool => createReviewerSubAgentTool({
  kind: 'examine',
  toolName: 'examine_subagent',
  // v6：子会话 system prompt 双语模板 + 用户覆写支持（同 inspect v6）。
  runtimeVersion: '6',
  label: '检查实施方案',
  promptSnippet: '委派一个只读审查子 Agent，对照 Task Spec 检查实施方案 Plan 的可行性、验收覆盖与风险，返回通过/不通过与问题清单。',
  promptGuidelines: [
    '在 plan 产出实施方案后调用，作为「方案质量门禁」：通过才进入 implement，不通过则回到上一步优化方案。',
    'task 里给出待检查的 plan 路径与对应 Task Spec 路径；scope 收敛到 .plans/ 与 .specs/。',
    '子 Agent 只读，不能写文件、执行命令或请求审批。',
    '审查因预算中止返回 partial 或报错时：基于已有证据直接收口，或把 scope 收窄到未覆盖部分后重新委派；不要以同等规模重复委派（配额按父 run 累计）。',
  ],
  description:
    'Delegates a read-only examination sub-agent that reviews an implementation Plan against the Task Spec for feasibility, acceptance coverage, and risk, returning a pass/fail verdict with a prioritized issue list. The sub-agent only uses read/ls/grep/find/web_search/web_fetch; scope is a hard runtime boundary resolved against the authorized workspace root.',
})
