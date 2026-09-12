import { createId } from '@/agent/core/id'
import {
  assistantContentBlocks,
  toolResultContentBlocks,
  userContentBlocks,
} from '@/agent/core/messages'
import type {
  AssistantMessage,
  JsonValue,
  ModelMessage,
  ModelRequest,
  ModelTransport,
} from '@/agent/core/types'
import {
  evaluateContextBudget,
  estimateMessageTokens,
  isContextProjectionMessage,
  modelRequestByteLength,
  utf8ByteLength,
} from './budget'
import { createContextLedgerMessage, mergeReadProgress, mergeToolLedger } from './ledger'
import { resolveSummaryInstructions, type SummaryInstructionOptions } from './summaryInstructions'
import type {
  CompactionReason,
  ContextBudgetUsage,
  ContextCheckpoint,
  ContextCheckpointFacts,
  ContextPolicy,
} from './types'

export const SUMMARY_PROMPT_VERSION = 4
const MAX_SUMMARY_INPUT_BYTES = 512 * 1024
const MAX_SUMMARY_OUTPUT_BYTES = 128 * 1024
const MAX_MESSAGE_SUMMARY_BYTES = 12 * 1024
const MAX_TOOL_ARGUMENT_BYTES = 4 * 1024

/**
 * 结构化检查点的共享标题与保留规则。
 *
 * 上下文压缩器与分支摘要器复用同一套模板，避免两份近似文案各改一处时产生漂移；
 * 调用方只需拼上各自的角色前缀。
 */
export const CHECKPOINT_HEADINGS = [
  '## 目标',
  '## 约束与偏好',
  '## 进度',
  '### 已完成',
  '### 进行中',
  '### 受阻',
  '## 关键决策',
  '## 后续步骤',
  '## 关键上下文',
].join('\n')

/**
 * 结构化检查点的共享保留规则。
 *
 * v4 起要求保留 Skill 装载记录：Skill 正文以 tool result 进入对话，压缩后会被
 * 摘要吞掉，而 finish 这类末段 Skill 最依赖正文细节——检查点留下「已加载名单 +
 * 阶段进度」，后续轮次可经 load_skill 幂等重载（idempotencyKey: load_skill:<name>）。
 */
export const CHECKPOINT_RULES = '保持简洁，必须保留精确文件路径、函数名、错误信息、用户限制以及未完成工作。若对话中经 load_skill 加载过 Skill，必须在「## 关键上下文」列出已加载的 Skill 名单及各自推进到的阶段或未完成的步骤，供后续轮次按需重新加载。'

export const SUMMARY_SYSTEM_PROMPT = `你是 Axiom 的上下文压缩器。只生成结构化检查点，不要继续对话，不要调用工具。
检查点正文必须用中文，并使用以下标题且保持简洁：
${CHECKPOINT_HEADINGS}
${CHECKPOINT_RULES}
不得在检查点中包含 API Key、令牌、文件正文或其他秘密；只保留完成工作必需的路径与符号引用。`

const TURN_PREFIX_INSTRUCTIONS = `这段对话是一个过大逻辑回合中即将被压缩的前缀，后缀仍会以原始消息保留。
请只生成以下结构，为保留的后缀补足直接上下文：
## 原始请求
## 早期进展
## 保留后缀所需上下文
保持简洁、正文用中文，明确原始请求、早期工具结果、关键决定以及理解后缀所必需的信息；必须包含用户明确表达的偏好与约束。不得包含 API Key、令牌、文件正文或其他秘密，只保留完成工作必需的路径与符号引用。`

const truncateToUtf8Bytes = (value: string, maxBytes: number): string => {
  if (utf8ByteLength(value) <= maxBytes) return value
  const suffix = '\n[… 已按上下文压缩输入上限截断]'
  const budget = Math.max(0, maxBytes - utf8ByteLength(suffix))
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (utf8ByteLength(value.slice(0, middle)) <= budget) low = middle
    else high = middle - 1
  }
  return `${value.slice(0, low)}${suffix}`
}

