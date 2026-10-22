import { describe, expect, it } from 'vitest'
import { QueueOrderState } from './sessionQueueOrdering'

const display = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

describe('QueueOrderState', () => {
  it('records explicit and implicit orders and sorts by them', () => {
    const state = new QueueOrderState()
    expect(state.record('a', 10)).toBe(10)
    expect(state.record('b')).toBe(11)
    expect(state.orderOf('a')).toBe(10)
    expect(state.orderOf('missing')).toBe(Number.MAX_SAFE_INTEGER)
    expect(state.sort([{ id: 'b' }, { id: 'a' }]).map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('resolves top/bottom and adjacent placements against the display order', () => {
    const state = new QueueOrderState()
    state.record('a', 1)
    state.record('b', 2)
    state.record('c', 3)
    expect(state.resolve('x', { position: 'top' }, display)).toBe(0)
    expect(state.resolve('x', { position: 'bottom' }, display)).toBe(4)
    expect(state.resolve('x', { position: 'above', anchorId: 'b' }, display)).toBe(1.5)
    expect(state.resolve('x', { position: 'below', anchorId: 'b' }, display)).toBe(2.5)
    expect(state.resolve('x', { position: 'above', anchorId: 'a' }, display)).toBe(0)
    expect(state.resolve('x', { position: 'below', anchorId: 'c' }, display)).toBe(4)
    expect(state.resolve('x', { position: 'above', anchorId: 'missing' }, display)).toBeUndefined()
  })

  it('flags precision degradation when the midpoint collapses onto a neighbor', () => {
    const state = new QueueOrderState()
    state.record('a', 0)
    state.record('b', Number.MIN_VALUE)
    const mid = state.resolve('x', { position: 'below', anchorId: 'a' }, [
      { id: 'a' },
      { id: 'b' },
    ])
    expect(mid).toBe(0)
    expect(state.precisionDegraded).toBe(true)
    state.clearPrecisionDegraded()
    expect(state.precisionDegraded).toBe(false)
  })

  it('plans an integer reindex in display order and can be reset', () => {
    const state = new QueueOrderState()
    state.record('a', 0.25)
    state.record('b', 0.5)
    const plan = state.reindexPlan([{ id: 'b' }, { id: 'a' }])
    expect([...plan.entries()]).toEqual([['b', 0], ['a', 1]])
    state.reset()
    expect(state.orderOf('a')).toBe(Number.MAX_SAFE_INTEGER)
    expect(state.precisionDegraded).toBe(false)
  })
})
