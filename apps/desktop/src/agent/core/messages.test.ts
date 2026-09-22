import { describe, expect, it } from 'vitest'
import type { UserMessage } from './types'
import {
  assertMessagePersistable,
  convertBuiltInCustomMessage,
  createAssistantContinueMessage,
  createTurnAbortedMessage,
  createUserMessage,
  defaultConvertToModelMessages,
  MAX_PERSISTABLE_MESSAGE_BYTES,
} from './messages'

describe('assertMessagePersistable', () => {
  it('accepts ordinary user messages', () => {
    expect(() => assertMessagePersistable(createUserMessage('普通消息'))).not.toThrow()
  })

  it('rejects messages above the persistable byte budget before a run starts', () => {
    const oversized: UserMessage = {
      id: 'u-oversized',
      role: 'user',
      content: 'x'.repeat(MAX_PERSISTABLE_MESSAGE_BYTES + 1),
      createdAt: 1,
    }
    expect(() => assertMessagePersistable(oversized))
      .toThrow('消息超过单条 1.5 MiB 持久化上限')
  })

  it('counts pasted image blocks toward the budget', () => {
    const withImage = createUserMessage([{
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: 'A'.repeat(MAX_PERSISTABLE_MESSAGE_BYTES) },
    }])
    expect(() => assertMessagePersistable(withImage))
      .toThrow('消息超过单条 1.5 MiB 持久化上限')
  })
})

describe('built-in custom message conversion', () => {
  it('converts the turn-aborted marker into a wrapped user message', () => {
    const marker = createTurnAbortedMessage('user-abort', 1234)
    expect(marker).toMatchObject({ role: 'custom', customType: 'turn-aborted', data: { reason: 'user-abort' } })
    const converted = convertBuiltInCustomMessage(marker)
    expect(converted).toMatchObject({ id: marker.id, role: 'user', createdAt: 1234 })
    expect(converted?.content).toContain('<turn-aborted>')
    expect(converted?.content).toContain('被用户中断')
    // 超时原因的文案区分
    const timeout = convertBuiltInCustomMessage(createTurnAbortedMessage('time-limit'))
    expect(timeout?.content).toContain('时间上限')
  })

  it('keeps converting the assistant-continue marker and still rejects unknown custom types', () => {
    expect(convertBuiltInCustomMessage(createAssistantContinueMessage())?.role).toBe('user')
    expect(() => defaultConvertToModelMessages([{
      id: 'c-unknown',
      role: 'custom',
      customType: 'unknown-type',
      content: '',
      createdAt: 1,
    }])).toThrow('unknown-type')
  })
})
