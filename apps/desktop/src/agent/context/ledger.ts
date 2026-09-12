import type {
  ContextCheckpoint,
  ContextCheckpointFacts,
  ReadProgressCursor,
  ToolLedgerEntry,
  ToolLedgerStatus,
} from './types'
import type { AgentMessage, JsonValue, ModelMessage, UserMessage } from '@/agent/core/types'
import { utf8ByteLength } from './budget'

/**
 * 确定性工作账本。
 *
 * 上下文压缩器用 LLM 生成结构化摘要，其忠实性无程序化保障、滚动压缩单向衰减。
 * 账本是与摘要解耦的确定性事实层：从工具结果 details 程序化提取文件读取游标
 * （readProgress）与执行账本（toolLedger），随 checkpoint 的 facts_json 持久化，
 * 并在投影中以 <work-ledger> 块注入模型。压缩后模型据此续读大文件、确认已完成
 * 工作，不依赖 LLM 摘要的忠实性。
 *
 * 硬预算与有界性：readProgress ≤ 32 条、toolLedger ≤ 64 条、渲染块 ≤ 8 KiB，
 * 均确定性截断，避免请求膨胀。
 */

export const MAX_READ_PROGRESS_ENTRIES = 32
export const MAX_TOOL_LEDGER_ENTRIES = 64
export const MAX_LEDGER_BLOCK_BYTES = 8 * 1024
export const LEDGER_MESSAGE_PREFIX = 'context-ledger:'

const READ_TOOL_NAMES = new Set(['read', 'read_workspace_file', 'read_authorized_text'])

const detailsObject = (message: ModelMessage): Record<string, JsonValue> | undefined =>
  message.role === 'tool' && typeof message.details === 'object'
    && message.details !== null && !Array.isArray(message.details)
    ? message.details as Record<string, JsonValue>
    : undefined

/** 规范化后的 facts：工作账本字段恒为必选，消费方无需再判可选。 */
export type NormalizedCheckpointFacts = Omit<ContextCheckpointFacts, 'readProgress' | 'toolLedger'> & {
  readProgress: Record<string, ReadProgressCursor>
  toolLedger: ToolLedgerEntry[]
}

/**
 * 对旧 checkpoint facts 补齐默认值（不可变），使缺失新字段的旧数据行为与现在一致。
 */
export const normalizeFacts = (facts: ContextCheckpointFacts): NormalizedCheckpointFacts => ({
  readFiles: facts.readFiles ?? [],
  modifiedFiles: facts.modifiedFiles ?? [],
  readProgress: facts.readProgress ?? {},
  toolLedger: facts.toolLedger ?? [],
})

const readCursorFromDetails = (details: Record<string, JsonValue>): ReadProgressCursor | undefined => {
  const nextOffset = details.nextOffset
  const totalLines = details.totalLines
  const truncated = details.truncated
  const sha256 = details.sha256
  if (typeof totalLines !== 'number' || !Number.isFinite(totalLines) || totalLines < 0) return undefined
  if (typeof truncated !== 'boolean') return undefined
  if (typeof sha256 !== 'string' || sha256.length === 0) return undefined
  if (nextOffset !== null && nextOffset !== undefined
    && (typeof nextOffset !== 'number' || !Number.isFinite(nextOffset) || nextOffset < 0)) {
    return undefined
  }
  return {
    nextOffset: typeof nextOffset === 'number' ? nextOffset : null,
    totalLines,
    truncated,
    sha256,
  }
}

/**
 * 合并读取游标：沿用最近一次 read 结果；已读完整（truncated=false 或无 nextOffset）
 * 的文件删除游标；被修改过的文件删除游标（sha256 已过期）。返回按路径字典序的
 * 新对象，上限 MAX_READ_PROGRESS_ENTRIES 条。
 */
export const mergeReadProgress = (
  previous: Record<string, ReadProgressCursor> | undefined,
  messages: ModelMessage[],
  modifiedFiles: string[],
): Record<string, ReadProgressCursor> => {
  const cursors = new Map<string, ReadProgressCursor>(Object.entries(previous ?? {}))
  for (const message of messages) {
    if (message.role !== 'tool' || message.isError) continue
    const details = detailsObject(message)
    if (!details) continue
    const path = typeof details.path === 'string' ? details.path : undefined
    if (!path || !READ_TOOL_NAMES.has(message.toolName)) continue
    if (details.truncated === false || details.nextOffset === null || details.nextOffset === undefined) {
      cursors.delete(path)
      continue
    }
    const cursor = readCursorFromDetails(details)
    if (cursor) cursors.set(path, cursor)
  }
  for (const path of modifiedFiles) cursors.delete(path)
  const entries = Array.from(cursors.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_READ_PROGRESS_ENTRIES)
  return Object.fromEntries(entries)
}

/**
 * 合并执行账本：遍历所有工具结果（含 isError——中断占位标记 pending），以
 * toolCallId 去重、同 id 后见更新并移到末尾。与旧账本合并后截尾保留最近
 * MAX_TOOL_LEDGER_ENTRIES 条。
 */