const takeLastUtf8Bytes = (value: string, maxBytes: number): string => {
  if (utf8ByteLength(value) <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (utf8ByteLength(value.slice(middle)) <= maxBytes) high = middle
    else low = middle + 1
  }
  return value.slice(low)
}

const truncateMiddleToUtf8Bytes = (value: string, maxBytes: number): string => {
  if (utf8ByteLength(value) <= maxBytes) return value
  const marker = '\n\n[… 中间对话因摘要请求上限被省略 …]\n\n'
  const remaining = Math.max(0, maxBytes - utf8ByteLength(marker))
  const head = truncateToUtf8Bytes(value, Math.floor(remaining * 0.45))
  const tail = takeLastUtf8Bytes(value, Math.ceil(remaining * 0.55))
  return `${head}${marker}${tail}`
}

const safeToolArguments = (toolName: string, input: JsonValue): JsonValue => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input
  const path = typeof input.path === 'string' ? input.path : undefined
  // Accept both the migrated short names (current) and the legacy names kept
  // for historical tool-call replay after session restore.
  if (
    (toolName === 'write' || toolName === 'create_workspace_file')
    && typeof input.content === 'string'
  ) {
    return { path: path ?? '', contentBytes: utf8ByteLength(input.content) }
  }
  if (toolName === 'edit' || toolName === 'edit_workspace_file') {
    // New schema: { path, edits: [{ oldText, newText }] }
    if (Array.isArray(input.edits)) {
      return {
        path: path ?? '',
        editCount: input.edits.length,
        oldTextBytes: (input.edits as JsonValue[]).map((edit) =>
          typeof edit === 'object' && edit !== null && typeof (edit as { oldText?: unknown }).oldText === 'string'
            ? utf8ByteLength((edit as { oldText: string }).oldText)
            : 0,
        ),
        newTextBytes: (input.edits as JsonValue[]).map((edit) =>
          typeof edit === 'object' && edit !== null && typeof (edit as { newText?: unknown }).newText === 'string'
            ? utf8ByteLength((edit as { newText: string }).newText)
            : 0,
        ),
      }
    }
    // Legacy schema: { path, oldText, newText }
    return {
      path: path ?? '',
      oldTextBytes: typeof input.oldText === 'string' ? utf8ByteLength(input.oldText) : 0,
      newTextBytes: typeof input.newText === 'string' ? utf8ByteLength(input.newText) : 0,
    }
  }
  return input
}

const serializeAssistant = (message: AssistantMessage): string => {
  const sections = assistantContentBlocks(message).flatMap((block) => {
    if (block.type === 'text') {
      return block.text
        ? [`[Assistant]: ${truncateToUtf8Bytes(block.text, MAX_MESSAGE_SUMMARY_BYTES)}`]
        : []
    }
    if (block.type === 'thinking') {
      return block.thinking
        ? [`[Assistant thinking]: ${truncateToUtf8Bytes(block.thinking, MAX_MESSAGE_SUMMARY_BYTES)}`]
        : []
    }
    const args = truncateToUtf8Bytes(
      JSON.stringify(safeToolArguments(block.name, block.arguments)),
      MAX_TOOL_ARGUMENT_BYTES,
    )
    return [`[Assistant tool call]: ${block.name}(${args})`]
  })
  if (message.errorMessage) {
    sections.push(`[Assistant error]: ${truncateToUtf8Bytes(message.errorMessage, 2_000)}`)
  }
  return sections.filter(Boolean).join('\n')
}

