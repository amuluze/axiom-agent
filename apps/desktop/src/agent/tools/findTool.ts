import { createId } from '@/agent/core/id'
import type { AgentTool, JsonValue } from '@/agent/core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { desktopAgentEnvironment } from '@/agent/environment/agentEnvironmentHost'
import { FIND_MAX_RESULTS } from './truncate'
import { hasOnlyKeys, isJsonObject, isSafeRelativePath, optionalInteger } from './workspaceToolUtils'

export const createFindTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'find',
  label: 'find',
  promptSnippet: '在授权工作区内按 glob 模式查找文件和目录。',
  promptGuidelines: [
    `传入更窄的工作区相对路径可限制搜索深度；遍历上限为 ${FIND_MAX_RESULTS} 条，遵循 .gitignore，.git/node_modules/dist 等已跳过。`,
  ],
  runtimeVersion: '5',
  recoveryPolicy: 'idempotent',
  idempotencyKey: (input) => {
    if (!isJsonObject(input)) return 'find:invalid'
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    const path = typeof input.path === 'string' ? input.path : '.'
    return `find:${path}:${pattern}`
  },
  description:
    `Find files and directories inside the authorized workspace by glob pattern (e.g. "**/*.ts", "src/**/index.ts"). Output is capped at ${FIND_MAX_RESULTS} matches per call. The workspace is walked in a single pass (respecting .gitignore); .git, node_modules, target, dist, .next, and .cache are skipped.`,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match against file or directory names.',
      },
      path: {
        type: 'string',
        description: 'Workspace-relative root directory to start searching from. Defaults to the workspace root.',
      },
      limit: {
        type: 'number',
        description: `Maximum matches to return (1-${FIND_MAX_RESULTS}).`,
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['pattern', 'path', 'limit'])) {
      return { ok: false, error: 'Arguments must be an object with only pattern, path, and limit.' }
    }
    if (typeof input.pattern !== 'string' || !input.pattern.trim() || input.pattern.length > 512) {
      return { ok: false, error: 'pattern must be a 1..512 character glob string.' }
    }
    if (input.path !== undefined && (typeof input.path !== 'string' || !isSafeRelativePath(input.path, true))) {
      return { ok: false, error: 'path must be a workspace-relative directory without "..".' }
    }
    if (!optionalInteger(input.limit, 1, FIND_MAX_RESULTS)) {
      return { ok: false, error: `limit must be an integer between 1 and ${FIND_MAX_RESULTS}.` }
    }
    return { ok: true, value: input }
  },
  execute: async (input, context) => {
    if (!isJsonObject(input) || typeof input.pattern !== 'string') throw new Error('Invalid find arguments.')
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const result = await environment.workspace.find({
      requestId: createId('workspace-find'),
      pattern: input.pattern,
      path: typeof input.path === 'string' ? input.path : undefined,
      limit: typeof input.limit === 'number' ? input.limit : undefined,
      signal: context.signal,
    })
    const lines = result.matches.length > 0
      ? result.matches.map((entry) => entry.kind === 'directory' ? `${entry.path}/` : entry.path)
      : ['No matches found.']
    const footer = result.truncated
      ? `\n\n[Result cap (${FIND_MAX_RESULTS}) reached. Refine the pattern or search under a narrower path.]`
      : ''
    const details: { [key: string]: JsonValue } = {
      workspace: result.workspace.path,
      pattern: result.pattern,
      rootPath: result.rootPath,
      matches: result.matches.map((entry): { [key: string]: JsonValue } => ({
        path: entry.path,
        name: entry.name,
        kind: entry.kind,
        sizeBytes: entry.sizeBytes,
      })),
      truncated: result.truncated,
    }
    return {
      content: `${lines.join('\n')}${footer}`,
      details,
    }
  },
})

export const findTool = createFindTool(desktopAgentEnvironment)
