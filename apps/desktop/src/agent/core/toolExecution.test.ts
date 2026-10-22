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
  executePreparedToolCall,
  executeToolCalls,
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
    expect(result).toEqual({ approved: true, approvalSource: 'not_required' })
  })

  it('surfaces the approval decision and lease', async () => {
    const beforeToolCall: BeforeToolCall = async () => ({ decision: 'approved', approvalLease: 'lease-1' })
    const spy = vi.fn(beforeToolCall)
    const result = await waitForApproval(prepared, makeAssistant(), makeContext([], []), 'r', new AbortController().signal, spy)
    expect(result).toEqual({
      approved: true,
      approvalLease: 'lease-1',
      approvalSource: 'interactive',
    })
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

  it('carries the tool-declared approval lease input into the approval context', async () => {
    const beforeToolCall: BeforeToolCall = async () => ({ decision: 'approved', approvalLease: 'lease-1' })
    const spy = vi.fn(beforeToolCall)
    const withLeaseInput = {
      ...prepared,
      tool: makeTool({
        requiresApproval: true,
        // 工具落盘字节≠模型输入（如 design_import 的编译产物）：租约必须绑定真实字节。
        approvalLeaseInput: async (input: JsonValue) => ({ path: 'b.ax', content: 'compiled', from: input }),
      }),
    }

    await waitForApproval(withLeaseInput, makeAssistant(), makeContext([], []), 'r', new AbortController().signal, spy)
    expect(spy.mock.calls[0]?.[0].approvalLeaseInput).toEqual({
      path: 'b.ax',
      content: 'compiled',
      from: { value: 'x' },
    })
  })

  it('denies the call when the approval lease input cannot be computed', async () => {
    const beforeToolCall: BeforeToolCall = async () => ({ decision: 'approved' })
    const spy = vi.fn(beforeToolCall)
    const failing = {
      ...prepared,
      tool: makeTool({
        requiresApproval: true,
        approvalLeaseInput: async () => { throw new Error('cannot compile .pen/axiom.pen') },
      }),
    }

    const result = await waitForApproval(failing, makeAssistant(), makeContext([], []), 'r', new AbortController().signal, spy)
    expect(result.approved).toBe(false)
    expect(result.reason).toContain('cannot compile')
    // 未拿到可绑定的租约就不该进审批流程（否则执行侧必然被写通道拒绝）。
    expect(spy).not.toHaveBeenCalled()
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


describe('父工具调用取消作用域', () => {
  it('硬超时中止本次委托信号，不取消父会话与另一次调用', async () => {
    const parent = new AbortController()
    let childSignal: AbortSignal | undefined
    const delegate = vi.fn(async (_request, context) => {
      childSignal = context.signal
      return await new Promise<never>(() => undefined)
    })
    const tool = makeTool({ execute: async (_input, context) => {
      if (!context.delegateAgent) throw new Error('缺委托端口')
      await context.delegateAgent({ kind: 'explore', task: 'x' })
      return { content: 'late' }
    } })
    const outcome = await executePreparedToolCall(
      { call: makeCall(), tool, input: {}, approvalState: 'not_required' },
      makeAssistant(), makeContext([tool]), 'run', parent.signal, sink().emit, undefined, 10, delegate,
    )
    expect(outcome.isError).toBe(true)
    expect(outcome.result.content).toContain(new ToolExecutionTimeoutError('echo').message)
    expect(childSignal?.aborted).toBe(true)
    expect(parent.signal.aborted).toBe(false)
    const nextTool = makeTool()
    const next = await executePreparedToolCall(
      { call: makeCall('echo', 'call-2'), tool: nextTool, input: {}, approvalState: 'not_required' },
      makeAssistant(), makeContext([nextTool]), 'run', parent.signal, sink().emit, undefined, 100,
    )
    expect(next.isError).toBe(false)
  })
})

describe('executeToolCalls · state guard（design §8.4）', () => {
  const uiTool = (name: string, executed: string[], overrides: Partial<AgentTool> = {}): AgentTool =>
    makeTool({
      name,
      label: name,
      execute: async () => {
        executed.push(name)
        return { content: `${name} ok` }
      },
      ...overrides,
    })

  // 批次执行模式刻意给 'parallel'：截断必须在"并发执行整批"的路径上也生效。
  const runBatch = async (
    tools: AgentTool[],
    calls: ToolCall[],
    signal: AbortSignal = new AbortController().signal,
  ) => {
    const { emit, events } = sink()
    const batch = await executeToolCalls(
      { ...makeAssistant(), toolCalls: calls },
      makeContext(tools, tools.map((tool) => tool.name)),
      'run',
      signal,
      emit,
      'parallel',
      1024 * 1024,
      undefined,
      undefined,
    )
    return { batch, events }
  }

  it('写动作之后的调用被截断为错误结果，并如实报告跳过数量', async () => {
    const executed: string[] = []
    const tools = [
      uiTool('ui_snapshot', executed),
      uiTool('ui_click', executed, { invalidatesPageState: true }),
    ]
    const calls = [makeCall('ui_snapshot', 'c1'), makeCall('ui_click', 'c2'), makeCall('ui_snapshot', 'c3')]
    const { batch } = await runBatch(tools, calls)

    expect(executed).toEqual(['ui_snapshot', 'ui_click'])
    // 不变量：每个 tool_call 仍有且只有一个 tool_result，顺序与调用一致。
    expect(batch.messages.map((message) => message.toolCallId)).toEqual(['c1', 'c2', 'c3'])
    expect(batch.messages[0]?.isError).toBe(false)
    expect(batch.messages[1]?.isError).toBe(false)
    const truncated = batch.messages[2]
    expect(truncated?.isError).toBe(true)
    expect(truncated?.content).toContain('ui_click')
    expect(truncated?.content).toContain('被截断')
    expect(truncated?.content).toContain('跳过 1 个后续调用')
    expect(truncated?.content).toContain('重新')
    expect(batch.allTerminate).toBe(false)
  })

  it('同一响应连发两个写动作时只执行第一个', async () => {
    const executed: string[] = []
    const tools = [
      uiTool('ui_click', executed, { invalidatesPageState: true, executionMode: 'sequential' }),
    ]
    const calls = [makeCall('ui_click', 'c1'), makeCall('ui_click', 'c2')]
    const { batch } = await runBatch(tools, calls)

    expect(executed).toEqual(['ui_click'])
    expect(batch.messages).toHaveLength(2)
    expect(batch.messages[1]?.isError).toBe(true)
    expect(batch.messages[1]?.content).toContain('ui_click')
    expect(batch.messages[1]?.content).toContain('跳过 1 个后续调用')
  })

  it('截断覆盖写动作之后的全部调用', async () => {
    const executed: string[] = []
    const tools = [
      uiTool('ui_snapshot', executed),
      uiTool('ui_click', executed, { invalidatesPageState: true }),
    ]
    const calls = [
      makeCall('ui_snapshot', 'c1'),
      makeCall('ui_click', 'c2'),
      makeCall('ui_snapshot', 'c3'),
      makeCall('ui_click', 'c4'),
    ]
    const { batch } = await runBatch(tools, calls)

    expect(executed).toEqual(['ui_snapshot', 'ui_click'])
    expect(batch.messages).toHaveLength(4)
    expect(batch.messages[2]?.content).toContain('跳过 2 个后续调用')
    expect(batch.messages[3]?.content).toContain('跳过 2 个后续调用')
    expect(batch.messages[3]?.isError).toBe(true)
  })

  it('不含写动作的批次不做任何截断', async () => {
    const executed: string[] = []
    const tools = [uiTool('ui_snapshot', executed), uiTool('ui_find', executed)]
    const calls = [makeCall('ui_snapshot', 'c1'), makeCall('ui_find', 'c2')]
    const { batch } = await runBatch(tools, calls)

    expect(executed).toEqual(['ui_snapshot', 'ui_find'])
    expect(batch.messages).toHaveLength(2)
    expect(batch.messages.every((message) => message.isError === false)).toBe(true)
    expect(batch.messages.some((message) => message.content.includes('被截断'))).toBe(false)
  })

  it('运行在写动作之前就被取消时按中断记账，不谎报页面已改变', async () => {
    const executed: string[] = []
    const tools = [
      uiTool('ui_snapshot', executed),
      uiTool('ui_click', executed, { invalidatesPageState: true }),
    ]
    const calls = [makeCall('ui_snapshot', 'c1'), makeCall('ui_click', 'c2'), makeCall('ui_snapshot', 'c3')]
    const controller = new AbortController()
    controller.abort()
    const { batch } = await runBatch(tools, calls, controller.signal)

    expect(executed).toEqual([])
    expect(batch.messages).toHaveLength(3)
    expect(
      batch.messages
        .filter((message) => message.content.includes('已取消或中断'))
        .map((message) => message.toolCallId),
    ).toEqual(['c2', 'c3'])
    expect(batch.messages.some((message) => message.content.includes('被截断'))).toBe(false)
  })
})
