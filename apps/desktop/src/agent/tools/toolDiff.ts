import type { WorkspaceChangeOperation } from '@/agent/environment/AgentEnvironment'

/**
 * 写工具结果 details 的 diff 段：行数统计 + 面向会话 UI 的统一预览文本。
 * details 只进入持久化与展示层（不回灌模型上下文），因此整体截断到上限即可；
 * 审批预览的「每条 edit 独立截断、内容必须全部可见」语义不同，不共用截断逻辑。
 */
export interface ToolResultDiff {
  diffAdded: number
  diffRemoved: number
  diffPreview: string
}

const MAX_DIFF_PREVIEW_CHARS = 12_000

interface DiffBlock {
  text: string
  lines: number
}

const diffBlock = (prefix: '-' | '+', value: string): DiffBlock => {
  const segments = value.split('\n')
  return {
    text: segments.map((line) => `${prefix} ${line}`).join('\n'),
    lines: segments.length,
  }
}

const toResultDiff = (parts: string[], added: number, removed: number): ToolResultDiff => ({
  diffAdded: added,
  diffRemoved: removed,
  diffPreview: truncatePreview(parts.join('\n')),
})

const truncatePreview = (preview: string): string =>
  preview.length > MAX_DIFF_PREVIEW_CHARS
    ? `${preview.slice(0, MAX_DIFF_PREVIEW_CHARS)}\n… [preview truncated]`
    : preview

/** edit 结果 diff：与审批预览同构（多条 edit 用 `@@ edit N @@` 分段）。 */
export const buildEditResultDiff = (
  path: string,
  edits: ReadonlyArray<{ oldText: string; newText: string }>,
): ToolResultDiff => {
  let added = 0
  let removed = 0
  const parts = edits.map((edit, index) => {
    const removedBlock = diffBlock('-', edit.oldText)
    const addedBlock = diffBlock('+', edit.newText)
    removed += removedBlock.lines
    added += addedBlock.lines
    const header = edits.length > 1 ? `@@ edit ${index + 1} @@\n` : ''
    return `${header}--- ${path}\n+++ ${path}\n${removedBlock.text}\n${addedBlock.text}`
  })
  return toResultDiff(parts, added, removed)
}

/** write 结果 diff：新文件全是新增行。 */
export const buildWriteResultDiff = (path: string, content: string): ToolResultDiff => {
  const addedBlock = diffBlock('+', content)
  return toResultDiff([`--- /dev/null\n+++ ${path}\n${addedBlock.text}`], addedBlock.lines, 0)
}

/**
 * apply_changes 结果 diff：只覆盖 create-file / patch-file 两个文本型操作；
 * 批次全为 mkdir/move/trash 时返回 undefined，details 不带 diff 段（UI 回退
 * 到 sizeBytes 展示）。
 */
export const buildApplyChangesResultDiff = (
  operations: ReadonlyArray<WorkspaceChangeOperation>,
): ToolResultDiff | undefined => {
  let added = 0
  let removed = 0
  const parts: string[] = []
  for (const operation of operations) {
    if (operation.type === 'create-file') {
      const addedBlock = diffBlock('+', operation.content)
      added += addedBlock.lines
      parts.push(`--- /dev/null\n+++ ${operation.path}\n${addedBlock.text}`)
    } else if (operation.type === 'patch-file') {
      const removedBlock = diffBlock('-', operation.oldText)
      const addedBlock = diffBlock('+', operation.newText)
      removed += removedBlock.lines
      added += addedBlock.lines
      parts.push(`--- ${operation.path}\n+++ ${operation.path}\n${removedBlock.text}\n${addedBlock.text}`)
    }
  }
  if (parts.length === 0) return undefined
  return toResultDiff(parts, added, removed)
}
