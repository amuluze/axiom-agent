import type { AgentMessage, ModelReasoning, ModelRef } from '@/agent/core/types'

export type QueuedMessageKind = 'steering' | 'follow-up' | 'next-turn'
export type AgentJournalStatus = 'pending' | 'consuming' | 'applied' | 'discarded'

export interface DurableRuntimeUpdate {
  systemPrompt?: string
  model?: ModelRef
  reasoning?: ModelReasoning | null
  activeToolNames?: string[]
}

interface AgentJournalEntryBase {
  id: string
  sessionId: string
  sequence: number
  status: AgentJournalStatus
  createdAt: number
  consumerRunId?: string
}

export type AgentSessionJournalEntry =
  | (AgentJournalEntryBase & {
      kind: 'queue'
      queueKind: QueuedMessageKind
      message: AgentMessage
      /** Durable hand-off marker: this is a user-owned draft, not runnable queue input. */
      recoveredAt?: number
    })
  | (AgentJournalEntryBase & {
      kind: 'message_append'
      message: AgentMessage
    })
  | (AgentJournalEntryBase & {
      kind: 'runtime_update'
      update: DurableRuntimeUpdate
    })

export interface AgentMutationJournal {
  append(entry: AgentSessionJournalEntry): Promise<void>
  markConsuming(entryIds: string[], runId: string): Promise<void>
  restorePending(entryIds: string[]): Promise<void>
  markRecovered(entryIds: string[]): Promise<void>
  markApplied(entryIds: string[]): Promise<void>
  discard(entryIds: string[]): Promise<void>
}
