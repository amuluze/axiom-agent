import { describe, expect, it } from 'vitest'
import type { AgentLoopResult } from '@/agent/core/types'
import { buildContextProjection } from '@/agent/context/budget'
import { createUserMessage } from '@/agent/core/messages'
import { createTaskSummary, readTaskSummary } from './taskSummary'
import { MemorySessionRepository } from '@/persistence/MemorySessionRepository'

const result = {
  reason: 'turn_limit',
  taskUsage: {
    stages: 4, continuations: 3, turns: 192, toolCalls: 50,
    elapsedMs: 1000, continuationDecision: 'continuation_limit',
    tokenUsage: { inputTokens: 100, outputTokens: 10, billableTokens: 110, totalTokens: 110 },
  },
} as AgentLoopResult

describe('任务结算持久化契约', () => {
  it('通过仓储 mutation 保存后可在重新初始化时恢复', async () => {
    const repository = new MemorySessionRepository()
    const defaults = { systemPrompt: 'system', modelProvider: 'test', modelId: 'model' }
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const message = createTaskSummary(result)
    await repository.commitMutationBatch(sessionId, {
      id: 'task-summary-test', sessionId, createdAt: Date.now(),
      events: [{ type: 'session_message_append', sessionId, message }],
    })
    const restored = await repository.initialize(defaults)
    expect(readTaskSummary(restored.active.messages)).toEqual({ reason: result.reason, usage: result.taskUsage })
  })
  it('JSON 往返保留累计用量，但不进入模型上下文', () => {
    const message = JSON.parse(JSON.stringify(createTaskSummary(result)))
    expect(readTaskSummary([message])).toEqual({ reason: result.reason, usage: result.taskUsage })
    expect(buildContextProjection([message])).toEqual([])
  })
  it('后续用户消息使旧暂停状态失效', () => {
    expect(readTaskSummary([createTaskSummary(result), createUserMessage('新任务')])).toBeUndefined()
  })
  it('非法版本或累计用量不允许恢复', () => {
    const message = createTaskSummary(result)
    expect(readTaskSummary([{ ...message, data: { version: 2 } }])).toBeUndefined()
    const bad = createTaskSummary({ ...result, taskUsage: { ...result.taskUsage!, turns: -1 } })
    expect(readTaskSummary([bad])).toBeUndefined()
  })
})
