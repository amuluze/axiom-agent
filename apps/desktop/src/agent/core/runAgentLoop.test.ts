import { createUserMessage } from './messages'
import { markPersistenceUnrelated } from './persistenceBarrier'
import { runAgentLoop } from './runAgentLoop'
import { ApprovalCoordinator } from '../approval/ApprovalCoordinator'
import { computeBudgetThresholds, DEFAULT_AGENT_LIMITS } from './types'
import type {
  AgentContext,
  AgentEvent,
  AgentMessage,
  AgentMutationBatch,
  AgentTool,
  JsonValue,
  ModelRequest,
  ModelStreamEvent,
  ModelTransport,
  UserMessage,
} from './types'
import { describe, expect, it, vi } from 'vitest'

class ScriptedTransport implements ModelTransport {
  readonly requests: ModelRequest[] = []

  constructor(private readonly scripts: ModelStreamEvent[][]) {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request)
    const script = this.scripts[this.requests.length - 1]
    if (!script) throw new Error('No scripted model response')
    for (const event of script) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      yield event
    }
  }
}

const createContext = (tools: AgentTool[] = []): AgentContext => ({
  sessionId: 'session-test',
  systemPrompt: 'Test system prompt',
  model: { provider: 'test', model: 'test-model' },
  messages: [],
  tools,
})

const textResponse = (content: string): ModelStreamEvent[] => [
  { type: 'start', responseId: 'response-1' },
  { type: 'text_delta', delta: content },
  { type: 'done', stopReason: 'stop' },
]

const toolResponse = (rawArguments: string, stopReason: 'tool_use' | 'length' = 'tool_use'): ModelStreamEvent[] => [
  { type: 'start', responseId: 'response-tool' },
  { type: 'tool_call_start', index: 0, id: 'call-1', name: 'echo' },
  { type: 'tool_call_delta', index: 0, argumentsDelta: rawArguments },
  { type: 'tool_call_end', index: 0 },
  { type: 'done', stopReason },
]

