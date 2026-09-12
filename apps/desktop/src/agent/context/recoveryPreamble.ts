import { utf8ByteLength } from './budget'
import { normalizeFacts } from './ledger'
import type { ContextCheckpoint } from './types'
import type { AgentMessage, JsonValue, ToolResultMessage, UserMessage } from '@/agent/core/types'

/**
 * 恢复前导语。
 *
 * 应用重启后，Rust 恢复流程（recover_repository）会把中断的工具调用注入为
 * `tool-interrupted-*` 占位结果消息。模型仅凭这些错误占位可能不理解上下文。
 * 本模块在投影层为含占位的会话前置注入一条确定性中文说明，解释"发生了什么"
 * （应用退出、Run 中断、未完成工具已注入占位、勿盲目重放），并附检查点覆盖统计。
 *
 * 与 `<context-summary>` 同模式：只存在于投影（context.messages），由消息历史
 * 每次重建，不入 SQLite 审计链；id 由占位集合确定，跨 bind 天然幂等。
 */

export const RECOVERY_MESSAGE_PREFIX = 'context-recovery:'
export const MAX_RECOVERY_PREAMBLE_BYTES = 512

const INTERRUPTED_ID_PREFIX = 'tool-interrupted-'

const detailsObject = (message: ToolResultMessage): Record<string, JsonValue> | undefined =>
  typeof message.details === 'object' && message.details !== null && !Array.isArray(message.details)
    ? message.details as Record<string, JsonValue>
    : undefined

/** 收集恢复路径注入的中断工具占位消息（Rust recovery.rs 与 TS interruptedToolRecovery 同语义）。 */
export const collectInterruptedPlaceholders = (messages: AgentMessage[]): ToolResultMessage[] =>
  messages.filter((message): message is ToolResultMessage =>
    message.role === 'tool'
    && message.id.startsWith(INTERRUPTED_ID_PREFIX)
    && detailsObject(message)?.reason === 'application_exit')

/**
 * 同步 32 位 FNV-1a 哈希（hex）。buildContextProjection 是同步函数，
 * 不能依赖 async crypto.subtle；FNV-1a 足够区分占位集合且零依赖。
 */
export const fnv1a32 = (input: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const truncateBytes = (value: string, maxBytes: number): string => {
  if (utf8ByteLength(value) <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (utf8ByteLength(value.slice(0, middle)) <= maxBytes) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

const buildCoverage = (checkpoint: ContextCheckpoint | null | undefined): string => {
  if (!checkpoint) return ''
  const facts = normalizeFacts(checkpoint.facts)
  const readProgressCount = Object.keys(facts.readProgress).length
  const pendingCount = facts.toolLedger.filter((entry) => entry.status === 'pending').length
  return `此前上下文已压缩为检查点：${facts.readFiles.length} 个已读文件、`
    + `${facts.modifiedFiles.length} 个已修改文件、${readProgressCount} 个续读游标、`
    + `${pendingCount} 个进行中工具。`
}

/**
 * 生成恢复前导语投影消息。无占位时返回 undefined（普通会话零成本）。
 * id 由排序后的占位消息 id 哈希确定，同占位集合跨 bind 幂等。
 */
export const createRecoveryPreambleMessage = (
  messages: AgentMessage[],
  checkpoint: ContextCheckpoint | null | undefined,
): UserMessage | undefined => {
  const placeholders = collectInterruptedPlaceholders(messages)
  if (placeholders.length === 0) return undefined
  const coverage = buildCoverage(checkpoint)
  const content = truncateBytes(
    `[恢复说明] 应用在上一会话运行中退出，Agent Run 已被中断，`
    + `${placeholders.length} 个未完成工具调用已注入占位结果（tool-interrupted-），`
    + `标记"已发起但未确认完成"的副作用，请勿盲目重放。${coverage}请先确认当前状态再决定是否继续。`,
    MAX_RECOVERY_PREAMBLE_BYTES,
  )
  const idSeed = placeholders.map((message) => message.id).sort().join('\0')
  return {
    id: `${RECOVERY_MESSAGE_PREFIX}${fnv1a32(idSeed)}`,
    role: 'user',
    content,
    createdAt: placeholders.reduce((latest, message) => Math.max(latest, message.createdAt), 0),
  }
}

export const isRecoveryPreambleMessage = (message: AgentMessage): boolean =>
  message.role === 'user' && message.id.startsWith(RECOVERY_MESSAGE_PREFIX)
