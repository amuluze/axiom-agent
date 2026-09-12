import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@/agent/core/types'
import type { SessionRepository } from '@/persistence/types'
import {
  createMutationBindings,
  getRepository,
  recordRuntimeEvent,
  setRepository,
} from './repositoryCore'
import { MemorySessionRepository } from '@/persistence/MemorySessionRepository'

const createRepoMock = (): SessionRepository => ({
  commitMutationBatch: vi.fn(() => ({ appliedEvents: 1 })),
  appendJournalEntry: vi.fn(async () => undefined),
  markJournalEntriesConsuming: vi.fn(async () => undefined),
  restoreJournalEntries: vi.fn(async () => undefined),
  markJournalEntriesRecovered: vi.fn(async () => undefined),
  markJournalEntriesApplied: vi.fn(async () => undefined),
  discardJournalEntries: vi.fn(async () => undefined),
  recordEvent: vi.fn(async () => undefined),
} as unknown as SessionRepository)

describe('repositoryCore', () => {
  let repo: SessionRepository

  beforeEach(() => {
    repo = createRepoMock()
    setRepository(repo)
  })

  afterEach(() => {
    setRepository(new MemorySessionRepository())
  })

  it('getRepository 返回当前 setRepository 设置的实例（支持热切换）', () => {
    expect(getRepository()).toBe(repo)
    const next = createRepoMock()
    setRepository(next)
    expect(getRepository()).toBe(next)
  })

  describe('createMutationBindings', () => {
    it('commitMutationBatch 转发并携带 runtime_tools_update 的 manifest', async () => {
      const manifest = { schemaVersion: 3 }
      const bindings = createMutationBindings('s1', () => manifest)
      const batch = { events: [{ type: 'runtime_tools_update' }], meta: { seq: 1 } }
      const receipt = bindings.commitMutationBatch(batch as never)
      expect(receipt).toEqual({ appliedEvents: 1 })
      expect(repo.commitMutationBatch).toHaveBeenCalledWith('s1', batch, manifest)
    })

    it('commitMutationBatch 无 runtime_tools_update 事件时不求值 manifest', () => {
      const manifestThunk = vi.fn(() => ({ schemaVersion: 3 }))
      const bindings = createMutationBindings('s1', manifestThunk)
      const batch = { events: [{ type: 'session_message_append' }], meta: { seq: 2 } }
      bindings.commitMutationBatch(batch as never)
      expect(manifestThunk).not.toHaveBeenCalled()
      expect(repo.commitMutationBatch).toHaveBeenCalledWith('s1', batch, undefined)
    })

    it('journal 六个方法全部按 sessionId 转发到当前 repository', async () => {
      const bindings = createMutationBindings('s1', () => undefined)
      const entry = { id: 'j1' }
      await bindings.journal.append(entry as never)
      expect(repo.appendJournalEntry).toHaveBeenCalledWith('s1', entry)

      await bindings.journal.markConsuming(['a'], 'run-1')
      expect(repo.markJournalEntriesConsuming).toHaveBeenCalledWith('s1', ['a'], 'run-1')

      await bindings.journal.restorePending(['b'])
      expect(repo.restoreJournalEntries).toHaveBeenCalledWith('s1', ['b'])

      await bindings.journal.markRecovered(['c'])
      expect(repo.markJournalEntriesRecovered).toHaveBeenCalledWith('s1', ['c'])

      await bindings.journal.markApplied(['d'])
      expect(repo.markJournalEntriesApplied).toHaveBeenCalledWith('s1', ['d'])

      await bindings.journal.discard(['e'])
      expect(repo.discardJournalEntries).toHaveBeenCalledWith('s1', ['e'])
    })
  })

  describe('recordRuntimeEvent', () => {
    it.each([
      'session_message_append',
      'runtime_system_prompt_update',
      'runtime_model_update',
      'runtime_reasoning_update',
      'runtime_tools_update',
    ])('已由 mutation batch 持久化的 %s 事件不再走 recordEvent', async (type) => {
      await recordRuntimeEvent('s1', { type } as AgentEvent)
      expect(repo.recordEvent).not.toHaveBeenCalled()
    })

    it('其余事件类型转发到 repository.recordEvent', async () => {
      const event = { type: 'run_started' } as unknown as AgentEvent
      await recordRuntimeEvent('s1', event)
      expect(repo.recordEvent).toHaveBeenCalledWith('s1', event)
    })
  })
})
