export type CompactionReason = 'token_threshold' | 'byte_threshold' | 'overflow' | 'manual'

/**
 * 单文件的确定性读取游标。由 read 系工具结果的 details 程序化提取，
 * 使压缩后模型可用 `read(path, offset=nextOffset)` 续读大文件，无需从头重读。
 * `nextOffset` 为 null 表示该文件已读完整（无续读必要）。
 */
export interface ReadProgressCursor {
  nextOffset: number | null
  totalLines: number
  truncated: boolean
  sha256: string
}

/** 账本条目状态：done=已确认完成；pending=已发起但未确认（中断占位）。 */
export type ToolLedgerStatus = 'done' | 'pending' | 'interrupted'

/** 确定性执行账本条目。id 取自 toolCallId，中断占位消息携带原 toolCallId 可去重。 */
export interface ToolLedgerEntry {
  id: string
  tool: string
  path: string | null
  status: ToolLedgerStatus
}

export interface ContextCheckpointFacts {
  readFiles: string[]
  modifiedFiles: string[]
  /**
   * 确定性工作账本：文件读取游标与执行账本，独立于 LLM 生成的摘要，
   * 作为长任务连贯性的程序化锚点。旧 checkpoint 无此两字段（可选语义，
   * 视为空）；消费方应经 normalizeFacts 统一兜底，避免可选字段渗入逻辑。
   */
  readProgress?: Record<string, ReadProgressCursor>
  toolLedger?: ToolLedgerEntry[]
}

export interface ContextCheckpoint {
  id: string
  sessionId: string
  throughMessageId: string
  summary: string
  summaryHash: string
  reason: CompactionReason
  tokensBefore: number
  estimatedTokensAfter: number
  requestBytesBefore: number
  requestBytesAfter: number
  modelProvider: string
  modelId: string
  promptVersion: number
  excludedMessageIds: string[]
  facts: ContextCheckpointFacts
  createdAt: number
}

export interface ContextBudgetUsage {
  estimatedTokens: number
  contextWindow: number
  tokenThreshold: number
  requestBytes: number
  requestByteThreshold: number
  hardRequestByteLimit: number
  tokenPercent: number
  bytePercent: number
  needsCompaction: boolean
  reason?: Extract<CompactionReason, 'token_threshold' | 'byte_threshold'>
}

export interface ContextPolicy {
  contextWindow: number
  reserveTokens: number
  keepRecentTokens: number
  requestByteThreshold: number
  hardRequestByteLimit: number
}

export interface ContextPolicySettings {
  reserveTokens: number
  keepRecentTokens: number
  requestByteThreshold: number
}

export const HARD_MODEL_REQUEST_BYTES = 2 * 1024 * 1024
export const MIN_REQUEST_BYTE_THRESHOLD = 512 * 1024
export const MAX_REQUEST_BYTE_THRESHOLD = HARD_MODEL_REQUEST_BYTES - 256 * 1024

export const DEFAULT_CONTEXT_POLICY_SETTINGS: ContextPolicySettings = {
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  requestByteThreshold: MAX_REQUEST_BYTE_THRESHOLD,
}

const boundedInteger = (
  value: number,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const normalized = Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(maximum, Math.max(minimum, normalized))
}

export const normalizeContextPolicySettings = (
  settings: ContextPolicySettings,
  contextWindow: number,
  minimumReserveTokens = 1_024,
): ContextPolicySettings => {
  const maximumReserve = Math.min(65_536, Math.max(1_024, contextWindow - 4_096))
  const minimumReserve = Math.min(
    maximumReserve,
    Math.max(1_024, Math.round(minimumReserveTokens)),
  )
  const reserveTokens = boundedInteger(
    settings.reserveTokens,
    DEFAULT_CONTEXT_POLICY_SETTINGS.reserveTokens,
    minimumReserve,
    maximumReserve,
  )
  const maximumRecent = Math.min(200_000, Math.max(2_048, contextWindow - reserveTokens))
  return {
    reserveTokens,
    keepRecentTokens: boundedInteger(
      settings.keepRecentTokens,
      DEFAULT_CONTEXT_POLICY_SETTINGS.keepRecentTokens,
      2_048,
      maximumRecent,
    ),
    requestByteThreshold: boundedInteger(
      settings.requestByteThreshold,
      DEFAULT_CONTEXT_POLICY_SETTINGS.requestByteThreshold,
      MIN_REQUEST_BYTE_THRESHOLD,
      MAX_REQUEST_BYTE_THRESHOLD,
    ),
  }
}

export const resolveContextPolicySettings = (
  storedValue: string | null,
  contextWindow: number,
  minimumReserveTokens = 1_024,
): ContextPolicySettings => {
  if (!storedValue) {
    return normalizeContextPolicySettings(
      DEFAULT_CONTEXT_POLICY_SETTINGS,
      contextWindow,
      minimumReserveTokens,
    )
  }
  try {
    const parsed = JSON.parse(storedValue) as Partial<ContextPolicySettings>
    if (
      typeof parsed.reserveTokens !== 'number'
      || typeof parsed.keepRecentTokens !== 'number'
      || typeof parsed.requestByteThreshold !== 'number'
    ) {
      throw new Error('invalid context policy settings')
    }
    return normalizeContextPolicySettings(
      parsed as ContextPolicySettings,
      contextWindow,
      minimumReserveTokens,
    )
  } catch {
    return normalizeContextPolicySettings(
      DEFAULT_CONTEXT_POLICY_SETTINGS,
      contextWindow,
      minimumReserveTokens,
    )
  }
}

export const createContextPolicy = (
  contextWindow: number,
  settings: ContextPolicySettings = DEFAULT_CONTEXT_POLICY_SETTINGS,
  minimumReserveTokens = 1_024,
): ContextPolicy => ({
  contextWindow,
  ...normalizeContextPolicySettings(settings, contextWindow, minimumReserveTokens),
  hardRequestByteLimit: HARD_MODEL_REQUEST_BYTES,
})
