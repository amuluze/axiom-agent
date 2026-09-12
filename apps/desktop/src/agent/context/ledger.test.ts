import { describe, expect, it } from 'vitest'
import type { ContextCheckpointFacts, ReadProgressCursor, ToolLedgerEntry } from './types'
import type { JsonValue, ModelMessage } from '@/agent/core/types'
import { utf8ByteLength } from './budget'
import {
  createContextLedgerMessage,
  formatLedgerBlock,
  isContextLedgerMessage,
  MAX_LEDGER_BLOCK_BYTES,
  mergeReadProgress,
  mergeToolLedger,
  normalizeFacts,
} from './ledger'

const readMessage = (
  overrides: Partial<ModelMessage & { details: Record<string, unknown> }> = {},
): ModelMessage => ({
  id: 'm-read',
  role: 'tool',
  toolCallId: 'call-read',
  toolName: 'read',
  content: '...',
  details: {
    path: 'a.ts',
    startLine: 1,
    endLine: 200,
    totalLines: 500,
    truncated: true,
    nextOffset: 201,
    sha256: 'a'.repeat(64),
    source: 'workspace',
  } as JsonValue,
  isError: false,
  createdAt: 1,
  ...overrides,
} as unknown as ModelMessage)

const interruptedMessage = (toolCallId: string): ModelMessage => ({
  id: `tool-interrupted-${toolCallId}`,
  role: 'tool',
  toolCallId,
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
  createdAt: 9,
})

describe('normalizeFacts', () => {
  it('defaults missing fields so legacy checkpoints behave identically', () => {
    const legacy = normalizeFacts({ readFiles: ['a.ts'], modifiedFiles: [] })
    expect(legacy).toEqual({
      readFiles: ['a.ts'],
      modifiedFiles: [],
      readProgress: {},
      toolLedger: [],
    })
  })

  it('preserves existing fields immutably', () => {
    const input: ContextCheckpointFacts = {
      readFiles: [],
      modifiedFiles: ['b.rs'],
      readProgress: {},
      toolLedger: [],
    }
    expect(normalizeFacts(input)).toEqual(input)
    expect(input).toEqual(input)
  })
})

describe('mergeReadProgress', () => {
  it('extracts a read cursor from read details', () => {
    const result = mergeReadProgress(undefined, [readMessage()], [])
    expect(result).toEqual({
      'a.ts': {
        nextOffset: 201,
        totalLines: 500,
        truncated: true,
        sha256: 'a'.repeat(64),
      },
    })
  })

  it('drops the cursor when the file was read to the end', () => {
    const messages = [
      readMessage(),
      readMessage({ id: 'm-read-2', details: { path: 'a.ts', totalLines: 500, truncated: false, nextOffset: null, sha256: 'b'.repeat(64) } }),
    ]
    expect(mergeReadProgress(undefined, messages, [])).toEqual({})
  })

  it('drops cursors for files that were modified since (stale sha256)', () => {
    const result = mergeReadProgress(undefined, [readMessage()], ['a.ts'])
    expect(result).toEqual({})
  })

  it('keeps the latest read for the same path across messages', () => {
    const messages = [
      readMessage({ id: 'm1', details: { path: 'a.ts', totalLines: 500, truncated: true, nextOffset: 201, sha256: 'a'.repeat(64) } }),
      readMessage({ id: 'm2', details: { path: 'a.ts', totalLines: 500, truncated: true, nextOffset: 401, sha256: 'a'.repeat(64) } }),
    ]
    expect(mergeReadProgress(undefined, messages, [])['a.ts']?.nextOffset).toBe(401)
  })

  it('ignores errors and non-read tools', () => {
    expect(mergeReadProgress(undefined, [interruptedMessage('c1')], [])).toEqual({})
    const write = readMessage({ id: 'm-w', toolName: 'write', details: { path: 'a.ts', totalLines: 1, truncated: false, nextOffset: null, sha256: 'a'.repeat(64) } })
    expect(mergeReadProgress(undefined, [write], [])).toEqual({})
  })

  it('is bounded by MAX_READ_PROGRESS_ENTRIES and deterministically sorted', () => {
    const messages = Array.from({ length: 40 }, (_, index) => readMessage({
      id: `m-${index}`,
      details: { path: `f-${String(index).padStart(2, '0')}.ts`, totalLines: 100, truncated: true, nextOffset: 11, sha256: 'a'.repeat(64) },
    }))
    const result = mergeReadProgress(undefined, messages, [])
    const keys = Object.keys(result)
    expect(keys).toHaveLength(32)
    expect(keys).toEqual([...keys].sort())
  })
})

