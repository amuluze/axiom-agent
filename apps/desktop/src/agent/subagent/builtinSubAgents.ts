import type { AgentCapability } from '@/config/runtimePolicy'
import type { AgentTool, SubAgentKind } from '@/agent/core/types'
import { createExploreSubAgentTool } from './explore/createExploreSubAgentTool'
import { createInspectSubAgentTool } from './reviewers/createInspectSubAgentTool'
import { createExamineSubAgentTool } from './reviewers/createExamineSubAgentTool'
import { createReviewSubAgentTool } from './reviewers/createReviewSubAgentTool'
import {
  DEFAULT_SUBAGENT_CHILD_BUDGET,
  DEFAULT_SUBAGENT_PARENT_RUN_BUDGET,
  type SubAgentChildBudget,
  type SubAgentParentRunBudget,
} from './contracts'
import { SUBAGENT_READONLY_TOOL_NAMES } from './readonlyTools'

/**
 * 内置 SubAgent 展示目录（设置-子智能体页消费）。
 *
 * 数据来源：
 * - 工具侧字段（label/description/promptSnippet/版本/执行模式）从
 *   `createExploreSubAgentTool()` 派生（纯工厂、无副作用），避免硬编码重复；
 * - 预算直接引用 `contracts.ts` 的权威默认常量；
 * - `allowedTools` 从 `readonlyTools.SUBAGENT_READONLY_TOOL_NAMES` 派生，与
 *   `SubAgentRuntime.buildChildContext` 共享同一权威来源（见 readonlyTools.ts）；
 *   变更子代理工具集只改 `SUBAGENT_READONLY_TOOL_FACTORIES` 一处即可。
 */
export interface BuiltinSubAgentInfo {
  kind: SubAgentKind
  toolName: string
  /**
   * 设置页 UI 展示专有名（品牌名）。
   * 区别于工具 label（通用中文名，用于审批对话框 / discover catalog / composer mention）——
   * 改 label 会波及那些面向模型与用户的展示，故设置页单独消费 displayName。
   */
  displayName: string
  label: string
  /** 面向模型的完整英文描述。 */
  description: string
  /** 中文摘要（设置页 UI 展示用）。 */
  promptSnippet: string
  allowedTools: readonly string[]
  runtimeVersion: string
  recoveryPolicy: string
  executionMode: string
  requiresApproval: boolean
  childBudget: SubAgentChildBudget
  parentRunBudget: SubAgentParentRunBudget
  capability: AgentCapability
  /** discover-gated：注册到完整工具表，但不加入默认激活集。 */
  discoverGated: boolean
}

const toEntry = (
  tool: AgentTool,
  kind: SubAgentKind,
  displayName: string,
  capability: AgentCapability,
): BuiltinSubAgentInfo => ({
  kind,
  toolName: tool.name,
  displayName,
  label: tool.label,
  description: tool.description,
  promptSnippet: tool.promptSnippet ?? '',
  allowedTools: SUBAGENT_READONLY_TOOL_NAMES,
  runtimeVersion: tool.runtimeVersion,
  recoveryPolicy: tool.recoveryPolicy ?? 'never',
  executionMode: tool.executionMode ?? 'sequential',
  requiresApproval: tool.requiresApproval ?? false,
  childBudget: DEFAULT_SUBAGENT_CHILD_BUDGET,
  parentRunBudget: DEFAULT_SUBAGENT_PARENT_RUN_BUDGET,
  capability,
  discoverGated: true,
})

const buildCatalog = (): readonly BuiltinSubAgentInfo[] => {
  const explore = createExploreSubAgentTool()
  const inspect = createInspectSubAgentTool()
  const examine = createExamineSubAgentTool()
  const review = createReviewSubAgentTool()
  return [
    toEntry(explore, 'explore', 'Explore', 'subagent:explore'),
    toEntry(inspect, 'inspect', 'Inspect', 'subagent:review'),
    toEntry(examine, 'examine', 'Examine', 'subagent:review'),
    toEntry(review, 'review', 'Review', 'subagent:review'),
  ]
}

export const BUILTIN_SUBAGENTS: readonly BuiltinSubAgentInfo[] = buildCatalog()
