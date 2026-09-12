import type {
  AgentEvent,
  AgentMessage,
  AgentMutationReceipt,
  AgentTool,
  ModelRequest,
  ModelStreamEvent,
  ModelTransport,
} from '@/agent/core/types'
import { createBranchMessageCopies } from '@/agent/session/branch'
import { describe, expect, it } from 'vitest'
import { AgentSession } from './AgentSession'
import type { AgentMutationJournal, AgentSessionJournalEntry } from './mutationJournal'

class CompactingTransport implements ModelTransport {
  readonly requests: ModelRequest[] = []

  requestByteLength = (request: ModelRequest): number => {
    if (request.systemPrompt.includes('上下文压缩器')) return 1_000
    if (request.messages.some((message) => message.id.startsWith('context-summary:'))) return 1_000
    return 1_900_000
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request)
    yield { type: 'start' }
    yield {
      type: 'text_delta',
      delta: request.systemPrompt.includes('上下文压缩器')
        ? '## 目标\n保留旧目标\n\n## 后续步骤\n1. 继续'
        : 'final answer',
    }
    yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
  }
}

class OverflowTransport implements ModelTransport {
  readonly requests: ModelRequest[] = []
  private normalRequests = 0

  constructor(private readonly alwaysOverflow = false) {}

  requestByteLength = (request: ModelRequest): number =>
    new TextEncoder().encode(JSON.stringify(request)).byteLength

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request)
    yield { type: 'start' }
    if (request.systemPrompt.includes('上下文压缩器')) {
      yield { type: 'text_delta', delta: '## 目标\n恢复溢出请求\n\n## 后续步骤\n1. 继续' }
      yield { type: 'done', stopReason: 'stop' }
      return
    }
    this.normalRequests += 1
    if (this.alwaysOverflow || this.normalRequests === 1) {
      yield { type: 'error', message: 'invalid params, context window exceeds limit' }
      return
    }
    yield { type: 'text_delta', delta: 'recovered' }
    yield { type: 'done', stopReason: 'stop' }
  }
}

class RetryableTransport implements ModelTransport {
  readonly requests: ModelRequest[] = []
  private attempts = 0

  constructor(
    private readonly failuresBeforeSuccess: number,
    private readonly emitPartialText = false,
  ) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(structuredClone(request))
    this.attempts += 1
    yield { type: 'start' }
    if (this.attempts <= this.failuresBeforeSuccess) {
      if (this.emitPartialText) yield { type: 'text_delta', delta: 'partial' }
      yield {
        type: 'error',
        message: 'provider overloaded',
        error: {
          kind: 'server',
          message: 'provider overloaded',
          status: 503,
          retryable: true,
        },
      }
      return
    }
    yield { type: 'text_delta', delta: 'recovered automatically' }
    yield { type: 'done', stopReason: 'stop' }
  }
}

/** 模拟 Rust model_http 重试耗尽后透传的 429 限流错误（rate_limit kind）。 */
class RateLimitedTransport implements ModelTransport {
  readonly requests: ModelRequest[] = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(structuredClone(request))
    yield { type: 'start' }
    yield {
      type: 'error',
      message: 'HTTP 429: The engine is currently overloaded, please try again later',
      error: {
        kind: 'rate_limit',
        message: 'HTTP 429: The engine is currently overloaded, please try again later',
        status: 429,
        retryable: true,
      },
    }
    return
  }
}

/** 模拟长任务中 max_tokens 截断：首个响应输出文本后被 Provider 硬截断，后续请求正常完成。 */
class TruncatingTransport implements ModelTransport {
  readonly requests: ModelRequest[] = []
  private attempts = 0

  requestByteLength = (request: ModelRequest): number =>
    new TextEncoder().encode(JSON.stringify(request)).byteLength

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request)
    this.attempts += 1
    yield { type: 'start' }
    if (this.attempts === 1) {
      yield { type: 'text_delta', delta: '第一段输出' }
      yield {
        type: 'done',
        stopReason: 'length',
        usage: { inputTokens: 10, outputTokens: 4096, totalTokens: 4106 },
      }
      return
    }
    yield { type: 'text_delta', delta: '续写输出' }
    yield { type: 'done', stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
  }
}

class ResumeTransport implements ModelTransport {
  readonly requests: ModelRequest[] = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request)
    yield { type: 'start' }
    yield { type: 'text_delta', delta: 'regenerated answer' }
    yield { type: 'done', stopReason: 'stop' }
  }
}

class QueuedMessageTransport implements ModelTransport {
  readonly requests: ModelRequest[] = []
  readonly firstRequestStarted: Promise<void>
  private readonly firstRequestReleased: Promise<void>
  private markFirstRequestStarted!: () => void
  private releaseFirstRequest!: () => void

  constructor() {
    this.firstRequestStarted = new Promise((resolve) => {
      this.markFirstRequestStarted = resolve
    })
    this.firstRequestReleased = new Promise((resolve) => {
      this.releaseFirstRequest = resolve
    })
  }

  release(): void {
    this.releaseFirstRequest()
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const requestIndex = this.requests.push(request) - 1
    if (requestIndex === 0) {
      this.markFirstRequestStarted()
      await this.firstRequestReleased
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    yield { type: 'start' }
    yield { type: 'text_delta', delta: `answer-${requestIndex + 1}` }
    yield { type: 'done', stopReason: 'stop' }
  }
}

class RecordingMutationJournal implements AgentMutationJournal {
  readonly entries = new Map<string, AgentSessionJournalEntry>()
  readonly operations: string[] = []

  constructor(
    private readonly appendBarrier?: Promise<void>,
    private readonly beforeConsuming?: () => void,
  ) {}

  async append(entry: AgentSessionJournalEntry): Promise<void> {
    await this.appendBarrier
    this.entries.set(entry.id, structuredClone(entry))
    this.operations.push(`append:${entry.id}`)
  }

  async markConsuming(entryIds: string[], runId: string): Promise<void> {
    this.beforeConsuming?.()
    for (const entryId of entryIds) {
      const entry = this.require(entryId)
      entry.status = 'consuming'
      entry.consumerRunId = runId
      this.operations.push(`consuming:${entryId}`)
    }
  }

  async restorePending(entryIds: string[]): Promise<void> {
    for (const entryId of entryIds) {
      const entry = this.require(entryId)
      entry.status = 'pending'
      entry.consumerRunId = undefined
      this.operations.push(`pending:${entryId}`)
    }
  }

  async markRecovered(entryIds: string[]): Promise<void> {
    for (const entryId of entryIds) {
      const entry = this.require(entryId)
      if (entry.kind !== 'queue') throw new Error('only queue entries can be recovered')
      entry.status = 'pending'
      entry.consumerRunId = undefined
      entry.recoveredAt = Date.now()
      this.operations.push(`recovered:${entryId}`)
    }
  }

  async markApplied(entryIds: string[]): Promise<void> {
    for (const entryId of entryIds) {
      const entry = this.require(entryId)
      entry.status = 'applied'
      if (entry.kind === 'queue') entry.recoveredAt = undefined
      this.operations.push(`applied:${entryId}`)
    }
  }

  async discard(entryIds: string[]): Promise<void> {
    for (const entryId of entryIds) {
      const entry = this.require(entryId)
      entry.status = 'discarded'
      if (entry.kind === 'queue') entry.recoveredAt = undefined
      this.operations.push(`discarded:${entryId}`)
    }
  }

