import type { AgentTool, JsonValue } from '@/agent/core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { desktopAgentEnvironment } from '@/agent/environment/agentEnvironmentHost'
import { hasOnlyKeys, isJsonObject, isMutablePath, sha256Text } from './workspaceToolUtils'
import { buildEditResultDiff } from './toolDiff'

const MAX_TEXT_BYTES = 1024 * 1024
const MAX_PREVIEW_CHARS = 12_000
const MAX_EDITS = 64

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

interface EditInput {
  path: string
  edits: Array<{ oldText: string; newText: string }>
}

const isEditOp = (value: JsonValue): value is { oldText: string; newText: string } => {
  if (!isJsonObject(value)) return false
  // Mirror the schema's `additionalProperties: false`: only `oldText` and
  // `newText` are allowed. Without this, non-schema-validated paths
  // (e.g. direct validate() in tests) silently accept extra fields.
  if (!hasOnlyKeys(value, ['oldText', 'newText'])) return false
  return typeof value.oldText === 'string' && typeof value.newText === 'string'
}

const asEditInput = (input: JsonValue): EditInput => {
  if (
    !isJsonObject(input)
    || typeof input.path !== 'string'
    || !Array.isArray(input.edits)
  ) {
    throw new Error('Invalid edit arguments.')
  }
  return {
    path: input.path,
    edits: (input.edits as JsonValue[]).map((edit) => {
      if (!isEditOp(edit)) throw new Error('Invalid edit arguments.')
      return { oldText: edit.oldText, newText: edit.newText }
    }),
  }
}

const diffBlock = (prefix: '-' | '+', value: string): { content: string; truncated: boolean } => {
  const truncated = value.length > MAX_PREVIEW_CHARS
  const visible = truncated ? value.slice(0, MAX_PREVIEW_CHARS) : value
  return {
    content: visible.split('\n').map((line) => `${prefix} ${line}`).join('\n'),
    truncated,
  }
}

const createEditPreview = (path: string, oldText: string, newText: string): string => {
  const removed = diffBlock('-', oldText)
  const added = diffBlock('+', newText)
  const truncated = removed.truncated || added.truncated
  return `--- ${path}\n+++ ${path}\n${removed.content}\n${added.content}${truncated ? '\n… [preview truncated]' : ''}`
}

/**
 * Compatibility shim run before schema validation. Mirrors pi's
 * `prepareEditArguments` (`edit.ts:94-118`):
 * 1. Upgrade the legacy single `{oldText,newText}` form into `edits:[…]`.
 * 2. Parse `edits` when a model emits it as a JSON string (seen on Opus 4.6 /
 *    GLM-5.1).
 */
const prepareEditArguments = (input: JsonValue): JsonValue => {
  if (!isJsonObject(input)) return input
  const args: Record<string, unknown> = { ...input }
  // Some models send edits as a JSON string instead of an array.
  if (typeof args.edits === 'string') {
    try {
      const parsed = JSON.parse(args.edits)
      if (Array.isArray(parsed)) args.edits = parsed
    } catch {
      /* leave as-is; validate will reject it */
    }
  }
  // Upgrade legacy single oldText/newText into an edits array.
  if (typeof args.oldText === 'string' && typeof args.newText === 'string') {
    const edits = Array.isArray(args.edits) ? [...(args.edits as unknown[])] : []
    edits.push({ oldText: args.oldText, newText: args.newText })
    delete args.oldText
    delete args.newText
    args.edits = edits
  }
  return args as JsonValue
}