export const mergeToolLedger = (
  previous: ToolLedgerEntry[] | undefined,
  messages: ModelMessage[],
): ToolLedgerEntry[] => {
  const byId = new Map<string, ToolLedgerEntry>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    const details = detailsObject(message)
    // 应用退出的中断占位标记为 interrupted（非 pending）：工具已停、副作用状态未知，
    // 不应被模型误读为"进行中待继续"。恢复确认后该占位不会被同 id 覆盖（新调用是新 id），
    // 用 interrupted 语义避免长期误导。
    const status: ToolLedgerStatus = details?.reason === 'application_exit'
      ? 'interrupted'
      : 'done'
    const path = typeof details?.path === 'string' ? details.path : null
    const entry: ToolLedgerEntry = {
      id: message.toolCallId,
      tool: message.toolName,
      path,
      status,
    }
    byId.delete(entry.id)
    byId.set(entry.id, entry)
  }
  const previousKept = (previous ?? []).filter((entry) => !byId.has(entry.id))
  return [...previousKept, ...byId.values()].slice(-MAX_TOOL_LEDGER_ENTRIES)
}

const serializeEntry = (entry: ToolLedgerEntry): string =>
  JSON.stringify({ id: entry.id, tool: entry.tool, path: entry.path, status: entry.status })

const serializeCursor = (path: string, cursor: ReadProgressCursor): string =>
  JSON.stringify({ path, nextOffset: cursor.nextOffset, totalLines: cursor.totalLines, sha256: cursor.sha256 })

const truncateBytes = (value: string, maxBytes: number): string => {
  if (utf8ByteLength(value) <= maxBytes) return value
  const suffix = '\n[… 账本按输入上限截断]'
  const budget = Math.max(0, maxBytes - utf8ByteLength(suffix))
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (utf8ByteLength(value.slice(0, middle)) <= budget) low = middle
    else high = middle - 1
  }
  return `${value.slice(0, low)}${suffix}`
}

/**
 * 渲染确定性账本块。空账本返回 ''。硬预算 8 KiB：先丢 toolLedger 最旧条目、
 * 再丢 readProgress 字典序尾部，直至不超过上限。
 */
export const formatLedgerBlock = (facts: ContextCheckpointFacts): string => {
  const { readProgress, toolLedger } = normalizeFacts(facts)
  const readEntries = Object.entries(readProgress)
  const toolEntries = toolLedger
  if (readEntries.length === 0 && toolEntries.length === 0) return ''
  const render = (reads: Array<[string, ReadProgressCursor]>, tools: ToolLedgerEntry[]): string => {
    const sections: string[] = []
    if (reads.length > 0) {
      sections.push(`<read-progress>\n${reads.map(([path, cursor]) => serializeCursor(path, cursor)).join('\n')}\n</read-progress>`)
    }
    if (tools.length > 0) {
      sections.push(`<tool-ledger>\n${tools.map(serializeEntry).join('\n')}\n</tool-ledger>`)
      if (tools.some((entry) => entry.status === 'interrupted')) {
        sections.push(
          '<tool-ledger-note>interrupted 表示该工具调用因应用退出被中断、实际状态未确认；'
            + '请先核实副作用是否已生效再决定是否重试，勿盲目重放。</tool-ledger-note>',
        )
      }
    }
    return `<work-ledger>\n${sections.join('\n\n')}\n</work-ledger>`
  }
  let body = render(readEntries, toolEntries)
  if (utf8ByteLength(body) <= MAX_LEDGER_BLOCK_BYTES) return body
  // 先丢最旧的 toolLedger 条目（尾部即最旧），再丢 readProgress 尾部。
  for (let trimmed = 1; trimmed <= toolEntries.length; trimmed += 1) {
    body = render(readEntries, toolEntries.slice(0, toolEntries.length - trimmed))
    if (utf8ByteLength(body) <= MAX_LEDGER_BLOCK_BYTES) return body
  }
  let reads = readEntries
  while (utf8ByteLength(render(reads, [])) > MAX_LEDGER_BLOCK_BYTES && reads.length > 0) {
    reads = reads.slice(0, reads.length - 1)
  }
  return truncateBytes(render(reads, []), MAX_LEDGER_BLOCK_BYTES)
}

/**
 * 生成账本投影消息。空账本返回 undefined（旧 checkpoint 不产生额外消息，投影不变）。
 */
export const createContextLedgerMessage = (checkpoint: ContextCheckpoint): UserMessage | undefined => {
  const block = formatLedgerBlock(checkpoint.facts)
  if (!block) return undefined
  return {
    id: `${LEDGER_MESSAGE_PREFIX}${checkpoint.id}`,
    role: 'user',
    content: block,
    createdAt: checkpoint.createdAt,
  }
}

export const isContextLedgerMessage = (message: AgentMessage): boolean =>
  message.role === 'user' && message.id.startsWith(LEDGER_MESSAGE_PREFIX)
