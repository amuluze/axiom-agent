import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@/agent/core/types'
import { hashContextSummary, SUMMARY_PROMPT_VERSION } from './compaction'
import { assertContextCheckpointIntegrity } from './checkpointIntegrity'
import type { ContextCheckpoint } from './types'

const userMessage: AgentMessage = {
  id: 'msg-user',
  role: 'user',
  content: 'hello',
  createdAt: 1,
}

const buildCheckpoint = async (
  overrides: Partial<ContextCheckpoint> = {},
): Promise<ContextCheckpoint> => {
  const base: Omit<ContextCheckpoint, 'summaryHash'> = {
    id: 'checkpoint-1',
    sessionId: 'session-1',
    throughMessageId: 'msg-user',
    summary: 'user said hello',
    reason: 'token_threshold',
    tokensBefore: 100,
    estimatedTokensAfter: 50,
    requestBytesBefore: 1_000,
    requestBytesAfter: 600,
    modelProvider: 'provider-a',
    modelId: 'model-a',
    promptVersion: SUMMARY_PROMPT_VERSION,
    excludedMessageIds: [],
    facts: { readFiles: [], modifiedFiles: [] },
    createdAt: 1_000,
    ...overrides,
  }
  const summary = (overrides.summary ?? base.summary) as string
  return {
    ...base,
    ...overrides,
    summaryHash: (overrides.summaryHash ?? (await hashContextSummary(summary))) as string,
  }
}

const messages: AgentMessage[] = [userMessage]

