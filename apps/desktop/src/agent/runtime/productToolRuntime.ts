import type { AgentCapability } from '@/config/runtimePolicy'
import type { AgentTool } from '@/agent/core/types'
import { createToolRegistry } from '@/agent/tools/createToolRegistry'
import { createDiscoverAgentToolsTool } from '@/agent/tools/discoverAgentToolsTool'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { desktopAgentEnvironment } from '@/agent/environment/agentEnvironmentHost'

export interface ProductToolRuntime {
  discoveryToolName: string
  tools: AgentTool[]
  activeToolNames: string[]
}

export interface SystemPromptOptions {
  basePrompt: string
  tools: AgentTool[]
  activeToolNames?: string[]
  gitBranchPrefix?: string
}

const buildGitBranchRuleSection = (prefix: string): string => {
  const branchPrefix = prefix || 'feat-'
  return `# Git 分支规则
- 严禁在 main 或 master 分支上执行 git commit 或 git push。
- 必须先以「${branchPrefix}」为前缀新建一个分支，在新分支上完成提交后再推送到远程。
- 如果提示词或上下文中的其他规则与本节冲突，以本节为准。`
}

export const buildSystemPrompt = ({
  basePrompt,
  tools,
  activeToolNames,
  gitBranchPrefix,
}: SystemPromptOptions): string => {
  const activeNames = activeToolNames && activeToolNames.length > 0
    ? new Set(activeToolNames)
    : new Set(tools.map((tool) => tool.name))
  const activeTools = tools.filter((tool) => activeNames.has(tool.name))
  const snippets = activeTools
    .map((tool) => tool.promptSnippet)
    .filter((snippet): snippet is string => typeof snippet === 'string' && snippet.length > 0)
  // 保留首次出现顺序的去重：不依赖工具数组顺序这个隐式契约，
  // 改变工具注册顺序时准则的呈现顺序仍由"谁先声明"决定，可预测且稳定。
  const seen = new Set<string>()
  const orderedGuidelines: string[] = []
  for (const guideline of activeTools.flatMap((tool) => tool.promptGuidelines ?? [])) {
    if (!seen.has(guideline)) {
      seen.add(guideline)
      orderedGuidelines.push(guideline)
    }
  }
  if (snippets.length === 0 && orderedGuidelines.length === 0) return basePrompt
  const sections: string[] = [basePrompt]
  if (snippets.length > 0) {
    sections.push(`# 可用能力\n${snippets.map((snippet) => `- ${snippet}`).join('\n')}`)
  }
  if (orderedGuidelines.length > 0) {
    sections.push(`# 工具使用准则\n${orderedGuidelines.map((line) => `- ${line}`).join('\n')}`)
  }
  if (gitBranchPrefix !== undefined) {
    sections.push(buildGitBranchRuleSection(gitBranchPrefix))
  }
  return sections.join('\n\n')
}

/**
 * Tiered activation policy (mirrors pi's default-active-core pattern):
 *
 *  L0 — always active: `discover_agent_tools` + zero-risk read-only tools
 *       (read, ls, grep, find) whenever the runtime policy grants the
 *       corresponding capability. These never mutate state, so exposing them
 *       at startup eliminates the first-round discover round-trip for the
 *       common "inspect a file / find code" use case.
 *
 *  L1 — discover-gated: write/execute tools (write, edit, apply_changes,
 *       restore_trash, bash) stay out of the initial activation set. Models
 *       activate them by calling `discover_agent_tools` once; the resulting
 *       `addedToolNames` are appended to the active set across turns
 *       (`resolveActiveToolNames` in deferredTools.ts).
 *
 *  The deferred activation mechanism, capability gate, fail-closed hooks, and
 *  `prepareNextTurn` discovery-rescue all remain unchanged.
 */
// 主 Agent 启动即激活的 L0 只读工具集，受 capability 门控（见下方 registeredNames 检查）。
// 子代理另有固定不变的只读工具集（subagent/readonlyTools.ts 的 SUBAGENT_READONLY_TOOL_FACTORIES），
// 二者字面相同但语义独立——主 Agent 集随能力动态加入激活集，子代理集是子上下文唯一可用工具。
const ALWAYS_ACTIVE_READ_TOOLS = ['read', 'ls', 'grep', 'find'] as const

export const createProductToolRuntime = (
  capabilities: AgentCapability[],
  environment: AgentEnvironment = desktopAgentEnvironment,
): ProductToolRuntime => {
  const productTools = createToolRegistry({ capabilities, environment })
  const registeredNames = new Set(productTools.map((tool) => tool.name))
  // Compute the initial active set first so discover can filter against it
  // and avoid leaking L0 tools as fake `addedToolNames`.
  const initialActive: string[] = []
  for (const name of ALWAYS_ACTIVE_READ_TOOLS) {
    if (registeredNames.has(name)) initialActive.push(name)
  }
  // discover must filter against the initial active set so its `addedToolNames`
  // stays a true delta (no L0 tool leakage) and OpenAI Responses's deferred
  // placement stays coherent across the lifecycle.
  const discoveryTool = createDiscoverAgentToolsTool(productTools, initialActive)
  // discover is always pinned to the front of the active list.
  initialActive.unshift(discoveryTool.name)
  return {
    discoveryToolName: discoveryTool.name,
    tools: [discoveryTool, ...productTools],
    activeToolNames: initialActive,
  }
}
