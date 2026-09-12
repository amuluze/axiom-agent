import { describe, expect, it, vi } from 'vitest'
import { createFakeAgentEnvironment } from '@/agent/tools/__fixtures__/fakeAgentEnvironment'
import type {
  ModelMessage,
  ModelRequest,
  ModelStreamEvent,
  ModelTransport,
  SubAgentKind,
} from '@/agent/core/types'
import {
  createParentRunLedger,
  DEFAULT_SUBAGENT_CHILD_BUDGET,
  SubAgentExecutionError,
  type SubAgentRuntimeBinding,
} from './contracts'
import { createSubAgentRuntime, describeToolTarget } from './SubAgentRuntime'

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

/** 与 ScriptedTransport 一致但简化：供 error 事件路径验证（不依赖数组迭代 transform）。 */
class ErrorOnlyTransport implements ModelTransport {
  constructor(private readonly message: string) {}

  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield { type: 'error', message: this.message }
  }
}

/**
 * 首轮按脚本回复、次轮起挂起直到 signal abort：驱动「内部 deadline 中止」与
 * 「父 run 取消」两条中止路径的确定性回归（此前时长中止走 'aborted' 分支丢弃 summary）。
 */
class HeldAfterFirstTransport implements ModelTransport {
  readonly requests: ModelRequest[] = []

  constructor(private readonly first: ModelStreamEvent[]) {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request)
    if (this.requests.length === 1) {
      for (const event of this.first) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        yield event
      }
      return
    }
    yield { type: 'start', responseId: 'resp-held' }
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => resolve(), { once: true })
    })
    throw new DOMException('Aborted', 'AbortError')
  }
}

const textResponse = (content: string): ModelStreamEvent[] => [
  { type: 'start', responseId: `resp-${content.length}` },
  { type: 'text_delta', delta: content },
  { type: 'done', stopReason: 'stop' },
]

const readToolResponse = (path: string): ModelStreamEvent[] => [
  { type: 'start', responseId: 'resp-read' },
  { type: 'tool_call_start', index: 0, id: `call-${path}`, name: 'read' },
  { type: 'tool_call_delta', index: 0, argumentsDelta: `{"path":"${path}"}` },
  { type: 'tool_call_end', index: 0 },
  { type: 'done', stopReason: 'tool_use' },
]

/** 同时输出文本与 read 工具调用：文本作为 summary candidate，tool 保持循环继续。 */
const textToolResponse = (text: string, path: string): ModelStreamEvent[] => [
  { type: 'start', responseId: 'resp-mixed' },
  { type: 'text_delta', delta: text },
  { type: 'tool_call_start', index: 0, id: `call-${path}`, name: 'read' },
  { type: 'tool_call_delta', index: 0, argumentsDelta: `{"path":"${path}"}` },
  { type: 'tool_call_end', index: 0 },
  { type: 'done', stopReason: 'tool_use' },
]

const defaultWorkspace = { path: '/workspace/repo', name: 'repo', gitBranch: 'main' }

const createBinding = (
  transport: ModelTransport,
  overrides: Partial<SubAgentRuntimeBinding> = {},
): SubAgentRuntimeBinding => ({
  parentSessionId: 'parent-session',
  parentRunId: 'parent-run',
  parentToolCallId: 'parent-tool',
  model: { provider: 'test', model: 'test-model', maxOutputTokens: 32_000 },
  transport,
  environment: createFakeAgentEnvironment({
    readText: async (path) => ({
      workspace: defaultWorkspace,
      path,
      content: `content of ${path}`,
      sha256: 'a'.repeat(64),
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      truncated: false,
    }),
  }),
  parentRunLedger: createParentRunLedger(),
  contextWindow: 100_000,
  ...overrides,
})

const request = { kind: 'explore' as const, task: '探索 src/a.ts', scope: ['src'] }

