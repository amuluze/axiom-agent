import type { JsonValue } from '@/agent/core/types'

/**
 * 文件事实提取的单一实现。
 *
 * 上下文 compaction 的 checkpoint facts 与分支摘要共用同一套「读出/改出」判定。
 * 历史上两处各写一份：compaction 用显式读工具名单，branchSummary 用
 * `toolName.includes('read')`——新增/改名读工具时两者会静默分叉，而且
 * `includes('read')` 会把未来名字里带 read 的非读工具误判为读取。
 *
 * 只提取工具结果 details 中的稳定字段，不解析正文；`operation: created|edited`
 * 视为修改，修改优先于读取（同一路径不会同时留在 readFiles）。
 */
export interface FileFactMessage {
  role: string
  toolName?: string
  isError?: boolean
  details?: JsonValue
}

export interface FileFactSnapshot {
  readFiles: readonly string[]
  modifiedFiles: readonly string[]
}

export const READ_FILE_TOOL_NAMES: readonly string[] = [
  'read',
  'read_workspace_file',
  'read_authorized_text',
]

const READ_FILE_TOOL_SET = new Set(READ_FILE_TOOL_NAMES)

export const mergeFileFacts = (
  previous: FileFactSnapshot | undefined,
  messages: readonly FileFactMessage[],
): { readFiles: string[]; modifiedFiles: string[] } => {
  const readFiles = new Set(previous?.readFiles ?? [])
  const modifiedFiles = new Set(previous?.modifiedFiles ?? [])
  for (const message of messages) {
    if (message.role !== 'tool' || message.isError) continue
    if (typeof message.details !== 'object' || message.details === null) continue
    if (Array.isArray(message.details)) continue
    const details = message.details as Record<string, JsonValue>
    const path = typeof details.path === 'string' ? details.path : undefined
    if (!path) continue
    if (details.operation === 'created' || details.operation === 'edited') {
      modifiedFiles.add(path)
      continue
    }
    if (message.toolName && READ_FILE_TOOL_SET.has(message.toolName)) readFiles.add(path)
  }
  for (const path of modifiedFiles) readFiles.delete(path)
  return {
    readFiles: Array.from(readFiles).sort(),
    modifiedFiles: Array.from(modifiedFiles).sort(),
  }
}