  private require(entryId: string): AgentSessionJournalEntry {
    const entry = this.entries.get(entryId)
    if (!entry) throw new Error(`missing journal entry: ${entryId}`)
    return entry
  }
}

const createQueuedMessageSession = (
  transport: ModelTransport,
  modes: { steeringMode?: 'one-at-a-time' | 'all'; followUpMode?: 'one-at-a-time' | 'all' } = {},
): AgentSession => new AgentSession({
  sessionId: 'queued-message-session',
  systemPrompt: 'system',
  model: { provider: 'test', model: 'model' },
  transport,
  ...modes,
})

const runtimeTool: AgentTool = {
  name: 'runtime_tool',
  runtimeVersion: '1',
  label: 'Runtime tool',
  description: 'Tool installed through updateRuntime',
  inputSchema: { type: 'object' },
  validate: (input) => ({ ok: true, value: input }),
  execute: async () => ({ content: 'ok' }),
}

const deferredRuntimeTool: AgentTool = {
  ...runtimeTool,
  name: 'deferred_runtime_tool',
  label: 'Deferred runtime tool',
}

describe('AgentSession rich runtime input', () => {
  it('accepts an image-only prompt and keeps the content block in the model request and history', async () => {
    const transport = new ResumeTransport()
    const session = new AgentSession({
      sessionId: 'rich-input',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
    })

    await session.prompt('', [{
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: 'cG5n' },
    }])

    expect(transport.requests[0]?.messages[0]).toMatchObject({
      role: 'user',
      content: '',
      contentBlocks: [{ type: 'image', source: { mediaType: 'image/png', data: 'cG5n' } }],
    })
    expect(session.messages[0]).toMatchObject({ role: 'user', contentBlocks: [{ type: 'image' }] })
  })

  it('accepts custom app messages when a converter is installed', async () => {
    const transport = new ResumeTransport()
    const session = new AgentSession({
      sessionId: 'custom-input',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      convertToModelMessages: async (messages) => messages.map((message) => message.role === 'custom'
        ? {
            id: message.id,
            role: 'user' as const,
            content: `note:${message.content}`,
            createdAt: message.createdAt,
          }
        : message),
    })

    await session.promptMessages([{
      id: 'note-1',
      role: 'custom',
      customType: 'note',
      content: 'remember',
      data: { durable: true },
      createdAt: 1,
    }])

    expect(transport.requests[0]?.messages[0]).toMatchObject({ role: 'user', content: 'note:remember' })
    expect(session.messages[0]).toMatchObject({ role: 'custom', customType: 'note' })
  })

  it('keeps constructor inputs, run results, and public snapshots isolated from session state', async () => {
    const model = { provider: 'test', model: 'original-model' }
    const inputSchema = { type: 'object', properties: { value: { type: 'string' } } }
    const tool: AgentTool = {
      ...runtimeTool,
      description: 'original-description',
      inputSchema,
    }
    const session = new AgentSession({
      sessionId: 'snapshot-isolation',
      systemPrompt: 'system',
      model,
      transport: new ResumeTransport(),
      tools: [tool],
    })

    model.model = 'mutated-constructor-model'
    tool.description = 'mutated-constructor-description'
    inputSchema.type = 'array'

    const result = await session.prompt('durable prompt')
    result.messages[0]!.content = 'mutated-result'
    result.context.model.model = 'mutated-result-model'

    const exposedMessages = session.messages
    exposedMessages[0]!.content = 'mutated-getter'
    const exposedContext = session.runtimeContext
    exposedContext.model.model = 'mutated-getter-model'
    exposedContext.tools[0]!.description = 'mutated-getter-description'
    exposedContext.tools[0]!.inputSchema.type = 'array'

    expect(session.messages[0]).toMatchObject({ role: 'user', content: 'durable prompt' })
    expect(session.runtimeContext.model.model).toBe('original-model')
    expect(session.getTools()[0]).toMatchObject({
      description: 'original-description',
      inputSchema: { type: 'object' },
    })
  })

  it('keeps a prepareNextTurn transport and model update for later prompt runs', async () => {
    const firstTransport = new ResumeTransport()
    const secondTransport = new ResumeTransport()
    let switched = false
    const session = new AgentSession({
      sessionId: 'dynamic-model',
      systemPrompt: 'system',
      model: { provider: 'first', model: 'first-model' },
      transport: firstTransport,
      prepareNextTurn: async () => {
        if (switched) return undefined
        switched = true
        return {
          model: {
            provider: 'second',
            model: 'second-model',
            contextWindow: 256_000,
            maxOutputTokens: 8_192,
          },
          transport: secondTransport,
        }
      },
    })

    await session.prompt('switch after this turn')
    await session.prompt('continue normally')

    expect(firstTransport.requests).toHaveLength(1)
    expect(secondTransport.requests).toHaveLength(1)
    expect(secondTransport.requests[0]).toMatchObject({
      model: { provider: 'second', model: 'second-model', contextWindow: 256_000 },
      maxOutputTokens: 8_192,
    })
  })

  it('keeps nextTurn messages pending and injects them before the next explicit prompt in FIFO order', async () => {
    const transport = new ResumeTransport()
    const journal = new RecordingMutationJournal()
    const session = new AgentSession({
      sessionId: 'next-turn-queue',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      messages: [{ id: 'u1', role: 'user', content: 'retry boundary', createdAt: 1 }],
      mutationJournal: journal,
    })
    let promptRunId: string | undefined
    session.subscribe((event) => {
      if (event.type === 'agent_start') promptRunId = event.runId
    })

    expect(await session.nextTurn('carry into normal prompt')).toBe(true)
    expect(await session.nextTurn('second queued context')).toBe(true)
    expect(session.pendingNextTurnCount).toBe(2)
    await session.continue()
    expect(transport.requests[0]?.messages.map((message) => message.content))
      .toEqual(['retry boundary'])
    expect(session.pendingNextTurnCount).toBe(2)

    await session.prompt('normal prompt')
    expect(transport.requests[1]?.messages.map((message) => message.content))
      .toEqual([
        'retry boundary',
        'regenerated answer',
        'carry into normal prompt',
        'second queued context',
        'normal prompt',
      ])
    expect(session.pendingNextTurnCount).toBe(0)
    expect(promptRunId).toBeDefined()
    expect([...journal.entries.values()]).toEqual([
      expect.objectContaining({ status: 'consuming', consumerRunId: promptRunId }),
      expect.objectContaining({ status: 'consuming', consumerRunId: promptRunId }),
    ])
  })

  it('separates strict continuation, retry, and normal continue semantics', async () => {
    const transport = new ResumeTransport()
    const failed = {
      id: 'a-error',
      role: 'assistant' as const,
      content: '',
      toolCalls: [],
      stopReason: 'error' as const,
      errorMessage: 'temporary failure',
      createdAt: 2,
    }
    const session = new AgentSession({
      sessionId: 'continuation-semantics',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      messages: [
        { id: 'u1', role: 'user', content: 'original prompt', createdAt: 1 },
        failed,
      ],
    })

    await expect(session.continue()).rejects.toThrow('不能从 Assistant 消息直接继续')
    await session.retry()
    expect(transport.requests[0]?.messages.map((message) => message.id)).toEqual(['u1'])
    // 失败 assistant 保留在审计历史，但被标记为排除出模型上下文
    expect(session.messages).toContainEqual({ ...failed, excludeFromModelContext: true })

    await expect(session.continue()).rejects.toThrow('不能从 Assistant 消息直接继续')
    await session.prompt('请继续。')
    const secondRequestMessages = transport.requests[1]?.messages ?? []
    expect(secondRequestMessages[secondRequestMessages.length - 1])
      .toMatchObject({ role: 'user', content: '请继续。' })
    // 回归：retry 成功后，后续请求的模型上下文不得再包含被排除的失败 assistant
    expect(secondRequestMessages.map((message) => message.id)).not.toContain('a-error')

    const unsafe = new AgentSession({
      sessionId: 'unsafe-retry',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: new ResumeTransport(),
      messages: [failed],
    })
    await expect(unsafe.retry()).rejects.toThrow('没有可安全重试')
    expect(unsafe.runtimeContext.messages).toEqual([failed])
  })

  it('auto-continues a max_tokens-truncated response within a single prompt run', async () => {
    const transport = new TruncatingTransport()
    const session = new AgentSession({
      sessionId: 'auto-continue',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
    })

    const result = await session.prompt('长任务')

    expect(result.reason).toBe('completed')
    // 同一 prompt 内自动续写：共 2 次模型请求
    expect(transport.requests).toHaveLength(2)
    // 第二轮请求以续写 user 指令结尾，模型据此从未完成处继续
    const secondRequestMessages = transport.requests[1]?.messages ?? []
    const lastMessage = secondRequestMessages[secondRequestMessages.length - 1]
    expect(lastMessage).toMatchObject({ role: 'user' })
    expect(lastMessage.content).toContain('截断')
    // 截断段与续写段都保留在会话历史
    const assistants = result.messages.filter((message) => message.role === 'assistant')
    expect(assistants.map((message) => message.content)).toEqual(['第一段输出', '续写输出'])
  })

  it('retries across consecutive durable failure responses after session reload', async () => {
    const transport = new ResumeTransport()
    const firstFailure = {
      id: 'a-error-1',
      role: 'assistant' as const,
      content: 'partial one',
      toolCalls: [],
      stopReason: 'error' as const,
      errorMessage: 'stream failed',
      createdAt: 2,
    }
    const secondFailure = {
      ...firstFailure,
      id: 'a-error-2',
      content: 'partial two',
      createdAt: 3,
    }
    const session = new AgentSession({
      sessionId: 'reloaded-retry',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      messages: [
        { id: 'u1', role: 'user', content: 'original prompt', createdAt: 1 },
        firstFailure,
        secondFailure,
      ],
    })

    await session.retry()

    expect(transport.requests[0]?.messages.map((message) => message.id)).toEqual(['u1'])
    // 仅最后一条失败响应被标记排除出模型上下文，前一条仍原样保留在审计历史
    expect(session.messages).toEqual(expect.arrayContaining([
      firstFailure,
      { ...secondFailure, excludeFromModelContext: true },
    ]))
  })

  it('automatically retries only pure retryable provider failures and keeps them out of model context', async () => {
    const transport = new RetryableTransport(2)
    const events: AgentEvent[] = []
    const session = new AgentSession({
      sessionId: 'safe-auto-retry',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      autoRetry: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
    })
    session.subscribe((event) => { events.push(event) })

    const result = await session.prompt('retry safely')

    expect(result.reason).toBe('completed')
    expect(transport.requests).toHaveLength(3)
    expect(transport.requests.map((request) => request.messages.map((message) => message.role)))
      .toEqual([['user'], ['user'], ['user']])
    const failedMessages = session.messages.filter((message) =>
      message.role === 'assistant' && message.stopReason === 'error')
    expect(failedMessages).toHaveLength(2)
    expect(session.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'recovered automatically',
      stopReason: 'stop',
    })
    expect(events.filter((event) => event.type === 'auto_retry_start')).toMatchObject([
      { attempt: 1, maxAttempts: 2, delayMs: 0 },
      { attempt: 2, maxAttempts: 2, delayMs: 0 },
    ])
    expect(events.filter((event) => event.type === 'auto_retry_end')).toMatchObject([
      { success: true, attempt: 2 },
    ])

    const restored = new AgentSession({
      sessionId: 'safe-auto-retry',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: new ResumeTransport(),
      messages: session.messages,
    })
    expect(restored.runtimeContext.messages.map((message) => message.id))
      .toEqual(session.messages.filter((message) =>
        message.role !== 'assistant' || message.stopReason !== 'error').map((message) => message.id))
  })

