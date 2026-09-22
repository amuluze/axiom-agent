import { describe, expect, it } from 'vitest'
import { MessageQueue } from './messageQueue'
import { createUserMessage } from '@/agent/core/messages'
import type { AgentMessage } from '@/agent/core/types'

const message = (id: string): AgentMessage => ({ ...createUserMessage(id), id })
const ids = (queue: MessageQueue): string[] => queue.snapshot().map((item) => item.id)

describe('MessageQueue 重排原语', () => {
  it('insertAt 按位置插入并把越界索引收敛到边界', () => {
    const queue = new MessageQueue('one-at-a-time')
    queue.enqueue(message('a'))
    queue.enqueue(message('c'))

    queue.insertAt(message('b'), 1)
    expect(ids(queue)).toEqual(['a', 'b', 'c'])

    queue.insertAt(message('head'), -5)
    expect(ids(queue)).toEqual(['head', 'a', 'b', 'c'])

    queue.insertAt(message('tail'), 99)
    expect(ids(queue)).toEqual(['head', 'a', 'b', 'c', 'tail'])

    // 非有限索引按 0 处理（不做静默 NaN 插入）。
    queue.insertAt(message('nan'), Number.NaN)
    expect(ids(queue)).toEqual(['nan', 'head', 'a', 'b', 'c', 'tail'])
  })

  it('reorder 移动已有项，未知 id 返回 false 且不改动队列', () => {
    const queue = new MessageQueue('one-at-a-time')
    queue.enqueue(message('a'))
    queue.enqueue(message('b'))
    queue.enqueue(message('c'))

    expect(queue.reorder('c', 0)).toBe(true)
    expect(ids(queue)).toEqual(['c', 'a', 'b'])

    expect(queue.reorder('b', 1)).toBe(true)
    expect(ids(queue)).toEqual(['c', 'b', 'a'])

    expect(queue.reorder('missing', 0)).toBe(false)
    expect(ids(queue)).toEqual(['c', 'b', 'a'])
  })

  it('reorder 不改变出队语义：one-at-a-time 逐条、all 整批', () => {
    const one = new MessageQueue('one-at-a-time')
    one.enqueue(message('a'))
    one.enqueue(message('b'))
    one.reorder('b', 0)
    expect(one.drain().map((item) => item.id)).toEqual(['b'])
    expect(one.drain().map((item) => item.id)).toEqual(['a'])

    const all = new MessageQueue('all')
    all.enqueue(message('a'))
    all.enqueue(message('b'))
    all.reorder('b', 0)
    expect(all.drain().map((item) => item.id)).toEqual(['b', 'a'])
    expect(all.drain()).toEqual([])
  })

  it('drainOne 无视 all 模式只出一条，队列余项保持原顺序', () => {
    const all = new MessageQueue('all')
    all.enqueue(message('a'))
    all.enqueue(message('b'))
    all.enqueue(message('c'))
    expect(all.drainOne().map((item) => item.id)).toEqual(['a'])
    expect(all.snapshot().map((item) => item.id)).toEqual(['b', 'c'])
    expect(all.drainOne().map((item) => item.id)).toEqual(['b'])
    expect(all.drain().map((item) => item.id)).toEqual(['c'])
  })

  it('find 返回队列内消息，未知 id 返回 undefined', () => {
    const queue = new MessageQueue('all')
    queue.enqueue(message('a'))
    expect(queue.find('a')?.id).toBe('a')
    expect(queue.find('missing')).toBeUndefined()
  })
})
