import type { AssistantMessage, ToolResultMessage } from '@/agent/core/types'
import { describe, expect, it } from 'vitest'
import {
  createInterruptedToolResult,
  interruptedToolResultId,
} from './interruptedToolRecovery'

const assistant: AssistantMessage = {
  id: 'assistant-tools',
  role: 'assistant',
  content: '',
  toolCalls: [{ id: 'call-shared', name: 'read', arguments: {}, rawArguments: '{}' }],
  stopReason: 'tool_use',
  createdAt: 1,
}

const result: ToolResultMessage = {
  id: 'tool-existing',
  role: 'tool',
  toolCallId: 'call-shared',
  toolName: 'read',
  content: 'done',
  isError: false,
  createdAt: 2,
}

describe('interrupted ToolCall recovery', () => {
  it('uses the exact run boundary and ignores a same-ID ToolResult from another run', async () => {
    const recovered = await createInterruptedToolResult([
      { message: assistant, runId: 'run-one' },
      { message: result, runId: 'run-two' },
    ], 'run-one', 'call-shared', 3)

    expect(recovered).toMatchObject({
      id: await interruptedToolResultId('run-one', 'call-shared'),
      toolCallId: 'call-shared',
      toolName: 'read',
      isError: true,
    })
  })

  it('is deterministic and never adds a second result to a completed call', async () => {
    expect(await createInterruptedToolResult([
      { message: assistant, runId: 'run-one' },
      { message: result, runId: 'run-one' },
    ], 'run-one', 'call-shared', 3)).toBeUndefined()
    expect(await interruptedToolResultId('run-one', 'call-shared'))
      .toBe(await interruptedToolResultId('run-one', 'call-shared'))
    expect(await interruptedToolResultId('run-one', 'call-shared'))
      .not.toBe(await interruptedToolResultId('run-two', 'call-shared'))
  })

  it('records conservative replay eligibility metadata for idempotent tools', async () => {
    const recovered = await createInterruptedToolResult(
      [{ message: assistant, runId: 'run-one' }],
      'run-one',
      'call-shared',
      3,
      'idempotent',
    )

    expect(recovered?.details).toEqual({
      reason: 'application_exit',
      executionState: 'interrupted',
      runId: 'run-one',
      recoveryPolicy: 'idempotent',
      replayed: false,
      eligibleForReplay: true,
    })
  })

  it('distinguishes a completed-but-unsaved execution with the anti-replay wording', async () => {
    const recovered = await createInterruptedToolResult(
      [{ message: assistant, runId: 'run-one' }],
      'run-one',
      'call-shared',
      3,
      'never',
      'completed',
    )

    expect(recovered).toBeDefined()
    expect(recovered?.details).toMatchObject({ executionState: 'completed' })
    expect(recovered?.content).toContain('已执行完成')
    expect(recovered?.content).not.toContain('应用可能在收尾阶段退出')
  })
})
