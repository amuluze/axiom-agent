import type { AgentMessage } from '@/agent/core/types'
import { describe, expect, it } from 'vitest'
import {
  assertRetryTarget,
  assertBranchSummarySource,
  canBranchThrough,
  createBranchMessageCopies,
  editBoundaryFor,
  getBranchMessageActions,
  retryBoundaryFor,
} from './branch'

const history: AgentMessage[] = [
  { id: 'u1', role: 'user', content: 'inspect', createdAt: 1 },
  {
    id: 'a1',
    role: 'assistant',
    content: 'reading',
    toolCalls: [
      { id: 'call-1', name: 'read', arguments: { path: 'a' }, rawArguments: '{"path":"a"}' },
      { id: 'call-2', name: 'read', arguments: { path: 'b' }, rawArguments: '{"path":"b"}' },
    ],
    stopReason: 'tool_use',
    createdAt: 2,
  },
  { id: 't1', role: 'tool', toolCallId: 'call-1', toolName: 'read', content: 'a', isError: false, createdAt: 3 },
  { id: 't2', role: 'tool', toolCallId: 'call-2', toolName: 'read', content: 'b', isError: false, createdAt: 4 },
  { id: 'a2', role: 'assistant', content: 'done', toolCalls: [], stopReason: 'stop', createdAt: 5 },
]

describe('session branch boundaries', () => {
  it('never splits an assistant tool call from its complete result batch', () => {
    expect(canBranchThrough(history, 'u1')).toBe(true)
    expect(canBranchThrough(history, 'a1')).toBe(false)
    expect(canBranchThrough(history, 't1')).toBe(false)
    expect(canBranchThrough(history, 't2')).toBe(true)
    expect(canBranchThrough(history, 'a2')).toBe(true)
  })

  it('copies canonical history with new message ids and source lineage', () => {
    const copies = createBranchMessageCopies(history, 't2')

    expect(copies.map((copy) => copy.sourceMessageId)).toEqual(['u1', 'a1', 't1', 't2'])
    expect(copies.map((copy) => copy.message.role)).toEqual(['user', 'assistant', 'tool', 'tool'])
    expect(copies.every((copy) => copy.message.id !== copy.sourceMessageId)).toBe(true)
    expect(copies[1]?.message).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'call-1' }, { id: 'call-2' }] })
  })

  it('deep-copies ordered assistant content and diagnostics', () => {
    const source: AgentMessage[] = [
      { id: 'u-rich', role: 'user', content: 'inspect', createdAt: 1 },
      {
        id: 'a-rich',
        role: 'assistant',
        content: 'answer',
        contentBlocks: [
          { type: 'text', text: 'answer', textSignature: 'text-signature' },
          {
            type: 'tool_call',
            id: 'call-rich',
            name: 'read',
            arguments: { path: 'a' },
            rawArguments: '{"path":"a"}',
            thoughtSignature: 'thought-signature',
          },
        ],
        toolCalls: [{
          id: 'call-rich',
          name: 'read',
          arguments: { path: 'a' },
          rawArguments: '{"path":"a"}',
          thoughtSignature: 'thought-signature',
        }],
        diagnostics: [{ type: 'provider', timestamp: 2, details: { recovered: true } }],
        stopReason: 'tool_use',
        createdAt: 2,
      },
      { id: 't-rich', role: 'tool', toolCallId: 'call-rich', toolName: 'read', content: 'a', isError: false, createdAt: 3 },
    ]

    const copy = createBranchMessageCopies(source, 't-rich')[1]?.message
    expect(copy).toMatchObject({
      role: 'assistant',
      contentBlocks: [
        { type: 'text', textSignature: 'text-signature' },
        { type: 'tool_call', thoughtSignature: 'thought-signature' },
      ],
      diagnostics: [{ details: { recovered: true } }],
    })
    expect(copy).not.toBe(source[1])
    if (copy?.role === 'assistant' && source[1]?.role === 'assistant') {
      expect(copy.contentBlocks).not.toBe(source[1].contentBlocks)
      expect(copy.diagnostics?.[0]?.details).not.toBe(source[1].diagnostics?.[0]?.details)
    }
  })

  it('requires retry to target the first assistant after a safe boundary', () => {
    expect(retryBoundaryFor(history, 'a2')).toBe('t2')
    expect(() => assertRetryTarget(history, 't2', 'a2')).not.toThrow()
    expect(() => assertRetryTarget(history, 'u1', 'a2')).toThrow('第一条 Assistant')
    expect(retryBoundaryFor(history, 'u1')).toBeUndefined()
  })

  it('requires a Branch Summary to cover the complete abandoned tail', () => {
    expect(() => assertBranchSummarySource(history, 't2', {
      content: 'summary',
      sourceFromMessageId: 'a2',
      sourceThroughMessageId: 'a2',
      readFiles: [],
      modifiedFiles: [],
    })).not.toThrow()
    expect(() => assertBranchSummarySource(history, 'u1', {
      content: 'partial summary',
      sourceFromMessageId: 't1',
      sourceThroughMessageId: 'a2',
      readFiles: [],
      modifiedFiles: [],
    })).toThrow('完整已离开历史')
  })

  it('precomputes message actions in one history pass', () => {
    expect(getBranchMessageActions(history)).toEqual([
      { branchable: true, retryBoundaryId: undefined },
      { branchable: false, retryBoundaryId: 'u1' },
      { branchable: false, retryBoundaryId: undefined },
      { branchable: true, retryBoundaryId: undefined },
      { branchable: true, retryBoundaryId: 't2' },
    ])
  })

  it('rejects duplicate ToolResult ids as an incomplete batch', () => {
    const duplicateResults: AgentMessage[] = [
      ...history.slice(0, 3),
      { id: 't1-duplicate', role: 'tool', toolCallId: 'call-1', toolName: 'read', content: 'again', isError: false, createdAt: 4 },
    ]

    expect(canBranchThrough(duplicateResults, 't1-duplicate')).toBe(false)
    expect(getBranchMessageActions(duplicateResults).at(-1)?.branchable).toBe(false)
  })

  it('edits a user message through the boundary that precedes it', () => {
    const withFollowUp: AgentMessage[] = [
      ...history,
      { id: 'u2', role: 'user', content: 'more', createdAt: 6 },
    ]

    expect(editBoundaryFor(withFollowUp, 'u2')).toBe('a2')
    expect(getBranchMessageActions(withFollowUp).at(-1)?.editBoundaryId).toBe('a2')
    // 首条用户消息之前没有边界，UI 据此禁用编辑按钮。
    expect(getBranchMessageActions(history)[0]?.editBoundaryId).toBeUndefined()
  })

  it('refuses to edit without a safe boundary before the user message', () => {
    const afterIncompleteBatch: AgentMessage[] = [
      ...history.slice(0, 3),
      { id: 'u2', role: 'user', content: 'more', createdAt: 4 },
    ]

    expect(editBoundaryFor(history, 'u1')).toBeUndefined()
    expect(editBoundaryFor(history, 'a2')).toBeUndefined()
    expect(editBoundaryFor(history, 't1')).toBeUndefined()
    expect(editBoundaryFor(afterIncompleteBatch, 'u2')).toBeUndefined()
  })
})
