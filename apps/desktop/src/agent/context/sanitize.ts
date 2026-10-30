import type { AgentMessage, JsonValue, ModelMessage, ToolResultMessage } from '@/agent/core/types'

const encoder = new TextEncoder()
const utf8ByteLength = (value: string): number => encoder.encode(value).byteLength

const SUPERSEDED_READ_PLACEHOLDER = '[Earlier read omitted: superseded by a later read of the same file range.]'
const DISCARDABLE_RESULT_PLACEHOLDER = '[Tool result omitted: no retained context value.]'
const EARLIER_IMAGE_PLACEHOLDER = '[Earlier image payload omitted from model context.]'
const CACHE_AFFINITY_REUSE_HORIZON = 3

export interface ContextSanitizerOptions {
  aggressive?: boolean
}

interface ReadRange {
  path: string
  sha256: string
  startLine: number
  endLine: number
}

const jsonRecord = (value: JsonValue | undefined): Record<string, JsonValue> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined

const readRange = (message: ToolResultMessage): ReadRange | undefined => {
  if (message.isError || (message.toolName !== 'read' && message.toolName !== 'read_workspace_file')) {
    return undefined
  }
  const details = jsonRecord(message.details)
  if (!details) return undefined
  const { path, sha256, startLine, endLine } = details
  if (
    typeof path !== 'string'
    || typeof sha256 !== 'string'
    || typeof startLine !== 'number'
    || typeof endLine !== 'number'
    || !Number.isInteger(startLine)
    || !Number.isInteger(endLine)
    || startLine < 1
    || endLine < startLine
  ) {
    return undefined
  }
  return { path, sha256, startLine, endLine }
}

const isCoveredBy = (earlier: ReadRange, later: ReadRange): boolean =>
  earlier.path === later.path
  && earlier.sha256 === later.sha256
  && later.startLine <= earlier.startLine
  && later.endLine >= earlier.endLine

const discardable = (message: ToolResultMessage): boolean =>
  jsonRecord(message.details)?.contextRetention === 'discardable'

const replaceContent = (
  message: ToolResultMessage,
  placeholder: string,
  cachedInvalidationBytes = 0,
): ToolResultMessage => {
  const originalBytes = utf8ByteLength(JSON.stringify({
    content: message.content,
    contentBlocks: message.contentBlocks,
  }))
  const replacementBytes = utf8ByteLength(JSON.stringify({ content: placeholder }))
  const savedBytes = originalBytes - replacementBytes
  if (
    savedBytes <= 0
    || (cachedInvalidationBytes > 0
      && savedBytes * CACHE_AFFINITY_REUSE_HORIZON < replacementBytes + cachedInvalidationBytes)
  ) return message
  const replacement: ToolResultMessage = { ...message, content: placeholder }
  delete replacement.contentBlocks
  return replacement
}

const withoutEmbeddedImageDetails = (message: ToolResultMessage): ToolResultMessage => {
  const details = jsonRecord(message.details)
  const image = jsonRecord(details?.image)
  if (!details || !image || typeof image.dataBase64 !== 'string') return message
  const sanitizedImage = { ...image }
  delete sanitizedImage.dataBase64
  return {
    ...message,
    details: {
      ...details,
      image: sanitizedImage,
    },
  }
}

const omitImagePayloads = (message: ToolResultMessage): ToolResultMessage => {
  const blocks = message.contentBlocks
  if (!blocks?.some((block) => block.type === 'image')) return withoutEmbeddedImageDetails(message)
  const replacement = withoutEmbeddedImageDetails({
    ...message,
    content: `${message.content}\n\n${EARLIER_IMAGE_PLACEHOLDER}`,
    contentBlocks: blocks.filter((block) => block.type !== 'image'),
  })
  if (replacement.contentBlocks?.length === 0) delete replacement.contentBlocks
  return replacement
}

const artifactPlaceholder = (message: ToolResultMessage): string | undefined => {
  if (!message.artifact) return undefined
  return `[Tool result omitted from model context; full result retained as Artifact ${message.artifact.id} (${message.artifact.sizeBytes} bytes).]`
}

const cachedInvalidationBytesByIndex = (messages: AgentMessage[]): number[] => {
  let boundary = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant' && (message.usage?.cacheReadTokens ?? 0) > 0) {
      boundary = index
      break
    }
  }
  const costs = new Array<number>(messages.length).fill(0)
  let suffixBytes = 0
  for (let index = boundary; index >= 0; index -= 1) {
    costs[index] = suffixBytes
    suffixBytes += utf8ByteLength(JSON.stringify(messages[index]))
  }
  return costs
}

export function sanitizeContextMessages(
  messages: ModelMessage[],
  options?: ContextSanitizerOptions,
): ModelMessage[]
export function sanitizeContextMessages(
  messages: AgentMessage[],
  options?: ContextSanitizerOptions,
): AgentMessage[]
export function sanitizeContextMessages(
  messages: AgentMessage[],
  options: ContextSanitizerOptions = {},
): AgentMessage[] {
  const laterReads: ReadRange[] = []
  const sanitized = [...messages]
  const cacheInvalidationCosts = options.aggressive
    ? new Array<number>(messages.length).fill(0)
    : cachedInvalidationBytesByIndex(messages)
  let keptNewestImagePayload = false
  let keptNewestArtifactInline = false

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'tool') continue

    let projected = message
    const hasImagePayload = message.contentBlocks?.some((block) => block.type === 'image') === true
    if (options.aggressive && hasImagePayload) {
      if (keptNewestImagePayload) projected = omitImagePayloads(projected)
      else {
        keptNewestImagePayload = true
        projected = withoutEmbeddedImageDetails(projected)
      }
    }

    const artifactReplacement = options.aggressive ? artifactPlaceholder(projected) : undefined
    if (artifactReplacement) {
      if (keptNewestArtifactInline) projected = replaceContent(projected, artifactReplacement)
      else keptNewestArtifactInline = true
    }

    const range = readRange(projected)
    if (range) {
      if (laterReads.some((later) => isCoveredBy(range, later))) {
        projected = replaceContent(
          projected,
          SUPERSEDED_READ_PLACEHOLDER,
          cacheInvalidationCosts[index],
        )
      }
      laterReads.push(range)
    } else if (discardable(projected)) {
      projected = replaceContent(
        projected,
        DISCARDABLE_RESULT_PLACEHOLDER,
        cacheInvalidationCosts[index],
      )
    }
    sanitized[index] = projected
  }

  return sanitized
}
