import { describe, expect, it, vi } from 'vitest'
import type {
  AgentContext,
  AgentEventSink,
  AgentTool,
  AssistantMessage,
  BeforeToolCall,
  JsonValue,
  ToolCall,
} from './types'
import {
  applyAfterToolCall,
  prepareToolCall,
  ToolExecutionTimeoutError,
  waitForApproval,
  type PreparedToolCall,
} from './toolExecution'

const makeContext = (tools: AgentTool[], activeToolNames?: string[]): AgentContext => ({
  sessionId: 's',
  systemPrompt: '',
  model: { provider: 'p', model: 'm' },
  messages: [],
  tools,
  activeToolNames,
})

const makeAssistant = (): AssistantMessage => ({
  id: 'm1',
  role: 'assistant',
  content: '',
  toolCalls: [],
  stopReason: 'stop',
  createdAt: 1,
  provider: 'p',
  model: 'm',
})

const makeCall = (name = 'echo', id = 'call-1'): ToolCall => ({
  id,
  name,
  arguments: { value: 'x' },
  rawArguments: '{"value":"x"}',
})

const makeTool = (overrides: Partial<AgentTool> = {}): AgentTool => ({
  name: 'echo',
  runtimeVersion: '1',
  label: 'Echo',
  description: 'Echo',
  inputSchema: { type: 'object' },
  validate: (input) => ({ ok: true, value: input as JsonValue }),
  execute: async () => ({ content: 'ok' }),
  ...overrides,
})

const sink = (): { emit: AgentEventSink; events: unknown[] } => {
  const events: unknown[] = []
  return { emit: (event) => { events.push(event) }, events }
}

describe('waitForApproval', () => {
  const prepared: Pick<PreparedToolCall, 'call' | 'tool' | 'input'> = {
    call: makeCall(),
    tool: makeTool({ requiresApproval: true }),
    input: { value: 'x' },
  }

  it('rejects immediately when no approval handler is wired', async () => {
    const result = await waitForApproval(prepared, makeAssistant(), makeContext([], []), 'r', new AbortController().signal, undefined)
    expect(result).toEqual({ approved: false, reason: '没有可用的用户审批处理器' })
  })

  it('approves a tool that does not require approval when no handler exists', async () => {
    const noApproval = { ...prepared, tool: makeTool({ requiresApproval: false }) }
    const result = await waitForApproval(noApproval, makeAssistant(), makeContext([], []), 'r', new AbortController().signal, undefined)
    expect(result).toEqual({ approved: true })
  })

  it('surfaces the approval decision and lease', async () => {
    const beforeToolCall: BeforeToolCall = async () => ({ decision: 'approved', approvalLease: 'lease-1' })
    const spy = vi.fn(beforeToolCall)
    const result = await waitForApproval(prepared, makeAssistant(), makeContext([], []), 'r', new AbortController().signal, spy)
    expect(result).toEqual({ approved: true, approvalLease: 'lease-1' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0].toolCallId).toBe('call-1')
  })

  it('maps a denied decision to an unapproved result with reason', async () => {
    const beforeToolCall: BeforeToolCall = async () => ({ decision: 'denied', reason: 'nope' })
    const spy = vi.fn(beforeToolCall)
    const result = await waitForApproval(prepared, makeAssistant(), makeContext([], []), 'r', new AbortController().signal, spy)
    expect(result).toEqual({ approved: false, reason: 'nope' })
  })

  it('respects an already-aborted signal', async () => {
    const signal = new AbortController()
    signal.abort()
    const beforeToolCall: BeforeToolCall = async () => ({ decision: 'approved' })
    const result = await waitForApproval(prepared, makeAssistant(), makeContext([], []), 'r', signal.signal, beforeToolCall)
    expect(result.approved).toBe(false)
    expect(result.reason).toMatch(/已取消/)
  })

  it('falls back to a default presentation when the tool provider does not supply one', async () => {
    const beforeToolCall: BeforeToolCall = async () => ({ decision: 'denied' })
    const spy = vi.fn(beforeToolCall)
    await waitForApproval(prepared, makeAssistant(), makeContext([], []), 'r', new AbortController().signal, spy)
    expect(spy.mock.calls[0]?.[0].presentation.title).toContain('允许工具')
  })
})

describe('applyAfterToolCall', () => {
  const prepared: PreparedToolCall = {
    call: makeCall(),
    tool: makeTool(),
    input: { value: 'x' },
    approvalState: 'not_required',
  }

  it('returns the outcome unchanged when no after-hook is present', async () => {
    const outcome = { call: makeCall(), result: { content: 'ok' }, isError: false }
    const result = await applyAfterToolCall(prepared, makeAssistant(), makeContext([], []), 'r', new AbortController().signal, outcome, undefined)
    expect(result).toBe(outcome)
  })

  it('applies an after-hook override', async () => {
    const afterToolCall = vi.fn(async () => ({ result: { content: 'patched' }, isError: true }))
    const outcome = { call: makeCall(), result: { content: 'ok' }, isError: false }
    const result = await applyAfterToolCall(prepared, makeAssistant(), makeContext([], []), 'r', new AbortController().signal, outcome, afterToolCall)
    expect(result.result).toEqual({ content: 'patched' })
    expect(result.isError).toBe(true)
  })

  it('degrades a throwing after-hook to an error result rather than throwing', async () => {
    const afterToolCall = vi.fn(async () => { throw new Error('hook failed') })
    const outcome = { call: makeCall(), result: { content: 'ok' }, isError: false }
    const result = await applyAfterToolCall(prepared, makeAssistant(), makeContext([], []), 'r', new AbortController().signal, outcome, afterToolCall)
    expect(result.isError).toBe(true)
    expect(result.result.content).toContain('后置处理失败')
  })
})

