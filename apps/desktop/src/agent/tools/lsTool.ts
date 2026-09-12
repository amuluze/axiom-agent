import type { AgentTool } from '@/agent/core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { desktopAgentEnvironment } from '@/agent/environment/agentEnvironmentHost'
import { LS_DEFAULT_ENTRIES, LS_MAX_ENTRIES } from './truncate'
import { hasOnlyKeys, isJsonObject, isSafeRelativePath, optionalInteger } from './workspaceToolUtils'

export const createLsTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'ls',
  label: 'ls',
  promptSnippet: '列出一个目录下的条目。',
  promptGuidelines: [
    '目录以“/”结尾；传入授权工作区内的相对路径。',
  ],
  runtimeVersion: '4',
  recoveryPolicy: 'idempotent',
  idempotencyKey: (input) => {
    if (!isJsonObject(input)) return 'ls:invalid'
    const path = typeof input.path === 'string' ? input.path : '.'
    const limit = typeof input.limit === 'number' ? input.limit : 0
    return `ls:${path}:${limit}`
  },
  description:
    `List the entries inside a directory of the authorized workspace. Output defaults to ${LS_DEFAULT_ENTRIES} entries (capped at ${LS_MAX_ENTRIES}); pass limit to widen. Directories end in "/".`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace-relative directory to list. Defaults to the workspace root.',
      },
      limit: {
        type: 'number',
        description: `Maximum entries to return (1-${LS_MAX_ENTRIES}). Defaults to ${LS_DEFAULT_ENTRIES}.`,
      },
    },
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['path', 'limit'])) {
      return { ok: false, error: 'Arguments must be an object with only path and limit.' }
    }
    if (input.path !== undefined && (typeof input.path !== 'string' || !isSafeRelativePath(input.path, true))) {
      return { ok: false, error: 'path must be a workspace-relative directory without "..".' }
    }
    if (!optionalInteger(input.limit, 1, LS_MAX_ENTRIES)) {
      return { ok: false, error: `limit must be an integer between 1 and ${LS_MAX_ENTRIES}.` }
    }
    return { ok: true, value: input }
  },
  execute: async (input, context) => {
    if (!isJsonObject(input)) throw new Error('Invalid ls arguments.')
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const result = await environment.workspace.list(
      typeof input.path === 'string' ? input.path : undefined,
      typeof input.limit === 'number' ? input.limit : undefined,
    )
    const lines = result.entries.length > 0
      ? result.entries.map((entry) => entry.kind === 'directory' ? `${entry.path}/` : entry.path)
      : ['(empty directory)']
    const effectiveLimit = typeof input.limit === 'number' ? input.limit : LS_DEFAULT_ENTRIES
    const footer = result.truncated
      ? `\n\n[Entry cap (${effectiveLimit}) reached. Narrow the directory or pass a larger limit.]`
      : ''
    return {
      content: `${lines.join('\n')}${footer}`,
      details: {
        workspace: result.workspace.path,
        directory: result.directory,
        entries: result.entries.map((entry) => ({
          path: entry.path,
          name: entry.name,
          kind: entry.kind,
          sizeBytes: entry.sizeBytes,
        })),
        truncated: result.truncated,
      },
    }
  },
})

export const lsTool = createLsTool(desktopAgentEnvironment)