describe('assertContextCheckpointIntegrity', () => {
  it('accepts a well-formed checkpoint as current', async () => {
    await expect(assertContextCheckpointIntegrity(await buildCheckpoint(), 'session-1', messages))
      .resolves.toBe(true)
  })

  it('rejects a checkpoint bound to another session', async () => {
    await expect(assertContextCheckpointIntegrity(await buildCheckpoint(), 'session-other', messages))
      .rejects.toThrow('不属于当前会话')
  })

  it('rejects empty id / boundary / summary fields', async () => {
    await expect(assertContextCheckpointIntegrity(await buildCheckpoint({ id: '  ' }), 'session-1', messages))
      .rejects.toThrow('ID 不能为空')
    await expect(assertContextCheckpointIntegrity(await buildCheckpoint({ throughMessageId: '' }), 'session-1', messages))
      .rejects.toThrow('边界消息不能为空')
    await expect(assertContextCheckpointIntegrity(await buildCheckpoint({ summary: '' }), 'session-1', messages))
      .rejects.toThrow('摘要不能为空')
  })

  it('rejects a summary beyond the 256 KiB persistence cap', async () => {
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({ summary: 'x'.repeat(256 * 1024 + 1) }),
      'session-1',
      messages,
    )).rejects.toThrow('256 KiB')
  })

  it('rejects a mismatched or malformed summary hash', async () => {
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({ summaryHash: 'deadbeef' }),
      'session-1',
      messages,
    )).rejects.toThrow('摘要哈希校验失败')
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({ summaryHash: 'a'.repeat(64) }),
      'session-1',
      messages,
    )).rejects.toThrow('摘要哈希校验失败')
  })

  it('rejects an invalid compaction reason', async () => {
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({ reason: 'automatic' as ContextCheckpoint['reason'] }),
      'session-1',
      messages,
    )).rejects.toThrow('原因无效')
  })

  it('rejects missing model identity', async () => {
    await expect(assertContextCheckpointIntegrity(await buildCheckpoint({ modelProvider: '' }), 'session-1', messages))
      .rejects.toThrow('模型标识无效')
    await expect(assertContextCheckpointIntegrity(await buildCheckpoint({ modelId: '  ' }), 'session-1', messages))
      .rejects.toThrow('模型标识无效')
  })

  it('rejects a prompt version from the future as unresolvable', async () => {
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({ promptVersion: SUMMARY_PROMPT_VERSION + 1 }),
      'session-1',
      messages,
    )).rejects.toThrow('高于当前摘要提示词')
  })

  it('marks an older prompt version as stale without blocking restore', async () => {
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({ promptVersion: SUMMARY_PROMPT_VERSION - 1 }),
      'session-1',
      messages,
    )).resolves.toBe(false)
  })

  it('rejects negative or non-finite budget fields', async () => {
    await expect(assertContextCheckpointIntegrity(await buildCheckpoint({ tokensBefore: -1 }), 'session-1', messages))
      .rejects.toThrow('token')
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({ estimatedTokensAfter: Number.NaN }),
      'session-1',
      messages,
    )).rejects.toThrow('token')
  })

  it('rejects a boundary message not persisted in the current session', async () => {
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({ throughMessageId: 'msg-ghost' }),
      'session-1',
      messages,
    )).rejects.toThrow('尚未持久化')
  })

  it('rejects a boundary that splits a ToolCall/ToolResult group', async () => {
    const groupMessages: AgentMessage[] = [
      {
        id: 'msg-user',
        role: 'user',
        content: 'go',
        createdAt: 1,
      },
      {
        id: 'msg-assistant',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'echo', arguments: {}, rawArguments: '{}' }],
        stopReason: 'tool_use',
        createdAt: 2,
      },
      {
        id: 'msg-tool',
        role: 'tool',
        toolCallId: 'call-1',
        toolName: 'echo',
        content: 'result',
        isError: false,
        createdAt: 3,
      },
    ]
    // 边界落在 assistant（组内首条）会拆分 ToolCall/ToolResult 组
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({ throughMessageId: 'msg-assistant' }),
      'session-1',
      groupMessages,
    )).rejects.toThrow('拆分')
  })

  it('rejects duplicate excluded message ids and ids outside history', async () => {
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({ excludedMessageIds: ['msg-user', 'msg-user'] }),
      'session-1',
      messages,
    )).rejects.toThrow('排除消息列表无效')
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({ excludedMessageIds: ['msg-ghost'] }),
      'session-1',
      messages,
    )).rejects.toThrow('不属于当前会话历史')
  })

  it('rejects duplicate or conflicting file facts', async () => {
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({ facts: { readFiles: ['a.ts', 'a.ts'], modifiedFiles: [] } }),
      'session-1',
      messages,
    )).rejects.toThrow('文件事实无效')
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({ facts: { readFiles: ['a.ts'], modifiedFiles: ['a.ts'] } }),
      'session-1',
      messages,
    )).rejects.toThrow('读写冲突')
  })

  it('tolerates legacy checkpoints without the ledger fields', async () => {
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({ facts: { readFiles: [], modifiedFiles: [] } }),
      'session-1',
      messages,
    )).resolves.toBe(true)
  })

  it('accepts a well-formed ledger and rejects malformed readProgress', async () => {
    const cursor = { nextOffset: 201, totalLines: 500, truncated: true, sha256: 'a'.repeat(64) }
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({
        facts: {
          readFiles: ['a.ts'],
          modifiedFiles: [],
          readProgress: { 'a.ts': cursor },
          toolLedger: [{ id: 'call-1', tool: 'read', path: 'a.ts', status: 'done' }],
        },
      }),
      'session-1',
      messages,
    )).resolves.toBe(true)
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({
        facts: {
          readFiles: [],
          modifiedFiles: [],
          readProgress: { 'a.ts': { ...cursor, totalLines: -1 } },
          toolLedger: [],
        },
      }),
      'session-1',
      messages,
    )).rejects.toThrow('读取游标')
  })

  it('rejects a readProgress cursor whose path was also modified', async () => {
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({
        facts: {
          readFiles: [],
          modifiedFiles: ['a.ts'],
          readProgress: { 'a.ts': { nextOffset: 2, totalLines: 10, truncated: true, sha256: 'a'.repeat(64) } },
          toolLedger: [],
        },
      }),
      'session-1',
      messages,
    )).rejects.toThrow('读写冲突')
  })

  it('rejects a malformed or duplicated toolLedger', async () => {
    const base = {
      readFiles: [],
      modifiedFiles: [],
      readProgress: {},
    }
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({
        facts: { ...base, toolLedger: [{ id: 'call-1', tool: 'read', path: null, status: 'unknown' as 'done' | 'pending' | 'interrupted' }] },
      }),
      'session-1',
      messages,
    )).rejects.toThrow('状态无效')
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({
        facts: {
          ...base,
          toolLedger: [
            { id: 'call-1', tool: 'read', path: null, status: 'done' },
            { id: 'call-1', tool: 'bash', path: null, status: 'pending' },
          ],
        },
      }),
      'session-1',
      messages,
    )).rejects.toThrow('ID 重复')
  })

  it('accepts interrupted ledger entries from application-exit placeholders', async () => {
    // 崩溃 → 恢复注入中断占位 → 压缩把占位并入 facts.toolLedger → 再次恢复：
    // interrupted 是 mergeToolLedger 的合法产出，不得被完整性校验误判为损坏。
    await expect(assertContextCheckpointIntegrity(
      await buildCheckpoint({
        facts: {
          readFiles: [],
          modifiedFiles: [],
          readProgress: {},
          toolLedger: [{ id: 'call-1', tool: 'bash', path: null, status: 'interrupted' }],
        },
      }),
      'session-1',
      messages,
    )).resolves.toBe(true)
  })
})