describe('prepareToolCall', () => {
  it('rejects a call with an argument parse error', async () => {
    const { emit } = sink()
    const call = { ...makeCall(), argumentError: 'bad json' }
    const outcome = await prepareToolCall(call, makeAssistant(), makeContext([makeTool()], ['echo']), 'r', new AbortController().signal, emit, undefined)
    if ('tool' in outcome) throw new Error('expected a failure outcome')
    expect(outcome.isError).toBe(true)
    expect(outcome.result.content).toContain('不是有效 JSON')
  })

  it('rejects an unregistered tool', async () => {
    const { emit } = sink()
    const outcome = await prepareToolCall(makeCall('ghost'), makeAssistant(), makeContext([makeTool()], ['echo']), 'r', new AbortController().signal, emit, undefined)
    if ('tool' in outcome) throw new Error('expected a failure outcome')
    expect(outcome.isError).toBe(true)
    expect(outcome.result.content).toContain('未注册工具：ghost')
  })

  it('reports a tool that exists but is not yet active', async () => {
    const { emit } = sink()
    const outcome = await prepareToolCall(makeCall(), makeAssistant(), makeContext([makeTool()], []), 'r', new AbortController().signal, emit, undefined)
    if ('tool' in outcome) throw new Error('expected a failure outcome')
    expect(outcome.result.content).toContain('尚未激活：echo')
  })

  it('returns a prepared call for a valid, non-approval tool', async () => {
    const { emit } = sink()
    const result = await prepareToolCall(makeCall(), makeAssistant(), makeContext([makeTool()], ['echo']), 'r', new AbortController().signal, emit, undefined)
    if (!('tool' in result)) throw new Error('expected a prepared call')
    expect(result.approvalState).toBe('not_required')
  })
})

describe('ToolExecutionTimeoutError / executePreparedToolCall', () => {
  it('carries the tool name', () => {
    const error = new ToolExecutionTimeoutError('echo')
    expect(error.name).toBe('ToolExecutionTimeoutError')
    expect(error.toolName).toBe('echo')
  })

  it('encloses a timing-out tool in a failed outcome, not a throwing run', async () => {
    const neverResolvingTool = makeTool({
      execute: async () => new Promise(() => { /* never resolves */ }),
    })
    const prepared: PreparedToolCall = {
      call: makeCall(),
      tool: neverResolvingTool,
      input: { value: 'x' },
      approvalState: 'not_required',
    }
    const { emit } = sink()
    const outcome = await import('./toolExecution').then(({ executePreparedToolCall }) =>
      executePreparedToolCall(
        prepared,
        makeAssistant(),
        makeContext([neverResolvingTool], ['echo']),
        'r',
        new AbortController().signal,
        emit,
        undefined,
        10,
      ))
    expect(outcome.isError).toBe(true)
    expect(outcome.result.content).toContain('执行超过时限')
  })

  it('transforms an aborted execution into a cancelled error result', async () => {
    const abortingTool = makeTool({
      execute: async () => { throw new DOMException('Aborted', 'AbortError') },
    })
    const prepared: PreparedToolCall = {
      call: makeCall(),
      tool: abortingTool,
      input: { value: 'x' },
      approvalState: 'not_required',
    }
    const { emit } = sink()
    const outcome = await import('./toolExecution').then(({ executePreparedToolCall }) =>
      executePreparedToolCall(
        prepared,
        makeAssistant(),
        makeContext([abortingTool], ['echo']),
        'r',
        new AbortController().signal,
        emit,
        undefined,
      ))
    expect(outcome.isError).toBe(true)
    expect(outcome.result.content).toContain('已取消')
  })

  it('fails the outcome when a tool returns invalid addedToolNames', async () => {
    const badTool = makeTool({
      execute: async () => ({ content: 'ok', addedToolNames: ['ghost'] }),
    })
    const prepared: PreparedToolCall = {
      call: makeCall(),
      tool: badTool,
      input: { value: 'x' },
      approvalState: 'not_required',
    }
    const { emit } = sink()
    const outcome = await import('./toolExecution').then(({ executePreparedToolCall }) =>
      executePreparedToolCall(
        prepared,
        makeAssistant(),
        makeContext([badTool], ['echo']),
        'r',
        new AbortController().signal,
        emit,
        undefined,
      ))
    expect(outcome.isError).toBe(true)
    expect(outcome.result.content).toContain('新增工具无效')
  })
})