  it('does not auto-retry a rate-limit failure (Rust already retried), and surfaces it directly', async () => {
    const rateLimited = new RateLimitedTransport()
    const events: AgentEvent[] = []
    const session = new AgentSession({
      sessionId: 'rate-limit-no-retry',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: rateLimited,
      autoRetry: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
    })
    session.subscribe((event) => { events.push(event) })

    const result = await session.prompt('rate limited')

    expect(result.reason).toBe('error')
    expect(rateLimited.requests).toHaveLength(1)
    expect(events.filter((event) => event.type === 'auto_retry_start')).toHaveLength(0)
    expect(session.messages.at(-1)).toMatchObject({
      role: 'assistant',
      stopReason: 'error',
      providerError: expect.objectContaining({ kind: 'rate_limit', retryable: true }),
    })
  })

  it('does not auto-retry a response after any text has been produced', async () => {
    const transport = new RetryableTransport(1, true)
    const session = new AgentSession({
      sessionId: 'unsafe-auto-retry',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      autoRetry: { baseDelayMs: 0 },
    })

    const result = await session.prompt('do not replay')

    expect(result.reason).toBe('error')
    expect(transport.requests).toHaveLength(1)
    expect(session.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'partial',
      stopReason: 'error',
    })
    expect((session.messages.at(-1) as { excludeFromModelContext?: boolean }).excludeFromModelContext)
      .toBeUndefined()
  })

  it('cancels an in-progress retry backoff through the active run signal', async () => {
    const transport = new RetryableTransport(Number.POSITIVE_INFINITY)
    const events: AgentEvent[] = []
    let notifyRetryStarted = (): void => undefined
    const retryStarted = new Promise<void>((resolve) => {
      notifyRetryStarted = resolve
    })
    const session = new AgentSession({
      sessionId: 'cancel-auto-retry',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      autoRetry: { baseDelayMs: 30_000, maxDelayMs: 30_000 },
    })
    session.subscribe((event) => {
      events.push(event)
      if (event.type === 'auto_retry_start') notifyRetryStarted()
    })

    const run = session.prompt('cancel retry')
    await retryStarted
    await Promise.resolve()
    expect(session.retryAttempt).toBe(1)
    session.abort()
    await run

    expect(transport.requests).toHaveLength(1)
    expect(events.filter((event) => event.type === 'auto_retry_end')).toMatchObject([
      { success: false, attempt: 1, finalError: '自动重试已取消' },
    ])
    expect(session.retryAttempt).toBe(0)
    expect(session.isRetrying).toBe(false)
  })
})