const isObject = (value: JsonValue): value is { [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const createEchoTool = (execute: AgentTool['execute']): AgentTool => ({
  name: 'echo',
  runtimeVersion: '1',
  label: 'Echo',
  description: 'Echo a value',
  inputSchema: {
    type: 'object',
    properties: {
      value: { type: 'string' },
    },
    required: ['value'],
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isObject(input) || typeof input.value !== 'string') {
      return { ok: false, error: 'value must be a string' }
    }
    return { ok: true, value: input }
  },
  execute,
})

const createObjectTool = (name: string, execute: AgentTool['execute']): AgentTool => ({
  name,
  runtimeVersion: '1',
  label: name,
  description: name,
  inputSchema: { type: 'object' },
  validate: (input) => isObject(input)
    ? { ok: true, value: input }
    : { ok: false, error: 'expected object' },
  execute,
})

describe('runAgentLoop', () => {
  it('streams a normal assistant response and emits an ordered lifecycle', async () => {
    const transport = new ScriptedTransport([textResponse('hello')])
    const events: AgentEvent[] = []

    const result = await runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('hi')],
      transport,
      emit: (event) => { events.push(event) },
    })

    expect(result.reason).toBe('completed')
    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(result.messages[1]).toMatchObject({ role: 'assistant', content: 'hello', stopReason: 'stop' })
    expect(events.slice(0, 4).map((event) => event.type)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_end',
    ])
    expect(events.at(-1)?.type).toBe('agent_end')
    const updates = events.filter((event) => event.type === 'message_update')
    expect(updates.map((event) => event.assistantMessageEvent.type)).toEqual([
      'text_start',
      'text_delta',
      'text_end',
    ])
    expect(updates[1]).toMatchObject({
      update: 'text',
      messageId: updates[1].messageId,
      delta: 'hello',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'hello',
      },
    })
  })

  it('preserves the provider order and metadata of rich assistant content', async () => {
    const transport = new ScriptedTransport([[
      { type: 'start', responseId: 'response-rich', responseModel: 'resolved-model' },
      { type: 'thinking_start', contentIndex: 0, thinkingSignature: 'thinking-signature' },
      { type: 'thinking_delta', contentIndex: 0, delta: 'reason' },
      { type: 'thinking_end', contentIndex: 0 },
      { type: 'text_delta', contentIndex: 1, delta: 'before', textSignature: 'text-signature' },
      {
        type: 'tool_call_start',
        index: 0,
        contentIndex: 2,
        id: 'call-rich',
        name: 'echo',
        thoughtSignature: 'thought-signature',
      },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"value":"ok"}' },
      { type: 'tool_call_end', index: 0 },
      { type: 'text_delta', contentIndex: 3, delta: 'after' },
      {
        type: 'diagnostic',
        diagnostic: { type: 'provider-recovery', timestamp: 10, details: { attempt: 2 } },
      },
      {
        type: 'done',
        stopReason: 'tool_use',
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
          cacheWriteTokens: 3,
          cacheWrite1hTokens: 2,
        },
      },
    ], textResponse('done')])

    const events: AgentEvent[] = []
    const result = await runAgentLoop({
      context: createContext([createEchoTool(async () => ({ content: 'ok' }))]),
      prompts: [createUserMessage('rich')],
      transport,
      emit: (event) => { events.push(event) },
    })

    expect(result.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'beforeafter',
      responseModel: 'resolved-model',
      diagnostics: [{ type: 'provider-recovery', timestamp: 10, details: { attempt: 2 } }],
      usage: { cacheWrite1hTokens: 2 },
      toolCalls: [{
        id: 'call-rich',
        name: 'echo',
        thoughtSignature: 'thought-signature',
      }],
      contentBlocks: [
        {
          type: 'thinking',
          thinking: 'reason',
          thinkingSignature: 'thinking-signature',
        },
        { type: 'text', text: 'before', textSignature: 'text-signature' },
        {
          type: 'tool_call',
          id: 'call-rich',
          name: 'echo',
          thoughtSignature: 'thought-signature',
        },
        { type: 'text', text: 'after' },
      ],
    })
    const streamedMessageId = result.messages[1]!.id
    expect(events.flatMap((event) =>
      event.type === 'message_update' && event.messageId === streamedMessageId
        ? [event.assistantMessageEvent.type]
        : [])).toEqual([
      'thinking_start',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta',
      'text_end',
      'toolcall_start',
      'toolcall_delta',
      'toolcall_end',
      'text_start',
      'text_delta',
      'text_end',
    ])
  })

  it('allows a preflight hook to replace the model-only context projection', async () => {
    const transport = new ScriptedTransport([textResponse('projected')])
    const oldMessage = createUserMessage('old history', 1)
    const result = await runAgentLoop({
      context: { ...createContext(), messages: [oldMessage] },
      prompts: [createUserMessage('new prompt', 2)],
      transport,
      prepareModelRequest: async (request) => ({
        ...request,
        messages: request.messages.filter((message) => message.id !== oldMessage.id),
      }),
    })

    expect(transport.requests[0]?.messages.map((message) => message.content)).toEqual(['new prompt'])
    expect(result.newMessages.map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  it('executes a tool, appends its result, and feeds it into the next model turn', async () => {
    let assistantBarrierSettled = false
    const execute = vi.fn<AgentTool['execute']>(async (input) => {
      expect(assistantBarrierSettled).toBe(true)
      if (!isObject(input) || typeof input.value !== 'string') throw new Error('invalid test input')
      return { content: input.value }
    })
    const transport = new ScriptedTransport([
      toolResponse('{"value":"from tool"}'),
      textResponse('final answer'),
    ])

    const result = await runAgentLoop({
      context: createContext([createEchoTool(execute)]),
      prompts: [createUserMessage('use the tool')],
      transport,
      emit: async (event) => {
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          await Promise.resolve()
          assistantBarrierSettled = true
        }
      },
    })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(result.messages[2]).toMatchObject({ role: 'tool', content: 'from tool', isError: false })
    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[1]?.messages.at(-1)?.role).toBe('tool')
  })

  it('activates deferred tools only after the declaring tool result', async () => {
    const discover = createObjectTool('discover', async () => ({
      content: 'loaded deferred',
      addedToolNames: ['deferred'],
    }))
    const deferredExecute = vi.fn<AgentTool['execute']>(async () => ({ content: 'deferred result' }))
    const deferred = createObjectTool('deferred', deferredExecute)
    const transport = new ScriptedTransport([
      [
        { type: 'start' },
        { type: 'tool_call_start', index: 0, id: 'discover-call', name: 'discover' },
        { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' },
        { type: 'tool_call_end', index: 0 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'start' },
        { type: 'tool_call_start', index: 0, id: 'deferred-call', name: 'deferred' },
        { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' },
        { type: 'tool_call_end', index: 0 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      textResponse('done'),
    ])

    const result = await runAgentLoop({
      context: {
        ...createContext([discover, deferred]),
        activeToolNames: ['discover'],
      },
      prompts: [createUserMessage('discover and use')],
      transport,
    })

    expect(transport.requests.map((request) => request.tools.map((tool) => tool.name))).toEqual([
      ['discover'],
      ['discover', 'deferred'],
      ['discover', 'deferred'],
    ])
    expect(result.messages.find((message) =>
      message.role === 'tool' && message.toolCallId === 'discover-call')).toMatchObject({
      addedToolNames: ['deferred'],
      isError: false,
    })
    expect(result.context.activeToolNames).toEqual(['discover', 'deferred'])
    expect(deferredExecute).toHaveBeenCalledTimes(1)
  })

  it.each([
    { label: 'unknown', addedToolNames: ['missing'] },
    { label: 'duplicate', addedToolNames: ['deferred', 'deferred'] },
  ])('turns $label deferred tool declarations into a safe tool error', async ({ addedToolNames }) => {
    const discover = createObjectTool('discover', async () => ({
      content: 'invalid discovery',
      addedToolNames,
    }))
    const deferred = createObjectTool('deferred', async () => ({ content: 'unused' }))
    const transport = new ScriptedTransport([
      [
        { type: 'start' },
        { type: 'tool_call_start', index: 0, id: 'discover-call', name: 'discover' },
        { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' },
        { type: 'tool_call_end', index: 0 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      textResponse('recovered'),
    ])

    const result = await runAgentLoop({
      context: {
        ...createContext([discover, deferred]),
        activeToolNames: ['discover'],
      },
      prompts: [createUserMessage('discover')],
      transport,
    })

    expect(result.messages.find((message) => message.role === 'tool')).toMatchObject({
      isError: true,
    })
    expect(result.messages.find((message) => message.role === 'tool')).not.toHaveProperty('addedToolNames')
    expect(result.context.activeToolNames).toEqual(['discover'])
  })

  it('restores active tools from history without replaying historical tool calls', async () => {
    const executions: string[] = []
    const discover = createObjectTool('discover', async () => {
      executions.push('discover')
      return { content: 'loaded', addedToolNames: ['deferred'] }
    })
    const deferred = createObjectTool('deferred', async () => {
      executions.push('deferred')
      return { content: 'used' }
    })
    const transport = new ScriptedTransport([textResponse('resumed')])

    const result = await runAgentLoop({
      context: {
        ...createContext([discover, deferred]),
        activeToolNames: ['discover'],
        messages: [
          createUserMessage('old', 1),
          {
            id: 'old-assistant',
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'old-call', name: 'discover', arguments: {}, rawArguments: '{}' }],
            stopReason: 'tool_use',
            createdAt: 2,
          },
          {
            id: 'old-result',
            role: 'tool',
            toolCallId: 'old-call',
            toolName: 'discover',
            content: 'loaded',
            addedToolNames: ['deferred'],
            isError: false,
            createdAt: 3,
          },
        ],
      },
      prompts: [],
      transport,
    })

    expect(transport.requests[0]?.tools.map((tool) => tool.name)).toEqual(['discover', 'deferred'])
    expect(executions).toEqual([])
    expect(result.context.activeToolNames).toEqual(['discover', 'deferred'])
  })

  it('externalizes oversized tool results before returning a bounded message to the model', async () => {
    const complete = JSON.stringify({ output: 'x'.repeat(300) })
    const externalizeToolResult = vi.fn(async () => ({
      id: `sha256:${'a'.repeat(64)}`,
      kind: 'json' as const,
      mediaType: 'application/json',
      relativePath: `artifacts/sha256/aa/${'a'.repeat(64)}`,
      contentHash: 'a'.repeat(64),
      sizeBytes: new TextEncoder().encode(complete).byteLength,
      createdAt: 1,
    }))
    const transport = new ScriptedTransport([
      toolResponse('{"value":"large"}'),
      textResponse('artifact saved'),
    ])

    const result = await runAgentLoop({
      context: createContext([createEchoTool(async () => ({ content: complete }))]),
      prompts: [createUserMessage('produce a large result')],
      transport,
      limits: { maxInlineToolResultBytes: 128 },
      externalizeToolResult,
    })

    expect(externalizeToolResult).toHaveBeenCalledWith(expect.objectContaining({ content: complete }))
    expect(result.messages[2]).toMatchObject({
      role: 'tool',
      artifact: { contentHash: 'a'.repeat(64), sizeBytes: complete.length },
    })
    expect(result.messages[2]?.content).toContain('完整工具结果已安全保存为 Artifact')
    expect(new TextEncoder().encode(result.messages[2]?.content).byteLength).toBeLessThanOrEqual(128)
    expect(transport.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      artifact: { contentHash: 'a'.repeat(64) },
    })
  })

  it('persists an explicit audit artifact without inflating the model-visible tool result', async () => {
    const externalizeToolResult = vi.fn(async ({ content }: { content: string }) => ({
      id: `sha256:${'b'.repeat(64)}`,
      kind: 'text' as const,
      mediaType: 'text/plain',
      relativePath: `artifacts/sha256/bb/${'b'.repeat(64)}`,
      contentHash: 'b'.repeat(64),
      sizeBytes: new TextEncoder().encode(content).byteLength,
      createdAt: 1,
    }))
    const transport = new ScriptedTransport([
      toolResponse('{"value":"audit"}'),
      textResponse('audit saved'),
    ])

    const result = await runAgentLoop({
      context: createContext([createEchoTool(async () => ({
        content: 'short result',
        artifactContent: 'full approved workspace diff',
      }))]),
      prompts: [createUserMessage('apply changes')],
      transport,
      externalizeToolResult,
    })

    expect(externalizeToolResult).toHaveBeenCalledWith(expect.objectContaining({
      content: 'full approved workspace diff',
    }))
    expect(result.messages[2]).toMatchObject({
      role: 'tool',
      content: 'short result',
      artifact: { contentHash: 'b'.repeat(64) },
    })
  })

  it('uses an artifact persisted atomically by the tool without externalizing it again', async () => {
    const artifact = {
      id: `sha256:${'c'.repeat(64)}`,
      kind: 'text' as const,
      mediaType: 'text/plain;charset=utf-8',
      relativePath: `artifacts/sha256/cc/${'c'.repeat(64)}`,
      contentHash: 'c'.repeat(64),
      sizeBytes: 42,
      createdAt: 1,
    }
    const externalizeToolResult = vi.fn()
    const transport = new ScriptedTransport([
      toolResponse('{"value":"atomic audit"}'),
      textResponse('audit linked'),
    ])

    const result = await runAgentLoop({
      context: createContext([createEchoTool(async () => ({
        content: 'workspace changes committed',
        artifact,
      }))]),
      prompts: [createUserMessage('apply changes')],
      transport,
      externalizeToolResult,
    })

    expect(externalizeToolResult).not.toHaveBeenCalled()
    expect(result.messages[2]).toMatchObject({
      role: 'tool',
      content: 'workspace changes committed',
      artifact: { contentHash: 'c'.repeat(64) },
    })
  })

  it('makes artifact persistence failures visible without replaying the completed tool', async () => {
    const execute = vi.fn<AgentTool['execute']>(async () => ({ content: 'x'.repeat(300) }))
    const transport = new ScriptedTransport([
      toolResponse('{"value":"large"}'),
      textResponse('continued safely'),
    ])

    const result = await runAgentLoop({
      context: createContext([createEchoTool(execute)]),
      prompts: [createUserMessage('produce a large result')],
      transport,
      limits: { maxInlineToolResultBytes: 128 },
      externalizeToolResult: async () => Promise.reject(new Error('disk unavailable')),
    })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.messages[2]).toMatchObject({
      role: 'tool',
      artifactError: '完整工具结果未能写入 Artifact 存储',
    })
    expect(result.messages[2]?.content).toContain('Artifact 保存失败')
  })

  it('returns invalid JSON to the model without executing the tool', async () => {
    const execute = vi.fn<AgentTool['execute']>(async () => ({ content: 'should not run' }))
    const transport = new ScriptedTransport([
      toolResponse('{"value":'),
      textResponse('recovered'),
    ])

    const result = await runAgentLoop({
      context: createContext([createEchoTool(execute)]),
      prompts: [createUserMessage('broken args')],
      transport,
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.messages[2]).toMatchObject({ role: 'tool', isError: true })
    expect(result.messages[2]?.content).toContain('不是有效 JSON')
    expect(result.reason).toBe('completed')
  })

  it('normalizes compatibility arguments before validation, approval, and execution', async () => {
    const validate = vi.fn<AgentTool['validate']>((input) =>
      isObject(input) && typeof input.value === 'string'
        ? { ok: true, value: input }
        : { ok: false, error: 'value must be a string' })
    const execute = vi.fn<AgentTool['execute']>(async (input) => ({
      content: isObject(input) && typeof input.value === 'string' ? input.value : '',
    }))
    const tool: AgentTool = {
      ...createEchoTool(execute),
      requiresApproval: true,
      prepareArguments: (input) => isObject(input) && typeof input.legacyValue === 'string'
        ? { value: input.legacyValue }
        : input,
      validate,
    }
    const transport = new ScriptedTransport([
      toolResponse('{"legacyValue":"normalized"}'),
      textResponse('done'),
    ])
    const beforeToolCall = vi.fn(async (hookContext) => {
      expect(hookContext.input).toEqual({ value: 'normalized' })
      expect(hookContext.toolCall.arguments).toEqual({ legacyValue: 'normalized' })
      expect(hookContext.assistantMessage.toolCalls[0]?.id).toBe('call-1')
      expect(hookContext.context.messages.at(-1)?.role).toBe('assistant')
      return { decision: 'approved' as const }
    })

    const result = await runAgentLoop({
      context: createContext([tool]),
      prompts: [createUserMessage('legacy args')],
      transport,
      beforeToolCall,
    })

    expect(validate).toHaveBeenCalledWith({ value: 'normalized' })
    expect(execute).toHaveBeenCalledWith(
      { value: 'normalized' },
      expect.objectContaining({ toolCallId: 'call-1' }),
    )
    expect(result.messages[2]).toMatchObject({ role: 'tool', content: 'normalized' })
  })

  it('allows beforeToolCall to block a tool that does not require user approval', async () => {
    const execute = vi.fn<AgentTool['execute']>(async () => ({ content: 'must not run' }))
    const transport = new ScriptedTransport([
      toolResponse('{"value":"blocked"}'),
      textResponse('acknowledged'),
    ])
    const beforeToolCall = vi.fn(async (hookContext) => {
      expect(hookContext.requiresApproval).toBe(false)
      return { decision: 'denied' as const, reason: 'runtime policy blocked this call' }
    })

    const result = await runAgentLoop({
      context: createContext([createEchoTool(execute)]),
      prompts: [createUserMessage('policy check')],
      transport,
      beforeToolCall,
    })

    expect(beforeToolCall).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
    expect(result.messages[2]).toMatchObject({ role: 'tool', isError: true })
    expect(result.messages[2]?.content).toContain('runtime policy blocked this call')
  })

  it('isolates preflight hook snapshots from validated execution state', async () => {
    const executedInputs: JsonValue[] = []
    const transport = new ScriptedTransport([
      toolResponse('{"value":"validated"}'),
      textResponse('done'),
    ])
    const context = createContext([createEchoTool(async (input) => {
      executedInputs.push(input)
      return { content: isObject(input) && typeof input.value === 'string' ? input.value : 'invalid' }
    })])
    context.messages = [createUserMessage('durable history', 1)]

    const result = await runAgentLoop({
      context,
      prompts: [createUserMessage('run safely', 2)],
      transport,
      beforeToolCall: async (hookContext) => {
        if (isObject(hookContext.input)) hookContext.input.value = 123
        hookContext.assistantMessage.toolCalls[0]!.name = 'mutated-call'
        hookContext.toolCall.name = 'mutated-call'
        hookContext.context.model.model = 'mutated-model'
        hookContext.context.messages[0]!.content = 'mutated-history'
        hookContext.presentation.title = 'mutated-title'
        return { decision: 'approved' }
      },
    })

    expect(executedInputs).toEqual([{ value: 'validated' }])
    expect(result.context.model.model).toBe('test-model')
    expect(result.messages[0]).toMatchObject({ role: 'user', content: 'durable history' })
    expect(result.messages[2]).toMatchObject({
      role: 'assistant',
      toolCalls: [{ name: 'echo', arguments: { value: 'validated' } }],
    })
    expect(result.messages[3]).toMatchObject({ role: 'tool', content: 'validated' })
  })

  it('isolates post-tool hooks and event observers unless they return an explicit override', async () => {
    const transport = new ScriptedTransport([
      toolResponse('{"value":"original"}'),
      textResponse('done'),
    ])

    const result = await runAgentLoop({
      context: createContext([createEchoTool(async () => ({
        content: 'original',
        details: { source: 'tool' },
      }))]),
      prompts: [createUserMessage('observe safely')],
      transport,
      afterToolCall: async (hookContext) => {
        hookContext.result.content = 'mutated-by-hook'
        hookContext.context.model.model = 'mutated-model'
        return undefined
      },
      emit: (event) => {
        if (event.type === 'tool_execution_end') {
          event.result.content = 'mutated-by-observer'
        }
        if (event.type === 'message_end') event.message.content = 'mutated-message'
      },
    })

    expect(result.context.model.model).toBe('test-model')
    expect(result.messages[0]).toMatchObject({ role: 'user', content: 'observe safely' })
    expect(result.messages[2]).toMatchObject({
      role: 'tool',
      content: 'original',
      details: { source: 'tool' },
    })
  })

  it('completes parallel tool preflight sequentially before any execution begins', async () => {
    let releasePreflight = (): void => undefined
    let notifyPreflightStarted = (): void => undefined
    const preflightGate = new Promise<void>((resolve) => {
      releasePreflight = resolve
    })
    const preflightStarted = new Promise<void>((resolve) => {
      notifyPreflightStarted = resolve
    })
    let activePreflights = 0
    let preflightsCompleted = 0
    let preflightsOverlapped = false
    const executionPreflightCounts: number[] = []
    const makeTool = (name: string): AgentTool => createObjectTool(name, async () => {
      executionPreflightCounts.push(preflightsCompleted)
      return { content: `${name} done` }
    })
    const transport = new ScriptedTransport([[
      { type: 'start' },
      { type: 'tool_call_start', index: 0, id: 'first-call', name: 'first' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' },
      { type: 'tool_call_end', index: 0 },
      { type: 'tool_call_start', index: 1, id: 'second-call', name: 'second' },
      { type: 'tool_call_delta', index: 1, argumentsDelta: '{}' },
      { type: 'tool_call_end', index: 1 },
      { type: 'done', stopReason: 'tool_use' },
    ], textResponse('done')])

    const run = runAgentLoop({
      context: createContext([makeTool('first'), makeTool('second')]),
      prompts: [createUserMessage('preflight in order')],
      transport,
      beforeToolCall: async () => {
        activePreflights += 1
        if (activePreflights > 1) preflightsOverlapped = true
        notifyPreflightStarted()
        await preflightGate
        activePreflights -= 1
        preflightsCompleted += 1
        return { decision: 'approved' }
      },
    })

    await preflightStarted
    releasePreflight()
    await run

    expect(preflightsOverlapped).toBe(false)
    expect(preflightsCompleted).toBe(2)
    expect(executionPreflightCounts).toEqual([2, 2])
  })

  it('serializes parallel approval requests without replacing an earlier decision', async () => {
    const approvalCoordinator = new ApprovalCoordinator()
    let notifyFirstPending = (): void => undefined
    let notifySecondPending = (): void => undefined
    const firstPending = new Promise<void>((resolve) => {
      notifyFirstPending = resolve
    })
    const secondPending = new Promise<void>((resolve) => {
      notifySecondPending = resolve
    })
    approvalCoordinator.subscribe((pending) => {
      if (pending?.toolCallId === 'first-call') notifyFirstPending()
      if (pending?.toolCallId === 'second-call') notifySecondPending()
    })
    const executeFirst = vi.fn<AgentTool['execute']>(async () => ({ content: 'first done' }))
    const executeSecond = vi.fn<AgentTool['execute']>(async () => ({ content: 'second done' }))
    const protectedTool = (name: string, execute: AgentTool['execute']): AgentTool => ({
      ...createObjectTool(name, execute),
      requiresApproval: true,
    })
    const transport = new ScriptedTransport([[
      { type: 'start' },
      { type: 'tool_call_start', index: 0, id: 'first-call', name: 'first' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' },
      { type: 'tool_call_end', index: 0 },
      { type: 'tool_call_start', index: 1, id: 'second-call', name: 'second' },
      { type: 'tool_call_delta', index: 1, argumentsDelta: '{}' },
      { type: 'tool_call_end', index: 1 },
      { type: 'done', stopReason: 'tool_use' },
    ], textResponse('done')])

    const run = runAgentLoop({
      context: createContext([
        protectedTool('first', executeFirst),
        protectedTool('second', executeSecond),
      ]),
      prompts: [createUserMessage('approve in order')],
      transport,
      beforeToolCall: approvalCoordinator.request,
    })

    await firstPending
    const firstApproved = await approvalCoordinator.respond('first-call', 'approved')
    if (!firstApproved) {
      approvalCoordinator.cancel('test cleanup')
      await run
    }
    expect(firstApproved).toBe(true)
    await secondPending
    await expect(approvalCoordinator.respond('second-call', 'approved')).resolves.toBe(true)
    await run

    expect(executeFirst).toHaveBeenCalledTimes(1)
    expect(executeSecond).toHaveBeenCalledTimes(1)
  })

  it('starts sequential tool calls only when each call actually begins', async () => {
    const tool = {
      ...createEchoTool(async (input) => ({
        content: isObject(input) && typeof input.value === 'string' ? input.value : '',
      })),
      executionMode: 'sequential' as const,
    }
    const transport = new ScriptedTransport([[
      { type: 'start' },
      { type: 'tool_call_start', index: 0, id: 'call-1', name: 'echo' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"value":"one"}' },
      { type: 'tool_call_end', index: 0 },
      { type: 'tool_call_start', index: 1, id: 'call-2', name: 'echo' },
      { type: 'tool_call_delta', index: 1, argumentsDelta: '{"value":"two"}' },
      { type: 'tool_call_end', index: 1 },
      { type: 'done', stopReason: 'tool_use' },
    ], textResponse('done')])
    const executionEvents: string[] = []

    await runAgentLoop({
      context: createContext([tool]),
      prompts: [createUserMessage('run sequentially')],
      transport,
      emit: (event) => {
        if (event.type === 'tool_execution_start') executionEvents.push(`start:${event.toolCallId}`)
        if (event.type === 'tool_execution_end') executionEvents.push(`end:${event.toolCallId}`)
      },
    })

    expect(executionEvents).toEqual([
      'start:call-1',
      'end:call-1',
      'start:call-2',
      'end:call-2',
    ])
  })

  it('emits parallel completion events in finish order but persists results in source order', async () => {
    let releaseSlow = (): void => undefined
    let notifyFastEnded = (): void => undefined
    const slowReleased = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const fastEnded = new Promise<void>((resolve) => {
      notifyFastEnded = resolve
    })
    const makeTool = (name: string, execute: AgentTool['execute']): AgentTool => ({
      ...createEchoTool(execute),
      name,
      label: name,
    })
    const transport = new ScriptedTransport([[
      { type: 'start' },
      { type: 'tool_call_start', index: 0, id: 'slow-call', name: 'slow' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"value":"slow"}' },
      { type: 'tool_call_end', index: 0 },
      { type: 'tool_call_start', index: 1, id: 'fast-call', name: 'fast' },
      { type: 'tool_call_delta', index: 1, argumentsDelta: '{"value":"fast"}' },
      { type: 'tool_call_end', index: 1 },
      { type: 'done', stopReason: 'tool_use' },
    ], textResponse('done')])
    const completionOrder: string[] = []
    const run = runAgentLoop({
      context: createContext([
        makeTool('slow', async () => {
          await slowReleased
          return { content: 'slow result' }
        }),
        makeTool('fast', async () => ({ content: 'fast result' })),
      ]),
      prompts: [createUserMessage('run in parallel')],
      transport,
      emit: (event) => {
        if (event.type !== 'tool_execution_end') return
        completionOrder.push(event.toolCallId)
        if (event.toolCallId === 'fast-call') notifyFastEnded()
      },
    })

    await fastEnded
    releaseSlow()
    const result = await run

    expect(completionOrder).toEqual(['fast-call', 'slow-call'])
    expect(result.messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId))
      .toEqual(['slow-call', 'fast-call'])
  })

  it('stops after a tool batch when every result requests termination', async () => {
    const makeTerminatingTool = (name: string): AgentTool => ({
      ...createEchoTool(async () => ({ content: `${name} done`, terminate: true })),
      name,
      label: name,
    })
    const transport = new ScriptedTransport([[
      { type: 'start' },
      { type: 'tool_call_start', index: 0, id: 'first-call', name: 'first' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"value":"one"}' },
      { type: 'tool_call_end', index: 0 },
      { type: 'tool_call_start', index: 1, id: 'second-call', name: 'second' },
      { type: 'tool_call_delta', index: 1, argumentsDelta: '{"value":"two"}' },
      { type: 'tool_call_end', index: 1 },
      { type: 'done', stopReason: 'tool_use' },
    ]])

    const result = await runAgentLoop({
      context: createContext([
        makeTerminatingTool('first'),
        makeTerminatingTool('second'),
      ]),
      prompts: [createUserMessage('terminate after tools')],
      transport,
    })

    expect(result.reason).toBe('completed')
    expect(transport.requests).toHaveLength(1)
    expect(result.messages.filter((message) => message.role === 'tool')).toHaveLength(2)
  })

  it('never executes tool calls from a length-truncated model response', async () => {
    const execute = vi.fn<AgentTool['execute']>(async () => ({ content: 'should not run' }))
    const transport = new ScriptedTransport([
      toolResponse('{"value":"looks valid"}', 'length'),
      textResponse('retried safely'),
    ])

    const result = await runAgentLoop({
      context: createContext([createEchoTool(execute)]),
      prompts: [createUserMessage('truncated')],
      transport,
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.messages[2]?.content).toContain('参数可能不完整')
    expect(transport.requests).toHaveLength(2)
  })

  it('auto-continues a text response truncated by max_tokens when there are no tool calls', async () => {
    const truncatedText = (content: string): ModelStreamEvent[] => [
      { type: 'start', responseId: 'response-truncated' },
      { type: 'text_delta', delta: content },
      { type: 'done', stopReason: 'length' },
    ]
    const transport = new ScriptedTransport([
      truncatedText('前半段输出'),
      textResponse('后半段输出'),
    ])

    const result = await runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('long output')],
      transport,
    })

    expect(result.reason).toBe('completed')
    expect(transport.requests).toHaveLength(2)
    // 第二轮请求以续写 custom 消息（转 user）结尾，模型据此从未完成处续写
    const secondRequestMessages = transport.requests[1]!.messages
    const lastMessage = secondRequestMessages[secondRequestMessages.length - 1]
    expect(lastMessage).toMatchObject({ role: 'user' })
    expect(lastMessage.content).toContain('截断')
    const assistants = result.messages.filter((message) => message.role === 'assistant')
    expect(assistants.map((message) => message.content)).toEqual(['前半段输出', '后半段输出'])
  })

  it('prefers queued follow-up over auto-continue when a response is length-truncated', async () => {
    const truncatedText = (content: string): ModelStreamEvent[] => [
      { type: 'start', responseId: 'response-truncated' },
      { type: 'text_delta', delta: content },
      { type: 'done', stopReason: 'length' },
    ]
    const transport = new ScriptedTransport([
      truncatedText('被截断的前半段'),
      textResponse('回答排队问题'),
    ])
    let followUpDelivered = false

    const result = await runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('task')],
      transport,
      getFollowUpMessages: async () => {
        if (followUpDelivered) return []
        followUpDelivered = true
        return [createUserMessage('排队问题')]
      },
    })

    expect(result.reason).toBe('completed')
    expect(transport.requests).toHaveLength(2)
    // 用户主动排队的 follow-up 优先，自动续写不介入
    const lastMessage = transport.requests[1]!.messages[transport.requests[1]!.messages.length - 1]
    expect(lastMessage).toMatchObject({ role: 'user', content: '排队问题' })
  })

  it('bounds streamed tool arguments even when the Provider omits a length stop reason', async () => {
    const execute = vi.fn<AgentTool['execute']>(async () => ({ content: 'must not run' }))
    const transport = new ScriptedTransport([
      toolResponse(JSON.stringify({ value: 'x'.repeat(200) })),
      textResponse('reissued safely'),
    ])

    const result = await runAgentLoop({
      context: createContext([createEchoTool(execute)]),
      prompts: [createUserMessage('large arguments')],
      transport,
      limits: { maxMessageBytes: 48 },
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.messages[1]).toMatchObject({ role: 'assistant', stopReason: 'length' })
    expect(result.messages[2]?.content).toContain('参数可能不完整')
  })

  it('waits for one-time approval before executing a protected tool', async () => {
    const execute = vi.fn<AgentTool['execute']>(async () => ({ content: 'written' }))
    const events: AgentEvent[] = []
    const tool: AgentTool = {
      ...createEchoTool(execute),
      requiresApproval: true,
      executionMode: 'sequential',
      approvalPresentation: () => ({
        title: '创建文件？',
        description: '即将在工作区创建文件。',
        path: 'notes.txt',
        preview: '+ hello',
      }),
      auditArguments: () => ({ path: 'notes.txt', contentBytes: 5 }),
    }
    const transport = new ScriptedTransport([
      toolResponse('{"value":"secret content"}'),
      textResponse('done'),
    ])
    const beforeToolCall = vi.fn(async (context) => {
      expect(context.input).toEqual({ value: 'secret content' })
      expect(context.presentation).toMatchObject({ path: 'notes.txt', preview: '+ hello' })
      return { decision: 'approved' as const }
    })

    const result = await runAgentLoop({
      context: createContext([tool]),
      prompts: [createUserMessage('write')],
      transport,
      beforeToolCall,
      emit: (event) => { events.push(event) },
    })

    expect(beforeToolCall).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.messages[2]).toMatchObject({ role: 'tool', content: 'written', isError: false })
    expect(events.find((event) => event.type === 'tool_execution_start')).toMatchObject({
      arguments: { path: 'notes.txt', contentBytes: 5 },
      approvalState: 'pending',
    })
    expect(events.find((event) => event.type === 'tool_execution_end')).toMatchObject({
      approvalState: 'approved',
      isError: false,
    })
  })

  it('returns a denial to the model without executing the protected tool', async () => {
    const execute = vi.fn<AgentTool['execute']>(async () => ({ content: 'must not run' }))
    const tool: AgentTool = { ...createEchoTool(execute), requiresApproval: true }
    const transport = new ScriptedTransport([
      toolResponse('{"value":"denied"}'),
      textResponse('acknowledged'),
    ])

    const result = await runAgentLoop({
      context: createContext([tool]),
      prompts: [createUserMessage('write')],
      transport,
      beforeToolCall: async () => ({ decision: 'denied', reason: '用户选择拒绝' }),
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.messages[2]).toMatchObject({ role: 'tool', isError: true })
    expect(result.messages[2]?.content).toContain('用户选择拒绝')
    expect(transport.requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', isError: true })
  })

  it('denies a protected tool by default when no approval handler exists', async () => {
    const execute = vi.fn<AgentTool['execute']>(async () => ({ content: 'must not run' }))
    const tool: AgentTool = { ...createEchoTool(execute), requiresApproval: true }
    const transport = new ScriptedTransport([
      toolResponse('{"value":"no handler"}'),
      textResponse('acknowledged'),
    ])

    const result = await runAgentLoop({
      context: createContext([tool]),
      prompts: [createUserMessage('write')],
      transport,
    })

    expect(execute).not.toHaveBeenCalled()
    expect(result.messages[2]?.content).toContain('没有可用的用户审批处理器')
  })

  it('does not execute when a protected tool cannot build its approval preview', async () => {
    const execute = vi.fn<AgentTool['execute']>(async () => ({ content: 'must not run' }))
    const beforeToolCall = vi.fn(async () => ({ decision: 'approved' as const }))
    const tool: AgentTool = {
      ...createEchoTool(execute),
      requiresApproval: true,
      approvalPresentation: () => {
        throw new Error('preview failed')
      },
    }
    const transport = new ScriptedTransport([
      toolResponse('{"value":"unsafe"}'),
      textResponse('acknowledged'),
    ])

    const result = await runAgentLoop({
      context: createContext([tool]),
      prompts: [createUserMessage('write')],
      transport,
      beforeToolCall,
    })

    expect(beforeToolCall).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(result.messages[2]?.content).toContain('无法生成安全审批预览')
  })

  it('aborts a pending approval without executing the tool', async () => {
    const execute = vi.fn<AgentTool['execute']>(async () => ({ content: 'must not run' }))
    const tool: AgentTool = { ...createEchoTool(execute), requiresApproval: true }
    const transport = new ScriptedTransport([toolResponse('{"value":"wait"}')])
    const controller = new AbortController()
    let notifyApproval = (): void => undefined
    const approvalStarted = new Promise<void>((resolve) => {
      notifyApproval = resolve
    })
    const events: AgentEvent[] = []

    const run = runAgentLoop({
      context: createContext([tool]),
      prompts: [createUserMessage('write')],
      transport,
      signal: controller.signal,
      beforeToolCall: async () => {
        notifyApproval()
        return new Promise(() => undefined)
      },
      emit: (event) => { events.push(event) },
    })

    await approvalStarted
    controller.abort(new DOMException('Cancelled by test', 'AbortError'))
    const result = await run

    expect(result.reason).toBe('aborted')
    expect(execute).not.toHaveBeenCalled()
    expect(result.messages[2]).toMatchObject({ role: 'tool', isError: true })
    expect(events.find((event) => event.type === 'tool_execution_end')).toMatchObject({
      approvalState: 'denied',
      isError: true,
    })
  })

  it('injects steering before the next model request', async () => {
    const transport = new ScriptedTransport([textResponse('first'), textResponse('second')])
    let steeringPolls = 0
    const steering: UserMessage = {
      id: 'steering-1',
      role: 'user',
      content: 'change direction',
      createdAt: 2,
    }

    const result = await runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('start', 1)],
      transport,
      getSteeringMessages: async () => {
        steeringPolls += 1
        return steeringPolls === 2 ? [steering] : []
      },
    })

    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[1]?.messages.at(-1)).toMatchObject({ role: 'user', content: 'change direction' })
    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('injects follow-up only after the agent would otherwise stop', async () => {
    const transport = new ScriptedTransport([textResponse('first'), textResponse('followed up')])
    let followUpPolls = 0
    const followUp: UserMessage = {
      id: 'follow-up-1',
      role: 'user',
      content: 'one more thing',
      createdAt: 2,
    }

    const result = await runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('start', 1)],
      transport,
      getFollowUpMessages: async () => {
        followUpPolls += 1
        return followUpPolls === 1 ? [followUp] : []
      },
    })

    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[1]?.messages.at(-1)).toMatchObject({ role: 'user', content: 'one more thing' })
    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('preserves streamed thinking blocks and extended usage separately from visible text', async () => {
    const transport = new ScriptedTransport([[
      { type: 'start', responseId: 'thinking-response' },
      { type: 'thinking_start', contentIndex: 0 },
      { type: 'thinking_delta', contentIndex: 0, delta: 'private reasoning' },
      { type: 'thinking_signature_delta', contentIndex: 0, delta: 'signed' },
      { type: 'thinking_end', contentIndex: 0 },
      { type: 'text_delta', contentIndex: 1, delta: 'visible answer' },
      {
        type: 'done',
        stopReason: 'stop',
        usage: {
          inputTokens: 10,
          outputTokens: 8,
          totalTokens: 18,
          cacheReadTokens: 4,
          reasoningTokens: 5,
        },
      },
    ]])
    const events: AgentEvent[] = []

    const result = await runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('think')],
      transport,
      emit: (event) => { events.push(event) },
    })

    expect(result.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'visible answer',
      contentBlocks: [
        { type: 'thinking', thinking: 'private reasoning', signature: 'signed' },
        { type: 'text', text: 'visible answer' },
      ],
      usage: { cacheReadTokens: 4, reasoningTokens: 5 },
    })
    expect(events.some((event) => event.type === 'message_update' && event.update === 'thinking')).toBe(true)
  })

  it('keeps a complete tool call when a large thinking signature exceeds the byte budget', async () => {
    // thinking signature 是 opaque provider 元数据，不应挤占可见内容字节预算：
    // 2 MiB signature 若按正文预算计，会把后续完整工具参数判为 length 而整体 fail。
    const transport = new ScriptedTransport([
      [
        { type: 'start', responseId: 'sig-response' },
        { type: 'thinking_start', contentIndex: 0 },
        { type: 'thinking_delta', contentIndex: 0, delta: 'private reasoning' },
        { type: 'thinking_signature_delta', contentIndex: 0, delta: 'x'.repeat(2 * 1024 * 1024) },
        { type: 'thinking_end', contentIndex: 0 },
        { type: 'tool_call_start', index: 0, id: 'call-1', name: 'echo' },
        { type: 'tool_call_delta', index: 0, argumentsDelta: '{"value":"from tool"}' },
        { type: 'tool_call_end', index: 0 },
        { type: 'done', stopReason: 'stop' },
      ],
      textResponse('final answer'),
    ])
    const execute = vi.fn<AgentTool['execute']>(async () => ({ content: 'ok' }))

    const result = await runAgentLoop({
      context: createContext([createEchoTool(execute)]),
      prompts: [createUserMessage('use the tool')],
      transport,
    })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.reason).toBe('completed')
  })

  it('transforms context, converts custom messages and resolves a credential reference for each turn', async () => {
    const transport = new ScriptedTransport([textResponse('converted')])
    const transformContext = vi.fn(async (messages: AgentMessage[]) => messages.map((message) => ({ ...message })))
    const convertToModelMessages = vi.fn(async (messages: AgentMessage[]) => messages.map((message) => message.role === 'custom'
      ? {
          id: message.id,
          role: 'user' as const,
          content: `custom:${message.content}`,
          createdAt: message.createdAt,
        }
      : message))
    const resolveModelAuth = vi.fn(async () => ({ secretId: 'provider.dynamic.api-key' }))
    const onModelRequest = vi.fn(async () => undefined)
    const onModelResponse = vi.fn(async () => undefined)

    const result = await runAgentLoop({
      context: createContext(),
      prompts: [{
        id: 'custom-1',
        role: 'custom',
        customType: 'runtime-note',
        content: 'keep this',
        data: { priority: 1 },
        createdAt: 1,
      }],
      transport,
      transformContext,
      convertToModelMessages,
      resolveModelAuth,
      onModelRequest,
      onModelResponse,
    })

    expect(transformContext).toHaveBeenCalledTimes(1)
    expect(convertToModelMessages).toHaveBeenCalledTimes(1)
    expect(resolveModelAuth).toHaveBeenCalledWith({ provider: 'test', model: 'test-model' }, expect.any(AbortSignal))
    expect(onModelRequest).toHaveBeenCalledWith(expect.objectContaining({
      auth: { secretId: 'provider.dynamic.api-key' },
    }), expect.any(AbortSignal))
    expect(onModelResponse).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: 'converted' }),
      expect.any(Object),
      expect.any(AbortSignal),
    )
    expect(transport.requests[0]).toMatchObject({
      auth: { secretId: 'provider.dynamic.api-key' },
      messages: [{ role: 'user', content: 'custom:keep this' }],
    })
    expect(result.messages[0]?.role).toBe('custom')
  })

  it('isolates transform and provider observer objects from durable runtime state', async () => {
    const transport = new ScriptedTransport([textResponse('provider answer')])
    const result = await runAgentLoop({
      context: createContext([createObjectTool('safe_tool', async () => ({ content: 'unused' }))]),
      prompts: [createUserMessage('durable prompt')],
      transport,
      transformContext: async (messages) => {
        messages[0]!.content = 'model-only projection'
        return messages
      },
      resolveModelAuth: async (model) => {
        model.model = 'mutated-auth-model'
        return { secretId: 'safe-secret-id' }
      },
      onModelRequest: async (request) => {
        request.model.model = 'mutated-observer-model'
        request.messages[0]!.content = 'mutated-observer-message'
        request.tools[0]!.name = 'mutated-observer-tool'
      },
      onModelResponse: async (message, request) => {
        message.content = 'mutated-observer-response'
        request.messages[0]!.content = 'mutated-response-request'
      },
    })

    expect(transport.requests[0]).toMatchObject({
      model: { model: 'test-model' },
      messages: [{ role: 'user', content: 'model-only projection' }],
      tools: [{ name: 'safe_tool' }],
    })
    expect(result.context.model.model).toBe('test-model')
    expect(result.messages).toMatchObject([
      { role: 'user', content: 'durable prompt' },
      { role: 'assistant', content: 'provider answer' },
    ])
  })

  it('allows afterToolCall to inspect and replace the result before model feedback', async () => {
    const transport = new ScriptedTransport([
      toolResponse('{"value":"raw"}'),
      textResponse('done'),
    ])
    const afterToolCall = vi.fn(async ({ assistantMessage, context, result }) => {
      expect(assistantMessage.toolCalls[0]?.id).toBe('call-1')
      expect(context.messages.at(-1)).toMatchObject({ role: 'assistant', id: assistantMessage.id })
      return {
        result: { ...result, content: `post:${result.content}`, details: { reviewed: true } },
      }
    })

    const result = await runAgentLoop({
      context: createContext([createEchoTool(async (input) => ({
        content: isObject(input) && typeof input.value === 'string' ? input.value : '',
      }))]),
      prompts: [createUserMessage('post process')],
      transport,
      afterToolCall,
    })

    expect(afterToolCall).toHaveBeenCalledTimes(1)
    expect(result.messages[2]).toMatchObject({
      role: 'tool',
      content: 'post:raw',
      details: { reviewed: true },
      isError: false,
    })
    expect(transport.requests[1]?.messages.at(-1)).toMatchObject({ content: 'post:raw' })
  })

  it('ignores tool progress reported after execution has settled', async () => {
    let reportLateProgress: (() => Promise<void>) | undefined
    const events: AgentEvent[] = []
    const transport = new ScriptedTransport([
      toolResponse('{"value":"progress"}'),
      textResponse('done'),
    ])

    await runAgentLoop({
      context: createContext([createEchoTool(async (_input, toolContext) => {
        reportLateProgress = () => toolContext.reportProgress('too late')
        await toolContext.reportProgress('in time')
        return { content: 'finished' }
      })]),
      prompts: [createUserMessage('progress lifecycle')],
      transport,
      emit: (event) => { events.push(event) },
    })

    expect(events.filter((event) => event.type === 'tool_execution_update')).toHaveLength(1)
    await reportLateProgress?.()
    expect(events.filter((event) => event.type === 'tool_execution_update')).toHaveLength(1)
  })

  it('keeps a successful tool result when a progress event emit rejects', async () => {
    const events: AgentEvent[] = []
    const transport = new ScriptedTransport([
      toolResponse('{"value":"progress"}'),
      textResponse('done'),
    ])

    const result = await runAgentLoop({
      context: createContext([createEchoTool(async (_input, toolContext) => {
        // fire-and-forget：工具不等待进度事件的落定，副作用在 emit 失败前已生效。
        void toolContext.reportProgress('progress that fails to emit')
        return { content: 'executed' }
      })]),
      prompts: [createUserMessage('progress emit failure')],
      transport,
      emit: (event) => {
        events.push(event)
        if (event.type === 'tool_execution_update') {
          return Promise.reject(new Error('store write failed'))
        }
        return undefined
      },
    })

    const toolResult = result.messages.find((message) => message.role === 'tool')
    expect(toolResult).toMatchObject({ content: 'executed', isError: false })
    expect(events.filter((event) => event.type === 'tool_execution_update')).toHaveLength(1)
  })

  it('does not replay afterToolCall when tool end persistence fails', async () => {
    const execute = vi.fn<AgentTool['execute']>(async () => ({ content: 'executed once' }))
    const afterToolCall = vi.fn(async () => undefined)
    const transport = new ScriptedTransport([toolResponse('{"value":"once"}')])

    const result = await runAgentLoop({
      context: createContext([createEchoTool(execute)]),
      prompts: [createUserMessage('persist tool end')],
      transport,
      afterToolCall,
      emit: (event) => {
        if (event.type === 'tool_execution_end') throw new Error('tool event persistence failed')
      },
    })

    expect(result.reason).toBe('error')
    expect(result.errorMessage).toBe('tool event persistence failed')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(afterToolCall).toHaveBeenCalledTimes(1)
  })

  it('applies next-turn model, reasoning and transport updates inside the same run', async () => {
    const firstTransport = new ScriptedTransport([toolResponse('{"value":"switch"}')])
    const secondTransport = new ScriptedTransport([textResponse('new model answer')])

    const result = await runAgentLoop({
      context: createContext([createEchoTool(async () => ({ content: 'switch now' }))]),
      prompts: [createUserMessage('switch model')],
      transport: firstTransport,
      prepareNextTurn: async (snapshot) => {
        expect(snapshot.context.messages).toEqual(snapshot.messages)
        expect(snapshot.newMessages).toEqual(snapshot.messages)
        return snapshot.turn === 1
          ? {
              model: { provider: 'next', model: 'next-model' },
              reasoning: { level: 'high', mode: 'effort' },
              transport: secondTransport,
            }
          : undefined
      },
    })

    expect(firstTransport.requests).toHaveLength(1)
    expect(secondTransport.requests[0]).toMatchObject({
      model: { provider: 'next', model: 'next-model' },
      reasoning: { level: 'high', mode: 'effort' },
    })
    expect(result.context).toMatchObject({
      model: { provider: 'next', model: 'next-model' },
      reasoning: { level: 'high', mode: 'effort' },
    })
  })

  it('allows prepareNextTurn to turn reasoning off explicitly', async () => {
    const transport = new ScriptedTransport([
      toolResponse('{"value":"continue"}'),
      textResponse('without reasoning'),
    ])

    await runAgentLoop({
      context: {
        ...createContext([createEchoTool(async () => ({ content: 'continue' }))]),
        reasoning: { level: 'medium', mode: 'effort' },
      },
      prompts: [createUserMessage('disable reasoning')],
      transport,
      prepareNextTurn: async ({ turn }) => turn === 1 ? { reasoning: null } : undefined,
    })

    expect(transport.requests[0]?.reasoning).toEqual({ level: 'medium', mode: 'effort' })
    expect(transport.requests[1]?.reasoning).toBeUndefined()
  })

  it('passes the prepared runtime context to shouldStopAfterTurn', async () => {
    const transport = new ScriptedTransport([toolResponse('{"value":"stop"}')])
    const shouldStopAfterTurn = vi.fn(async (snapshot) => {
      expect(snapshot.context.model).toEqual({ provider: 'next', model: 'next-model' })
      expect(snapshot.messages).toEqual(snapshot.context.messages)
      return true
    })

    const result = await runAgentLoop({
      context: createContext([createEchoTool(async () => ({ content: 'stop now' }))]),
      prompts: [createUserMessage('prepare and stop')],
      transport,
      prepareNextTurn: async () => ({ model: { provider: 'next', model: 'next-model' } }),
      shouldStopAfterTurn,
    })

    expect(result.reason).toBe('stopped')
    expect(shouldStopAfterTurn).toHaveBeenCalledTimes(1)
    expect(transport.requests).toHaveLength(1)
    expect(result.context.model).toEqual({ provider: 'next', model: 'next-model' })
  })

  it('fails the turn after an onModelResponse observer error while retaining the response', async () => {
    const transport = new ScriptedTransport([textResponse('provider response')])

    const result = await runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('observe')],
      transport,
      onModelResponse: async () => {
        throw new Error('observer unavailable')
      },
    })

    expect(result.reason).toBe('error')
    expect(result.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'provider response',
      stopReason: 'error',
      errorMessage: '模型响应观察器失败：observer unavailable',
    })
  })

  it('rejects before_agent_start failures without emitting an orphaned lifecycle', async () => {
    const events: AgentEvent[] = []

    await expect(runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('never starts')],
      transport: new ScriptedTransport([textResponse('unused')]),
      beforeAgentStart: async () => {
        throw new Error('start hook failed')
      },
      emit: (event) => { events.push(event) },
    })).rejects.toThrow('start hook failed')

    expect(events).toEqual([])
  })

  it('closes an orchestration failure with a durable synthetic assistant turn', async () => {
    const events: AgentEvent[] = []
    const result = await runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('starts normally')],
      transport: new ScriptedTransport([textResponse('unused')]),
      getSteeringMessages: async () => {
        throw new Error('queue unavailable')
      },
      emit: (event) => { events.push(event) },
    })

    expect(result.reason).toBe('error')
    expect(result.errorMessage).toBe('queue unavailable')
    expect(result.messages).toHaveLength(2)
    expect(result.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '',
      stopReason: 'error',
      errorMessage: 'queue unavailable',
      diagnostics: [{ type: 'agent-orchestration-error' }],
    })
    expect(events.map((event) => event.type)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_end',
      'message_start',
      'message_end',
      'turn_end',
      'turn_save_point',
      'agent_end',
    ])
  })

  it('retains the original orchestration error when lifecycle compensation also fails', async () => {
    let turnEndAttempts = 0
    const result = await runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('persist turn')],
      transport: new ScriptedTransport([textResponse('completed response')]),
      emit: (event) => {
        if (event.type === 'turn_end') {
          turnEndAttempts += 1
          throw new Error(`turn persistence failed ${turnEndAttempts}`)
        }
      },
    })

    expect(result.reason).toBe('error')
    expect(result.errorMessage).toContain('turn persistence failed 1')
    expect(result.errorMessage).toContain('生命周期补偿失败：turn persistence failed 2')
    expect(result.messages.at(-1)).toMatchObject({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'turn persistence failed 1',
    })
    expect(turnEndAttempts).toBe(2)
  })

  it('rolls back an unpersisted message so the compensation Save Point matches the durable boundary', async () => {
    // 锁定：message_end 落库失败（监听器抛错）的消息不得留在 newMessages——否则补偿 Turn
    // Save Point 的 newMessageCount 把它计入，与已持久化消息边界失配，被 Rust 判定
    // 「Turn Save Point 与已持久化消息边界不一致」，run 永远无法结算。
    const events: AgentEvent[] = []
    const result = await runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('persist me')],
      transport: new ScriptedTransport([textResponse('done')]),
      emit: (event) => {
        events.push(event)
        if (event.type === 'message_end' && event.message.role === 'user') {
          throw new Error('Session message 与 queue journal 消费事实不匹配')
        }
      },
    })

    expect(result.reason).toBe('error')
    expect(result.errorMessage).toBe('Session message 与 queue journal 消费事实不匹配')
    expect(result.newMessages.some((message) => message.role === 'user')).toBe(false)
    expect(result.messages.some((message) => message.role === 'user')).toBe(false)
    // 补偿 Save Point 只统计已落库消息：只有合成失败 assistant 一条留在边界内。
    const savePoints = events.filter((event) => event.type === 'turn_save_point')
    expect(savePoints.at(-1)).toMatchObject({ savePoint: { messageCount: 1 } })
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'error' })
  })

  it('keeps a marked persistence-unrelated failure inside the runtime boundary', async () => {
    // UI 投影类错误发生在写库之后：不得回滚已落库消息——否则内存边界落后于持久化边界，
    // 队列消息还会被重复入队（重复投递）。
    const result = await runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('keep me')],
      transport: new ScriptedTransport([textResponse('done')]),
      emit: (event) => {
        if (event.type === 'message_end' && event.message.role === 'user') {
          throw markPersistenceUnrelated(new Error('projection failed'))
        }
      },
    })

    expect(result.reason).toBe('error')
    expect(result.errorMessage).toBe('projection failed')
    expect(result.newMessages.some((message) => message.role === 'user')).toBe(true)
  })

  it('registers tool results up to the persisted prefix when a later result fails to persist', async () => {
    // 锁定：一批工具结果逐条 emit，第 k 条落库失败时前 k-1 条已落库——它们必须已登记进
    // 内存边界（DB 领先内存同样会让 Turn Save Point 边界失配）。
    const events: AgentEvent[] = []
    const twoCallsResponse: ModelStreamEvent[] = [
      { type: 'start', responseId: 'response-tools' },
      { type: 'tool_call_start', index: 0, id: 'call-a', name: 'echo' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"value":"a"}' },
      { type: 'tool_call_end', index: 0 },
      { type: 'tool_call_start', index: 1, id: 'call-b', name: 'echo' },
      { type: 'tool_call_delta', index: 1, argumentsDelta: '{"value":"b"}' },
      { type: 'tool_call_end', index: 1 },
      { type: 'done', stopReason: 'tool_use' },
    ]
    const toolMessageEnds: string[] = []
    const result = await runAgentLoop({
      context: createContext([createEchoTool(async () => ({ content: 'echo' }))]),
      prompts: [createUserMessage('use two tools')],
      transport: new ScriptedTransport([twoCallsResponse]),
      emit: (event) => {
        events.push(event)
        if (event.type === 'message_end' && event.message.role === 'tool') {
          toolMessageEnds.push(event.message.id)
          if (toolMessageEnds.length === 2) throw new Error('tool result persistence failed')
        }
      },
    })

    expect(result.reason).toBe('error')
    expect(result.errorMessage).toBe('tool result persistence failed')
    expect(result.messages.filter((message) => message.role === 'tool')).toEqual([
      expect.objectContaining({ role: 'tool', content: 'echo' }),
    ])
    // 补偿 Save Point 只统计已落库消息：user + assistant(tool_calls) + 首条 tool + 失败 assistant
    const savePoints = events.filter((event) => event.type === 'turn_save_point')
    expect(savePoints.at(-1)).toMatchObject({ savePoint: { messageCount: 4 } })
  })

  it('aborts an in-flight model stream with a normal agent_end result', async () => {
    let notifyStarted = (): void => undefined
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    const transport: ModelTransport = {
      async *stream(_request, signal) {
        notifyStarted()
        yield { type: 'start' }
        await new Promise<void>((_resolve, reject) => {
          const rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'))
          if (signal.aborted) {
            rejectAbort()
          } else {
            signal.addEventListener('abort', rejectAbort, { once: true })
          }
        })
      },
    }
    const controller = new AbortController()
    const run = runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('wait')],
      transport,
      signal: controller.signal,
    })

    await started
    controller.abort(new DOMException('Cancelled by test', 'AbortError'))
    const result = await run

    expect(result.reason).toBe('aborted')
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'aborted' })
  })

  it('strips dangling partial tool calls from an aborted assistant message', async () => {
    let notifyConsumed: () => void = () => undefined
    const consumed = new Promise<void>((resolve) => {
      notifyConsumed = resolve
    })
    const transport: ModelTransport = {
      async *stream(_request, signal) {
        yield { type: 'start' }
        yield { type: 'tool_call_start', index: 0, id: 'call-partial', name: 'echo' }
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"value":' }
        notifyConsumed()
        await new Promise<void>((_resolve, reject) => {
          const rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'))
          if (signal.aborted) {
            rejectAbort()
          } else {
            signal.addEventListener('abort', rejectAbort, { once: true })
          }
        })
      },
    }
    const context = createContext([createEchoTool(async () => ({ content: 'unused' }))])
    const controller = new AbortController()
    const run = runAgentLoop({
      context,
      prompts: [createUserMessage('start a tool then abort')],
      transport,
      signal: controller.signal,
    })

    await consumed
    controller.abort(new DOMException('Cancelled by test', 'AbortError'))
    const result = await run

    expect(result.reason).toBe('aborted')
    const aborted = result.messages.at(-1)
    expect(aborted).toMatchObject({ role: 'assistant', stopReason: 'aborted' })
    // 悬空的部分工具调用必须被剥离，不能作为"有 tool_call 无 tool_result"的历史进入后续上下文
    expect(aborted && 'toolCalls' in aborted ? aborted.toolCalls : undefined).toEqual([])
    // 无文本/thinking 的空消息整体排除出模型上下文
    expect(aborted && 'excludeFromModelContext' in aborted
      ? aborted.excludeFromModelContext
      : undefined).toBe(true)
  })

  it('does not send dangling tool calls from an aborted run to the next provider request', async () => {
    let notifyConsumed: () => void = () => undefined
    const consumed = new Promise<void>((resolve) => {
      notifyConsumed = resolve
    })
    const abortingTransport: ModelTransport = {
      async *stream(_request, signal) {
        yield { type: 'start' }
        yield { type: 'tool_call_start', index: 0, id: 'call-partial', name: 'echo' }
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"value":' }
        notifyConsumed()
        await new Promise<void>((_resolve, reject) => {
          const rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'))
          if (signal.aborted) {
            rejectAbort()
          } else {
            signal.addEventListener('abort', rejectAbort, { once: true })
          }
        })
      },
    }
    const context = createContext([createEchoTool(async () => ({ content: 'unused' }))])
    const controller = new AbortController()
    const run = runAgentLoop({
      context,
      prompts: [createUserMessage('abort mid tool call')],
      transport: abortingTransport,
      signal: controller.signal,
    })

    await consumed
    controller.abort(new DOMException('Cancelled by test', 'AbortError'))
    expect((await run).reason).toBe('aborted')

    // 同一 context 发起新一轮：请求体不得包含缺 tool_result 的 assistant tool_call
    const nextTransport = new ScriptedTransport([textResponse('continue')])
    const nextResult = await runAgentLoop({
      context,
      prompts: [createUserMessage('continue after abort')],
      transport: nextTransport,
    })
    expect(nextResult.reason).toBe('completed')
    for (const message of nextTransport.requests[0]!.messages) {
      if (message.role === 'assistant') {
        expect(message.toolCalls ?? []).toEqual([])
      }
    }
  })

  it('keeps aborted partial text but drops its dangling tool call', async () => {
    let notifyConsumed: () => void = () => undefined
    const consumed = new Promise<void>((resolve) => {
      notifyConsumed = resolve
    })
    const transport: ModelTransport = {
      async *stream(_request, signal) {
        yield { type: 'start' }
        yield { type: 'text_delta', delta: 'partial reply' }
        yield { type: 'tool_call_start', index: 0, id: 'call-partial', name: 'echo' }
        notifyConsumed()
        await new Promise<void>((_resolve, reject) => {
          const rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'))
          if (signal.aborted) {
            rejectAbort()
          } else {
            signal.addEventListener('abort', rejectAbort, { once: true })
          }
        })
      },
    }
    const controller = new AbortController()
    const run = runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('abort after text')],
      transport,
      signal: controller.signal,
    })

    await consumed
    controller.abort(new DOMException('Cancelled by test', 'AbortError'))
    const result = await run

    expect(result.reason).toBe('aborted')
    const aborted = result.messages.at(-1)
    expect(aborted).toMatchObject({ role: 'assistant', stopReason: 'aborted', content: 'partial reply' })
    // 部分文本保留，悬空工具调用剥离，且不再被排除出模型上下文
    expect(aborted && 'toolCalls' in aborted ? aborted.toolCalls : undefined).toEqual([])
    expect(aborted && 'excludeFromModelContext' in aborted
      ? aborted.excludeFromModelContext
      : undefined).toBeUndefined()
  })

  it('does not poison a completed run when beforeAgentEnd telemetry throws', async () => {
    const transport = new ScriptedTransport([textResponse('done')])
    const result = await runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('hi')],
      transport,
      beforeAgentEnd: async () => {
        throw new Error('context_usage listener failed')
      },
    })
    // 收尾遥测失败不得把成功 run 改判为 error，也不得追加失败消息
    expect(result.reason).toBe('completed')
    expect(result.errorMessage).toBeUndefined()
    expect(result.messages.filter(
      (message) => message.role === 'assistant' && message.stopReason === 'error',
    )).toHaveLength(0)
  })

  it('remaps an explicit provider contentIndex collision so no tool block is lost', async () => {
    const transport = new ScriptedTransport([
      [
        { type: 'start' },
        { type: 'tool_call_start', index: 0, id: 'call-a', name: 'echo' },
        { type: 'tool_call_delta', index: 0, argumentsDelta: '{"value":"a"}' },
        { type: 'tool_call_end', index: 0 },
        { type: 'tool_call_start', index: 1, id: 'call-b', name: 'echo' },
        { type: 'tool_call_delta', index: 1, argumentsDelta: '{"value":"b"}' },
        { type: 'tool_call_end', index: 1 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      textResponse('done'),
    ])
    const context = createContext([createEchoTool(async () => ({ content: 'ok' }))])
    const result = await runAgentLoop({
      context,
      prompts: [createUserMessage('two same-index tools')],
      transport,
    })

    expect(result.reason).toBe('completed')
    const assistant = result.messages.find((message) => message.role === 'assistant')
    const calls = assistant && 'toolCalls' in assistant
      ? assistant.toolCalls.map((call) => call.id)
      : []
    // 显式重复的 contentIndex 必须被 remap，两个工具块都不能丢失
    expect(calls).toEqual(['call-a', 'call-b'])
  })

  it('synthesizes results for tool calls skipped by a mid-batch abort', async () => {
    let notifyToolStarted: () => void = () => undefined
    const toolStarted = new Promise<void>((resolve) => {
      notifyToolStarted = resolve
    })
    const transport: ModelTransport = {
      async *stream() {
        yield { type: 'start' }
        yield { type: 'tool_call_start', index: 0, id: 'call-a', name: 'echo' }
        yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{"value":"a"}' }
        yield { type: 'tool_call_end', index: 0 }
        yield { type: 'tool_call_start', index: 1, id: 'call-b', name: 'echo' }
        yield { type: 'tool_call_delta', index: 1, argumentsDelta: '{"value":"b"}' }
        yield { type: 'tool_call_end', index: 1 }
        yield { type: 'done', stopReason: 'tool_use' }
      },
    }
    const hangingEcho = createEchoTool(async (_input, context) => {
      // 信号：第一个工具真正开始执行后挂起，测试据此再 abort，
      // 保证流已干净结束、进入批量执行阶段。
      notifyToolStarted()
      await new Promise<void>((_resolve, reject) => {
        const rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'))
        if (context.signal.aborted) {
          rejectAbort()
        } else {
          context.signal.addEventListener('abort', rejectAbort, { once: true })
        }
      })
      return { content: 'unused' }
    })
    const controller = new AbortController()
    const run = runAgentLoop({
      context: createContext([hangingEcho]),
      prompts: [createUserMessage('two tools')],
      transport,
      signal: controller.signal,
      toolExecution: 'sequential',
    })

    await toolStarted
    controller.abort(new DOMException('Cancelled by test', 'AbortError'))
    const result = await run

    expect(result.reason).toBe('aborted')
    const assistant = result.messages.find(
      (message) => message.role === 'assistant' && message.stopReason === 'tool_use',
    )
    expect(assistant && 'toolCalls' in assistant
      ? assistant.toolCalls.map((call) => call.id)
      : []).toEqual(['call-a', 'call-b'])
    // 批量执行中中断：每个 tool call 都必须有对应结果，不允许悬空
    const toolResultIds = new Set(
      result.messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId),
    )
    expect(toolResultIds.has('call-a')).toBe(true)
    expect(toolResultIds.has('call-b')).toBe(true)
  })

  it('stops a looping tool workflow at the configured turn limit', async () => {
    const execute = vi.fn<AgentTool['execute']>(async () => ({ content: 'continue' }))
    const transport = new ScriptedTransport([
      toolResponse('{"value":"one"}'),
      toolResponse('{"value":"two"}'),
    ])

    const result = await runAgentLoop({
      context: createContext([createEchoTool(execute)]),
      prompts: [createUserMessage('loop')],
      transport,
      limits: { maxTurns: 2 },
    })

    expect(result.reason).toBe('turn_limit')
    expect(result.turns).toBe(2)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('stops at the tool call limit without executing the excess tool', async () => {
    const execute = vi.fn<AgentTool['execute']>(async () => ({ content: 'continue' }))
    const transport = new ScriptedTransport([
      toolResponse('{"value":"one"}'),
      toolResponse('{"value":"two"}'),
      toolResponse('{"value":"three"}'),
    ])

    const result = await runAgentLoop({
      context: createContext([createEchoTool(execute)]),
      prompts: [createUserMessage('loop')],
      transport,
      limits: { maxToolCalls: 2 },
    })

    expect(result.reason).toBe('tool_limit')
    // 前两次执行，第三次超限不执行
    expect(execute).toHaveBeenCalledTimes(2)
    const failedTool = result.messages.find(
      (message) => message.role === 'tool' && message.isError === true,
    )
    expect(failedTool).toBeDefined()
  })

  it('stops at the wall-clock duration limit', async () => {
    const slowTransport: ModelTransport = {
      async *stream(_request, signal) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        yield { type: 'start', responseId: 'slow-1' }
        yield { type: 'text_delta', delta: 'slow' }
        yield { type: 'done', stopReason: 'stop' }
      },
    }

    const result = await runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('slow')],
      transport: slowTransport,
      limits: { maxDurationMs: 50 },
    })

    expect(result.reason).toBe('time_limit')
  })

  it('attributes a concurrent user cancel over an expired duration timer to aborted', async () => {
    const controller = new AbortController()
    const slowTransport: ModelTransport = {
      async *stream(_request, signal) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        yield { type: 'start', responseId: 'slow-1' }
        yield { type: 'done', stopReason: 'stop' }
      },
    }
    // 内部超时 timer（10ms）先于外部用户取消（30ms）触发；归因必须优先外部取消，
    // 即使 timeLimitReached 已置位，也不能误报 time_limit。
    const cancelTimer = setTimeout(
      () => controller.abort(new DOMException('user cancel', 'AbortError')),
      30,
    )
    const result = await runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('slow')],
      transport: slowTransport,
      signal: controller.signal,
      limits: { maxDurationMs: 10 },
    })
    clearTimeout(cancelTimer)

    expect(result.reason).toBe('aborted')
  })

  it('cuts off a signal-ignoring tool at the run deadline so the loop does not hang', async () => {
    // 工具忽略 signal、永不 settle：无硬超时兜底时 executeToolCalls 的 Promise.all
    // 永不 resolve，runAgentLoop / abort / dispose 会无限挂起。修复后由 deadline 切断。
    const execute = vi.fn<AgentTool['execute']>(() => new Promise<never>(() => {
      // 永不 resolve，也不监听 signal
    }))
    const result = await runAgentLoop({
      context: createContext([createEchoTool(execute)]),
      prompts: [createUserMessage('use the tool')],
      transport: new ScriptedTransport([toolResponse('{"value":"x"}'), textResponse('done')]),
      limits: { maxDurationMs: 50 },
    })

    const failedTool = result.messages.find(
      (message) => message.role === 'tool' && message.isError === true,
    )
    expect(failedTool).toBeDefined()
    // 整轮超时 abort 与工具 deadline 几乎同时触发，工具以"已取消"或"超过时限"被切断；
    // 两种文案都证明 ignore-signal 的工具被兜底终止、Promise.all 得以 resolve。
    expect(failedTool?.content).toMatch(/已取消|超过时限/)
    // 工具被切断后整轮随后以超时/完成结束，绝不挂死。
    expect(result.reason === 'time_limit' || result.reason === 'completed').toBe(true)
  })

  it('commits a save-point mutation batch for appended messages and verifies receipt ownership', async () => {
    const committedBatches: AgentMutationBatch[] = []
    const transport = new ScriptedTransport([textResponse('done')])

    const result = await runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('hi')],
      transport,
      commitMutationBatch: async (batch) => {
        committedBatches.push(batch)
        return {
          batchId: batch.id,
          sessionId: batch.sessionId,
          runId: batch.runId,
          turn: batch.turn,
          committedAt: Date.now(),
          replayed: false,
        }
      },
      prepareNextTurn: async () => ({
        appendMessages: [createUserMessage('steering-appended')],
      }),
    })

    expect(committedBatches).toHaveLength(1)
    expect(committedBatches[0]?.events.map((event) => event.type)).toContain('session_message_append')
    // 追加的用户消息进入最终上下文
    expect(
      result.messages.some(
        (message) => message.role === 'user' && message.content === 'steering-appended',
      ),
    ).toBe(true)
    expect(result.reason).toBe('completed')
  })

  it('projects the flat content in contentIndex order even when text deltas arrive out of order', async () => {
    const transport = new ScriptedTransport([[
      { type: 'start', responseId: 'response-oo' },
      // contentIndex 1 先于 0 到达：flat content 必须按 contentIndex 重排为 "AB"
      { type: 'text_delta', contentIndex: 1, delta: 'B' },
      { type: 'text_delta', delta: 'A' },
      { type: 'done', stopReason: 'stop' },
    ]])

    const result = await runAgentLoop({
      context: createContext(),
      prompts: [createUserMessage('hi')],
      transport,
    })

    const assistant = result.messages.find((message) => message.role === 'assistant')
    expect(assistant && 'content' in assistant ? assistant.content : '').toBe('AB')
    const textBlocks = (assistant && 'contentBlocks' in assistant ? assistant.contentBlocks ?? [] : [])
      .filter((block) => block.type === 'text')
    expect(textBlocks.map((block) => block.text).join('')).toBe('AB')
  })

  it('uses the expanded exploration budget and warns before tool calls are exhausted', async () => {
    expect(DEFAULT_AGENT_LIMITS).toMatchObject({
      maxTurns: 48,
      maxToolCalls: 144,
      maxDurationMs: 15 * 60 * 1000,
    })
    const transport = new ScriptedTransport([
      toolResponse('{"value":"inspect"}'),
      textResponse('done'),
    ])

    const result = await runAgentLoop({
      context: createContext([createEchoTool(async () => ({ content: 'continue' }))]),
      prompts: [createUserMessage('inspect repository')],
      transport,
      limits: { maxTurns: 2, maxToolCalls: 21 },
    })

    expect(result.reason).toBe('completed')
    expect(transport.requests[0]?.systemPrompt).toContain('Test system prompt')
    expect(transport.requests[1]?.systemPrompt).toContain('当前是第 2/2 轮')
    expect(transport.requests[1]?.systemPrompt).toContain('本次任务还可调用 20 次工具')
    expect(transport.requests[1]?.systemPrompt).toContain('同一轮并行调用多个互不依赖的只读工具')
  })

  it('deduplicates a repeated full tool name in tool_call_delta', async () => {
    const transport = new ScriptedTransport([[
      { type: 'start', responseId: 'response-tool' },
      { type: 'tool_call_start', index: 0, id: 'call-1', name: 'echo' },
      // 部分兼容 provider 在非首 chunk 重复携带完整 name，不应拼出 "echoecho"。
      { type: 'tool_call_delta', index: 0, argumentsDelta: '', nameDelta: 'echo' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"value":"ok"}' },
      { type: 'tool_call_end', index: 0 },
      { type: 'done', stopReason: 'tool_use' },
    ], textResponse('done')])

    const result = await runAgentLoop({
      context: createContext([createEchoTool(async (raw) => ({ content: String((raw as { value: string }).value) }))]),
      prompts: [createUserMessage('call echo')],
      transport,
      beforeToolCall: async () => ({ decision: 'approved' }),
    })

    const assistant = result.messages.find((message) => message.role === 'assistant')
    expect(assistant?.toolCalls[0]?.name).toBe('echo')
    expect(result.reason).toBe('completed')
  })

  it('still concatenates genuine fragmented tool name deltas', async () => {
    const transport = new ScriptedTransport([[
      { type: 'start', responseId: 'response-tool' },
      { type: 'tool_call_start', index: 0, id: 'call-1', name: 'read_' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '', nameDelta: 'file' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"path":"a"}' },
      { type: 'tool_call_end', index: 0 },
      { type: 'done', stopReason: 'tool_use' },
    ], textResponse('done')])
    const tool = { ...createEchoTool(async () => ({ content: 'x' })), name: 'read_file' }

    const result = await runAgentLoop({
      context: createContext([tool]),
      prompts: [createUserMessage('read a')],
      transport,
      beforeToolCall: async () => ({ decision: 'approved' }),
    })

    const assistant = result.messages.find((message) => message.role === 'assistant')
    expect(assistant?.toolCalls[0]?.name).toBe('read_file')
  })
})

