import type { AgentMessage } from '@/agent/core/types'
import { canBranchThrough } from '@/agent/session/branch'
import { utf8ByteLength } from './budget'
import { hashContextSummary, SUMMARY_PROMPT_VERSION } from './compaction'
import type { ContextCheckpoint, ContextCheckpointFacts } from './types'

const MAX_PERSISTED_CHECKPOINT_BYTES = 256 * 1024
const COMPACTION_REASONS = new Set(['token_threshold', 'byte_threshold', 'overflow', 'manual'])

const assertNonNegativeFinite = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`上下文检查点 ${label} 无效`)
  }
}

const assertUniquePaths = (paths: string[], label: string): void => {
  if (new Set(paths).size !== paths.length || paths.some((path) => !path.trim())) {
    throw new Error(`上下文检查点${label}文件事实无效`)
  }
}

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 校验确定性工作账本（readProgress / toolLedger）。旧 checkpoint 可缺失这两个
 * 字段（宽容，视为空）；存在则 fail-closed 校验形状，防止损坏或篡改的账本
 * 进入模型上下文。readProgress 与 modifiedFiles 存在冲突（sha256 已过期）时拒绝。
 */
export const assertCheckpointLedgerIntegrity = (
  facts: ContextCheckpointFacts,
  modifiedFiles: Set<string>,
): void => {
  if (facts.readProgress !== undefined) {
    if (!isJsonObject(facts.readProgress)) {
      throw new Error('上下文检查点读取游标事实无效')
    }
    for (const [path, cursor] of Object.entries(facts.readProgress)) {
      if (!path.trim()) throw new Error('上下文检查点读取游标路径无效')
      if (modifiedFiles.has(path)) throw new Error('上下文检查点文件事实存在读写冲突')
      if (!isJsonObject(cursor)) throw new Error('上下文检查点读取游标条目无效')
      const { nextOffset, totalLines, truncated, sha256 } = cursor
      if (nextOffset !== null && nextOffset !== undefined
        && (typeof nextOffset !== 'number' || !Number.isFinite(nextOffset) || nextOffset < 0)) {
        throw new Error('上下文检查点读取游标 nextOffset 无效')
      }
      if (typeof totalLines !== 'number' || !Number.isFinite(totalLines) || totalLines < 0) {
        throw new Error('上下文检查点读取游标 totalLines 无效')
      }
      if (typeof truncated !== 'boolean') throw new Error('上下文检查点读取游标 truncated 无效')
      if (typeof sha256 !== 'string' || !sha256.trim()) throw new Error('上下文检查点读取游标 sha256 无效')
    }
  }
  if (facts.toolLedger !== undefined) {
    if (!Array.isArray(facts.toolLedger)) throw new Error('上下文检查点工具账本无效')
    const seen = new Set<string>()
    for (const entry of facts.toolLedger) {
      if (!isJsonObject(entry)) throw new Error('上下文检查点工具账本条目无效')
      const { id, tool, path, status } = entry
      if (typeof id !== 'string' || !id.trim()) throw new Error('上下文检查点工具账本条目 ID 无效')
      if (seen.has(id)) throw new Error('上下文检查点工具账本 ID 重复')
      seen.add(id)
      if (typeof tool !== 'string' || !tool.trim()) throw new Error('上下文检查点工具账本工具名无效')
      // interrupted 是合法状态：mergeToolLedger 会为应用退出的中断占位生成该状态
      // （占位随压缩进入 checkpoint 的 facts.toolLedger）。漏列会导致崩溃后压缩过的
      // 会话在下次恢复时被误判为损坏（fail-closed 方向安全，但可恢复状态被丢弃）。
      if (status !== 'done' && status !== 'pending' && status !== 'interrupted') {
        throw new Error('上下文检查点工具账本状态无效')
      }
      if (path !== null && path !== undefined && typeof path !== 'string') {
        throw new Error('上下文检查点工具账本路径无效')
      }
    }
  }
}