describe('mergeToolLedger', () => {
  it('marks interrupted placeholders as interrupted and completed tools as done', () => {
    const messages = [
      readMessage(),
      interruptedMessage('call-bash'),
    ]
    const ledger = mergeToolLedger(undefined, messages)
    const byId = new Map(ledger.map((entry) => [entry.id, entry]))
    expect(byId.get('call-read')).toMatchObject({ tool: 'read', status: 'done' })
    expect(byId.get('call-bash')).toMatchObject({ tool: 'bash', status: 'interrupted' })
  })

  it('dedupes by toolCallId with the later result winning and moving to the end', () => {
    const messages = [
      interruptedMessage('call-x'),
      readMessage({ id: 'm-retry', toolCallId: 'call-x', toolName: 'edit', details: { path: 'a.ts' } }),
    ]
    const ledger = mergeToolLedger(undefined, messages)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ id: 'call-x', tool: 'edit', status: 'done' })
  })

  it('merges with the previous ledger and caps at MAX_TOOL_LEDGER_ENTRIES', () => {
    const previous: ToolLedgerEntry[] = Array.from({ length: 64 }, (_, index) => ({
      id: `old-${index}`,
      tool: 'read',
      path: null,
      status: 'done' as const,
    }))
    const ledger = mergeToolLedger(previous, [readMessage()])
    expect(ledger).toHaveLength(64)
    expect(ledger[ledger.length - 1]).toMatchObject({ id: 'call-read' })
    expect(ledger.some((entry) => entry.id === 'old-0')).toBe(false)
  })
})

describe('formatLedgerBlock', () => {
  const factsWithLedger: ContextCheckpointFacts = {
    readFiles: ['a.ts'],
    modifiedFiles: [],
    readProgress: {
      'a.ts': { nextOffset: 201, totalLines: 500, truncated: true, sha256: 'a'.repeat(64) },
    },
    toolLedger: [
      { id: 'call-1', tool: 'read', path: 'a.ts', status: 'done' },
      { id: 'call-2', tool: 'bash', path: null, status: 'interrupted' },
    ],
  }

  it('returns an empty string for an empty ledger', () => {
    expect(formatLedgerBlock({ readFiles: [], modifiedFiles: [], readProgress: {}, toolLedger: [] })).toBe('')
    expect(formatLedgerBlock({ readFiles: ['a.ts'], modifiedFiles: [], readProgress: {}, toolLedger: [] })).toBe('')
  })

  it('renders both sections inside <work-ledger>', () => {
    const block = formatLedgerBlock(factsWithLedger)
    expect(block).toContain('<work-ledger>')
    expect(block).toContain('<read-progress>')
    expect(block).toContain('"nextOffset":201')
    expect(block).toContain('<tool-ledger>')
    expect(block).toContain('"status":"interrupted"')
    expect(block).toContain('<tool-ledger-note>')
  })

  it('stays within the hard byte budget even with many entries', () => {
    const many: ContextCheckpointFacts = {
      readFiles: [],
      modifiedFiles: [],
      readProgress: Object.fromEntries(
        Array.from({ length: 32 }, (_, index) => [`f-${index}.ts`, {
          nextOffset: 1, totalLines: 1_000_000, truncated: true, sha256: 'b'.repeat(64),
        } as ReadProgressCursor]),
      ),
      toolLedger: Array.from({ length: 64 }, (_, index) => ({
        id: `c-${index}`, tool: 'read', path: `f-${index % 32}.ts`, status: 'done' as const,
      })),
    }
    expect(utf8ByteLength(formatLedgerBlock(many))).toBeLessThanOrEqual(MAX_LEDGER_BLOCK_BYTES)
  })
})

describe('createContextLedgerMessage / isContextLedgerMessage', () => {
  it('returns undefined for an empty ledger (legacy checkpoint)', () => {
    const checkpoint = {
      id: 'ck-1',
      sessionId: 's-1',
      throughMessageId: 'm-1',
      summary: 's',
      summaryHash: '',
      reason: 'manual' as const,
      tokensBefore: 1,
      estimatedTokensAfter: 1,
      requestBytesBefore: 1,
      requestBytesAfter: 1,
      modelProvider: 'p',
      modelId: 'm',
      promptVersion: 2,
      excludedMessageIds: [],
      facts: { readFiles: [], modifiedFiles: [] } as ContextCheckpointFacts,
      createdAt: 1,
    }
    expect(createContextLedgerMessage(checkpoint)).toBeUndefined()
  })

  it('builds a projection user message with the ledger prefix', () => {
    const checkpoint = {
      id: 'ck-2',
      sessionId: 's-1',
      throughMessageId: 'm-1',
      summary: 's',
      summaryHash: '',
      reason: 'manual' as const,
      tokensBefore: 1,
      estimatedTokensAfter: 1,
      requestBytesBefore: 1,
      requestBytesAfter: 1,
      modelProvider: 'p',
      modelId: 'm',
      promptVersion: 2,
      excludedMessageIds: [],
      facts: {
        readFiles: [],
        modifiedFiles: [],
        readProgress: { 'a.ts': { nextOffset: 2, totalLines: 10, truncated: true, sha256: 'a'.repeat(64) } },
        toolLedger: [],
      },
      createdAt: 42,
    }
    const message = createContextLedgerMessage(checkpoint)
    expect(message).toBeDefined()
    expect(message?.id).toBe('context-ledger:ck-2')
    expect(message?.role).toBe('user')
    expect(isContextLedgerMessage(message as never)).toBe(true)
    expect(isContextLedgerMessage({ id: 'context-summary:x', role: 'user', content: '', createdAt: 1 })).toBe(false)
  })
})
