import { createId } from '@/agent/core/id'
import type { AgentTool, JsonValue } from '@/agent/core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { desktopAgentEnvironment } from '@/agent/environment/agentEnvironmentHost'
import { GREP_MAX_MATCHES, GREP_MAX_LINE_LENGTH, truncateLongLine } from './truncate'
import { hasOnlyKeys, isJsonObject, isSafeRelativePath, optionalInteger } from './workspaceToolUtils'

export const createGrepTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'grep',
  label: 'grep',
  promptSnippet: '按 ripgrep 风格过滤搜索文件内容，可选上下文行。',
  promptGuidelines: [
    '传 context 可显示周边行（匹配行用 路径:N: 分隔，上下文行用 路径-N- 分隔），与 ripgrep 输出一致。',
    '结果被截断时用 glob 收窄；超过 500 字符的匹配会被裁成单行。',
  ],
  runtimeVersion: '5',
  recoveryPolicy: 'idempotent',
  idempotencyKey: (input) => {
    if (!isJsonObject(input)) return 'grep:invalid'
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    const path = typeof input.path === 'string' ? input.path : '.'
    const glob = typeof input.glob === 'string' ? input.glob : ''
    const context = typeof input.context === 'number' ? input.context : 0
    return `grep:${pattern}:${path}:${glob}:${context}`
  },
  description:
    `Search file contents inside the authorized workspace with ripgrep-style filters. Output is capped at ${GREP_MAX_MATCHES} matches; individual lines are truncated to ${GREP_MAX_LINE_LENGTH} chars. Supports regex or literal mode, optional glob, optional context lines (0-10), and respects .gitignore.`,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Pattern to search for. Regex by default; pass literal=true for verbatim matching.',
      },
      path: {
        type: 'string',
        description: 'Workspace-relative directory to search in. Defaults to the workspace root.',
      },
      glob: {
        type: 'string',
        description: 'File glob filter such as "**/*.ts".',
      },
      ignoreCase: {
        type: 'boolean',
        description: 'Match case-insensitively.',
      },
      literal: {
        type: 'boolean',
        description: 'Treat pattern as a literal string instead of a regex.',
      },
      context: {
        type: 'number',
        description: 'Number of context lines to show before and after each match (0-10, default 0). Match lines use path:N: separators; context lines use path-N-.',
      },
      limit: {
        type: 'number',
        description: `Maximum number of matches to return (1-${GREP_MAX_MATCHES}).`,
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['pattern', 'path', 'glob', 'ignoreCase', 'literal', 'context', 'limit'])) {
      return { ok: false, error: 'Unsupported grep argument.' }
    }
    if (typeof input.pattern !== 'string' || !input.pattern.trim() || input.pattern.length > 1024) {
      return { ok: false, error: 'pattern must be a 1..1024 character string.' }
    }
    if (input.path !== undefined && (typeof input.path !== 'string' || !isSafeRelativePath(input.path, true))) {
      return { ok: false, error: 'path must be a workspace-relative directory without "..".' }
    }
    if (input.glob !== undefined && (typeof input.glob !== 'string' || input.glob.length > 512)) {
      return { ok: false, error: 'glob must be a string no longer than 512 chars.' }
    }
    if (input.ignoreCase !== undefined && typeof input.ignoreCase !== 'boolean') {
      return { ok: false, error: 'ignoreCase must be a boolean.' }
    }
    if (input.literal !== undefined && typeof input.literal !== 'boolean') {
      return { ok: false, error: 'literal must be a boolean.' }
    }
    if (!optionalInteger(input.context, 0, 10)) {
      return { ok: false, error: 'context must be an integer between 0 and 10.' }
    }
    if (!optionalInteger(input.limit, 1, GREP_MAX_MATCHES)) {
      return { ok: false, error: `limit must be an integer between 1 and ${GREP_MAX_MATCHES}.` }
    }
    return { ok: true, value: input }
  },
  execute: async (input, context) => {
    if (!isJsonObject(input) || typeof input.pattern !== 'string') throw new Error('Invalid grep arguments.')
    await context.reportProgress('Searching workspace', {
      pattern: input.pattern,
      path: typeof input.path === 'string' ? input.path : '.',
    })
    const result = await environment.workspace.searchText({
      requestId: createId('workspace-search'),
      pattern: input.pattern,
      path: typeof input.path === 'string' ? input.path : undefined,
      glob: typeof input.glob === 'string' ? input.glob : undefined,
      ignoreCase: typeof input.ignoreCase === 'boolean' ? input.ignoreCase : undefined,
      literal: typeof input.literal === 'boolean' ? input.literal : undefined,
      context: typeof input.context === 'number' ? input.context : undefined,
      limit: typeof input.limit === 'number' ? input.limit : undefined,
    }, context.signal)
    const lines = result.matches.length > 0
      ? result.matches.flatMap((match) => {
          const matchedLine = truncateLongLine(match.line, GREP_MAX_LINE_LENGTH)
          // Match line plus its context lines, sorted by line number for natural
          // reading order. Match lines use `path:N:` separators; context lines use
          // `path-N-`, mirroring ripgrep's native output.
          const entries: string[] = [`${match.path}:${match.lineNumber}: ${matchedLine}`]
          for (const ctx of match.contextLines ?? []) {
            const ctxLine = truncateLongLine(ctx.line, GREP_MAX_LINE_LENGTH)
            entries.push(`${match.path}-${ctx.lineNumber}- ${ctxLine}`)
          }
          entries.sort((a, b) => grepLineNumber(a) - grepLineNumber(b))
          return entries
        })
      : ['No matches found.']
    // Separate match groups (from different files or non-adjacent matches) with a blank line,
    // matching ripgrep's grouping. We rebuild grouping using match boundaries.
    const grouped = groupGrepOutput(result.matches, lines)
    const footer = result.truncated
      ? `\n\n[Match cap (${GREP_MAX_MATCHES}) reached. Refine the glob, restrict the path, or pass a larger limit.]`
      : ''
    const details: { [key: string]: JsonValue } = {
      workspace: result.workspace.path,
      matches: result.matches.map((match): { [key: string]: JsonValue } => {
        const entry: { [key: string]: JsonValue } = {
          path: match.path,
          lineNumber: match.lineNumber,
          line: match.line,
        }
        if (match.contextLines) {
          entry.contextLines = match.contextLines.map((ctx) => ({
            lineNumber: ctx.lineNumber,
            line: ctx.line,
            isMatch: ctx.isMatch,
          }))
        }
        return entry
      }),
      truncated: result.truncated,
    }
    return {
      content: `${grouped}${footer}`,
      details,
    }
  },
})

