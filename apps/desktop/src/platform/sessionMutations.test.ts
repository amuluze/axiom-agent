import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import type { AgentMutationBatch } from '@/agent/core/types'
import { commitSessionMutationBatch, createSessionMutationRequest } from './sessionMutations'

beforeEach(() => {
  mocks.invoke.mockReset()
})

const idleReasoningBatch = (): AgentMutationBatch => ({
  id: 'mutation_receipt_test',
  sessionId: 'session_receipt_test',
  events: [
    {
      type: 'runtime_reasoning_update',
      previous: null,
      current: { level: 'low', mode: 'effort' },
      source: 'set',
    },
  ],
  createdAt: 1_700_000_000_000,
})

describe('createSessionMutationRequest', () => {
  it('空闲 batch 的 request 编码缺省 runId/turn（无 Run ownership）', () => {
    const request = createSessionMutationRequest(idleReasoningBatch())
    expect('runId' in request).toBe(false)
    expect('turn' in request).toBe(false)
    expect(request.batchId).toBe('mutation_receipt_test')
    expect(request.eventCount).toBe(1)
    expect(request.reasoningUpdated).toBe(true)
  })
})

describe('commitSessionMutationBatch', () => {
  it('把 Rust wire receipt 中的 null 可选字段归一为 undefined', async () => {
    // 模拟修复前 Rust serde 的输出形态：None → null 而非字段缺失。
    // ownership 校验是严格比较，null 会被误判为 batch ownership 不一致。
    mocks.invoke.mockResolvedValueOnce({
      batchId: 'mutation_receipt_test',
      sessionId: 'session_receipt_test',
      runId: null,
      turn: null,
      committedAt: 1_700_000_000_001,
      replayed: false,
    })
    const receipt = await commitSessionMutationBatch(idleReasoningBatch())
    expect(receipt.runId).toBeUndefined()
    expect(receipt.turn).toBeUndefined()
    expect(receipt.batchId).toBe('mutation_receipt_test')
    expect(receipt.sessionId).toBe('session_receipt_test')
    expect(receipt.committedAt).toBe(1_700_000_000_001)
    expect(receipt.replayed).toBe(false)
    expect(mocks.invoke).toHaveBeenCalledWith('commit_session_mutation_batch', {
      request: expect.objectContaining({ batchId: 'mutation_receipt_test' }),
    })
  })

  it('Run 内 batch 的 receipt ownership 字段原样透传', async () => {
    mocks.invoke.mockResolvedValueOnce({
      batchId: 'mutation_receipt_test',
      sessionId: 'session_receipt_test',
      runId: 'run_receipt_test',
      turn: 2,
      committedAt: 1_700_000_000_001,
      replayed: true,
    })
    const receipt = await commitSessionMutationBatch({
      ...idleReasoningBatch(),
      runId: 'run_receipt_test',
      turn: 2,
    })
    expect(receipt.runId).toBe('run_receipt_test')
    expect(receipt.turn).toBe(2)
    expect(receipt.replayed).toBe(true)
  })
})
