import type { ModelRequest, ModelStreamEvent, ModelTransport } from '@/agent/core/types'
import { describe, expect, it } from 'vitest'
import { AgentSession } from './AgentSession'
import { createProductRuntimeHooks } from './productRuntimeHooks'
import { createProductToolRuntime } from './productToolRuntime'

class DiscoveryTransport implements ModelTransport {
  readonly requests: ModelRequest[] = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const requestIndex = this.requests.push(structuredClone(request)) - 1
    yield { type: 'start' }
    if (requestIndex === 0) {
      yield {
        type: 'tool_call_start',
        index: 0,
        contentIndex: 0,
        id: 'discover-call',
        name: 'discover_agent_tools',
      }
      yield {
        type: 'tool_call_delta',
        index: 0,
        argumentsDelta: '{"query":"bash","limit":1}',
      }
      yield { type: 'tool_call_end', index: 0 }
      yield { type: 'done', stopReason: 'tool_use' }
      return
    }
    yield { type: 'text_delta', delta: '工具已就绪' }
    yield { type: 'done', stopReason: 'stop' }
  }
}

class RestoredTransport implements ModelTransport {
  readonly requests: ModelRequest[] = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(structuredClone(request))
    yield { type: 'start' }
    yield { type: 'text_delta', delta: '恢复完成' }
    yield { type: 'done', stopReason: 'stop' }
  }
}

describe('product tool runtime', () => {
  it('discovers a real product tool, activates it next turn, and restores it from history', async () => {
    const runtime = createProductToolRuntime(['workspace:execute'])
    const transport = new DiscoveryTransport()
    const hooks = createProductRuntimeHooks({
      sessionId: 'desktop-discovery',
      discoveryToolName: runtime.discoveryToolName,
      getBasePrompt: () => 'system',
    })
    const session = new AgentSession({
      sessionId: 'desktop-discovery',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      tools: runtime.tools,
      activeToolNames: runtime.activeToolNames,
      prepareNextTurn: hooks.prepareNextTurn,
    })

    await session.prompt('请运行工作区测试')

    expect(transport.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      'discover_agent_tools',
    ])
    expect(transport.requests[1]?.tools.map((tool) => tool.name)).toEqual([
      'discover_agent_tools',
      'bash',
    ])
    expect(session.messages.find((message) => message.role === 'tool')).toMatchObject({
      toolName: 'discover_agent_tools',
      addedToolNames: ['bash'],
    })

    const restoredTransport = new RestoredTransport()
    const restoredSession = new AgentSession({
      sessionId: 'desktop-discovery',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: restoredTransport,
      tools: runtime.tools,
      activeToolNames: runtime.activeToolNames,
      messages: session.messages,
      prepareNextTurn: hooks.prepareNextTurn,
    })

    await restoredSession.prompt('继续')

    expect(restoredTransport.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      'discover_agent_tools',
      'bash',
    ])
  })

  it('activates read-only tools at startup so inspect-only tasks skip the first discover round-trip', () => {
    const runtime = createProductToolRuntime(['workspace:read'])
    // The new tiered activation policy exposes read/ls/grep/find at startup
    // (mirrors pi's defaultActiveToolNames for zero-risk tools) while leaving
    // write/execute tools gated behind discover_agent_tools.
    expect(runtime.activeToolNames).toContain('discover_agent_tools')
    expect(runtime.activeToolNames).toContain('read')
    expect(runtime.activeToolNames).toContain('ls')
    expect(runtime.activeToolNames).toContain('grep')
    expect(runtime.activeToolNames).toContain('find')
    expect(runtime.activeToolNames).not.toContain('write')
    expect(runtime.activeToolNames).not.toContain('edit')
    expect(runtime.activeToolNames).not.toContain('bash')
  })
})
