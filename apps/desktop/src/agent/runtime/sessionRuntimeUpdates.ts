/**
 * 会话运行时更新的解析与快照（自 AgentSession 抽出的纯函数簇）。
 *
 * 两个函数都不读会话实例状态：`snapshotRuntimeUpdate` 做深拷贝隔离（入队前冻结，
 * 避免调用方后续就地修改工具表），`resolveRuntimeUpdate` 把一次更新合并进上下文并
 * 校验工具注册表与活动名。副作用（入队、广播、落库）仍由 AgentSession 承担。
 */
import {
  normalizeAgentContextTools,
  validateActiveToolNames,
  validateToolRegistry,
} from '@/agent/core/deferredTools'
import { snapshotAgentTools } from '@/agent/core/snapshots'
import type {
  AgentContext,
  AgentTool,
  ModelReasoning,
  ModelRef,
  ModelTransport,
} from '@/agent/core/types'

export interface AgentRuntimeUpdate {
  systemPrompt?: string
  model?: ModelRef
  reasoning?: ModelReasoning | null
  tools?: AgentTool[]
  activeToolNames?: string[]
  transport?: ModelTransport
}

export const resolveRuntimeUpdate = (
  current: AgentContext,
  update: AgentRuntimeUpdate,
): { context: AgentContext; activeToolNames: string[] } => {
  const tools = update.tools ? snapshotAgentTools(update.tools) : current.tools
  const activeToolNames = update.activeToolNames?.slice()
    ?? (update.tools ? tools.map((tool) => tool.name) : current.activeToolNames?.slice()
      ?? tools.map((tool) => tool.name))
  validateToolRegistry(tools)
  validateActiveToolNames(activeToolNames, tools)
  return {
    context: normalizeAgentContextTools({
      ...current,
      systemPrompt: update.systemPrompt ?? current.systemPrompt,
      model: update.model ? structuredClone(update.model) : current.model,
      reasoning: update.reasoning === null
        ? undefined
        : update.reasoning
          ? structuredClone(update.reasoning)
          : current.reasoning,
      messages: current.messages,
      tools,
      activeToolNames,
    }),
    activeToolNames,
  }
}

export const snapshotRuntimeUpdate = (update: AgentRuntimeUpdate): AgentRuntimeUpdate => ({
  ...(update.systemPrompt !== undefined ? { systemPrompt: update.systemPrompt } : {}),
  ...(update.model ? { model: structuredClone(update.model) } : {}),
  ...(update.reasoning === null
    ? { reasoning: null }
    : update.reasoning ? { reasoning: structuredClone(update.reasoning) } : {}),
  ...(update.tools ? { tools: snapshotAgentTools(update.tools) } : {}),
  ...(update.activeToolNames ? { activeToolNames: update.activeToolNames.slice() } : {}),
  ...(update.transport ? { transport: update.transport } : {}),
})
