import type { AgentTool, JsonValue } from '@/agent/core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { desktopAgentEnvironment } from '@/agent/environment/agentEnvironmentHost'
import { hasOnlyKeys, isJsonObject, isMutablePath, sha256Text } from './workspaceToolUtils'
import { buildWriteResultDiff } from './toolDiff'

const MAX_TEXT_BYTES = 1024 * 1024
const MAX_PREVIEW_CHARS = 16_000

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

const asWriteInput = (input: JsonValue): { path: string; content: string } => {
  if (!isJsonObject(input) || typeof input.path !== 'string' || typeof input.content !== 'string') {
    throw new Error('Invalid write arguments.')
  }
  return { path: input.path, content: input.content }
}

const createPreview = (path: string, content: string): string => {
  const truncated = content.length > MAX_PREVIEW_CHARS
  const visible = truncated ? content.slice(0, MAX_PREVIEW_CHARS) : content
  const additions = visible.split('\n').map((line) => `+ ${line}`).join('\n')
  return `--- /dev/null\n+++ ${path}\n${additions}${truncated ? '\n… [preview truncated]' : ''}`
}

export const createWriteTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'write',
  label: 'write',
  promptSnippet: '创建一个新的 UTF-8 文本文件（拒绝覆盖已存在的路径）。',
  promptGuidelines: [
    '目标路径尚不存在时用 write；原地修改用 edit。',
  ],
  // v6：结果 details 新增 diffAdded/diffRemoved/diffPreview——会话 UI 可展开查看
  // 新文件内容；schema 不变，仅输出语义增强（details 不回灌模型）。
  runtimeVersion: '6',
  recoveryPolicy: 'idempotent',
  idempotencyKey: async (input) => {
    const { path, content } = asWriteInput(input)
    return `write:${path}:${await sha256Text(content)}`
  },
  description:
    'Create a new UTF-8 text file inside the authorized workspace. Existing paths are refused; use edit for in-place modifications. Content is limited to 1 MiB. Each invocation requires an approval lease and is recorded in the audit log.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace-relative file path that does not yet exist.',
      },
      content: {
        type: 'string',
        description: 'Full UTF-8 content of the new file (up to 1 MiB).',
      },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  executionMode: 'sequential',
  requiresApproval: true,
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['path', 'content'])) {
      return { ok: false, error: 'Arguments must be an object with only path and content.' }
    }
    if (typeof input.path !== 'string' || !isMutablePath(input.path)) {
      return { ok: false, error: 'path must be a non-empty workspace-relative path without "..", "\\", or ".git"/".axiom" segments.' }
    }
    if (typeof input.content !== 'string') {
      return { ok: false, error: 'content must be a string.' }
    }
    if (byteLength(input.content) > MAX_TEXT_BYTES) {
      return { ok: false, error: 'content exceeds 1 MiB limit.' }
    }
    return { ok: true, value: input }
  },
  approvalPresentation: (input) => {
    const { path, content } = asWriteInput(input)
    return {
      category: 'workspace-write',
      title: `Create ${path}?`,
      description: 'Axiom will create a new text file; existing paths are refused.',
      path,
      preview: createPreview(path, content),
    }
  },
  auditArguments: (input) => {
    const { path, content } = asWriteInput(input)
    return { path, contentBytes: byteLength(content) }
  },
  execute: async (input, context) => {
    if (!context.approvalLease) throw new Error('Missing workspace approval lease.')
    if (!isJsonObject(input)) throw new Error('Invalid write arguments.')
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const { path, content } = asWriteInput(input)
    const result = await environment.workspace.createTextFile(path, content, context.approvalLease)
    // Rust 已成功落盘：abort 信号只在写盘后到达时，不把已生效的写入判为失败
    // （对齐 applyChangesTool/restoreTrashTool 的 completedAfterAbort 语义，
    // 避免模型误以为写入失败而重试——write 拒绝覆盖已存在路径）。
    const completedAfterAbort = context.signal.aborted
    return {
      content: `Created ${result.path} (${result.sizeBytes} bytes). New sha256: ${result.sha256}.${completedAfterAbort ? ' Abort signal arrived after the file was created.' : ''}`,
      details: {
        workspace: result.workspace.path,
        path: result.path,
        sizeBytes: result.sizeBytes,
        sha256: result.sha256,
        operation: 'created',
        completedAfterAbort,
        ...buildWriteResultDiff(result.path, content),
      },
    }
  },
})

export const writeTool = createWriteTool(desktopAgentEnvironment)
