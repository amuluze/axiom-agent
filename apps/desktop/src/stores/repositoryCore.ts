import { MemorySessionRepository } from '@/persistence/MemorySessionRepository'
import type { AgentLifecycleEvent, SessionRepository } from '@/persistence/types'
import type { AgentEvent, AgentMutationBatch, AgentMutationReceipt } from '@/agent/core/types'
import type { AgentMutationJournal } from '@/agent/runtime/mutationJournal'
import type { RuntimeDependencyManifest } from '@/agent/runtime/runtimeDependencyManifest'

/**
 * Module-level repository singleton with explicit setter/getter accessors.
 *
 * The store's `initialize` action calls `setRepository(...)` twice in its
 * lifecycle: once with the persistent backend, and once with an in-memory
 * fallback if the persistent init throws. Bindings returned by
 * `createMutationBindings` always read the current repository through
 * `getRepository()`, so a late swap remains visible to already-bound
 * AgentHarness instances.
 */

let repository: SessionRepository = new MemorySessionRepository()

export const getRepository = (): SessionRepository => repository

export const setRepository = (next: SessionRepository): void => {
  repository = next
}

export interface MutationBindings {
  commitMutationBatch: (batch: AgentMutationBatch) => AgentMutationReceipt | void | Promise<AgentMutationReceipt | void>
  journal: AgentMutationJournal
}

/**
 * Construct the 7 closure-shaped dependencies the AgentHarness expects, all
 * reading the current repository at call time. `getRuntimeManifest` is a
 * thunk the store passes in to satisfy the `runtime_tools_update` branch
 * inside `commitMutationBatch` (see agentStore `bindSession`).
 */
export const createMutationBindings = (
  sessionId: string,
  getRuntimeManifest: () => unknown,
): MutationBindings => ({
  commitMutationBatch: (batch) => {
    // runtime_tools_update 的 manifest 来自上层当前 live manifest；而
    // runtime_dependencies_update 的 manifest 已在事件 current 载荷中（reload 后的
    // 新快照），repository 边界内 decode 为强类型。
    const dependenciesEvent = batch.events.find(
      (event) => event.type === 'runtime_dependencies_update',
    )
    const manifest = dependenciesEvent
      ? (dependenciesEvent as { current: { runtimeManifest: unknown } }).current.runtimeManifest
      : batch.events.some((event) => event.type === 'runtime_tools_update')
        ? getRuntimeManifest()
        : undefined
    return getRepository().commitMutationBatch(
      sessionId,
      batch,
      manifest as RuntimeDependencyManifest | undefined,
    )
  },
  journal: {
    append: (entry) => getRepository().appendJournalEntry(sessionId, entry),
    markConsuming: (entryIds, runId) =>
      getRepository().markJournalEntriesConsuming(sessionId, entryIds, runId),
    restorePending: (entryIds) => getRepository().restoreJournalEntries(sessionId, entryIds),
    markRecovered: (entryIds) => getRepository().markJournalEntriesRecovered(sessionId, entryIds),
    markApplied: (entryIds) => getRepository().markJournalEntriesApplied(sessionId, entryIds),
    discard: (entryIds) => getRepository().discardJournalEntries(sessionId, entryIds),
  },
})

/**
 * Event types already persisted via the mutation batch / journal paths and
 * therefore excluded from direct `recordEvent` calls.
 */
const PERSISTED_THROUGH_BATCH = new Set<string>([
  'session_message_append',
  'runtime_system_prompt_update',
  'runtime_model_update',
  'runtime_reasoning_update',
  'runtime_tools_update',
  'runtime_dependencies_update',
])

/**
 * Persist a runtime event onto the current repository, skipping event types
 * that are already covered by the mutation batch / journal path. The
 * underlying `recordEvent` is typed as `AgentLifecycleEvent`; after filtering,
 * every remaining event in practice carries that shape.
 */
export const recordRuntimeEvent = async (sessionId: string, event: AgentEvent): Promise<void> => {
  if (PERSISTED_THROUGH_BATCH.has(event.type)) return
  await getRepository().recordEvent(sessionId, event as AgentLifecycleEvent)
}