export const createEditTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'edit',
  label: 'edit',
  promptSnippet: '对一个工作区文件执行一次或多次精确的 oldText → newText 替换。',
  promptGuidelines: [
    '每条 edits[].oldText 必须在文件中精确匹配一次（模糊匹配可容忍智能引号、连字符和空白差异），并尽量短小同时保持唯一。',
    '修改同一文件的多个不相邻位置时，在一次调用里传入多条互不重叠的 edit；重叠的 edit 会被拒绝。',
  ],
  // v7：结果 details 新增 diffAdded/diffRemoved/diffPreview——会话 UI 可展开查看
  // 改动 diff；schema 不变，仅输出语义增强（details 不回灌模型）。
  runtimeVersion: '7',
  recoveryPolicy: 'idempotent',
  prepareArguments: prepareEditArguments,
  idempotencyKey: async (input) => {
    if (!isJsonObject(input)) return 'edit:invalid'
    const path = typeof input.path === 'string' ? input.path : ''
    const edits = Array.isArray(input.edits) ? input.edits : []
    const canonical = JSON.stringify({
      path,
      edits: edits.map((edit) => {
        if (!isJsonObject(edit)) return null
        return { oldText: edit.oldText ?? '', newText: edit.newText ?? '' }
      }),
    })
    return `edit:${path}:${await sha256Text(canonical)}`
  },
  description:
    'Apply one or more precise oldText → newText replacements to a UTF-8 text file inside the authorized workspace. Each oldText must occur exactly once in the file; otherwise the call is rejected. Fuzzy matching tolerates differences in smart quotes, Unicode dashes, and whitespace. Edits must not overlap. Each invocation requires an approval lease and is recorded in the audit log.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace-relative path of the file to edit.',
      },
      edits: {
        type: 'array',
        description: 'One or more non-overlapping { oldText, newText } replacements, applied in one approval.',
        items: {
          type: 'object',
          properties: {
            oldText: {
              type: 'string',
              description: 'Exact, non-empty substring that occurs once in the file.',
            },
            newText: {
              type: 'string',
              description: 'Replacement text (may be empty).',
            },
          },
          required: ['oldText', 'newText'],
          additionalProperties: false,
        },
      },
    },
    required: ['path', 'edits'],
    additionalProperties: false,
  },
  executionMode: 'sequential',
  requiresApproval: true,
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['path', 'edits'])) {
      return { ok: false, error: 'Arguments must be an object with only path and edits.' }
    }
    if (typeof input.path !== 'string' || !isMutablePath(input.path)) {
      return { ok: false, error: 'path must be a non-empty workspace-relative path without "..", "\\", or ".git"/".axiom" segments.' }
    }
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      return { ok: false, error: 'edits must be a non-empty array of { oldText, newText } objects.' }
    }
    if (input.edits.length > MAX_EDITS) {
      return { ok: false, error: `edits must contain at most ${MAX_EDITS} replacements.` }
    }
    for (const edit of input.edits) {
      if (!isEditOp(edit)) {
        return { ok: false, error: 'Each edit must be an object with string oldText and newText.' }
      }
      if (edit.oldText.length === 0) {
        return { ok: false, error: 'oldText must be a non-empty string.' }
      }
      if (byteLength(edit.oldText) > MAX_TEXT_BYTES || byteLength(edit.newText) > MAX_TEXT_BYTES) {
        return { ok: false, error: 'oldText/newText must each be at most 1 MiB.' }
      }
    }
    return { ok: true, value: input }
  },
  approvalPresentation: (input) => {
    const { path, edits } = asEditInput(input)
    const preview = edits
      .map((edit, index) => {
        const header = edits.length > 1 ? `@@ edit ${index + 1} @@\n` : ''
        return header + createEditPreview(path, edit.oldText, edit.newText)
      })
      .join('\n')
    return {
      category: 'workspace-write',
      title: edits.length > 1 ? `Edit ${path} (${edits.length} replacements)?` : `Edit ${path}?`,
      description: 'Axiom applies the replacements only when every oldText matches the file exactly once.',
      path,
      preview,
    }
  },
  auditArguments: (input) => {
    const { path, edits } = asEditInput(input)
    return {
      path,
      editCount: edits.length,
      oldTextBytes: edits.map((edit) => byteLength(edit.oldText)),
      newTextBytes: edits.map((edit) => byteLength(edit.newText)),
    }
  },
  execute: async (input, context) => {
    if (!context.approvalLease) throw new Error('Missing workspace approval lease.')
    if (!isJsonObject(input)) throw new Error('Invalid edit arguments.')
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const { path, edits } = asEditInput(input)
    const result = await environment.workspace.editTextFile(path, edits, context.approvalLease)
    // Rust 已成功落盘：abort 信号只在编辑完成后到达时，不把已生效的编辑判为失败
    // （对齐 applyChangesTool/restoreTrashTool 的 completedAfterAbort 语义）。
    const completedAfterAbort = context.signal.aborted
    return {
      content: `Edited ${result.path} (${result.sizeBytes} bytes, ${edits.length} replacement${edits.length > 1 ? 's' : ''}). New sha256: ${result.sha256}.${completedAfterAbort ? ' Abort signal arrived after the edit was applied.' : ''}`,
      details: {
        workspace: result.workspace.path,
        path: result.path,
        sizeBytes: result.sizeBytes,
        sha256: result.sha256,
        editCount: edits.length,
        operation: 'edited',
        completedAfterAbort,
        ...buildEditResultDiff(result.path, edits),
      },
    }
  },
})

export const editTool = createEditTool(desktopAgentEnvironment)
