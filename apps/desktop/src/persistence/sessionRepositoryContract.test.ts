/// <reference types="node" />
import type { AgentLifecycleEvent } from './types'
import type { JsonValue } from '@/agent/core/types'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MemorySessionRepository } from './MemorySessionRepository'

interface SessionRepositoryContract {
  schemaVersion: 1
  scenario: string
  sessionId: string
  runId: string
  tool: {
    toolCallId: string
    toolName: string
    arguments: JsonValue
    canonicalReplayArguments: JsonValue
    driftedArguments: JsonValue
    approvalState: 'not_required' | 'pending'
    recoveryPolicy: 'never' | 'idempotent'
    idempotencyKey?: string
  }
  expected: {
    canonicalReplay: 'accepted'
    driftError: string
    recoveredRuns: number
    sessionStatus: 'idle'
    runStatus: 'interrupted'
    toolStatus: 'interrupted'
    runCount: number
    toolExecutionCount: number
  }
}

const contract = JSON.parse(readFileSync(
  new URL('../../contracts/session-repository-contract-v1.json', import.meta.url),
  'utf8',
)) as SessionRepositoryContract

const toolStart = (argumentsValue: JsonValue): AgentLifecycleEvent => ({
  type: 'tool_execution_start',
  runId: contract.runId,
  toolCallId: contract.tool.toolCallId,
  toolName: contract.tool.toolName,
  arguments: structuredClone(argumentsValue),
  approvalState: contract.tool.approvalState,
  recoveryPolicy: contract.tool.recoveryPolicy,
  ...(contract.tool.idempotencyKey ? { idempotencyKey: contract.tool.idempotencyKey } : {}),
})

describe('Session Repository shared contract', () => {
  it('runs canonical replay and recovery transitions against Memory', async () => {
    expect(contract.schemaVersion).toBe(1)
    expect(contract.scenario).toBe('canonical-tool-replay-and-recovery')
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize({
      systemPrompt: 'system',
      modelProvider: 'test',
      modelId: 'model',
    })
    const sessionId = initialized.active.session.id

    await repository.recordEvent(sessionId, {
      type: 'agent_start',
      sessionId,
      runId: contract.runId,
    })
    await repository.recordEvent(sessionId, toolStart(contract.tool.arguments))
    await expect(repository.recordEvent(
      sessionId,
      toolStart(contract.tool.canonicalReplayArguments),
    )).resolves.toBeUndefined()
    await expect(repository.recordEvent(
      sessionId,
      toolStart(contract.tool.driftedArguments),
    )).rejects.toThrow(contract.expected.driftError)

    await expect(repository.recoverRuntimeState()).resolves.toEqual({
      recoveredRuns: contract.expected.recoveredRuns,
    })
    await expect(repository.loadSession(sessionId)).resolves.toMatchObject({
      session: { status: contract.expected.sessionStatus },
    })
    await expect(repository.getStats()).resolves.toMatchObject({
      runCount: contract.expected.runCount,
      toolExecutionCount: contract.expected.toolExecutionCount,
    })
  })
})
