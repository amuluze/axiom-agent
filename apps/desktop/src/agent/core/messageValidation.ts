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

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 对象参与比较的键：显式 `undefined` 视同缺失（与 JSON 投影一致，避免虚假差异）。 */
const comparableKeys = (value: Record<string, unknown>): string[] =>
  Object.keys(value).filter((key) => value[key] !== undefined).sort()

/**
 * 比较两个运行时值是否结构相等：对象按键集合比较（**键序无关**），数组按元素顺序比较，
 * 原始值按类型严格比较（`0` 与 `"0"` 不等）。
 *
 * 不能用 `JSON.stringify` 代替：它键序敏感（同一对象换构造顺序就判不等，产生虚假的
 * runtime_*_update 事件与持久化 churn），且会把 `0` 与 `"0"` 判为相等。两条偏差都会让
 * 「运行时是否变化」的判定偏离语义。
 */
export const sameRuntimeValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameRuntimeValue(item, right[index]))
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false
  const leftKeys = comparableKeys(left)
  const rightKeys = comparableKeys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameRuntimeValue(left[key], right[key]))
}

/** 投影出 context 中工具相关的可观察快照（工具名 + 激活工具名）。 */
export const runtimeToolsSnapshot = (context: AgentContext) => ({
  toolNames: context.tools.map((tool) => tool.name),
  activeToolNames: context.activeToolNames?.slice() ?? context.tools.map((tool) => tool.name),
})
