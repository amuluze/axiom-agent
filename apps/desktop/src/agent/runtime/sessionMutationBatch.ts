import { createId } from '@/agent/core/id'
import type { AgentLoopTurnUpdate } from '@/agent/core/runAgentLoop'
import { snapshotAgentMessages } from '@/agent/core/snapshots'
import type { AgentMessage, RuntimeUpdateSource } from '@/agent/core/types'
import { snapshotRuntimeUpdate, type AgentRuntimeUpdate } from './sessionRuntimeUpdates'

/**
 * Save Point 前把「运行中追加的消息 + 调度的 Runtime 更新」组装成一个 mutation
 * batch（A4 切片，自 AgentSession 抽出的纯映射）。
 *
 * 不读会话实例状态：快照、journal entry 关联与 batch id 派生都在这里完成；
 * 入队、提交与确认仍由 AgentSession 承担。
 */

export interface PendingAppendedMessage {
  message: AgentMessage
  journalEntryId?: string
}

export interface PendingRuntimeUpdate {
  update: AgentRuntimeUpdate
  source: RuntimeUpdateSource
  journalEntryId?: string
}

export interface AssembledMutationBatch {
  id: string
  appendedCount: number
  runtimeCount: number
  journalEntryIds: string[]
  update: AgentLoopTurnUpdate
}

export interface AssembleMutationBatchInput {
  appendedMessages: readonly PendingAppendedMessage[]
  runtimeUpdates: readonly PendingRuntimeUpdate[]
  /** 无 journal entry 可派生的 batch id；测试可注入确定性实现。 */
  createMutationId?: () => string
}

export const assembleMutationBatch = (
  input: AssembleMutationBatchInput,
): AssembledMutationBatch | undefined => {
  if (input.appendedMessages.length === 0 && input.runtimeUpdates.length === 0) return undefined
  const appendMessages = snapshotAgentMessages(
    input.appendedMessages.map(({ message }) => message),
  )
  const runtimeUpdates = input.runtimeUpdates.map(({ update, source }) => ({
    ...snapshotRuntimeUpdate(update),
    source,
  }))
  const update: AgentLoopTurnUpdate = {
    ...(appendMessages.length ? { appendMessages } : {}),
    ...(runtimeUpdates.length ? { runtimeUpdates } : {}),
  }
  const journalEntryIds = [
    ...input.appendedMessages.flatMap(({ journalEntryId }) => journalEntryId ? [journalEntryId] : []),
    ...input.runtimeUpdates.flatMap(({ journalEntryId }) => journalEntryId ? [journalEntryId] : []),
  ]
  return {
    id: journalEntryIds[0]
      ? `mutation:${journalEntryIds[0]}`
      : (input.createMutationId ?? (() => createId('mutation')))(),
    appendedCount: appendMessages.length,
    runtimeCount: runtimeUpdates.length,
    journalEntryIds,
    update,
  }
}
