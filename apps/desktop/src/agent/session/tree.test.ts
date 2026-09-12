import type { StoredAgentSession } from '@/persistence/types'
import { describe, expect, it } from 'vitest'
import { flattenSessionTree } from './tree'

const stored = (
  id: string,
  parentSessionId: string | null,
  updatedAt: number,
): StoredAgentSession => ({
  id,
  title: id,
  systemPrompt: 'system',
  modelProvider: 'test',
  modelId: 'model',
  status: 'idle',
  createdAt: 1,
  reasoning: null,
  activeToolNames: [],
  providerConfig: null,
  runtimeManifest: null,
  updatedAt,
  messageCount: 0,
  parentSessionId,
  forkedFromMessageId: null,
  branchKind: parentSessionId ? 'branch' : null,
  retriedMessageId: null,
})

describe('session tree', () => {
  it('keeps branches adjacent to parents and sorts siblings by recency', () => {
    const tree = flattenSessionTree([
      stored('root-old', null, 1),
      stored('child-old', 'root-old', 2),
      stored('child-new', 'root-old', 3),
      stored('root-new', null, 4),
    ])

    expect(tree.map(({ session, depth }) => [session.id, depth])).toEqual([
      ['root-new', 0],
      ['root-old', 0],
      ['child-new', 1],
      ['child-old', 1],
    ])
  })

  it('surfaces missing parents and cycles as recoverable orphan roots', () => {
    const tree = flattenSessionTree([
      stored('missing-parent', 'gone', 3),
      stored('cycle-a', 'cycle-b', 2),
      stored('cycle-b', 'cycle-a', 1),
    ])

    expect(tree).toHaveLength(3)
    expect(tree.every((item) => item.depth === 0 && item.orphaned)).toBe(true)
  })
})