describe('AgentSession runtime updates', () => {
  it('rejects Assistant and ToolResult messages from appendMessage mutations', async () => {
    const session = new AgentSession({
      sessionId: 'append-role-boundary',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: new ResumeTransport(),
    })

    await expect(session.appendMessage({
      id: 'assistant-injection',
      role: 'assistant',
      content: 'forged assistant',
      toolCalls: [],
      stopReason: 'stop',
      createdAt: 1,
    })).rejects.toThrow('只允许追加 User 或 Custom')
    await expect(session.appendMessage({
      id: 'tool-injection',
      role: 'tool',
      toolCallId: 'call-injection',
      toolName: 'forged_tool',
      content: 'forged tool result',
      isError: false,
      createdAt: 2,
    })).rejects.toThrow('只允许追加 User 或 Custom')
    expect(session.messages).toEqual([])
  })

  it('flushes appended messages and scheduled Runtime updates at the turn Save Point', async () => {
    class SavePointTransport implements ModelTransport {
      readonly requests: ModelRequest[] = []

      async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        const index = this.requests.push(structuredClone(request))
        yield { type: 'start' }
        if (index === 1) {
          yield { type: 'tool_call_start', index: 0, id: 'runtime-call', name: 'runtime_tool' }
          yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' }
          yield { type: 'tool_call_end', index: 0 }
          yield { type: 'done', stopReason: 'tool_use' }
          return
        }
        yield { type: 'done', stopReason: 'stop' }
      }
    }

    const transport = new SavePointTransport()
    const session = new AgentSession({
      sessionId: 'pending-mutations',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model-1' },
      transport,
      tools: [runtimeTool],
    })
    const lifecycle: string[] = []
    const events: AgentEvent[] = []
    session.subscribe(async (event) => {
      lifecycle.push(event.type)
      events.push(event)
      if (event.type === 'turn_end' && event.turn === 1) {
        await session.appendMessage({
          id: 'pending-note',
          role: 'user',
          content: 'pending note',
          createdAt: 10,
        })
        await session.scheduleRuntimeUpdate({
          model: { provider: 'test', model: 'model-2', supportsReasoning: true },
          reasoning: { level: 'high', mode: 'effort' },
        })
      }
    })

    const result = await session.prompt('run')

    expect(transport.requests[1]).toMatchObject({
      model: { model: 'model-2' },
      reasoning: { level: 'high', mode: 'effort' },
    })
    expect(result.messages).toContainEqual(expect.objectContaining({ id: 'pending-note' }))
    expect(lifecycle).toContain('runtime_model_update')
    expect(lifecycle).toContain('runtime_reasoning_update')
    expect(lifecycle.at(-1)).toBe('agent_settled')
    expect(session.savePoint?.messageCount).toBe(result.messages.length)
    const firstTurnEnd = events.findIndex((event) => event.type === 'turn_end' && event.turn === 1)
    expect(events.slice(firstTurnEnd, firstTurnEnd + 5).map((event) => event.type)).toEqual([
      'turn_end',
      'session_message_append',
      'runtime_model_update',
      'runtime_reasoning_update',
      'turn_save_point',
    ])
    const turnSavePoints = events.filter((event) => event.type === 'turn_save_point')
    expect(turnSavePoints[0]).toMatchObject({
      savePoint: {
        turn: 1,
        hadPendingMutations: true,
        messageCount: 4,
        lastMessageId: 'pending-note',
      },
    })
    expect(turnSavePoints[1]).toMatchObject({
      savePoint: { turn: 2, hadPendingMutations: false, messageCount: result.messages.length },
    })
  })

  it('attributes prepareNextTurn mutations to the planned next turn receipt', async () => {
    class PrepareNextTurnTransport implements ModelTransport {
      private requestCount = 0

      async *stream(): AsyncIterable<ModelStreamEvent> {
        this.requestCount += 1
        yield { type: 'start' }
        if (this.requestCount === 1) {
          yield { type: 'tool_call_start', index: 0, id: 'prepare-call', name: 'runtime_tool' }
          yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' }
          yield { type: 'tool_call_end', index: 0 }
          yield { type: 'done', stopReason: 'tool_use' }
          return
        }
        yield { type: 'done', stopReason: 'stop' }
      }
    }

    const batches: Array<{ id: string; runId?: string; turn?: number }> = []
    const savePoints: AgentEvent[] = []
    let prepared = false
    const session = new AgentSession({
      sessionId: 'prepare-next-turn-owner',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model-1' },
      transport: new PrepareNextTurnTransport(),
      tools: [runtimeTool],
      prepareNextTurn: () => {
        if (prepared) return undefined
        prepared = true
        return { model: { provider: 'test', model: 'model-2' } }
      },
      commitMutationBatch: (batch) => {
        batches.push({ id: batch.id, runId: batch.runId, turn: batch.turn })
        return {
          batchId: batch.id,
          sessionId: batch.sessionId,
          runId: batch.runId,
          turn: batch.turn,
          committedAt: batch.createdAt,
          replayed: false,
        }
      },
    })
    session.subscribe((event) => {
      if (event.type === 'turn_save_point') savePoints.push(event)
    })

    const result = await session.prompt('run')

    expect(result.reason).toBe('completed')
    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({ turn: 2 })
    expect(savePoints.filter((event) => event.type === 'turn_save_point')[1]).toMatchObject({
      savePoint: {
        turn: 2,
        mutationBatchIds: [batches[0]!.id],
        hadPendingMutations: true,
      },
    })
  })

  it('retries an unknown mutation outcome in the same Run/Turn before applying Runtime', async () => {
    class RetryMutationTransport implements ModelTransport {
      readonly requests: ModelRequest[] = []

      async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        const index = this.requests.push(structuredClone(request))
        yield { type: 'start' }
        if (index === 1) {
          yield { type: 'tool_call_start', index: 0, id: 'runtime-call', name: 'runtime_tool' }
          yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' }
          yield { type: 'tool_call_end', index: 0 }
          yield { type: 'done', stopReason: 'tool_use' }
          return
        }
        yield { type: 'text_delta', delta: 'recovered' }
        yield { type: 'done', stopReason: 'stop' }
      }
    }

    const transport = new RetryMutationTransport()
    const committedIds: string[] = []
    let durableReceipt: AgentMutationReceipt | undefined
    let scheduled = false
    const events: AgentEvent[] = []
    const session = new AgentSession({
      sessionId: 'retry-pending-mutation',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model-1' },
      transport,
      tools: [runtimeTool],
      commitMutationBatch: async (batch) => {
        committedIds.push(batch.id)
        if (durableReceipt) return { ...durableReceipt, replayed: true }
        if (!batch.runId || batch.turn === undefined) throw new Error('missing mutation ownership')
        durableReceipt = {
          batchId: batch.id,
          sessionId: batch.sessionId,
          runId: batch.runId,
          turn: batch.turn,
          committedAt: batch.createdAt,
          replayed: false,
        }
        throw new Error('commit response unavailable')
      },
    })
    session.subscribe(async (event) => {
      events.push(event)
      if (!scheduled && event.type === 'turn_end') {
        scheduled = true
        await session.appendMessage({
          id: 'retry-note',
          role: 'user',
          content: 'retry me',
          createdAt: 10,
        })
        await session.scheduleRuntimeUpdate({
          model: { provider: 'test', model: 'model-2' },
        })
      }
    })

    const recovered = await session.prompt('first run')
    expect(recovered.reason).toBe('completed')
    expect(committedIds).toHaveLength(2)
    expect(committedIds[1]).toBe(committedIds[0])
    expect(durableReceipt).toMatchObject({
      runId: recovered.runId,
      turn: 1,
    })
    expect(session.runtimeContext.model.model).toBe('model-2')
    expect(session.messages.filter((message) => message.id === 'retry-note')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn_save_point').at(-1)).toMatchObject({
      savePoint: {
        hadPendingMutations: false,
        mutationBatchIds: [],
      },
    })
  })

  it('retains one idle mutation identity until the durable outcome is confirmed', async () => {
    const batchIds: string[] = []
    let durableReceipt: AgentMutationReceipt | undefined
    let unavailableResponses = 2
    const session = new AgentSession({
      sessionId: 'stable-idle-mutation',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: new ResumeTransport(),
      commitMutationBatch: async (batch) => {
        batchIds.push(batch.id)
        durableReceipt ??= {
          batchId: batch.id,
          sessionId: batch.sessionId,
          committedAt: batch.createdAt,
          replayed: false,
        }
        if (unavailableResponses > 0) {
          unavailableResponses -= 1
          throw new Error('idle commit response unavailable')
        }
        return { ...durableReceipt, replayed: true }
      },
    })
    const message: AgentMessage = {
      id: 'stable-idle-message',
      role: 'user',
      content: 'persist once',
      createdAt: 1,
    }

    await expect(session.appendMessage(message)).rejects.toThrow('response unavailable')
    expect(session.messages).toEqual([])
    await session.appendMessage(structuredClone(message))

    expect(batchIds).toHaveLength(3)
    expect(new Set(batchIds)).toEqual(new Set([batchIds[0]!]))
    expect(session.messages).toEqual([message])
  })

  it('rejects a mutation receipt from another Turn before applying Runtime state', async () => {
    class OwnershipMismatchTransport implements ModelTransport {
      private requestCount = 0

      async *stream(): AsyncIterable<ModelStreamEvent> {
        this.requestCount += 1
        yield { type: 'start' }
        if (this.requestCount === 1) {
          yield { type: 'tool_call_start', index: 0, id: 'ownership-call', name: 'runtime_tool' }
          yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' }
          yield { type: 'tool_call_end', index: 0 }
          yield { type: 'done', stopReason: 'tool_use' }
          return
        }
        yield { type: 'done', stopReason: 'stop' }
      }
    }

    const session = new AgentSession({
      sessionId: 'reject-mutation-owner',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model-1' },
      transport: new OwnershipMismatchTransport(),
      tools: [runtimeTool],
      prepareNextTurn: () => ({ model: { provider: 'test', model: 'model-2' } }),
      commitMutationBatch: (batch) => ({
        batchId: batch.id,
        sessionId: batch.sessionId,
        runId: batch.runId,
        turn: (batch.turn ?? 0) + 1,
        committedAt: batch.createdAt,
        replayed: true,
      }),
    })

    const result = await session.prompt('run')

    expect(result.reason).toBe('error')
    expect(result.errorMessage).toContain('ownership 不一致')
    expect(session.runtimeContext.model.model).toBe('model-1')
  })

  it('replays the exact pending Turn Save Point after an unknown listener outcome', async () => {
    const observed: Array<Extract<AgentEvent, { type: 'turn_save_point' }>['savePoint']> = []
    let rejectFirstSavePoint = true
    const session = new AgentSession({
      sessionId: 'stable-turn-save-point',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: new ResumeTransport(),
    })
    session.subscribe((event) => {
      if (event.type !== 'turn_save_point') return
      observed.push(structuredClone(event.savePoint))
      if (rejectFirstSavePoint) {
        rejectFirstSavePoint = false
        throw new Error('turn save point response unavailable')
      }
    })

    const result = await session.prompt('run')

    expect(result.reason).toBe('error')
    expect(observed).toHaveLength(2)
    expect(observed[1]).toEqual(observed[0])
  })

  it('acknowledges a committed batch before projection listeners and never commits it twice', async () => {
    class ProjectionFailureTransport implements ModelTransport {
      readonly requests: ModelRequest[] = []

      async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        const index = this.requests.push(structuredClone(request))
        yield { type: 'start' }
        if (index === 1) {
          yield { type: 'tool_call_start', index: 0, id: 'runtime-call', name: 'runtime_tool' }
          yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' }
          yield { type: 'tool_call_end', index: 0 }
          yield { type: 'done', stopReason: 'tool_use' }
          return
        }
        yield { type: 'done', stopReason: 'stop' }
      }
    }

    const committedIds: string[] = []
    let scheduled = false
    let rejectProjection = true
    const session = new AgentSession({
      sessionId: 'projection-failure',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model-1' },
      transport: new ProjectionFailureTransport(),
      tools: [runtimeTool],
      commitMutationBatch: (batch) => {
        committedIds.push(batch.id)
      },
    })
    session.subscribe(async (event) => {
      if (!scheduled && event.type === 'turn_end') {
        scheduled = true
        await session.scheduleRuntimeUpdate({
          model: { provider: 'test', model: 'model-2' },
        })
      }
      if (rejectProjection && event.type === 'runtime_model_update') {
        rejectProjection = false
        throw new Error('projection failed')
      }
    })

    const failed = await session.prompt('first run')
    expect(failed.reason).toBe('error')
    expect(failed.errorMessage).toBe('projection failed')
    expect(session.runtimeContext.model.model).toBe('model-2')
    expect(committedIds).toHaveLength(1)

    await session.prompt('next run')
    expect(committedIds).toHaveLength(1)
    expect(session.runtimeContext.model.model).toBe('model-2')
  })

  it('manages a validated active-tool registry while idle', () => {
    const session = new AgentSession({
      sessionId: 'active-tools',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: new ResumeTransport(),
      tools: [runtimeTool, deferredRuntimeTool],
      activeToolNames: ['runtime_tool'],
    })

    expect(session.getTools().map((tool) => tool.name)).toEqual([
      'runtime_tool',
      'deferred_runtime_tool',
    ])
    expect(session.getActiveTools().map((tool) => tool.name)).toEqual(['runtime_tool'])

    session.setActiveTools(['runtime_tool', 'deferred_runtime_tool'])
    expect(session.runtimeContext.activeToolNames).toEqual([
      'runtime_tool',
      'deferred_runtime_tool',
    ])

    expect(() => session.setActiveTools(['missing'])).toThrow('未知工具')
    expect(() => session.setActiveTools(['runtime_tool', 'runtime_tool'])).toThrow('重复工具')
    expect(() => session.setTools([runtimeTool, runtimeTool])).toThrow('重复工具')
  })

  it('reconstructs branch-local tool activation and rejects inconsistent history', () => {
    const history: AgentMessage[] = [
      { id: 'u1', role: 'user', content: 'discover', createdAt: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'runtime_tool', arguments: {}, rawArguments: '{}' }],
        stopReason: 'tool_use',
        createdAt: 2,
      },
      {
        id: 't1',
        role: 'tool',
        toolCallId: 'call-1',
        toolName: 'runtime_tool',
        content: 'loaded',
        addedToolNames: ['deferred_runtime_tool'],
        isError: false,
        createdAt: 3,
      },
    ]
    const createSession = (messages: AgentMessage[]) => new AgentSession({
      sessionId: 'branch-tools',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: new ResumeTransport(),
      tools: [runtimeTool, deferredRuntimeTool],
      activeToolNames: ['runtime_tool'],
      messages,
    })

    expect(createSession(history.slice(0, 1)).getActiveTools().map((tool) => tool.name))
      .toEqual(['runtime_tool'])
    expect(createSession(history).getActiveTools().map((tool) => tool.name))
      .toEqual(['runtime_tool', 'deferred_runtime_tool'])
    expect(() => new AgentSession({
      sessionId: 'invalid-history',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: new ResumeTransport(),
      tools: [runtimeTool],
      activeToolNames: ['runtime_tool'],
      messages: [{
        id: 'invalid-result',
        role: 'tool',
        toolCallId: 'call-1',
        toolName: 'runtime_tool',
        content: 'bad',
        addedToolNames: ['missing'],
        isError: false,
        createdAt: 1,
      }],
    })).toThrow('未知工具')
  })

  it('updates the idle runtime and uses the new model, reasoning, tools, and transport', async () => {
    const initialTransport = new ResumeTransport()
    const nextTransport = new ResumeTransport()
    const session = new AgentSession({
      sessionId: 'runtime-update',
      systemPrompt: 'initial system',
      model: { provider: 'initial', model: 'initial-model' },
      transport: initialTransport,
    })

    session.updateRuntime({
      systemPrompt: 'updated system',
      model: {
        provider: 'updated',
        model: 'updated-model',
        contextWindow: 256_000,
        maxOutputTokens: 8_192,
        supportsReasoning: true,
      },
      reasoning: { level: 'high', mode: 'effort' },
      tools: [runtimeTool],
      transport: nextTransport,
    })

    expect(session.runtimeContext).toMatchObject({
      systemPrompt: 'updated system',
      model: { provider: 'updated', model: 'updated-model', contextWindow: 256_000 },
      reasoning: { level: 'high', mode: 'effort' },
    })
    expect(session.runtimeContext.tools).toEqual([runtimeTool])

    await session.prompt('use the updated runtime')

    expect(initialTransport.requests).toHaveLength(0)
    expect(nextTransport.requests[0]).toMatchObject({
      systemPrompt: 'updated system',
      model: { provider: 'updated', model: 'updated-model', contextWindow: 256_000 },
      reasoning: { level: 'high', mode: 'effort' },
      maxOutputTokens: 8_192,
      tools: [{ name: 'runtime_tool' }],
    })
  })

  it('atomically applies runtime dependencies update and emits the dedicated event', async () => {
    const commits: Array<{ events: Array<{ type: string }> }> = []
    const session = new AgentSession({
      sessionId: 'runtime-deps',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: new ResumeTransport(),
      tools: [runtimeTool],
      activeToolNames: ['runtime_tool'],
      commitMutationBatch: (batch) => {
        commits.push(batch)
        return { batchId: batch.id, sessionId: batch.sessionId, committedAt: Date.now(), replayed: false }
      },
    })

    await session.updateRuntimeDependencies({
      previous: {
        systemPrompt: 'system',
        activeToolNames: ['runtime_tool'],
        runtimeManifest: { schemaVersion: 4, provider: {}, tools: [], hooks: [], skills: { schemaVersion: 1, skills: [] } },
      },
      current: {
        systemPrompt: 'system-reloaded',
        activeToolNames: ['runtime_tool'],
        runtimeManifest: { schemaVersion: 4, provider: {}, tools: [], hooks: [], skills: { schemaVersion: 1, skills: [] } },
      },
    })

    expect(commits).toHaveLength(1)
    expect(commits[0]?.events[0]?.type).toBe('runtime_dependencies_update')
    expect(session.runtimeContext).toMatchObject({
      systemPrompt: 'system-reloaded',
      activeToolNames: ['runtime_tool'],
    })
  })

  it('clears reasoning explicitly with null', () => {
    const session = new AgentSession({
      sessionId: 'runtime-clear-reasoning',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: new ResumeTransport(),
      reasoning: { level: 'medium', mode: 'effort' },
    })

    session.updateRuntime({ reasoning: null })

    expect(session.runtimeContext.reasoning).toBeUndefined()
  })

  it('rejects direct runtime updates while a run is active', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    const run = session.prompt('start')
    await transport.firstRequestStarted

    expect(() => session.updateRuntime({ systemPrompt: 'unsafe update' }))
      .toThrow('Agent 运行期间请使用 prepareNextTurn 更新 Runtime')

    transport.release()
    await run
    expect(session.runtimeContext.systemPrompt).toBe('system')
  })

  it('exposes the active signal, streaming message, pending tool calls, and final error state', async () => {
    let releaseTool = (): void => undefined
    let notifyToolStarted = (): void => undefined
    const toolStarted = new Promise<void>((resolve) => {
      notifyToolStarted = resolve
    })
    const toolReleased = new Promise<void>((resolve) => {
      releaseTool = resolve
    })
    let requestCount = 0
    const transport: ModelTransport = {
      async *stream(request) {
        requestCount += 1
        if (requestCount === 1) {
          yield { type: 'start' }
          yield { type: 'tool_call_start', index: 0, id: 'runtime-call', name: 'runtime_tool' }
          yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' }
          yield { type: 'tool_call_end', index: 0 }
          yield { type: 'done', stopReason: 'tool_use' }
          return
        }
        expect(request.messages.at(-1)?.role).toBe('tool')
        yield { type: 'start' }
        yield { type: 'text_delta', delta: 'finished' }
        yield { type: 'done', stopReason: 'stop' }
      },
    }
    let session!: AgentSession
    const tool: AgentTool = {
      ...runtimeTool,
      execute: async () => {
        expect(session.pendingToolCalls.has('runtime-call')).toBe(true)
        notifyToolStarted()
        await toolReleased
        return { content: 'tool result' }
      },
    }
    session = new AgentSession({
      sessionId: 'runtime-state',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      tools: [tool],
    })
    const listenerSignals: AbortSignal[] = []
    let streamedToolName = ''
    session.subscribe((event, signal) => {
      listenerSignals.push(signal)
      if (event.type === 'message_update' && event.update === 'tool_call') {
        const streaming = session.streamingMessage
        if (streaming?.role === 'assistant') streamedToolName = streaming.toolCalls[0]?.name ?? ''
      }
    })

    const run = session.prompt('inspect runtime state')
    await toolStarted

    expect(session.isRunning).toBe(true)
    expect(session.signal).toBeInstanceOf(AbortSignal)
    expect(streamedToolName).toBe('runtime_tool')
    expect(session.pendingToolCalls).toEqual(new Set(['runtime-call']))
    expect(listenerSignals.every((signal) => signal === session.signal)).toBe(true)

    releaseTool()
    await run

    expect(session.signal).toBeUndefined()
    expect(session.streamingMessage).toBeUndefined()
    expect(session.pendingToolCalls.size).toBe(0)
    expect(session.errorMessage).toBeUndefined()
  })

  it('queues a custom AgentMessage and converts it at the model boundary', async () => {
    const transport = new QueuedMessageTransport()
    const session = new AgentSession({
      sessionId: 'runtime-custom-queue',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      convertToModelMessages: async (messages) => messages.flatMap((message) => message.role === 'custom'
        ? [{
            id: message.id,
            role: 'user' as const,
            content: `queued:${message.content}`,
            createdAt: message.createdAt,
          }]
        : [message]),
    })
    const run = session.prompt('start')
    await transport.firstRequestStarted

    expect(await session.steer({
      id: 'queued-custom',
      role: 'custom',
      customType: 'runtime-note',
      content: 'remember this',
      data: { priority: 1 },
      createdAt: 2,
    })).toBe(true)
    expect(session.hasQueuedMessages()).toBe(true)

    transport.release()
    await run

    expect(transport.requests[1]?.messages.at(-1)).toMatchObject({
      id: 'queued-custom',
      role: 'user',
      content: 'queued:remember this',
    })
    expect(session.messages.some((message) => message.role === 'custom')).toBe(true)
    expect(session.hasQueuedMessages()).toBe(false)
  })
})