const serializeMessage = (message: ModelMessage): string => {
  if (message.role === 'user') {
    const images = userContentBlocks(message)
      .flatMap((block) => block.type === 'image'
        ? [`[Image: ${block.source.type === 'base64' ? block.source.mediaType : 'URL'}]`]
        : [])
    return `[User]: ${truncateToUtf8Bytes(
      [message.content, ...images].filter(Boolean).join('\n'),
      MAX_MESSAGE_SUMMARY_BYTES,
    )}`
  }
  if (message.role === 'assistant') return serializeAssistant(message)
  const images = toolResultContentBlocks(message)
    .flatMap((block) => block.type === 'image'
      ? [`[Image: ${block.source.type === 'base64' ? block.source.mediaType : 'URL'}]`]
      : [])
  return `[Tool result ${message.toolName}${message.isError ? ' error' : ''}]: ${truncateToUtf8Bytes(
    [message.content, ...images].filter(Boolean).join('\n'),
    2_000,
  )}`
}

export const serializeConversationForCompaction = (messages: ModelMessage[]): string =>
  truncateMiddleToUtf8Bytes(messages.map(serializeMessage).join('\n\n'), MAX_SUMMARY_INPUT_BYTES)

export interface MessageGroup {
  messages: ModelMessage[]
  tokens: number
}

export const groupContextMessages = (messages: ModelMessage[]): MessageGroup[] => {
  const groups: MessageGroup[] = []
  for (const message of messages.filter((candidate) => !isContextProjectionMessage(candidate))) {
    const previous = groups[groups.length - 1]
    if (message.role === 'tool' && previous?.messages[0]?.role === 'assistant') {
      previous.messages.push(message)
      previous.tokens += estimateMessageTokens(message)
    } else {
      groups.push({ messages: [message], tokens: estimateMessageTokens(message) })
    }
  }
  return groups
}

const mergeFacts = (
  previous: ContextCheckpointFacts | undefined,
  messages: ModelMessage[],
): ContextCheckpointFacts => {
  const readFiles = new Set(previous?.readFiles ?? [])
  const modifiedFiles = new Set(previous?.modifiedFiles ?? [])
  for (const message of messages) {
    if (message.role !== 'tool' || message.isError || typeof message.details !== 'object' || !message.details) continue
    const details = message.details as Record<string, JsonValue>
    const path = typeof details.path === 'string' ? details.path : undefined
    if (!path) continue
    if (details.operation === 'created' || details.operation === 'edited') modifiedFiles.add(path)
    else if (
      message.toolName === 'read'
      || message.toolName === 'read_workspace_file'
      || message.toolName === 'read_authorized_text'
    ) readFiles.add(path)
  }
  for (const path of modifiedFiles) readFiles.delete(path)
  const modifiedFilesArray = Array.from(modifiedFiles).sort()
  return {
    readFiles: Array.from(readFiles).sort(),
    modifiedFiles: modifiedFilesArray,
    readProgress: mergeReadProgress(previous?.readProgress, messages, modifiedFilesArray),
    toolLedger: mergeToolLedger(previous?.toolLedger, messages),
  }
}

