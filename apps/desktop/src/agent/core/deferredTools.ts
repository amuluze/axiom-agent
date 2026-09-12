import type {
  AgentContext,
  AgentMessage,
  AgentTool,
  ToolResultMessage,
} from './types'

const duplicateNames = (names: string[]): string[] => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) duplicates.add(name)
    seen.add(name)
  }
  return [...duplicates]
}

export const validateToolRegistry = (tools: AgentTool[]): void => {
  const names = tools.map((tool) => tool.name)
  const duplicates = duplicateNames(names)
  if (duplicates.length > 0) throw new Error(`重复工具名称：${duplicates.join(', ')}`)
  const invalid = names.filter((name) => !name.trim())
  if (invalid.length > 0) throw new Error('工具名称不能为空')
  for (const tool of tools) {
    if (typeof tool.runtimeVersion !== 'string' || !tool.runtimeVersion.trim()) {
      throw new Error(`工具 ${tool.name} 的 Runtime version 不能为空`)
    }
    if (tool.recoveryPolicy === 'idempotent' && !tool.idempotencyKey) {
      throw new Error(`幂等工具 ${tool.name} 必须提供 idempotencyKey`)
    }
    if (tool.recoveryPolicy !== 'idempotent' && tool.idempotencyKey) {
      throw new Error(`工具 ${tool.name} 只有声明 idempotent 后才能提供 idempotencyKey`)
    }
  }
}

export const validateActiveToolNames = (
  toolNames: string[],
  tools: AgentTool[],
): string[] => {
  validateToolRegistry(tools)
  const duplicates = duplicateNames(toolNames)
  if (duplicates.length > 0) throw new Error(`重复工具名称：${duplicates.join(', ')}`)
  const registry = new Set(tools.map((tool) => tool.name))
  const unknown = toolNames.filter((name) => !registry.has(name))
  if (unknown.length > 0) throw new Error(`未知工具：${unknown.join(', ')}`)
  return toolNames.slice()
}

export const validateAddedToolNames = (
  toolNames: string[] | undefined,
  tools: AgentTool[],
): string[] => {
  if (!toolNames || toolNames.length === 0) return []
  return validateActiveToolNames(toolNames, tools)
}

const additionsFromMessage = (message: AgentMessage): string[] => {
  if (message.role !== 'tool' || message.isError) return []
  if (message.addedToolNames && message.addedToolNames.length > 0) {
    return message.addedToolNames
  }
  return []
}

export const resolveActiveToolNames = (
  tools: AgentTool[],
  messages: AgentMessage[],
  initialActiveToolNames?: string[],
): string[] => {
  validateToolRegistry(tools)
  const initial = validateActiveToolNames(
    initialActiveToolNames ?? tools.map((tool) => tool.name),
    tools,
  )
  const active = new Set(initial)
  for (const message of messages) {
    const additions = validateAddedToolNames(additionsFromMessage(message), tools)
    for (const name of additions) active.add(name)
  }
  return tools.flatMap((tool) => active.has(tool.name) ? [tool.name] : [])
}

export const normalizeAgentContextTools = (context: AgentContext): AgentContext => ({
  ...context,
  messages: context.messages.slice(),
  tools: context.tools.slice(),
  activeToolNames: resolveActiveToolNames(
    context.tools,
    context.messages,
    context.activeToolNames,
  ),
})

export const activeToolsForContext = (context: AgentContext): AgentTool[] => {
  const names = new Set(resolveActiveToolNames(
    context.tools,
    context.messages,
    context.activeToolNames,
  ))
  return context.tools.filter((tool) => names.has(tool.name))
}

export const activateToolResults = (
  context: AgentContext,
  results: ToolResultMessage[],
): AgentContext => ({
  ...context,
  activeToolNames: resolveActiveToolNames(
    context.tools,
    results,
    context.activeToolNames,
  ),
})