export const assertContextCheckpointIntegrity = async (
  checkpoint: ContextCheckpoint,
  expectedSessionId: string,
  messages: AgentMessage[],
): Promise<boolean> => {
  if (checkpoint.sessionId !== expectedSessionId) throw new Error('上下文检查点不属于当前会话')
  if (!checkpoint.id.trim()) throw new Error('上下文检查点 ID 不能为空')
  if (!checkpoint.throughMessageId.trim()) throw new Error('上下文检查点边界消息不能为空')
  if (!checkpoint.summary.trim()) throw new Error('上下文检查点摘要不能为空')
  if (utf8ByteLength(checkpoint.summary) > MAX_PERSISTED_CHECKPOINT_BYTES) {
    throw new Error('上下文检查点摘要超过 256 KiB 持久化上限')
  }
  if (!/^[a-f0-9]{64}$/u.test(checkpoint.summaryHash)
    || await hashContextSummary(checkpoint.summary) !== checkpoint.summaryHash) {
    throw new Error('上下文检查点摘要哈希校验失败')
  }
  if (!COMPACTION_REASONS.has(checkpoint.reason)) throw new Error('上下文检查点原因无效')
  if (!checkpoint.modelProvider.trim() || !checkpoint.modelId.trim()) {
    throw new Error('上下文检查点模型标识无效')
  }
  // promptVersion 宽松化：低于当前版本视为"过期"而非损坏——会话仍可恢复，
  // 调用方应丢弃该 checkpoint 投影并用当前提示词版本重新压缩；高于当前版本
  // 来自未来版本/降级，语义未知，仍 fail-closed 拒绝。
  const stale = checkpoint.promptVersion < SUMMARY_PROMPT_VERSION
  if (checkpoint.promptVersion > SUMMARY_PROMPT_VERSION) {
    throw new Error('上下文检查点 Prompt 版本高于当前摘要提示词，无法解析')
  }
  assertNonNegativeFinite(checkpoint.tokensBefore, '压缩前 token 数')
  assertNonNegativeFinite(checkpoint.estimatedTokensAfter, '压缩后 token 数')
  assertNonNegativeFinite(checkpoint.requestBytesBefore, '压缩前字节数')
  assertNonNegativeFinite(checkpoint.requestBytesAfter, '压缩后字节数')
  assertNonNegativeFinite(checkpoint.createdAt, '创建时间')

  if (new Set(checkpoint.excludedMessageIds).size !== checkpoint.excludedMessageIds.length
    || checkpoint.excludedMessageIds.some((id) => !id.trim())) {
    throw new Error('上下文检查点排除消息列表无效')
  }
  const messageIds = new Set(messages.map((message) => message.id))
  if (!messageIds.has(checkpoint.throughMessageId)) {
    throw new Error('上下文检查点边界消息尚未持久化到当前会话')
  }
  if (!canBranchThrough(messages, checkpoint.throughMessageId)) {
    throw new Error('上下文检查点边界会拆分 ToolCall/ToolResult 消息组')
  }
  if (checkpoint.excludedMessageIds.some((id) => !messageIds.has(id))) {
    throw new Error('上下文检查点排除消息不属于当前会话历史')
  }

  assertUniquePaths(checkpoint.facts.readFiles, '已读')
  assertUniquePaths(checkpoint.facts.modifiedFiles, '已修改')
  const modifiedFiles = new Set(checkpoint.facts.modifiedFiles)
  if (checkpoint.facts.readFiles.some((path) => modifiedFiles.has(path))) {
    throw new Error('上下文检查点文件事实存在读写冲突')
  }
  assertCheckpointLedgerIntegrity(checkpoint.facts, modifiedFiles)
  // 返回"是否当前版本"（true=可复用，false=过期需重新压缩），调用方据此决定是否丢弃投影。
  return !stale
}