describe('AgentSession durable mutation journal', () => {
  it('does not resolve an enqueue API or expose the queue before its journal append is durable', async () => {
    let releaseAppend!: () => void
    const appendBarrier = new Promise<void>((resolve) => {
      releaseAppend = resolve
    })
    const journal = new RecordingMutationJournal(appendBarrier)
    const session = new AgentSession({
      sessionId: 'durable-enqueue',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: new ResumeTransport(),
      mutationJournal: journal,
    })

    let resolved = false
    const enqueue = session.nextTurn('persist before returning').then((accepted) => {
      resolved = true
      return accepted
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(resolved).toBe(false)
    expect(session.pendingNextTurnCount).toBe(0)
    expect(journal.entries.size).toBe(0)

    releaseAppend()
    expect(await enqueue).toBe(true)
    expect(session.pendingNextTurnCount).toBe(1)
    expect([...journal.entries.values()]).toEqual([
      expect.objectContaining({ kind: 'queue', queueKind: 'next-turn', status: 'pending' }),
    ])
  })

  it('marks a queued message consuming before removing it from the in-memory queue', async () => {
    const transport = new QueuedMessageTransport()
    let pendingAtTransition = -1
    let session!: AgentSession
    const journal = new RecordingMutationJournal(undefined, () => {
      pendingAtTransition = session.pendingSteeringCount
    })
    session = new AgentSession({
      sessionId: 'durable-drain',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      mutationJournal: journal,
    })
    let consumedJournalEntryId: string | undefined
    session.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'user'
        && event.message.content === 'durable steering') {
        consumedJournalEntryId = event.consumedJournalEntryId
      }
    })
    const run = session.prompt('start')
    await transport.firstRequestStarted
    expect(await session.steer('durable steering')).toBe(true)

    transport.release()
    await run

    expect(pendingAtTransition).toBe(1)
    expect(journal.operations.map((operation) => operation.split(':')[0])).toEqual([
      'append',
      'consuming',
    ])
    expect(consumedJournalEntryId).toBe([...journal.entries.keys()][0])
    expect([...journal.entries.values()][0]?.status).toBe('consuming')
  })

  it('keeps a queued message in memory when its durable discard fails', async () => {
    const journal = new RecordingMutationJournal()
    journal.discard = async () => {
      throw new Error('discard unavailable')
    }
    const session = new AgentSession({
      sessionId: 'durable-restore-failure',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: new ResumeTransport(),
      mutationJournal: journal,
    })
    await session.nextTurn('keep until discard commits')
    const messageId = session.queuedMessages[0]!.id

    await expect(session.restoreQueuedMessage(messageId)).rejects.toThrow('discard unavailable')
    expect(session.queuedMessages).toEqual([
      expect.objectContaining({ id: messageId, kind: 'next-turn' }),
    ])
  })

  it('derives a stable pending mutation batch ID and journal acknowledgement set after restart', async () => {
    class PendingMutationTransport implements ModelTransport {
      private requestCount = 0

      async *stream(): AsyncIterable<ModelStreamEvent> {
        this.requestCount += 1
        yield { type: 'start' }
        if (this.requestCount === 1) {
          yield { type: 'tool_call_start', index: 0, id: 'runtime-call', name: 'runtime_tool' }
          yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' }
          yield { type: 'tool_call_end', index: 0 }
          yield { type: 'done', stopReason: 'tool_use' }
          return
        }
        yield { type: 'done', stopReason: 'stop' }
      }
    }

    const entries: AgentSessionJournalEntry[] = [
      {
        id: 'journal-message',
        sessionId: 'stable-journal-session',
        sequence: 4,
        kind: 'message_append',
        message: { id: 'restored-note', role: 'user', content: 'restored', createdAt: 4 },
        status: 'pending',
        createdAt: 4,
      },
      {
        id: 'journal-runtime',
        sessionId: 'stable-journal-session',
        sequence: 5,
        kind: 'runtime_update',
        update: { systemPrompt: 'restored system' },
        status: 'pending',
        createdAt: 5,
      },
    ]
    const batchIds: string[] = []
    const runOnce = async (failCommit: boolean): Promise<void> => {
      const journal = new RecordingMutationJournal()
      for (const entry of entries) journal.entries.set(entry.id, structuredClone(entry))
      const session = new AgentSession({
        sessionId: 'stable-journal-session',
        systemPrompt: 'system',
        model: { provider: 'test', model: 'model' },
        transport: new PendingMutationTransport(),
        tools: [runtimeTool],
        journalEntries: entries,
        mutationJournal: journal,
        commitMutationBatch: (batch) => {
          batchIds.push(batch.id)
          expect(batch.journalEntryIds).toEqual(['journal-message', 'journal-runtime'])
          if (failCommit) throw new Error('unknown commit outcome')
        },
      })
      const result = await session.prompt('run')
      expect(result.reason).toBe(failCommit ? 'error' : 'completed')
    }

    await runOnce(true)
    await runOnce(false)
    expect(batchIds).toEqual([
      'mutation:journal-message',
      'mutation:journal-message',
      'mutation:journal-message',
    ])
  })
})

