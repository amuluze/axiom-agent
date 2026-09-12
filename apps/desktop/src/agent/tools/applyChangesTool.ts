import { createId } from '@/agent/core/id'
import type { AgentTool, JsonValue } from '@/agent/core/types'
import type { AgentEnvironment, WorkspaceChangeOperation } from '@/agent/environment/AgentEnvironment'
import { desktopAgentEnvironment } from '@/agent/environment/agentEnvironmentHost'
import { hasOnlyKeys, isJsonObject, isMutablePath } from './workspaceToolUtils'
import { buildApplyChangesResultDiff } from './toolDiff'

const MAX_OPERATIONS = 32
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_BATCH_TEXT_BYTES = 2 * 1024 * 1024
const MAX_PREVIEW_CHARS = 12_000
const SHA256_PATTERN = /^[a-f0-9]{64}$/iu
const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

const validHash = (value: unknown): value is string =>
  typeof value === 'string' && SHA256_PATTERN.test(value)

const asOperation = (value: JsonValue): WorkspaceChangeOperation | null => {
  if (!isJsonObject(value) || typeof value.type !== 'string') return null
  if (value.type === 'create-file') {
    if (
      !hasOnlyKeys(value, ['type', 'path', 'content'])
      || !isMutablePath(value.path)
      || typeof value.content !== 'string'
      || byteLength(value.content) > MAX_TEXT_BYTES
    ) return null
    return { type: 'create-file', path: value.path, content: value.content }
  }
  if (value.type === 'patch-file') {
    if (
      !hasOnlyKeys(value, ['type', 'path', 'expectedSha256', 'oldText', 'newText'])
      || !isMutablePath(value.path)
      || !validHash(value.expectedSha256)
      || typeof value.oldText !== 'string'
      || value.oldText.length === 0
      || typeof value.newText !== 'string'
      || byteLength(value.oldText) > MAX_TEXT_BYTES
      || byteLength(value.newText) > MAX_TEXT_BYTES
    ) return null
    return {
      type: 'patch-file',
      path: value.path,
      expectedSha256: value.expectedSha256.toLowerCase(),
      oldText: value.oldText,
      newText: value.newText,
    }
  }
  if (value.type === 'create-directory') {
    if (!hasOnlyKeys(value, ['type', 'path']) || !isMutablePath(value.path)) return null
    return { type: 'create-directory', path: value.path }
  }
  if (value.type === 'move') {
    if (
      !hasOnlyKeys(value, ['type', 'from', 'to', 'expectedSha256'])
      || !isMutablePath(value.from)
      || !isMutablePath(value.to)
      || (value.expectedSha256 !== undefined && !validHash(value.expectedSha256))
    ) return null
    return {
      type: 'move',
      from: value.from,
      to: value.to,
      ...(typeof value.expectedSha256 === 'string'
        ? { expectedSha256: value.expectedSha256.toLowerCase() }
        : {}),
    }
  }
  if (value.type === 'trash') {
    if (
      !hasOnlyKeys(value, ['type', 'path', 'expectedSha256'])
      || !isMutablePath(value.path)
      || (value.expectedSha256 !== undefined && !validHash(value.expectedSha256))
    ) return null
    return {
      type: 'trash',
      path: value.path,
      ...(typeof value.expectedSha256 === 'string'
        ? { expectedSha256: value.expectedSha256.toLowerCase() }
        : {}),
    }
  }
  return null
}

const asOperations = (input: JsonValue): WorkspaceChangeOperation[] => {
  if (!isJsonObject(input) || !Array.isArray(input.operations)) {
    throw new Error('Invalid apply_changes arguments.')
  }
  const operations = input.operations.map(asOperation)
  if (operations.some((operation) => operation === null)) {
    throw new Error('apply_changes contains invalid operations.')
  }
  return operations as WorkspaceChangeOperation[]
}

const operationPaths = (operation: WorkspaceChangeOperation): string[] =>
  operation.type === 'move' ? [operation.from, operation.to] : [operation.path]

const operationTextBytes = (operation: WorkspaceChangeOperation): number => {
  if (operation.type === 'create-file') return byteLength(operation.content)
  if (operation.type === 'patch-file') {
    return byteLength(operation.oldText) + byteLength(operation.newText)
  }
  return 0
}

const diffBlock = (prefix: '-' | '+', value: string): string =>
  value.split('\n').map((line) => `${prefix} ${line}`).join('\n')

const fullOperationPreview = (operation: WorkspaceChangeOperation): string => {
  switch (operation.type) {
    case 'create-file':
      return `--- /dev/null\n+++ ${operation.path}\n${diffBlock('+', operation.content)}`
    case 'patch-file':
      return `--- ${operation.path}\n+++ ${operation.path}\nexpected sha256 ${operation.expectedSha256}\n${diffBlock('-', operation.oldText)}\n${diffBlock('+', operation.newText)}`
    case 'create-directory':
      return `mkdir ${operation.path}`
    case 'move':
      return `move ${operation.from} -> ${operation.to}${operation.expectedSha256 ? `\nexpected sha256 ${operation.expectedSha256}` : ''}`
    case 'trash':
      return `recoverable trash ${operation.path}${operation.expectedSha256 ? `\nexpected sha256 ${operation.expectedSha256}` : ''}`
  }
}

const approvalPreview = (operation: WorkspaceChangeOperation): string => {
  const preview = fullOperationPreview(operation)
  return preview.length > MAX_PREVIEW_CHARS
    ? `${preview.slice(0, MAX_PREVIEW_CHARS)}\n… [this file preview is truncated; approval still covers the full content]`
    : preview
}