const formatFacts = (facts: ContextCheckpointFacts): string => {
  const sections: string[] = []
  if (facts.readFiles.length > 0) sections.push(`<read-files>\n${facts.readFiles.join('\n')}\n</read-files>`)
  if (facts.modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${facts.modifiedFiles.join('\n')}\n</modified-files>`)
  }
  return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : ''
}

const checkpointNarrative = (checkpoint: ContextCheckpoint | undefined): string | undefined => {
  if (!checkpoint) return undefined
  const factsSuffix = formatFacts(checkpoint.facts)
  let narrative = checkpoint.summary
  while (factsSuffix && narrative.endsWith(factsSuffix)) {
    narrative = narrative.slice(0, -factsSuffix.length).trimEnd()
  }
  return narrative
}

export const hashContextSummary = async (value: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const MIN_SUMMARY_OUTPUT_TOKENS = 4_096
const MAX_SUMMARY_OUTPUT_TOKENS = 16_384

/**
 * 按摘要输入字节数动态确定摘要请求的输出 token 上限。
 *
 * 摘要输出与输入信息量成正比（约 1/12 压缩比）：短会话取 4096 下界；长会话逐步
 * 提高到 16384 上界（中文约 48 KiB，远低于 128 KiB 输出安全上限），避免长会话的
 * 结构化检查点因固定 4096 输出上限被截断而丢失关键决策/进度。
 */
export const resolveSummaryMaxOutputTokens = (inputBytes: number): number => {
  const inputTokens = Math.max(1, Math.ceil(inputBytes / 3))
  return Math.min(MAX_SUMMARY_OUTPUT_TOKENS, Math.max(MIN_SUMMARY_OUTPUT_TOKENS, Math.ceil(inputTokens / 12)))
}

const generateSummary = async (
  baseRequest: ModelRequest,
  transport: ModelTransport,
  messages: ModelMessage[],
  previousSummary: string | undefined,
  signal: AbortSignal,
  purpose: 'history' | 'turn-prefix' = 'history',
  summaryInstructions?: SummaryInstructionOptions,
): Promise<string> => {
  const conversation = serializeConversationForCompaction(messages)
  const content = [
    '<conversation>',
    conversation,
    '</conversation>',
    purpose === 'history' && previousSummary
      ? `<previous-summary>\n${previousSummary}\n</previous-summary>`
      : '',
    purpose === 'turn-prefix'
      ? TURN_PREFIX_INSTRUCTIONS
      : resolveSummaryInstructions(
          previousSummary
            ? '请保留旧检查点中的有效信息，并用新增对话更新进度、决定和下一步。'
            : '请把以上对话压缩为结构化检查点。',
          summaryInstructions,
          false,
        ),
  ].filter(Boolean).join('\n\n')
  const summaryRequest: ModelRequest = {
    sessionId: baseRequest.sessionId,
    runId: createId('compaction'),
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    model: baseRequest.model,
    messages: [{
      id: createId('message'),
      role: 'user',
      content,
      createdAt: Date.now(),
    }],
    tools: [],
    maxOutputTokens: resolveSummaryMaxOutputTokens(utf8ByteLength(content)),
  }
  const requestBytes = modelRequestByteLength(summaryRequest, transport)
  if (requestBytes > 2 * 1024 * 1024) throw new Error('上下文摘要请求超过 Rust 2 MiB 硬上限')

  let output = ''
  let done = false
  for await (const event of transport.stream(summaryRequest, signal)) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (event.type === 'text_delta') {
      output += event.delta
      if (utf8ByteLength(output) > MAX_SUMMARY_OUTPUT_BYTES) {
        throw new Error('上下文摘要输出超过 128 KiB 安全上限')
      }
    } else if (event.type === 'tool_call_start') {
      throw new Error('上下文摘要模型尝试调用工具')
    } else if (event.type === 'error') {
      throw new Error(`上下文摘要失败：${event.message}`)
    } else if (event.type === 'done') {
      done = true
    }
  }
  if (!done) throw new Error('上下文摘要模型流未正常结束')
  const summary = output.trim()
  if (!summary) throw new Error('上下文摘要为空')
  return summary
}

export interface CompactionBoundary {
  historyMessages: ModelMessage[]
  turnPrefixMessages: ModelMessage[]
  summarizedMessages: ModelMessage[]
  keptMessages: ModelMessage[]
  isSplitTurn: boolean
}

export const prepareCompactionBoundary = (
  groups: MessageGroup[],
  firstKeptGroup: number,
): CompactionBoundary => {
  const firstKept = groups[firstKeptGroup]
  const isSplitTurn = firstKept?.messages[0]?.role === 'assistant'
  let turnStartGroup = firstKeptGroup
  if (isSplitTurn) {
    while (turnStartGroup > 0 && groups[turnStartGroup]?.messages[0]?.role !== 'user') {
      turnStartGroup -= 1
    }
  }
  const hasTurnStart = isSplitTurn && groups[turnStartGroup]?.messages[0]?.role === 'user'
  const historyEnd = hasTurnStart ? turnStartGroup : firstKeptGroup
  const historyMessages = groups.slice(0, historyEnd).flatMap((group) => group.messages)
  const turnPrefixMessages = hasTurnStart
    ? groups.slice(turnStartGroup, firstKeptGroup).flatMap((group) => group.messages)
    : []
  return {
    historyMessages,
    turnPrefixMessages,
    summarizedMessages: [...historyMessages, ...turnPrefixMessages],
    keptMessages: groups.slice(firstKeptGroup).flatMap((group) => group.messages),
    isSplitTurn: turnPrefixMessages.length > 0,
  }
}

export interface CompactionResult {
  checkpoint: ContextCheckpoint
  request: ModelRequest
  usageBefore: ContextBudgetUsage
  usageAfter: ContextBudgetUsage
}

export interface CompactionReplacement {
  /** Narrative only. Axiom appends deterministic file facts and builds the checkpoint. */
  summary: string
  /** Last raw message covered by the replacement narrative. */
  throughMessageId: string
}

export interface CompactModelRequestOptions {
  request: ModelRequest
  transport: ModelTransport
  policy: ContextPolicy
  checkpoint?: ContextCheckpoint
  reason: CompactionReason
  signal: AbortSignal
  excludedMessageIds?: string[]
  summaryInstructions?: SummaryInstructionOptions
  replacement?: CompactionReplacement
}

interface CreateCompactionResultOptions {
  request: ModelRequest
  transport: ModelTransport
  policy: ContextPolicy
  checkpoint?: ContextCheckpoint
  reason: CompactionReason
  excludedMessageIds: string[]
  boundary: CompactionBoundary
  narrative: string
  usageBefore: ContextBudgetUsage
}

const createCompactionResult = async ({
  request,
  transport,
  policy,
  checkpoint,
  reason,
  excludedMessageIds,
  boundary,
  narrative,
  usageBefore,
}: CreateCompactionResultOptions): Promise<CompactionResult> => {
  const normalizedNarrative = narrative.trim()
  if (!normalizedNarrative) throw new Error('Compaction 替代摘要不能为空')
  if (utf8ByteLength(normalizedNarrative) > MAX_SUMMARY_OUTPUT_BYTES) {
    throw new Error('Compaction 摘要超过 128 KiB 安全上限')
  }
  const facts = mergeFacts(checkpoint?.facts, boundary.summarizedMessages)
  const finalSummary = `${normalizedNarrative}${formatFacts(facts)}`
  const throughMessageId = boundary.summarizedMessages[boundary.summarizedMessages.length - 1]?.id
  if (!throughMessageId) throw new Error('Compaction 缺少安全的摘要边界消息')
  const provisional: ContextCheckpoint = {
    id: createId('checkpoint'),
    sessionId: request.sessionId,
    throughMessageId,
    summary: finalSummary,
    summaryHash: '',
    reason,
    tokensBefore: usageBefore.estimatedTokens,
    estimatedTokensAfter: 0,
    requestBytesBefore: usageBefore.requestBytes,
    requestBytesAfter: 0,
    modelProvider: request.model.provider,
    modelId: request.model.model,
    promptVersion: SUMMARY_PROMPT_VERSION,
    excludedMessageIds: Array.from(new Set([
      ...(checkpoint?.excludedMessageIds ?? []),
      ...excludedMessageIds,
    ])),
    facts,
    createdAt: Date.now(),
  }
  const ledgerMessage = createContextLedgerMessage(provisional)
  const projectedRequest: ModelRequest = {
    ...request,
    messages: [
      {
        id: `context-summary:${provisional.id}`,
        role: 'user',
        content: `此前对话已压缩为以下可审计上下文检查点：\n\n<context-summary>\n${finalSummary}\n</context-summary>`,
        createdAt: provisional.createdAt,
      },
      ...(ledgerMessage ? [ledgerMessage] : []),
      ...boundary.keptMessages.filter((message) => !provisional.excludedMessageIds.includes(message.id)),
    ],
  }
  const usageAfter = evaluateContextBudget(projectedRequest, transport, policy, provisional)
  provisional.summaryHash = await hashContextSummary(finalSummary)
  provisional.estimatedTokensAfter = usageAfter.estimatedTokens
  provisional.requestBytesAfter = usageAfter.requestBytes
  return { checkpoint: provisional, request: projectedRequest, usageBefore, usageAfter }
}

const assertCompactionFitsHardLimits = (
  result: CompactionResult,
  policy: ContextPolicy,
): void => {
  if (result.usageAfter.requestBytes > policy.hardRequestByteLimit) {
    throw new Error('Compaction 后模型请求仍超过 Rust 2 MiB 硬上限')
  }
  if (result.usageAfter.estimatedTokens > policy.contextWindow) {
    throw new Error('Compaction 后模型请求仍超过模型上下文窗口')
  }
}

export const compactModelRequest = async ({
  request,
  transport,
  policy,
  checkpoint,
  reason,
  signal,
  excludedMessageIds = [],
  summaryInstructions,
  replacement,
}: CompactModelRequestOptions): Promise<CompactionResult | undefined> => {
  const usageBefore = evaluateContextBudget(request, transport, policy, checkpoint)
  const groups = groupContextMessages(request.messages)
  if (groups.length < 2) return undefined

  if (replacement) {
    const summarizedThroughGroup = groups.findIndex(
      (group) => group.messages[group.messages.length - 1]?.id === replacement.throughMessageId,
    )
    if (summarizedThroughGroup < 0) {
      throw new Error('Compaction 替代摘要边界必须是完整消息组的末尾')
    }
    if (summarizedThroughGroup >= groups.length - 1) {
      throw new Error('Compaction 替代摘要必须至少保留一个原始消息组')
    }
    const boundary: CompactionBoundary = {
      historyMessages: groups.slice(0, summarizedThroughGroup + 1).flatMap((group) => group.messages),
      turnPrefixMessages: [],
      summarizedMessages: groups.slice(0, summarizedThroughGroup + 1).flatMap((group) => group.messages),
      keptMessages: groups.slice(summarizedThroughGroup + 1).flatMap((group) => group.messages),
      isSplitTurn: false,
    }
    const result = await createCompactionResult({
      request,
      transport,
      policy,
      checkpoint,
      reason,
      excludedMessageIds,
      boundary,
      narrative: replacement.summary,
      usageBefore,
    })
    assertCompactionFitsHardLimits(result, policy)
    return result
  }

  let accumulated = 0
  let firstKeptGroup = groups.length - 1
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    accumulated += groups[index].tokens
    firstKeptGroup = index
    if (accumulated >= policy.keepRecentTokens) break
  }
  if (firstKeptGroup === 0) firstKeptGroup = 1

  const previousSummary = checkpointNarrative(checkpoint)

  while (firstKeptGroup < groups.length) {
    const boundary = prepareCompactionBoundary(groups, firstKeptGroup)
    if (boundary.summarizedMessages.length === 0) break
    const historySummary = boundary.historyMessages.length > 0
      ? await generateSummary(
          request,
          transport,
          boundary.historyMessages,
          previousSummary,
          signal,
          'history',
          summaryInstructions,
        )
      : previousSummary ?? '此前没有更早的已压缩历史。'
    const turnPrefixSummary = boundary.isSplitTurn
      ? await generateSummary(
          request,
          transport,
          boundary.turnPrefixMessages,
          undefined,
          signal,
          'turn-prefix',
        )
      : undefined
    const narrative = turnPrefixSummary
      ? `${historySummary}\n\n---\n\n## 轮次上下文（分片轮）\n\n${turnPrefixSummary}`
      : historySummary
    const result = await createCompactionResult({
      request,
      transport,
      policy,
      checkpoint,
      reason,
      excludedMessageIds,
      boundary,
      narrative,
      usageBefore,
    })
    if (!result.usageAfter.needsCompaction || firstKeptGroup >= groups.length - 1) {
      assertCompactionFitsHardLimits(result, policy)
      return result
    }
    firstKeptGroup += 1
  }

  return undefined
}