describe('computeBudgetThresholds', () => {
  it('derives proportional thresholds from the default limits', () => {
    // maxTurns=48 → soft=24 / hard=5; maxToolCalls=144 → tool=36
    // 默认 token 软预算 2M → 软提醒 1.5M / 硬提醒 1.8M（billable 口径）
    expect(computeBudgetThresholds(DEFAULT_AGENT_LIMITS)).toEqual({
      turnSoftNotice: 24,
      turnHardNotice: 5,
      toolCallNotice: 36,
      tokenSoftNotice: 1_500_000,
      tokenHardNotice: 1_800_000,
    })
  })

  it('scales linearly for larger limits', () => {
    // maxTurns=64 → soft=32 / hard=7; maxToolCalls=192 → tool=48
    expect(computeBudgetThresholds({ ...DEFAULT_AGENT_LIMITS, maxTurns: 64, maxToolCalls: 192 }))
      .toEqual({
        turnSoftNotice: 32,
        turnHardNotice: 7,
        toolCallNotice: 48,
        tokenSoftNotice: 1_500_000,
        tokenHardNotice: 1_800_000,
      })
  })

  it('enforces minimum floors so tiny limits do not fire on the first turn', () => {
    // maxTurns=4 → raw soft=2 floored to 4 / raw hard=1 floored to 3; maxToolCalls=8 → raw tool=2 floored to 20
    expect(computeBudgetThresholds({ ...DEFAULT_AGENT_LIMITS, maxTurns: 4, maxToolCalls: 8 }))
      .toEqual({
        turnSoftNotice: 4,
        turnHardNotice: 3,
        toolCallNotice: 20,
        tokenSoftNotice: 1_500_000,
        tokenHardNotice: 1_800_000,
      })
  })

  it('derives absolute token thresholds when maxTotalTokens is configured', () => {
    expect(computeBudgetThresholds({ ...DEFAULT_AGENT_LIMITS, maxTotalTokens: 100_000 }))
      .toEqual({
        turnSoftNotice: 24,
        turnHardNotice: 5,
        toolCallNotice: 36,
        tokenSoftNotice: 75_000,
        tokenHardNotice: 90_000,
      })
  })

  it('disables token thresholds when maxTotalTokens is explicitly undefined', () => {
    expect(computeBudgetThresholds({ ...DEFAULT_AGENT_LIMITS, maxTotalTokens: undefined }))
      .toEqual({
        turnSoftNotice: 24,
        turnHardNotice: 5,
        toolCallNotice: 36,
        tokenSoftNotice: Number.POSITIVE_INFINITY,
        tokenHardNotice: Number.POSITIVE_INFINITY,
      })
  })
})