describe('AgentSession queued messages', () => {
  it('delivers steering before the next model request and exposes pending counts', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    const run = session.prompt('start')
    await transport.firstRequestStarted

    expect(session.canQueueMessages).toBe(true)
    expect(await session.steer('change direction')).toBe(true)
    expect(session.pendingSteeringCount).toBe(1)
    expect(session.pendingFollowUpCount).toBe(0)

    transport.release()
    const result = await run

    expect(result.reason).toBe('completed')
    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'change direction',
    })
    expect(session.pendingSteeringCount).toBe(0)
    expect(session.canQueueMessages).toBe(false)
  })

  it('delivers follow-up only after the active task would otherwise finish', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    const run = session.prompt('start')
    await transport.firstRequestStarted

    expect(await session.followUp('one more thing')).toBe(true)
    expect(session.pendingFollowUpCount).toBe(1)

    transport.release()
    await run

    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[1]?.messages.map((message) => message.content)).toEqual([
      'start',
      'answer-1',
      'one more thing',
    ])
    expect(session.pendingFollowUpCount).toBe(0)
  })

  it('clears only messages that have not entered the model context', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    const run = session.prompt('start')
    await transport.firstRequestStarted

    expect(await session.steer('queued steering')).toBe(true)
    expect(await session.followUp('queued follow-up')).toBe(true)
    await session.clearQueuedMessages()
    expect(session.pendingSteeringCount).toBe(0)
    expect(session.pendingFollowUpCount).toBe(0)

    transport.release()
    await run

    expect(transport.requests).toHaveLength(1)
    expect(session.messages.some((message) => message.role === 'user' && message.content.includes('queued'))).toBe(false)
  })

  it('exposes queued body previews and restores one message for editing', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    const run = session.prompt('start')
    await transport.firstRequestStarted

    expect(await session.steer('inspect the failing test')).toBe(true)
    expect(await session.followUp('then summarize the fix')).toBe(true)
    expect(session.queuedMessages.map(({ kind, content }) => ({ kind, content }))).toEqual([
      { kind: 'steering', content: 'inspect the failing test' },
      { kind: 'follow-up', content: 'then summarize the fix' },
    ])
    const restored = await session.restoreQueuedMessage(session.queuedMessages[0]!.id)
    expect(restored).toMatchObject({ kind: 'steering', content: 'inspect the failing test' })
    expect(session.pendingSteeringCount).toBe(0)
    expect(session.pendingFollowUpCount).toBe(1)

    await session.clearQueuedMessages()
    session.abort()
    transport.release()
    await run
  })

  it('supports one-at-a-time and all steering delivery modes', async () => {
    const oneTransport = new QueuedMessageTransport()
    const oneSession = createQueuedMessageSession(oneTransport)
    const oneRun = oneSession.prompt('start')
    await oneTransport.firstRequestStarted
    await oneSession.steer('first')
    await oneSession.steer('second')
    oneTransport.release()
    await oneRun

    expect(oneTransport.requests).toHaveLength(3)
    expect(oneTransport.requests[1]?.messages.at(-1)?.content).toBe('first')
    expect(oneTransport.requests[2]?.messages.at(-1)?.content).toBe('second')

    const allTransport = new QueuedMessageTransport()
    const allSession = createQueuedMessageSession(allTransport, { steeringMode: 'all' })
    const allRun = allSession.prompt('start')
    await allTransport.firstRequestStarted
    await allSession.steer('first')
    await allSession.steer('second')
    allTransport.release()
    await allRun

    expect(allTransport.requests).toHaveLength(2)
    expect(allTransport.requests[1]?.messages.slice(-2).map((message) => message.content)).toEqual([
      'first',
      'second',
    ])
  })

  it('keeps stopped queued messages recoverable instead of carrying them into the next run', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    const run = session.prompt('start')
    await transport.firstRequestStarted
    await session.steer('do not lose this')
    await session.followUp('or this follow-up')

    session.abort()
    transport.release()
    await run
    const recovered = await session.takeQueuedMessages()

    expect(recovered.map(({ kind, content }) => ({ kind, content }))).toEqual([
      { kind: 'steering', content: 'do not lose this' },
      { kind: 'follow-up', content: 'or this follow-up' },
    ])
    expect(session.pendingSteeringCount).toBe(0)
    expect(session.pendingFollowUpCount).toBe(0)
  })

  it('keeps recovered drafts durable until explicit composer hand-off', async () => {
    const transport = new QueuedMessageTransport()
    const journal = new RecordingMutationJournal()
    const session = new AgentSession({
      sessionId: 'durable-recovered-draft',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      mutationJournal: journal,
    })
    const run = session.prompt('start')
    await transport.firstRequestStarted
    await session.steer('survive a second crash')

    const abort = session.abort()
    transport.release()
    const settlement = await abort
    await run

    expect(settlement).toMatchObject({
      hadActiveRun: true,
      settled: true,
      durable: true,
      reason: 'aborted',
      queues: { recovered: [expect.objectContaining({ content: 'survive a second crash' })] },
    })
    const recoveredEntry = [...journal.entries.values()].find((entry) => entry.kind === 'queue')
    expect(recoveredEntry).toMatchObject({ status: 'pending', recoveredAt: expect.any(Number) })
    expect(journal.operations.map((operation) => operation.split(':')[0])).toContain('recovered')
    expect(await session.takeQueuedMessages()).toEqual([
      expect.objectContaining({ content: 'survive a second crash' }),
    ])
    expect(recoveredEntry?.status).toBe('pending')

    const restartedJournal = new RecordingMutationJournal()
    if (!recoveredEntry || recoveredEntry.kind !== 'queue') throw new Error('missing recovered entry')
    restartedJournal.entries.set(recoveredEntry.id, structuredClone(recoveredEntry))
    const restarted = new AgentSession({
      sessionId: 'durable-recovered-draft',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: new ResumeTransport(),
      mutationJournal: restartedJournal,
      journalEntries: [recoveredEntry],
    })
    expect(restarted.pendingSteeringCount).toBe(0)
    expect(restarted.recoveredMessages).toEqual([
      expect.objectContaining({ content: 'survive a second crash' }),
    ])

    const restored = await restarted.restoreQueuedMessage(recoveredEntry.message.id)
    expect(restored?.content).toBe('survive a second crash')
    expect(restarted.recoveredMessages).toEqual([])
    expect(restartedJournal.entries.get(recoveredEntry.id)?.status).toBe('discarded')
  })

  it('requeues a message drained just before an abort but never injected into context', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    const run = session.prompt('start')

    expect(await session.steer('drained before abort')).toBe(true)
    session.abort()
    await run

    expect(transport.requests).toHaveLength(0)
    expect(await session.takeQueuedMessages()).toEqual([
      expect.objectContaining({ kind: 'steering', content: 'drained before abort' }),
    ])
    expect(session.messages.some((message) => message.content === 'drained before abort')).toBe(false)
  })

  it('keeps an unconsumed draft when agent_end persistence fails', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    session.subscribe((event) => {
      if (event.type === 'agent_end') throw new Error('persistence failed')
    })
    const run = session.prompt('start')

    expect(await session.steer('recover despite event failure')).toBe(true)
    session.abort()
    await expect(run).rejects.toThrow('persistence failed')

    expect(await session.takeQueuedMessages()).toEqual([
      expect.objectContaining({
        kind: 'steering',
        content: 'recover despite event failure',
      }),
    ])
  })

  it('preserves a drained steering message while clearing messages still queued behind it', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    session.subscribe(async (event) => {
      if (
        event.type === 'message_start'
        && event.message.role === 'user'
        && event.message.content === 'already drained'
      ) {
        await session.clearQueuedMessages()
      }
    })
    const run = session.prompt('start')
    await transport.firstRequestStarted

    expect(await session.steer('already drained')).toBe(true)
    expect(await session.steer('still queued')).toBe(true)
    expect(session.pendingSteeringCount).toBe(2)

    transport.release()
    await run

    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[1]?.messages.map((message) => message.content)).toEqual([
      'start',
      'answer-1',
      'already drained',
    ])
    expect(session.messages.some((message) => message.role === 'user' && message.content === 'already drained')).toBe(true)
    expect(session.messages.some((message) => message.role === 'user' && message.content === 'still queued')).toBe(false)
    expect(session.pendingSteeringCount).toBe(0)
  })

  it('closes the queue before awaited agent_end listeners settle', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    let notifyAgentEnd!: () => void
    let releaseAgentEnd!: () => void
    const agentEndStarted = new Promise<void>((resolve) => {
      notifyAgentEnd = resolve
    })
    const agentEndReleased = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve
    })
    const lifecycle: AgentEvent['type'][] = []
    session.subscribe((event) => {
      lifecycle.push(event.type)
      if (event.type !== 'agent_end') return
      notifyAgentEnd()
      return agentEndReleased
    })

    const run = session.prompt('start')
    await transport.firstRequestStarted
    transport.release()
    await agentEndStarted

    expect(session.isRunning).toBe(true)
    expect(session.canQueueMessages).toBe(false)
    expect(await session.steer('too late')).toBe(false)
    expect(await session.followUp('also too late')).toBe(false)

    const idle = session.waitForIdle()
    releaseAgentEnd()
    await idle
    expect(session.isRunning).toBe(false)
    await run
    expect(lifecycle[lifecycle.length - 1]).toBe('agent_settled')
    expect(session.savePoint).toMatchObject({
      sessionId: 'queued-message-session',
      messageCount: 2,
    })
  })
})

