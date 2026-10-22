import { toolApprovalScope } from '@/agent/core/approvalScope'
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
    '工作区授权不能解除凭据或 Axiom 数据保护；隐私目录只开放经原生确认的项目子目录，拒绝后不要通过改名或其他工具绕过。',
    '路径默认工作区相对；完全访问模式下可用绝对路径（含工作区外），凭据与 Axiom 数据目录在任何模式下都不可写。',
    '目标路径尚不存在时用 write；原地修改用 edit。',
  ],
  // v6：结果 details 新增 diffAdded/diffRemoved/diffPreview——会话 UI 可展开查看
  // 新文件内容；schema 不变，仅输出语义增强（details 不回灌模型）。
  // v10：完全访问档真正兑现 schema 承诺——写通道消费审批租约 tier，工作区外
  // 绝对路径在 Unrestricted 租约下可用（此前仅 apply_changes/restore_trash 生效，
  // write 恒在 Rust 侧被拒）。schema 与保护路径判定不变。
  runtimeVersion: '12',
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
        description: 'File path that does not yet exist. Workspace-relative by default; absolute paths are accepted in full-access mode (protected credential and Axiom data paths stay refused). Missing parent directories are created automatically within the authorized root.',
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
      return { ok: false, error: 'path must be a non-empty path without ".." or "\\" segments; workspace-relative by default, absolute allowed in full-access mode.' }
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
      titleKey: 'app.approval.write.title',
      titleParams: { path },
      description: 'Axiom will create a new text file; existing paths are refused.',
      descriptionKey: 'app.approval.write.description',
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
    const result = await environment.workspace.createTextFile(path, content, context.approvalLease, toolApprovalScope(context))
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
