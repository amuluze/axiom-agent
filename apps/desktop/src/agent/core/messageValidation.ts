import { snapshotAgentMessages } from './snapshots'
import type { AgentContext, AgentMessage } from './types'

/**
 * 校验传入的消息数组结构合法、角色字段一致、ID 不重复。
 * 校验通过后返回隔离快照副本，避免上游改动污染内部状态。
 */
export const validatedMessages = (
  value: AgentMessage[],
  label: string,
  existingIds: ReadonlySet<string> = new Set(),
): AgentMessage[] => {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是消息数组`)
  const messages = snapshotAgentMessages(value)
  const ids = new Set(existingIds)
  for (const message of messages) {
    if (!message || typeof message !== 'object'
      || typeof message.id !== 'string' || !message.id
      || typeof message.createdAt !== 'number' || !Number.isFinite(message.createdAt)
      || !['user', 'assistant', 'tool', 'custom'].includes(message.role)
      || typeof message.content !== 'string') {
      throw new Error(`${label} 包含格式无效的消息`)
    }
    if ((message.role === 'assistant'
      && (!Array.isArray(message.toolCalls)
        || !['stop', 'tool_use', 'length', 'error', 'aborted'].includes(message.stopReason)))
      || (message.role === 'tool'
        && (typeof message.toolCallId !== 'string'
          || typeof message.toolName !== 'string'
          || typeof message.isError !== 'boolean'))
      || (message.role === 'custom' && typeof message.customType !== 'string')) {
      throw new Error(`${label} 包含角色字段无效的消息`)
    }
    if (ids.has(message.id)) throw new Error(`${label} 包含重复消息 ID：${message.id}`)
    ids.add(message.id)
  }
  return messages
}

/** 用 JSON 字符串比较两个运行时值是否结构相等。 */
export const sameRuntimeValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

/** 投影出 context 中工具相关的可观察快照（工具名 + 激活工具名）。 */
export const runtimeToolsSnapshot = (context: AgentContext) => ({
  toolNames: context.tools.map((tool) => tool.name),
  activeToolNames: context.activeToolNames?.slice() ?? context.tools.map((tool) => tool.name),
})
