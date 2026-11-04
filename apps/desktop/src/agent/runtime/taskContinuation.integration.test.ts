import { describe, expect, it } from 'vitest'
import type { AgentTool, ModelTransport } from '@/agent/core/types'
import { MemorySessionRepository } from '@/persistence/MemorySessionRepository'
import { AgentHarness } from './AgentHarness'
import { readTaskSummary } from './taskSummary'
import type { AgentLifecycleEvent } from '@/persistence/types'

describe('受控续跑的 Harness 与仓储集成', () => {
  it('跨阶段结算、持久化恢复和手动继续共用正确的消息边界', async () => {
    const repository = new MemorySessionRepository()
    const defaults = { systemPrompt: 'system', modelProvider: 'test', modelId: 'model' }
    const initial = await repository.initialize(defaults)
    const sessionId = initial.active.session.id
    let requests = 0
    let executions = 0
    const tool: AgentTool = {
      name: 'inspect', runtimeVersion: '1', label: 'inspect', description: 'inspect',
      inputSchema: { type: 'object' }, validate: (value) => ({ ok: true, value }),
      execute: async () => ({ content: `证据 ${++executions}` }),
    }
    const transport: ModelTransport = {
      async *stream() {
        requests += 1
        yield { type: 'start' }
        if (requests <= 4) {
          yield { type: 'tool_call_start', index: 0, id: `call-${requests}`, name: 'inspect' }
          yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' }
          yield { type: 'tool_call_end', index: 0 }
          yield { type: 'done', stopReason: 'tool_use' }
        } else {
          yield { type: 'text_delta', delta: '完成' }
          yield { type: 'done', stopReason: 'stop' }
        }
      },
    }
    const createHarness = (messages = initial.active.messages) => {
      const harness = new AgentHarness({
        sessionId, systemPrompt: 'system', model: { provider: 'test', model: 'model' },
        transport, tools: [tool], messages, limits: { maxTurns: 1 }, autoContinueOnLimit: true,
        commitMutationBatch: (batch) => repository.commitMutationBatch(sessionId, batch),
      })
      harness.subscribeRuntime((event) => repository.recordEvent(sessionId, event as AgentLifecycleEvent))
      return harness
    }
    const harness = createHarness()
    expect((await harness.prompt('完成长任务')).reason).toBe('turn_limit')
    const saved = await repository.loadSession(sessionId)
    expect(saved.session.status).toBe('idle')
    expect(saved.messages).toEqual(harness.messages)
    expect(readTaskSummary(saved.messages)?.usage).toMatchObject({ stages: 4, continuations: 3 })
    await harness.dispose()
    const restored = createHarness(saved.messages)
    expect(requests).toBe(4)
    expect((await restored.continue()).reason).toBe('completed')
    const completed = await repository.loadSession(sessionId)
    expect(completed.session.status).toBe('idle')
    expect(completed.messages).toEqual(restored.messages)
    expect(completed.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(executions).toBe(4)
    await restored.dispose()
  })
})