describe('runAgentLoop budget notices (proportional thresholds)', () => {
  it('does not emit a soft turn notice when the remaining budget is well above 50%', async () => {
    const transport = new ScriptedTransport([
      toolResponse('{"value":"x"}'),
      textResponse('done'),
    ])
    await runAgentLoop({
      context: createContext([createEchoTool(async () => ({ content: 'continue' }))]),
      prompts: [createUserMessage('go')],
      transport,
      limits: { maxTurns: 48, maxToolCalls: 144 },
    })
    // turn 1/48: remainingTurns = 48 > turnSoftNotice(24) → no budget notice
    expect(transport.requests[0]?.systemPrompt).toBe('Test system prompt')
  })

  it('injects the token budget soft notice from the default budget once billable tokens cross 75%', async () => {
    // 默认 maxTotalTokens=2M（mergeLimits 兜底，调用方未传 limits）：第一轮累计
    // billable 1.605M（output 5k + 非缓存 input 1.6M）越过 75% 软线 → 第二轮注入提醒。
    const bigTransport = new ScriptedTransport([
      [
        { type: 'start', responseId: 'response-big' },
        { type: 'tool_call_start', index: 0, id: 'call-1', name: 'echo' },
        { type: 'tool_call_delta', index: 0, argumentsDelta: '{"value":"x"}' },
        { type: 'tool_call_end', index: 0 },
        {
          type: 'done',
          stopReason: 'tool_use',
          usage: { inputTokens: 1_600_000, outputTokens: 5_000, totalTokens: 1_605_000 },
        },
      ],
      [
        { type: 'start', responseId: 'response-final' },
        { type: 'text_delta', delta: 'done' },
        { type: 'done', stopReason: 'stop' },
      ],
    ])
    await runAgentLoop({
      context: createContext([createEchoTool(async () => ({ content: 'continue' }))]),
      prompts: [createUserMessage('go')],
      transport: bigTransport,
    })
    // 第一轮：尚无累计 → 无 token 提醒；第二轮：累计越线 → 注入软提醒
    expect(bigTransport.requests[0]?.systemPrompt).not.toContain('token 预算提示')
    expect(bigTransport.requests[1]?.systemPrompt).toContain('token 预算提示')
    expect(bigTransport.requests[1]?.systemPrompt).toContain('1605000/2000000')
    expect(bigTransport.requests[1]?.systemPrompt).not.toContain('token 预算硬约束')
  })
})