export const createApplyChangesTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'apply_changes',
  label: 'apply_changes',
  promptSnippet: '在单次逐文件审批后，原子地应用最多 32 条互不重叠的工作区变更。',
  promptGuidelines: [
    '多文件重构需要整体成功或整体回滚时，用 apply_changes。',
    '每条 patch-file 自带 expected sha256 用于冲突检测；先 read 确认后再提交。',
    'patch-file 的 oldText 是精确字节匹配（不做空白/引号归一化、区分 CRLF）且必须唯一出现一次——不同于容忍模糊差异的 edit。',
    '删除操作进入本地可恢复存储；用 restore_trash 配合 recoveryId 恢复。',
  ],
  // v5：结果 details 新增 diffAdded/diffRemoved/diffPreview（只覆盖 create-file/
  // patch-file 文本型操作）；schema 不变，仅输出语义增强（details 不回灌模型）。
  runtimeVersion: '5',
  recoveryPolicy: 'never',
  description:
    'Atomically apply up to 32 non-overlapping workspace changes after a single per-file review: create-file, patch-file (with sha256 conflict detection), create-directory, move, and recoverable trash. Any failure rolls back the partially applied steps; the request is not auto-replayed. Each invocation requires an approval lease.',
  inputSchema: {
    type: 'object',
    properties: {
      operations: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_OPERATIONS,
        description: 'Non-overlapping batch of changes; all parent directories must already exist.',
        items: {
          anyOf: [
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['create-file'] },
                path: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['type', 'path', 'content'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['patch-file'] },
                path: { type: 'string' },
                expectedSha256: { type: 'string' },
                oldText: {
                  type: 'string',
                  description: 'Exact byte substring (no normalization; CRLF-sensitive) that occurs once in the file at the expected sha256.',
                },
                newText: { type: 'string' },
              },
              required: ['type', 'path', 'expectedSha256', 'oldText', 'newText'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['create-directory'] },
                path: { type: 'string' },
              },
              required: ['type', 'path'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['move'] },
                from: { type: 'string' },
                to: { type: 'string' },
                expectedSha256: { type: 'string' },
              },
              required: ['type', 'from', 'to'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['trash'] },
                path: { type: 'string' },
                expectedSha256: { type: 'string' },
              },
              required: ['type', 'path'],
              additionalProperties: false,
            },
          ],
        },
      },
    },
    required: ['operations'],
    additionalProperties: false,
  },
  executionMode: 'sequential',
  requiresApproval: true,
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['operations'])) {
      return { ok: false, error: 'Arguments must be an object with only operations.' }
    }
    if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > MAX_OPERATIONS) {
      return { ok: false, error: `operations must contain 1-${MAX_OPERATIONS} entries.` }
    }
    const operations = input.operations.map(asOperation)
    if (operations.some((operation) => operation === null)) {
      return { ok: false, error: 'operations contain invalid paths, fields, hashes, or oversized text.' }
    }
    const typed = operations as WorkspaceChangeOperation[]
    if (typed.reduce((total, operation) => total + operationTextBytes(operation), 0) > MAX_BATCH_TEXT_BYTES) {
      return { ok: false, error: 'Batch text exceeds 2 MiB limit.' }
    }
    const paths = typed.flatMap(operationPaths).map((path) => path.split('/').filter((part) => part && part !== '.').join('/'))
    const overlapping = paths.some((path, index) => paths.some((other, otherIndex) =>
      index !== otherIndex && (path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`))))
    if (overlapping) return { ok: false, error: 'Batch must not contain duplicate or ancestor/descendant paths.' }
    return { ok: true, value: { operations: typed } }
  },
  approvalPresentation: (input) => {
    const operations = asOperations(input)
    return {
      category: 'workspace-write',
      title: `Apply ${operations.length} workspace ${operations.length === 1 ? 'change' : 'changes'} atomically?`,
      description: 'All changes share one transaction: conflicts or failures trigger rollback. Trash entries enter the Axiom recoverable store.',
      changes: operations.map((operation) => ({
        path: operation.type === 'move' ? `${operation.from} → ${operation.to}` : operation.path,
        preview: approvalPreview(operation),
      })),
    }
  },
  auditArguments: (input) => {
    const operations = asOperations(input)
    return {
      operationCount: operations.length,
      operations: operations.map((operation) => ({
        type: operation.type,
        paths: operationPaths(operation),
        textBytes: operationTextBytes(operation),
        expectedSha256: 'expectedSha256' in operation ? operation.expectedSha256 ?? null : null,
      })),
    }
  },
  execute: async (input, context) => {
    if (!context.approvalLease) throw new Error('Missing workspace approval lease.')
    if (!isJsonObject(input)) throw new Error('Invalid apply_changes arguments.')
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const operations = asOperations(input)
    const requestId = createId('workspace-change')
    const result = await environment.workspace.applyChanges(
      { requestId, operations },
      context.approvalLease,
    )
    const completedAfterAbort = context.signal.aborted
    return {
      content: [
        `Applied ${result.changes.length} workspace changes atomically.`,
        result.recoveryId ? `Recoverable trash id: ${result.recoveryId}` : '',
        completedAfterAbort ? 'Abort signal arrived mid-transaction; the transaction completed and is not auto-replayed.' : '',
      ].filter(Boolean).join('\n'),
      artifact: result.auditArtifact,
      details: {
        workspace: result.workspace.path,
        requestId: result.requestId,
        recoveryId: result.recoveryId ?? null,
        changes: result.changes.map((change) => ({
          operation: change.operation,
          path: change.path,
          destination: change.destination ?? null,
          sha256: change.sha256 ?? null,
        })),
        completedAfterAbort,
        ...(buildApplyChangesResultDiff(operations) ?? {}),
      },
    }
  },
})

export const applyChangesTool = createApplyChangesTool(desktopAgentEnvironment)
