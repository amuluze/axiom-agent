import type { AgentCapability } from '@/config/runtimePolicy'
import type { AgentTool } from '@/agent/core/types'
import { createReviewerSubAgentTool } from './createReviewerSubAgentTool'

/** diff 参数上限：128 KiB（UTF-8 字节口径，validate 以字节为权威；schema maxLength 仅为字符粗界）。task（≤8000）+ diff 合计远低于子会话 512 KiB 单请求消息预算。 */
const MAX_DIFF_LENGTH = 128 * 1024

export interface CreateReviewSubAgentToolOptions {
  /**
   * 当前运行时授予的能力集：无 diff 委派的降级提醒按 workspace:execute 分化——
   * 有命令执行能力却未携带 diff 属可避免的降级（提醒采集后重委派）；未授予时
   * diff 本就无法采集（提示词已声明降级指引），不再重复提醒。缺省视为未授予。
   */
  capabilities?: readonly AgentCapability[]
}

/**
 * `review_subagent`：委派只读审查子 Agent，审查代码改动的正确性、安全与测试覆盖。
 * 子 Agent 无 bash/git——除 task 里的意图描述外，父 Agent 应把 git diff 全文经
 * `diff` 参数携带，子 Agent 才能看到「改了什么」而非只看改动后的当前状态。
 */
export const createReviewSubAgentTool = (
  options: CreateReviewSubAgentToolOptions = {},
): AgentTool => createReviewerSubAgentTool({
  kind: 'review',
  toolName: 'review_subagent',
  // v8：子会话 system prompt 双语模板 + 用户覆写支持（同 inspect v6）。schema 不变。
  runtimeVersion: '8',
  diffMaxLength: MAX_DIFF_LENGTH,
  capabilities: options.capabilities,
  label: '审查代码改动',
  promptSnippet: '委派一个只读审查子 Agent，复核代码改动的正确性、安全与测试覆盖，返回通过/不通过与问题清单。',
  promptGuidelines: [
    '在 implement 完成后调用，作为「改动质量门禁」：通过才进入 finish，不通过则回到上一步继续修改。',
    '先在主 Agent 用 bash 采集 git diff，把 diff 全文放入 diff 参数、改动意图与文件清单写进 task；diff 超限时按文件分批审查。scope 收敛到改动涉及的文件/目录。未携带 diff 的委派是降级审查（只看当前状态，看不到改了什么）。',
    '子 Agent 只读，不能写文件、执行命令或请求审批；它以 diff 为「改了什么」的权威依据，读当前文件复核上下文。',
    '审查因预算中止返回 partial 或报错时：基于已有证据直接收口，或把 scope 收窄到未覆盖部分后重新委派；不要以同等规模重复委派（配额按父 run 累计）。',
  ],
  description:
    'Delegates a read-only review sub-agent that checks code changes for correctness, security, and test coverage, returning a pass/fail verdict with a prioritized issue list. The sub-agent has no bash/git: pass the unified diff via the diff parameter and describe intent in task. Delegating without diff is a downgraded review (current state only). The sub-agent only uses read/ls/grep/find with scope as a hard runtime boundary.',
})