describe('empty assistant responses from a successful stream', () => {
  it('excludes an empty assistant turn so it never reaches the next provider request', async () => {
    // Provider 空流但正常结束（message_start → 无内容块 → message_stop）：
    // 若空 assistant 消息落盘且不带 excludeFromModelContext，下一轮请求会构造
    // { role: 'assistant', content: [] }，Anthropic-compatible 会返回 HTTP 400。
    const emptyResponse = (): ModelStreamEvent[] => [
      { type: 'start', responseId: 'response-empty' },
      { type: 'done', stopReason: 'stop' },
    ]
    const firstTransport = new ScriptedTransport([emptyResponse()])
    const context = createContext()
    const first = await runAgentLoop({
      context,
      prompts: [createUserMessage('empty reply')],
      transport: firstTransport,
    })
    expect(first.reason).toBe('completed')

    const emptyAssistant = first.messages.find((message) => message.role === 'assistant')
    expect(emptyAssistant).toBeDefined()
    // 成功终态的空消息也必须整体排除出模型上下文
    expect('excludeFromModelContext' in emptyAssistant!).toBe(true)

    const secondTransport = new ScriptedTransport([textResponse('ok')])
    const second = await runAgentLoop({
      context,
      prompts: [createUserMessage('next turn')],
      transport: secondTransport,
    })
    expect(second.reason).toBe('completed')
    for (const message of secondTransport.requests[0]!.messages) {
      if (message.role === 'assistant') {
        expect(message.content.length + (message.toolCalls?.length ?? 0)).toBeGreaterThan(0)
      }
    }
  })

  it('excludes a thinking-only truncated assistant turn (no visible text) from model context', async () => {
    // 全部输出 token 消耗在 thinking 上命中 max_tokens（stopReason 'length'）：
    // 消息只有 thinking 块、无可见文本、无工具调用。多数 Anthropic-compatible 中继会
    // 剥离历史中的 thinking 块，剥离后 content 为空 → HTTP 400。
    const thinkingOnlyResponse = (): ModelStreamEvent[] => [
      { type: 'start', responseId: 'response-thinking' },
      { type: 'thinking_start', contentIndex: 0, thinkingSignature: 'sig-1' },
      { type: 'thinking_delta', contentIndex: 0, delta: '设计实施路径...' },
      { type: 'thinking_end', contentIndex: 0 },
      { type: 'done', stopReason: 'length', usage: { inputTokens: 100, outputTokens: 4096, totalTokens: 4196 } },
    ]
    const firstTransport = new ScriptedTransport([
      thinkingOnlyResponse(),
      textResponse('基于上述思考，给出最终方案'),
    ])
    const context = createContext()
    const first = await runAgentLoop({
      context,
      prompts: [createUserMessage('think hard')],
      transport: firstTransport,
    })
    expect(first.reason).toBe('completed')

    // thinking-only 空响应整体排除出模型上下文：续写分支把空消息从 context 移除，
    // 避免同 run 下一轮请求向 Provider 发送空 assistant 触发 HTTP 400。
    const truncatedThinking = first.newMessages.find((message) =>
      message.role === 'assistant' && message.stopReason === 'length')
    expect(truncatedThinking).toBeDefined()
    expect('excludeFromModelContext' in truncatedThinking!).toBe(true)
    expect(first.messages.filter((message) => (
      message.role === 'assistant' && !message.content.trim()
    ))).toHaveLength(0)
    // length 截断自动续写：第二轮请求以续写 user 指令结尾，且不含空 assistant
    expect(firstTransport.requests).toHaveLength(2)
    for (const message of firstTransport.requests[1]!.messages) {
      if (message.role === 'assistant') {
        expect(message.content.length + (message.toolCalls?.length ?? 0)).toBeGreaterThan(0)
      }
    }
    const assistants = first.messages.filter((message) => message.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]!.content).toBe('基于上述思考，给出最终方案')
  })
})