describe('AgentSession context compaction', () => {
  it('exposes compaction lifecycle hooks through the first-party runtime', async () => {
    const transport = new CompactingTransport()
    const lifecycle: string[] = []
    const session = new AgentSession({
      sessionId: 'session-hooked-compaction',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      messages: [
        { id: 'u-old', role: 'user', content: 'old goal', createdAt: 1 },
        { id: 'a-old', role: 'assistant', content: 'old answer', toolCalls: [], stopReason: 'stop', createdAt: 2 },
      ],
      beforeCompaction: () => ({
        replacement: { summary: 'runtime replacement', throughMessageId: 'u-old' },
      }),
      afterCompaction: ({ replaced, result }) => {
        lifecycle.push(`${replaced}:${result.checkpoint.throughMessageId}`)
      },
    })

    await session.compact()

    expect(transport.requests).toHaveLength(0)
    expect(lifecycle).toEqual(['true:u-old'])
    expect(session.checkpoint?.summary).toContain('runtime replacement')
  })

  it('persists a checkpoint barrier before using the compacted model projection', async () => {
    const transport = new CompactingTransport()
    const history: AgentMessage[] = [
      { id: 'u-old', role: 'user', content: 'old goal', createdAt: 1 },
      { id: 'a-old', role: 'assistant', content: 'old answer', toolCalls: [], stopReason: 'stop', createdAt: 2 },
    ]
    const events: string[] = []
    const session = new AgentSession({
      sessionId: 'session-1',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      messages: history,
      contextWindow: 1_000_000,
    })
    session.subscribe(async (event) => {
      if (event.type === 'compaction_end' && event.checkpoint) {
        await Promise.resolve()
        events.push(`persisted:${event.checkpoint.id}`)
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        events.push('assistant:end')
      }
    })

    await session.prompt('new prompt')

    expect(session.checkpoint).not.toBeNull()
    expect(events[0]).toMatch(/^persisted:/u)
    expect(events).toContain('assistant:end')
    const modelRequest = transport.requests.find((request) => request.systemPrompt === 'system')
    expect(modelRequest?.messages[0]?.id).toMatch(/^context-summary:/u)
    expect(session.messages.map((message) => message.id)).toEqual([
      'u-old',
      'a-old',
      expect.stringMatching(/^message-/u),
      expect.stringMatching(/^message-/u),
    ])
    expect(session.messages.some((message) => message.id.startsWith('context-summary:'))).toBe(false)
  })

  it('compacts and retries an overflow once without replaying the user prompt', async () => {
    const transport = new OverflowTransport()
    const reasons: string[] = []
    const queueLifecycle: boolean[] = []
    const session = new AgentSession({
      sessionId: 'session-overflow',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      messages: [
        { id: 'u-old', role: 'user', content: 'old', createdAt: 1 },
        { id: 'a-old', role: 'assistant', content: 'old answer', toolCalls: [], stopReason: 'stop', createdAt: 2 },
      ],
      contextWindow: 128_000,
    })
    session.subscribe((event) => {
      if (event.type === 'compaction_start') reasons.push(event.reason)
      if (event.type === 'agent_start' || event.type === 'agent_end') {
        queueLifecycle.push(session.canQueueMessages)
      }
    })

    const result = await session.prompt('new prompt')

    expect(result.reason).toBe('completed')
    expect(reasons).toEqual(['overflow'])
    expect(queueLifecycle).toEqual([true, false, true, false])
    expect(session.checkpoint?.reason).toBe('overflow')
    expect(session.checkpoint?.excludedMessageIds).toHaveLength(1)
    expect(session.messages.filter((message) => message.role === 'user' && message.content === 'new prompt')).toHaveLength(1)
    expect(session.messages.some((message) => message.role === 'assistant' && message.errorMessage?.includes('context window'))).toBe(true)
    const retriedRequest = transport.requests.filter((request) => request.systemPrompt === 'system')[1]
    expect(retriedRequest?.messages.some((message) => message.role === 'assistant' && message.stopReason === 'error')).toBe(false)
  })

  it('does not retry when the recovered request overflows a second time', async () => {
    const transport = new OverflowTransport(true)
    const reasons: string[] = []
    const session = new AgentSession({
      sessionId: 'session-repeat-overflow',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      messages: [
        { id: 'u-old', role: 'user', content: 'old', createdAt: 1 },
        { id: 'a-old', role: 'assistant', content: 'old answer', toolCalls: [], stopReason: 'stop', createdAt: 2 },
      ],
      contextWindow: 128_000,
    })
    session.subscribe((event) => {
      if (event.type === 'compaction_start') reasons.push(event.reason)
    })

    const result = await session.prompt('new prompt')

    expect(result.reason).toBe('error')
    expect(reasons).toEqual(['overflow'])
    expect(transport.requests.filter((request) => request.systemPrompt === 'system')).toHaveLength(2)
    expect(session.messages.filter((message) =>
      message.role === 'assistant' && message.errorMessage?.includes('context window'),
    )).toHaveLength(2)
  })

  it('does not resend an overflowed request when no complete group can be compacted', async () => {
    const transport = new OverflowTransport()
    const reasons: string[] = []
    const session = new AgentSession({
      sessionId: 'session-no-compactable-history',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      contextWindow: 128_000,
    })
    session.subscribe((event) => {
      if (event.type === 'compaction_start') reasons.push(event.reason)
    })

    const result = await session.prompt('only prompt')

    expect(result.reason).toBe('error')
    expect(result.errorMessage).toContain('没有足够的完整消息组')
    expect(reasons).toEqual(['overflow'])
    expect(transport.requests.filter((request) => request.systemPrompt === 'system')).toHaveLength(1)
    expect(session.checkpoint).toBeNull()
  })
})