describe('createSubAgentRuntime / delegate', () => {
  it('初始 messages 为空，user prompt 只追加一次', async () => {
    const transport = new ScriptedTransport([
      readToolResponse('src/a.ts'),
      textResponse('探索完成'),
    ])
    const runtime = createSubAgentRuntime()
    const result = await runtime.delegate(
      request,
      createBinding(transport),
      new AbortController().signal,
    )
    expect(result.status).toBe('completed')
    const firstRequest = transport.requests[0]
    expect(firstRequest.messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(firstRequest.messages[0]).toMatchObject({ role: 'user' })
  })

  it('只注册 read/ls/grep/find/web_search/web_fetch 且全部 active；maxOutputTokens 收窄、不继承 reasoning', async () => {
    const transport = new ScriptedTransport([textResponse('结论')])
    const seen = vi.fn()
    const runtime = createSubAgentRuntime()
    await runtime.delegate(
      request,
      createBinding(transport, {
        observation: { onModelRequest: (req) => { seen(req) } },
      }),
      new AbortController().signal,
    )
    const modelRequest = seen.mock.calls[0][0] as ModelRequest
    const toolNames = modelRequest.tools.map((tool) => tool.name)
    expect(toolNames).toEqual(['read', 'ls', 'grep', 'find', 'web_search', 'web_fetch'])
    expect(modelRequest.model.maxOutputTokens).toBe(DEFAULT_SUBAGENT_CHILD_BUDGET.maxOutputTokens)
    expect(modelRequest.reasoning).toBeUndefined()
  })

  it('completed：返回结构化结果与真实计数', async () => {
    const transport = new ScriptedTransport([
      readToolResponse('src/a.ts'),
      textResponse('探索完成：src/a.ts 包含核心逻辑'),
    ])
    const runtime = createSubAgentRuntime()
    const result = await runtime.delegate(
      request,
      createBinding(transport),
      new AbortController().signal,
    )
    expect(result.status).toBe('completed')
    expect(result.summary).toContain('探索完成')
    expect(result.endReason).toBe('completed')
    expect(result.turns).toBe(2)
    expect(result.modelRequests).toBe(2)
    expect(result.toolCalls).toBeGreaterThanOrEqual(1)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('observation envelope 保留真实 childSessionId + 父身份聚合键', async () => {
    const transport = new ScriptedTransport([textResponse('证据')])
    const onRequest = vi.fn()
    const onResponse = vi.fn()
    const runtime = createSubAgentRuntime()
    await runtime.delegate(
      request,
      createBinding(transport, {
        observation: { onModelRequest: onRequest, onModelResponse: onResponse },
      }),
      new AbortController().signal,
    )
    const reqCtx = onRequest.mock.calls[0][1]
    expect(reqCtx).toMatchObject({
      kind: 'explore',
      parentSessionId: 'parent-session',
      parentRunId: 'parent-run',
      parentToolCallId: 'parent-tool',
    })
    // 请求保留真实 childSessionId（不等于父 session）
    expect(onRequest.mock.calls[0][0].sessionId).not.toBe('parent-session')
    expect(onResponse).toHaveBeenCalled()
  })

  it('scope 越界：read 路径在 scope 外导致工具失败', async () => {
    const transport = new ScriptedTransport([
      readToolResponse('outside.txt'),
      textResponse('仍然返回了结果'),
    ])
    const runtime = createSubAgentRuntime({ childBudget: { ...DEFAULT_SUBAGENT_CHILD_BUDGET, maxTurns: 2 } })
    const result = await runtime.delegate(
      request,
      createBinding(transport),
      new AbortController().signal,
    )
    // 越界 read 失败后模型仍能收口（completed 或 partial），但绝不返回越界内容
    expect(result.status).toBe('completed')
    expect(result.summary).not.toContain('outside')
  })

  it('turn_limit：有总结时返回 partial/endReason=turn_limit', async () => {
    const transport = new ScriptedTransport([
      textToolResponse('证据A', 'src/a.ts'),
      readToolResponse('src/a.ts'),
      readToolResponse('src/a.ts'),
    ])
    const runtime = createSubAgentRuntime({ childBudget: { ...DEFAULT_SUBAGENT_CHILD_BUDGET, maxTurns: 3 } })
    const result = await runtime.delegate(
      request,
      createBinding(transport),
      new AbortController().signal,
    )
    expect(result.status).toBe('partial')
    expect(result.endReason).toBe('turn_limit')
    expect(result.summary).toContain('证据A')
  })

  it('预算接近上限（轮次 ≥75%）时在模型请求中注入预算状态消息，未达阈值不注入', async () => {
    const transport = new ScriptedTransport([
      textToolResponse('证据一', 'src/a.ts'),
      textToolResponse('证据二', 'src/b.ts'),
      textToolResponse('证据三', 'src/c.ts'),
      textToolResponse('证据四', 'src/d.ts'),
      textResponse('总结'),
    ])
    const runtime = createSubAgentRuntime({
      childBudget: { ...DEFAULT_SUBAGENT_CHILD_BUDGET, maxTurns: 4 },
    })
    const result = await runtime.delegate(
      request,
      createBinding(transport),
      new AbortController().signal,
    )
    // 第 4 次请求时已用 3 轮 = 75%×4 → 注入；前 3 次（0/1/2 轮）不注入
    const injected = (message: ModelMessage): boolean =>
      message.role === 'user' && message.content.includes('[预算状态]')
    expect(transport.requests.length).toBe(4)
    for (let i = 0; i < 3; i += 1) {
      expect(transport.requests[i].messages.some(injected)).toBe(false)
    }
    const lastRequest = transport.requests[3]
    expect(lastRequest.messages.some(injected)).toBe(true)
    expect(lastRequest.messages.find(injected)?.content).toContain('已用 3/4 轮')
    expect(result.status).toBe('partial')
  })

  it('context_limit：消息字节耗尽（有总结）返回 partial/endReason=context_limit', async () => {
    const transport = new ScriptedTransport([
      textToolResponse('第一批证据', 'src/a.ts'),
      readToolResponse('src/a.ts'),
    ])
    // maxMessageBytes 25：第一条 user 请求通过（~15B），第二次请求累计超限触发 ledger fail-closed
    const runtime = createSubAgentRuntime({
      childBudget: { ...DEFAULT_SUBAGENT_CHILD_BUDGET, maxTurns: 3, maxMessageBytes: 25 },
    })
    const result = await runtime.delegate(
      request,
      createBinding(transport),
      new AbortController().signal,
    )
    expect(result.status).toBe('partial')
    expect(result.endReason).toBe('context_limit')
    expect(result.summary).toBe('第一批证据')
  })

  it('context_limit：预算耗尽（无总结）抛 SubAgentExecutionError', async () => {
    const transport = new ScriptedTransport([readToolResponse('src/a.ts')])
    const runtime = createSubAgentRuntime({ childBudget: { ...DEFAULT_SUBAGENT_CHILD_BUDGET, maxTurns: 1 } })
    await expect(
      runtime.delegate(request, createBinding(transport), new AbortController().signal),
    ).rejects.toBeInstanceOf(SubAgentExecutionError)
  })

  it('context_limit：contextWindow 触顶（估算 token 超窗口）返回 partial/endReason=context_limit', async () => {
    const transport = new ScriptedTransport([
      textToolResponse('第一批证据', 'src/a.ts'),
      readToolResponse('src/a.ts'),
    ])
    // contextWindow 20 tokens：第一条 user 请求（约 16 字节 → 6 tokens）通过；
    // 第二条完整历史（含 text/tool_call/tool 结果，约 77 字节 → 26 tokens）超窗口触发 fail-closed
    const runtime = createSubAgentRuntime({ childBudget: { ...DEFAULT_SUBAGENT_CHILD_BUDGET, maxTurns: 3 } })
    const result = await runtime.delegate(
      request,
      createBinding(transport, { contextWindow: 20 }),
      new AbortController().signal,
    )
    expect(result.status).toBe('partial')
    expect(result.endReason).toBe('context_limit')
    expect(result.summary).toContain('第一批证据')
  })

  it('completed 但空总结：抛 SubAgentExecutionError', async () => {
    const transport = new ScriptedTransport([textResponse('')])
    const runtime = createSubAgentRuntime()
    await expect(
      runtime.delegate(request, createBinding(transport), new AbortController().signal),
    ).rejects.toBeInstanceOf(SubAgentExecutionError)
  })

  it('父 signal 已 abort：fail-fast 不启动子请求', async () => {
    const transport = new ScriptedTransport([textResponse('不应发生')])
    const runtime = createSubAgentRuntime()
    const controller = new AbortController()
    controller.abort()
    await expect(
      runtime.delegate(request, createBinding(transport), controller.signal),
    ).rejects.toBeInstanceOf(SubAgentExecutionError)
    expect(transport.requests).toHaveLength(0)
  })

  it('父 deadline 过近：不启动子请求', async () => {
    const transport = new ScriptedTransport([textResponse('不应发生')])
    const runtime = createSubAgentRuntime()
    await expect(
      runtime.delegate(
        request,
        createBinding(transport, { deadlineMs: Date.now() + 100 }),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SubAgentExecutionError)
    expect(transport.requests).toHaveLength(0)
  })

  it('同一父 run 第 9 次 Explore fail-closed（失败/校验也计数），拒绝文案内嵌对症配方', async () => {
    const runtime = createSubAgentRuntime()
    const ledger = createParentRunLedger() // maxCallsPerParentRun = 8
    const signal = new AbortController().signal
    const delegate = () =>
      runtime.delegate(
        request,
        createBinding(new ScriptedTransport([textResponse('ok')]), { parentRunLedger: ledger }),
        signal,
      )
    for (let index = 0; index < 8; index += 1) await delegate()
    // 委派配额尽的正确动作是父 Agent 亲自收口/自查——不是「收窄 scope 重委派」（必然再被拒）
    await expect(delegate()).rejects.toThrow('委派次数已达上限（8 次）')
    await expect(delegate()).rejects.toThrow('主 Agent 亲自完成剩余只读复核')
    expect(ledger.callCount).toBe(8)
  })

  it('时长预算中止（内部 deadline）：已有总结收口为 partial/endReason=time_limit，不再丢弃', async () => {
    // 首轮产出文本（summary candidate）+ read 调用延续循环；次轮挂起直到 1200ms deadline。
    // SubAgentRuntime 与 runAgentLoop 的双 deadline timer 同刻触发、reason 为 'aborted'——
    // 重映射前该路径走 case 'aborted' 抛「子任务已中止」，把可用的中期总结整个丢弃。
    const transport = new HeldAfterFirstTransport(textToolResponse('中期结论：已覆盖两个文件', 'src/a.ts'))
    const runtime = createSubAgentRuntime({
      childBudget: { ...DEFAULT_SUBAGENT_CHILD_BUDGET, maxTurns: 4, maxDurationMs: 1200 },
    })
    const result = await runtime.delegate(
      request,
      createBinding(transport),
      new AbortController().signal,
    )
    expect(result.status).toBe('partial')
    expect(result.endReason).toBe('time_limit')
    expect(result.summary).toContain('中期结论')
  })

  it('父 run 取消（父 signal abort）：仍 fail-closed 报「子任务已取消」，不冒充时长中止', async () => {
    const transport = new HeldAfterFirstTransport(textToolResponse('中期结论', 'src/a.ts'))
    const runtime = createSubAgentRuntime({ childBudget: { ...DEFAULT_SUBAGENT_CHILD_BUDGET, maxTurns: 4 } })
    const parentController = new AbortController()
    const delegation = runtime.delegate(
      request,
      createBinding(transport),
      parentController.signal,
    )
    // 等次轮请求挂起后取消父 signal（内部 deadline 240s 不会先触发）
    await vi.waitFor(() => expect(transport.requests.length).toBe(2))
    parentController.abort()
    await expect(delegation).rejects.toThrow('子任务已取消')
  })

  it('父 run 请求累计超过上限 fail-closed', async () => {
    const runtime = createSubAgentRuntime({ childBudget: { ...DEFAULT_SUBAGENT_CHILD_BUDGET, maxTurns: 2 } })
    const ledger = createParentRunLedger({ ...createParentRunLedger().budget, maxModelRequestsPerParentRun: 2 })
    const signal = new AbortController().signal
    const delegate = (script: ModelStreamEvent[][]) =>
      runtime.delegate(
        request,
        createBinding(new ScriptedTransport(script), { parentRunLedger: ledger }),
        signal,
      )
    // 第 1 次 delegate：单轮完成，modelRequestCount=1
    await delegate([textResponse('ok')])
    // 第 2 次 delegate：首轮通过（count 1→2），次轮触发父 run 请求上限
    const result = await delegate([textToolResponse('ok', 'src/a.ts')])
    expect(result.status).toBe('partial')
    expect(result.endReason).toBe('parent_run_budget')
    expect(ledger.modelRequestCount).toBe(2)
  })

  it('settleDuration 累计到父 run ledger，且 provider 错误分类透传', async () => {
    // message 驱动的分类（真实 Provider 错误流）：authentication / HTTP 401 → kind authentication
    const transport = new ErrorOnlyTransport('authentication failed: invalid API key HTTP 401')
    const runtime = createSubAgentRuntime()
    const ledger = createParentRunLedger()
    const error = await runtime
      .delegate(request, createBinding(transport, { parentRunLedger: ledger }), new AbortController().signal)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SubAgentExecutionError)
    expect((error as SubAgentExecutionError).providerErrorKind).toBe('authentication')
    expect(ledger.callCount).toBe(1)
    expect(ledger.spentDurationMs).toBeGreaterThanOrEqual(0)
  })

  it('Provider context overflow 且有总结时返回 partial/endReason=context_limit', async () => {
    // 第一轮输出文本（设 summaryCandidate）+ read 工具调用（让循环继续）；
    // 第二轮 Provider 返回 context overflow → settleResult 收口为 partial。
    const transport = new ScriptedTransport([
      textToolResponse('已收集的证据', 'src/a.ts'),
      [{ type: 'error', message: 'context window exceeds limit' }],
    ])
    const runtime = createSubAgentRuntime()
    const result = await runtime.delegate(
      request,
      createBinding(transport),
      new AbortController().signal,
    )
    expect(result.status).toBe('partial')
    expect(result.endReason).toBe('context_limit')
    expect(result.summary).toContain('已收集的证据')
  })

  it('Provider context overflow 且无总结时仍抛 SubAgentExecutionError', async () => {
    // 第一轮只有工具调用（不产生文本 summary），第二轮 overflow → 无总结 fail-closed。
    const transport = new ScriptedTransport([
      readToolResponse('src/a.ts'),
      [{ type: 'error', message: 'context window exceeds limit' }],
    ])
    const runtime = createSubAgentRuntime()
    const error = await runtime
      .delegate(request, createBinding(transport), new AbortController().signal)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SubAgentExecutionError)
    expect((error as SubAgentExecutionError).providerErrorKind).toBe('context_overflow')
  })

  it('parentRunUsage 填充累计计费与回流字节', async () => {
    const transport = new ScriptedTransport([textResponse('结论')])
    const runtime = createSubAgentRuntime()
    const result = await runtime.delegate(
      request,
      createBinding(transport),
      new AbortController().signal,
    )
    expect(result.parentRunUsage).toBeDefined()
    expect(result.parentRunUsage?.calls).toBe(1)
    expect(result.parentRunUsage?.modelRequests).toBe(1)
    // returnedBytes 等于 summary 的 UTF-8 字节长度
    expect(result.parentRunUsage?.returnedBytes).toBe(
      new TextEncoder().encode(result.summary).byteLength,
    )
  })

  it('子会话诊断 type 标签通过 parentRunUsage 返回（成功路径）', async () => {
    const transport = new ScriptedTransport([
      [
        { type: 'start', responseId: 'resp-diag' },
        { type: 'diagnostic', diagnostic: { type: 'provider-warning', timestamp: Date.now() } },
        { type: 'text_delta', delta: '结论' },
        { type: 'done', stopReason: 'stop' },
      ],
    ])
    const runtime = createSubAgentRuntime()
    const result = await runtime.delegate(
      request,
      createBinding(transport),
      new AbortController().signal,
    )
    expect(result.status).toBe('completed')
    expect(result.parentRunUsage?.diagnosticTypes).toContain('provider-warning')
  })

  it('子会话诊断归并到父 run ledger（失败路径也累计）', async () => {
    const transport = new ErrorOnlyTransport('authentication failed: invalid API key HTTP 401')
    const runtime = createSubAgentRuntime()
    const ledger = createParentRunLedger()
    await runtime
      .delegate(request, createBinding(transport, { parentRunLedger: ledger }), new AbortController().signal)
      .catch(() => undefined)
    // 失败路径：delegate 抛错不返回 parentRunUsage，但诊断已累计到共享 ledger
    expect(ledger.diagnosticTypes).toContain('provider-error')
  })

  it('returnedBytes 在同一父 run 跨多次 Explore 累计', async () => {
    const runtime = createSubAgentRuntime()
    const ledger = createParentRunLedger()
    const signal = new AbortController().signal
    await runtime.delegate(
      request,
      createBinding(new ScriptedTransport([textResponse('first')]), { parentRunLedger: ledger }),
      signal,
    )
    const firstReturned = ledger.returnedBytes
    expect(firstReturned).toBeGreaterThan(0)
    await runtime.delegate(
      request,
      createBinding(new ScriptedTransport([textResponse('second')]), { parentRunLedger: ledger }),
      signal,
    )
    expect(ledger.returnedBytes).toBeGreaterThan(firstReturned)
    expect(ledger.callCount).toBe(2)
  })

  it('progress 回传含探索目标描述（read 路径）', async () => {
    const transport = new ScriptedTransport([
      readToolResponse('src/a.ts'),
      textResponse('结论'),
    ])
    const reportProgress = vi.fn((_value: string) => Promise.resolve())
    const runtime = createSubAgentRuntime()
    await runtime.delegate(
      request,
      createBinding(transport, { reportProgress }),
      new AbortController().signal,
    )
    expect(reportProgress).toHaveBeenCalled()
    const lastCall = reportProgress.mock.calls[reportProgress.mock.calls.length - 1]
    expect(lastCall[0]).toContain('读取 src/a.ts')
    expect(lastCall[0]).toContain('只读调用')
  })

  it('scope 全部路径不存在：执行前快速失败，不启动子请求', async () => {
    const transport = new ScriptedTransport([textResponse('不应到达')])
    const runtime = createSubAgentRuntime()
    await expect(
      runtime.delegate(
        { kind: 'explore', task: 'x', scope: ['src', 'lib'] },
        createBinding(transport, {
          environment: createFakeAgentEnvironment({
            list: async () => {
              throw new Error('failed to inspect workspace directory: No such file or directory')
            },
            readText: async () => {
              throw new Error('failed to resolve workspace path: No such file or directory (os error 2)')
            },
          }),
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(SubAgentExecutionError)
    await expect(
      runtime.delegate(
        { kind: 'explore', task: 'x', scope: ['src'] },
        createBinding(transport, {
          environment: createFakeAgentEnvironment({
            list: async () => {
              throw new Error('failed to inspect workspace directory: No such file or directory')
            },
            readText: async () => {
              throw new Error('failed to resolve workspace path: No such file or directory (os error 2)')
            },
          }),
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('不在授权工作区内')
    expect(transport.requests).toHaveLength(0)
  })

  it('scope 条目为文件（list 失败，readText 回退成功）：视为有效，正常执行', async () => {
    const transport = new ScriptedTransport([textResponse('结论')])
    const runtime = createSubAgentRuntime()
    const result = await runtime.delegate(
      { kind: 'explore', task: 'x', scope: ['docs/readme.md'] },
      createBinding(transport, {
        environment: createFakeAgentEnvironment({
          list: async () => {
            throw new Error('workspace list path is not a directory')
          },
        }),
      }),
      new AbortController().signal,
    )
    expect(result.status).toBe('completed')
    expect(transport.requests).toHaveLength(1)
  })

  it('scope 为空：不触发存在性校验，行为不变', async () => {
    const listSpy = vi.fn(async () => ({
      workspace: defaultWorkspace,
      directory: '.',
      entries: [],
      truncated: false,
    }))
    const transport = new ScriptedTransport([textResponse('结论')])
    const runtime = createSubAgentRuntime()
    await runtime.delegate(
      { kind: 'explore', task: 'x' },
      createBinding(transport, {
        environment: createFakeAgentEnvironment({ list: listSpy }),
      }),
      new AbortController().signal,
    )
    expect(listSpy).not.toHaveBeenCalled()
    expect(transport.requests).toHaveLength(1)
  })
})

describe('describeToolTarget', () => {
  it('read 提取 path', () => {
    expect(describeToolTarget('read', { path: 'src/a.ts' })).toBe('读取 src/a.ts')
  })

  it('grep 提取 pattern + path', () => {
    expect(describeToolTarget('grep', { pattern: 'foo', path: 'src' })).toBe("搜索 'foo' in src")
    expect(describeToolTarget('grep', { pattern: 'foo' })).toBe("搜索 'foo'")
    // 缺 pattern 时返回 undefined
    expect(describeToolTarget('grep', { path: 'src' })).toBeUndefined()
  })

  it('find 提取 glob/pattern + path', () => {
    expect(describeToolTarget('find', { glob: '*.ts', path: 'src' })).toBe('查找 *.ts in src')
    expect(describeToolTarget('find', { pattern: '*.ts' })).toBe('查找 *.ts')
    expect(describeToolTarget('find', { path: 'src' })).toBe('查找 in src')
  })

  it('ls 提取 path', () => {
    expect(describeToolTarget('ls', { path: 'src' })).toBe('列出 src')
  })

  it('未知工具或无有效参数返回 undefined', () => {
    expect(describeToolTarget('unknown', { path: 'x' })).toBeUndefined()
    expect(describeToolTarget('read', {})).toBeUndefined()
    expect(describeToolTarget('read', null)).toBeUndefined()
    expect(describeToolTarget('read', 'not-object')).toBeUndefined()
    expect(describeToolTarget('read', [])).toBeUndefined()
  })
})

/**
 * 审查 kinds（inspect/examine/review）的 runtime 级集成回归：此前本文件只覆盖
 * explore kind，buildSubAgentSystemPrompt 的三分支与 diff 拼接后的 task 进入子
 * 首条 user message 的链路没有端到端护栏（prompt builder 只有单测）。
 */
describe('reviewer kinds（inspect/examine/review runtime 集成）', () => {
  it.each([
    ['inspect', '审查 Task Spec'],
    ['examine', '检查实施方案'],
    ['review', '审查代码改动'],
  ] as const)('%s 分发对应审查 system prompt（含 contextWindow 预算行），工具集只读', async (kind, roleKeyword) => {
    const transport = new ScriptedTransport([textResponse('结论：通过\n- 依据：验收可判定')])
    const seen = vi.fn()
    const runtime = createSubAgentRuntime()
    await runtime.delegate(
      { kind, task: '按 scope 审查目标文档' },
      createBinding(transport, {
        observation: { onModelRequest: (req) => { seen(req) } },
      }),
      new AbortController().signal,
    )
    const modelRequest = seen.mock.calls[0][0] as ModelRequest
    // kind 分发命中各自的 prompt builder（角色行是三者互斥的判别文本）
    expect(modelRequest.systemPrompt).toContain(roleKeyword)
    expect(modelRequest.systemPrompt).toContain('通过 / 不通过')
    // 预算段渲染 contextWindow（binding 默认 100_000），对齐 explore
    expect(modelRequest.systemPrompt).toContain('你的上下文窗口为 100000 tokens')
    // 与 explore 同构的只读工具集：无 bash/write/edit
    expect(modelRequest.tools.map((tool) => tool.name))
      .toEqual(['read', 'ls', 'grep', 'find', 'web_search', 'web_fetch'])
  })

  it('review 委派：diff 分节随 task 进入子首条 user message，prompt 声明 diff 权威依据', async () => {
    const transport = new ScriptedTransport([textResponse('结论：不通过\n- 问题：边界缺失')])
    const seen = vi.fn()
    const runtime = createSubAgentRuntime()
    const diff = '+ export const foo = 1\n- export const bar = 2'
    // task 由 review_subagent 工具层拼好（意图 + 固定分节头 + diff）后传入 delegate
    const result = await runtime.delegate(
      {
        kind: 'review',
        task: `审查 src/a.ts 的改动\n\n# 改动 diff（由父 Agent 提供）\n\n${diff}`,
        scope: ['src'],
      },
      createBinding(transport, {
        observation: { onModelRequest: (req) => { seen(req) } },
      }),
      new AbortController().signal,
    )
    expect(result.status).toBe('completed')
    expect(result.summary).toContain('不通过')
    const modelRequest = seen.mock.calls[0][0] as ModelRequest
    expect(modelRequest.systemPrompt).toContain('权威依据')
    const userMessages = modelRequest.messages.filter((m) => m.role === 'user')
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('# 改动 diff（由父 Agent 提供）'),
    })
    expect((userMessages[0] as { content: string }).content).toContain(diff)
  })

  it('未知 kind fail-closed 拒绝', async () => {
    const transport = new ScriptedTransport([])
    const runtime = createSubAgentRuntime()
    await expect(runtime.delegate(
      { kind: 'bogus' as SubAgentKind, task: 'x' },
      createBinding(transport),
      new AbortController().signal,
    )).rejects.toThrow(SubAgentExecutionError)
    await expect(runtime.delegate(
      { kind: 'bogus' as SubAgentKind, task: 'x' },
      createBinding(transport),
      new AbortController().signal,
    )).rejects.toThrow('不支持的 SubAgent 种类')
  })
})