/** Extract the line number from a grep output line of the form `path:N:` or `path-N-`. */
const grepLineNumber = (entry: string): number => {
  // Match line uses `path:N:`, context uses `path-N-`. Find the separator after the path.
  const colonMatch = entry.indexOf(':')
  const dashMatch = entry.indexOf('-')
  const sep = colonMatch === -1 ? dashMatch : dashMatch === -1 ? colonMatch : Math.min(colonMatch, dashMatch)
  if (sep === -1) return Number.MAX_SAFE_INTEGER
  const rest = entry.slice(sep + 1)
  const num = parseInt(rest, 10)
  return Number.isNaN(num) ? Number.MAX_SAFE_INTEGER : num
}

/**
 * Re-insert blank lines between distinct match groups so the output reads like
 * ripgrep. Each match contributes (1 + contextLines.length) rendered lines; we
 * walk them in order and break groups when the source match index advances.
 */
const groupGrepOutput = (
  matches: Array<{ path: string; lineNumber: number; contextLines?: unknown[] }>,
  flatLines: string[],
): string => {
  if (matches.length <= 1) return flatLines.join('\n')
  // Reconstruct per-match slice sizes.
  const out: string[] = []
  let cursor = 0
  for (let i = 0; i < matches.length; i++) {
    if (i > 0) out.push('')
    const sliceLen = 1 + (matches[i].contextLines?.length ?? 0)
    out.push(...flatLines.slice(cursor, cursor + sliceLen))
    cursor += sliceLen
  }
  return out.join('\n')
}

export const grepTool = createGrepTool(desktopAgentEnvironment)
