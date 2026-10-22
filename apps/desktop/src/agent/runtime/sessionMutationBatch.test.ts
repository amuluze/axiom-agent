import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@/agent/core/types'
import { assembleMutationBatch } from './sessionMutationBatch'

const userMessage = (id: string): AgentMessage => ({
  id,
  role: 'user',
  content: id,
  createdAt: 1_700_000_000_000,
})

describe('assembleMutationBatch', () => {
  it('returns undefined when nothing is pending', () => {
    expect(assembleMutationBatch({ appendedMessages: [], runtimeUpdates: [] })).toBeUndefined()
  })

  it('assembles messages and runtime updates with journal ids in input order', () => {
    const batch = assembleMutationBatch({
      appendedMessages: [
        { message: userMessage('message-1'), journalEntryId: 'journal-1' },
        { message: userMessage('message-2') },
      ],
      runtimeUpdates: [
        { update: { systemPrompt: 'next' }, source: 'set', journalEntryId: 'journal-2' },
      ],
    })
    expect(batch).toMatchObject({
      id: 'mutation:journal-1',
      appendedCount: 2,
      runtimeCount: 1,
      journalEntryIds: ['journal-1', 'journal-2'],
    })
    expect(batch?.update.appendMessages?.map((message) => message.id)).toEqual([
      'message-1',
      'message-2',
    ])
    expect(batch?.update.runtimeUpdates?.[0]).toMatchObject({
      systemPrompt: 'next',
      source: 'set',
    })
  })

  it('uses the injected id factory when no journal entry can seed the id', () => {
    const batch = assembleMutationBatch({
      appendedMessages: [{ message: userMessage('message-1') }],
      runtimeUpdates: [],
      createMutationId: () => 'mutation:test',
    })
    expect(batch?.id).toBe('mutation:test')
    expect(batch?.journalEntryIds).toEqual([])
  })
})
