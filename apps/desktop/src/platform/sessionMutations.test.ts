import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import type { AgentMutationBatch } from '@/agent/core/types'
import type { RuntimeDependencyManifest } from '@/agent/runtime/runtimeDependencyManifest'
import { createSessionMutationRequest } from '@/persistence/sessionMutationPayload'
import { commitSessionMutationBatch } from './sessionMutations'

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

const runtimeManifest = (): RuntimeDependencyManifest => ({
  schemaVersion: 4,
  provider: {
    providerId: 'test',
    apiFormat: 'openai-compatible',
    modelId: 'model',
    transportVersion: '1',
  },
  tools: [{ name: 'read', version: '1', recoveryPolicy: 'never' }],
  hooks: [],
  skills: { schemaVersion: 1, skills: [] },
})

const dependenciesBatch = (invalidateCheckpoint: boolean): AgentMutationBatch => ({
  id: 'mutation_dependencies_test',
  sessionId: 'session_receipt_test',
  events: [
    {
      type: 'runtime_dependencies_update',
      previous: { systemPrompt: '旧提示词', activeToolNames: ['read'], runtimeManifest: runtimeManifest() },
      current: { systemPrompt: '新提示词', activeToolNames: ['read'], runtimeManifest: runtimeManifest() },
      source: 'set',
      invalidateCheckpoint,
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

  it('依赖替换批次只发一个事件（Rust 侧按一次操作计数）', () => {
    const request = createSessionMutationRequest(dependenciesBatch(false), runtimeManifest())
    expect(request.eventCount).toBe(1)
    expect(request.runtimeDependenciesUpdated).toBe(true)
    expect(request.invalidateCheckpoint).toBe(false)
    expect(request.systemPrompt).toBe('新提示词')
    expect(request.activeToolNames).toEqual(['read'])
    expect(request.runtimeManifestJson).toBeDefined()
  })

  it('依赖替换批次把 checkpoint 作废意图透传到 wire（Skill reload 声明作废）', () => {
    const request = createSessionMutationRequest(dependenciesBatch(true), runtimeManifest())
    expect(request.invalidateCheckpoint).toBe(true)
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
