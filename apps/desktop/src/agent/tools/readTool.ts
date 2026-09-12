import type { AgentTool, JsonValue, ToolResultContentBlock } from '@/agent/core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { desktopAgentEnvironment } from '@/agent/environment/agentEnvironmentHost'
import { DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from './truncate'
import { hasOnlyKeys, isJsonObject, optionalInteger } from './workspaceToolUtils'

const MAX_PATH_LENGTH = 16 * 1024

const normalizeRelativePath = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('/') || /^[a-z]:[\\/]/iu.test(trimmed)) return trimmed
  return trimmed
}

export interface ReadToolOptions {
  /** 默认读取行数上限；缺省用全局默认（200 行）。字节上限由宿主命令权威执行。 */
  maxLines?: number
}

export const createReadTool = (
  environment: AgentEnvironment,
  options: ReadToolOptions = {},
): AgentTool => {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  return {
  name: 'read',
  label: 'read',
  promptSnippet: '读取文件内容（文本或图片）。',
  promptGuidelines: [
    '查看文件时优先用 read，而非 cat / sed / head。',
    '大文件用 offset 和 limit 分页读取，不要靠猜。',
    '读取结果末尾附带完整文件 SHA-256，用于编辑冲突检测；回显内容时请保留该值。',
  ],
  runtimeVersion: '6',
  recoveryPolicy: 'idempotent',
  idempotencyKey: (input) => {
    if (!isJsonObject(input)) return 'read:invalid'
    const path = typeof input.path === 'string' ? input.path : ''
    const offset = typeof input.offset === 'number' ? input.offset : 0
    const limit = typeof input.limit === 'number' ? input.limit : 0
    return `read:${path}:${offset}:${limit}`
  },
  description:
    `Read the contents of a text or image file. Relative paths resolve inside the authorized workspace. Absolute paths anywhere on disk are read directly without asking for approval; sensitive credential locations (e.g. ~/.ssh, ~/.aws, ~/.gnupg) and Axiom's own data directory are denied by the runtime — if a read is denied, stop and explain to the user instead of retrying other paths. Pagination via offset/limit and image output apply to workspace-relative reads. Text output is truncated to ${maxLines} lines or ${DEFAULT_MAX_BYTES / 1024}KB, whichever comes first. The full-file SHA-256 is appended for edit conflict detection.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path. Relative paths are resolved inside the authorized workspace; absolute paths outside it require the user to confirm the native authorization prompt.',
      },
      offset: {
        type: 'number',
        description: '1-indexed line offset to start reading from.',
      },
      limit: {
        type: 'number',
        description: `Maximum number of lines to read (1-1000). Defaults to ${maxLines}.`,
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['path', 'offset', 'limit'])) {
      return { ok: false, error: 'Arguments must be an object with only path, offset, limit.' }
    }
    if (typeof input.path !== 'string' || !input.path.trim()) {
      return { ok: false, error: 'path must be a non-empty string.' }
    }
    if (input.path.length > MAX_PATH_LENGTH) {
      return { ok: false, error: 'path is too long.' }
    }
    if (!optionalInteger(input.offset, 1, Number.MAX_SAFE_INTEGER)) {
      return { ok: false, error: 'offset must be an integer >= 1 when provided.' }
    }
    if (!optionalInteger(input.limit, 1, 1000)) {
      return { ok: false, error: 'limit must be an integer in 1..1000.' }
    }
    return { ok: true, value: { ...input, path: normalizeRelativePath(input.path) } }
  },
  execute: async (input, context) => {
    if (!isJsonObject(input) || typeof input.path !== 'string') {
      throw new Error('Invalid read arguments.')
    }
    const path = input.path
    const isAbsolute = path.startsWith('/') || /^[a-z]:[\\/]/iu.test(path)
    const offset = typeof input.offset === 'number' ? input.offset : undefined
    const limit = typeof input.limit === 'number' ? input.limit : undefined
    if (isAbsolute) {
      const result = await environment.authorizedFiles.readText(path)
      if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const details: { [key: string]: JsonValue } = {
        path: result.file.path,
        name: result.file.name,
        sizeBytes: result.file.sizeBytes,
        source: 'absolute',
      }
      return { content: result.content, details }
    }
    const result = await environment.workspace.readText(path, offset, limit)
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const details: { [key: string]: JsonValue } = {
      workspace: result.workspace.path,
      path: result.path,
      startLine: result.startLine,
      endLine: result.endLine,
      totalLines: result.totalLines,
      truncated: result.truncated,
      ...(result.nextOffset !== undefined ? { nextOffset: result.nextOffset } : { nextOffset: null }),
      sha256: result.sha256,
      source: 'workspace',
    }
    if (result.image) {
      details.image = {
        mimeType: result.image.mimeType,
        dataBase64: result.image.dataBase64,
        resized: result.image.resized,
        ...(result.image.originalWidth !== undefined ? { originalWidth: result.image.originalWidth } : {}),
        ...(result.image.originalHeight !== undefined ? { originalHeight: result.image.originalHeight } : {}),
      }
    }
    // Image files: emit a structured image block so vision-capable models can
    // perceive the picture directly. The text content carries the note + sha.
    // Non-vision models receive only the text note (no image block) to avoid
    // sending payload the model cannot interpret.
    if (result.image) {
      const textContent = `${result.content}\n\n[Full file sha256: ${result.sha256}]`
      if (context.modelAcceptsImage === false) {
        return {
          content: `${textContent}\n\n[The current model does not support images. The image content was omitted. Describe the image to the user or switch to a vision-capable model.]`,
          details,
        }
      }
      const blocks: ToolResultContentBlock[] = [
        { type: 'text', text: textContent },
        {
          type: 'image',
          source: {
            type: 'base64',
            mediaType: result.image.mimeType,
            data: result.image.dataBase64,
          },
        },
      ]
      return {
        content: textContent,
        contentBlocks: blocks,
        details,
      }
    }
    const pagination = result.truncated && result.nextOffset
      ? `\n\n[Showing lines ${result.startLine}-${result.endLine} of ${result.totalLines}. Use offset=${result.nextOffset} to continue.]`
      : ''
    const notice = `${pagination}\n\n[Full file sha256: ${result.sha256}]`
    return { content: `${result.content}${notice}`, details }
  },
  }
}

export const readTool = createReadTool(desktopAgentEnvironment)