describe('AgentSession branch continuation', () => {
  it('continues from copied context without replaying historical tools or adding a user prompt', async () => {
    const transport = new ResumeTransport()
    const toolExecutions: string[] = []
    const session = new AgentSession({
      sessionId: 'retry-branch',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      messages: [
        { id: 'u1', role: 'user', content: 'inspect', createdAt: 1 },
        {
          id: 'a1',
          role: 'assistant',
          content: 'reading',
          toolCalls: [{ id: 'call-1', name: 'read', arguments: {}, rawArguments: '{}' }],
          stopReason: 'tool_use',
          createdAt: 2,
        },
        {
          id: 't1',
          role: 'tool',
          toolCallId: 'call-1',
          toolName: 'read',
          content: 'contents',
          isError: false,
          createdAt: 3,
        },
      ],
    })
    session.subscribe((event) => {
      if (event.type === 'tool_execution_start') toolExecutions.push(event.toolCallId)
    })

    const result = await session.continue()

    expect(result.reason).toBe('completed')
    expect(result.newMessages).toHaveLength(1)
    expect(result.newMessages[0]).toMatchObject({ role: 'assistant', content: 'regenerated answer' })
    expect(transport.requests[0]?.messages.map((message) => message.id)).toEqual(['u1', 'a1', 't1'])
    expect(toolExecutions).toEqual([])
  })

  it('anchors automatic compaction to copied branch message ids', async () => {
    const transport = new CompactingTransport()
    const sourceHistory: AgentMessage[] = [
      { id: 'source-u1', role: 'user', content: 'old goal', createdAt: 1 },
      { id: 'source-a1', role: 'assistant', content: 'old answer', toolCalls: [], stopReason: 'stop', createdAt: 2 },
      { id: 'source-u2', role: 'user', content: 'try again', createdAt: 3 },
    ]
    const copiedHistory = createBranchMessageCopies(sourceHistory, 'source-u2')
      .map((copy) => copy.message)
    const session = new AgentSession({
      sessionId: 'retry-compaction',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      messages: copiedHistory,
      contextWindow: 1_000_000,
    })

    await session.continue()

    expect(session.checkpoint?.reason).toBe('byte_threshold')
    expect(copiedHistory.map((message) => message.id)).toContain(session.checkpoint?.throughMessageId)
    expect(sourceHistory.map((message) => message.id)).not.toContain(session.checkpoint?.throughMessageId)
    expect(session.checkpoint?.sessionId).toBe('retry-compaction')
  })
})
