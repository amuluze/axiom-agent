import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@/agent/core/types'
import type { ContextCheckpoint } from './types'
import { utf8ByteLength } from './budget'
import {
  collectInterruptedPlaceholders,
  createRecoveryPreambleMessage,
  fnv1a32,
  isRecoveryPreambleMessage,
  MAX_RECOVERY_PREAMBLE_BYTES,
} from './recoveryPreamble'

const placeholder = (id: string, createdAt = 10): AgentMessage => ({
  id: `tool-interrupted-${id}`,
  role: 'tool',
  toolCallId: `call-${id}`,
  toolName: 'bash',
  content: '工具调用未形成完整的持久化结果，应用可能在收尾阶段退出。',
  details: {
    reason: 'application_exit',
    runId: 'run-1',
    recoveryPolicy: 'never',
    replayed: false,
    eligibleForReplay: false,
  },
  isError: true,
  createdAt,
})

const normalTool = (id: string): AgentMessage => ({
  id,
  role: 'tool',
  toolCallId: `call-${id}`,
  toolName: 'read',
  content: 'ok',
  details: { path: 'a.ts', sha256: 'a'.repeat(64) },
  isError: false,
  createdAt: 1,
})

const checkpoint: ContextCheckpoint = {
  id: 'ck-1',
  sessionId: 's-1',
  throughMessageId: 'm-1',
  summary: 's',
  summaryHash: '',
  reason: 'token_threshold',
  tokensBefore: 1,
  estimatedTokensAfter: 1,
  requestBytesBefore: 1,
  requestBytesAfter: 1,
  modelProvider: 'p',
  modelId: 'm',
  promptVersion: 2,
  excludedMessageIds: [],
  facts: {
    readFiles: ['a.ts'],
    modifiedFiles: ['b.rs'],
    readProgress: { 'a.ts': { nextOffset: 201, totalLines: 500, truncated: true, sha256: 'a'.repeat(64) } },
    toolLedger: [{ id: 'call-x', tool: 'bash', path: null, status: 'pending' }],
  },
  createdAt: 5,
}

describe('collectInterruptedPlaceholders', () => {
  it('collects only application_exit placeholder tool messages', () => {
    const messages = [
      placeholder('a'),
      normalTool('b'),
      { ...placeholder('c'), details: { reason: 'provider_error' } },
    ]
    const result = collectInterruptedPlaceholders(messages)
    expect(result.map((message) => message.id)).toEqual(['tool-interrupted-a'])
  })

  it('returns an empty list without placeholders', () => {
    expect(collectInterruptedPlaceholders([normalTool('b')])).toEqual([])
  })
})

describe('createRecoveryPreambleMessage', () => {
  it('returns undefined for a session without interrupted placeholders', () => {
    expect(createRecoveryPreambleMessage([normalTool('b')], checkpoint)).toBeUndefined()
  })

  it('builds a deterministic message with the recovery prefix', () => {
    const message = createRecoveryPreambleMessage([placeholder('a')], checkpoint)
    expect(message).toBeDefined()
    expect(message?.role).toBe('user')
    expect(message?.id.startsWith('context-recovery:')).toBe(true)
    expect(message?.content).toContain('恢复说明')
    expect(message?.content).toContain('1 个未完成工具调用')
    expect(message?.content).toContain('请勿盲目重放')
  })

  it('is idempotent for the same placeholder set regardless of order', () => {
    const left = createRecoveryPreambleMessage([placeholder('a'), placeholder('b')], checkpoint)
    const right = createRecoveryPreambleMessage([placeholder('b'), placeholder('a')], checkpoint)
    expect(left?.id).toBe(right?.id)
  })

  it('changes identity when the placeholder set changes', () => {
    const one = createRecoveryPreambleMessage([placeholder('a')], checkpoint)
    const two = createRecoveryPreambleMessage([placeholder('a'), placeholder('b')], checkpoint)
    expect(one?.id).not.toBe(two?.id)
  })

  it('includes checkpoint coverage stats when a checkpoint is present', () => {
    const message = createRecoveryPreambleMessage([placeholder('a')], checkpoint)
    expect(message?.content).toContain('1 个已读文件')
    expect(message?.content).toContain('1 个已修改文件')
    expect(message?.content).toContain('1 个续读游标')
    expect(message?.content).toContain('1 个进行中工具')
  })

  it('stays within the byte budget even with many placeholders', () => {
    const messages = Array.from({ length: 20 }, (_, index) => placeholder(`p-${index}`))
    const message = createRecoveryPreambleMessage(messages, checkpoint)
    expect(utf8ByteLength(message?.content ?? '')).toBeLessThanOrEqual(MAX_RECOVERY_PREAMBLE_BYTES)
  })

  it('uses the latest placeholder creation time deterministically', () => {
    const message = createRecoveryPreambleMessage([placeholder('a', 3), placeholder('b', 17)], checkpoint)
    expect(message?.createdAt).toBe(17)
  })
})

describe('fnv1a32', () => {
  it('produces a stable 8-hex hash', () => {
    expect(fnv1a32('abc')).toBe(fnv1a32('abc'))
    expect(fnv1a32('abc')).toMatch(/^[0-9a-f]{8}$/u)
    expect(fnv1a32('abc')).not.toBe(fnv1a32('abd'))
  })
})

describe('isRecoveryPreambleMessage', () => {
  it('detects only recovery-prefixed user messages', () => {
    expect(isRecoveryPreambleMessage({ id: 'context-recovery:abc', role: 'user', content: '', createdAt: 1 })).toBe(true)
    expect(isRecoveryPreambleMessage({ id: 'context-summary:x', role: 'user', content: '', createdAt: 1 })).toBe(false)
    expect(isRecoveryPreambleMessage({ id: 'tool-interrupted-x', role: 'tool', content: '', toolCallId: 'c', toolName: 'bash', isError: true, createdAt: 1 })).toBe(false)
  })
})
