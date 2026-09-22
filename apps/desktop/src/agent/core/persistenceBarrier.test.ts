import { describe, expect, it } from 'vitest'
import {
  impliesMessageNotPersisted,
  isPersistenceUnrelated,
  markPersistenceUnrelated,
} from './persistenceBarrier'

describe('persistence barrier failure 分类', () => {
  it('默认把监听器错误视为「消息未落库」', () => {
    const error = new Error('Session message 与 queue journal 消费事实不匹配')
    expect(isPersistenceUnrelated(error)).toBe(false)
    expect(impliesMessageNotPersisted(error)).toBe(true)
    expect(impliesMessageNotPersisted('plain failure')).toBe(true)
    expect(impliesMessageNotPersisted(undefined)).toBe(true)
  })

  it('显式标记后不再视为落库失败，且保留原始错误身份与消息', () => {
    const error = markPersistenceUnrelated(new Error('投影失败'))
    expect(isPersistenceUnrelated(error)).toBe(true)
    expect(impliesMessageNotPersisted(error)).toBe(false)
    expect(error.message).toBe('投影失败')
    // 标记不可枚举：不影响既有错误序列化/日志形态
    expect(Object.keys(error)).toEqual([])
  })

  it('标记返回原对象，便于内联上抛', () => {
    const error = new Error('projection')
    expect(markPersistenceUnrelated(error)).toBe(error)
  })

  it('非对象错误无法标记，仍按落库失败处理', () => {
    expect(markPersistenceUnrelated('boom')).toBe('boom')
    expect(impliesMessageNotPersisted('boom')).toBe(true)
  })
})
