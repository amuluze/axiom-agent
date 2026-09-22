import { createId } from '@/agent/core/id'
import { snapshotAgentMessage } from '@/agent/core/snapshots'
import type { AgentMessage } from '@/agent/core/types'
import type {
  AgentMutationJournal,
  AgentSessionJournalEntry,
  DurableRuntimeUpdate,
  QueuedMessageKind,
} from './mutationJournal'

/**
 * AgentSession 的 journal 持久化层：序列号分配、写入串行化与 entry 生成。
 * queue/context 相关的 journal 状态（queueJournalEntryIds、pending 队列等）
 * 仍由 AgentSession 持有；本类只承载可独立验证的持久化语义。
 */
export class SessionJournal {
  private sequence = 0
  private writeTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly sessionId: string,
    private readonly adapter?: AgentMutationJournal,
  ) {}

  get hasAdapter(): boolean {
    return Boolean(this.adapter)
  }

  nextSequence(): number {
    const next = this.sequence
    this.sequence += 1
    return next
  }

  /** 恢复时按 entry.sequence 推进，确保后续新 entry 的序列号不冲突。 */
  syncSequence(sequence: number): void {
    this.sequence = Math.max(this.sequence, sequence + 1)
  }

  reset(): void {
    this.sequence = 0
    this.writeTail = Promise.resolve()
  }

  /** 串行化 journal 写入，避免并发操作交错落盘。 */
  write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation, operation)
    this.writeTail = result.then(() => undefined, () => undefined)
    return result
  }

  createEntry(
    value:
      | { kind: 'queue'; queueKind: QueuedMessageKind; message: AgentMessage; order?: number }
      | { kind: 'message_append'; message: AgentMessage }
      | { kind: 'runtime_update'; update: DurableRuntimeUpdate },
  ): AgentSessionJournalEntry | undefined {
    if (!this.adapter) return undefined
    const base = {
      id: createId('journal'),
      sessionId: this.sessionId,
      sequence: this.nextSequence(),
      status: 'pending' as const,
      createdAt: Date.now(),
    }
    if (value.kind === 'queue') {
      return {
        ...base,
        kind: 'queue',
        queueKind: value.queueKind,
        message: snapshotAgentMessage(value.message),
        ...(value.order === undefined ? {} : { order: value.order }),
      }
    }
    if (value.kind === 'message_append') {
      return { ...base, kind: 'message_append', message: snapshotAgentMessage(value.message) }
    }
    return { ...base, kind: 'runtime_update', update: structuredClone(value.update) }
  }
}
