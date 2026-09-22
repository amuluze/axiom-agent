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
import { describe, expect, it, vi } from 'vitest'
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
  modes: {
    steeringMode?: 'one-at-a-time' | 'all'
    followUpMode?: 'one-at-a-time' | 'all'
    autoDrain?: boolean
  } = {},
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

    expect((await session.nextTurn('carry into normal prompt')).accepted).toBe(true)
    expect((await session.nextTurn('second queued context')).accepted).toBe(true)
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

  it('auto-resolves a stale pending idle mutation via idempotent replay when a different operation arrives', async () => {
    const callIds: string[] = []
    const session = new AgentSession({
      sessionId: 'stale-idle-replay',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: new ResumeTransport(),
      commitMutationBatch: async (batch) => {
        callIds.push(batch.id)
        // commitThenApply 内置两次尝试：失败两次才会留下挂起 batch。
        if (callIds.length <= 2) {
          throw new Error('idle commit response unavailable')
        }
        return {
          batchId: batch.id,
          sessionId: batch.sessionId,
          committedAt: batch.createdAt,
          replayed: false,
        }
      },
    })
    const message: AgentMessage = {
      id: 'stale-idle-message',
      role: 'user',
      content: 'persist once',
      createdAt: 1,
    }

    await expect(session.appendMessage(message)).rejects.toThrow('response unavailable')
    expect(session.messages).toEqual([])

    // 不同的新操作不再被「结果未知」卡死：先幂等重放挂起 batch（补跑原 apply），
    // 再提交并应用新操作。
    await session.updateRuntime({ systemPrompt: 'updated system' })

    expect(session.messages).toEqual([message])
    expect(session.runtimeContext.systemPrompt).toBe('updated system')
    // 调用序列：A 失败×2 → A 幂等重放成功（补跑原 apply）→ 新 batch B 提交。
    expect(callIds).toHaveLength(4)
    expect(callIds[1]).toBe(callIds[0])
    expect(callIds[2]).toBe(callIds[0])
    expect(callIds[3]).not.toBe(callIds[0])
  })

  it('drops a never-durable pending idle mutation when its replay fails and lets the new operation proceed', async () => {
    let staleBatchId: string | undefined
    const session = new AgentSession({
      sessionId: 'stale-idle-drop',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: new ResumeTransport(),
      commitMutationBatch: async (batch) => {
        if (!staleBatchId) staleBatchId = batch.id
        if (batch.id === staleBatchId) throw new Error('会话不存在或已被删除')
        return {
          batchId: batch.id,
          sessionId: batch.sessionId,
          committedAt: batch.createdAt,
          replayed: false,
        }
      },
    })
    const message: AgentMessage = {
      id: 'stale-idle-message',
      role: 'user',
      content: 'persist once',
      createdAt: 1,
    }

    await expect(session.appendMessage(message)).rejects.toThrow('会话不存在')
    expect(session.messages).toEqual([])

    // 重放失败证明挂起 batch 从未持久化：安全丢弃并放行新操作。
    await session.updateRuntime({ systemPrompt: 'updated system' })

    expect(session.messages).toEqual([])
    expect(session.runtimeContext.systemPrompt).toBe('updated system')
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

    expect((await session.steer({
      id: 'queued-custom',
      role: 'custom',
      customType: 'runtime-note',
      content: 'remember this',
      data: { priority: 1 },
      createdAt: 2,
    })).accepted).toBe(true)
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
    expect((await enqueue).accepted).toBe(true)
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
    expect((await session.steer('durable steering')).accepted).toBe(true)

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
    expect((await session.steer('change direction')).accepted).toBe(true)
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

    expect((await session.followUp('one more thing')).accepted).toBe(true)
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

    expect((await session.steer('queued steering')).accepted).toBe(true)
    expect((await session.followUp('queued follow-up')).accepted).toBe(true)
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

    expect((await session.steer('inspect the failing test')).accepted).toBe(true)
    expect((await session.followUp('then summarize the fix')).accepted).toBe(true)
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

  it('follows a steering steer by a plain reply without re-answering the original task', async () => {
    // 行为断言（而非「注入了 steering」这类内部实现断言）：被 steering 引导后的后续轮
    // 必须只面向 steering 响应，不得重新回答被中断的原始任务——否则用户会感觉
    // 「我发的补充又被当成新问题从头做了一遍」。
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    const run = session.prompt('start')
    await transport.firstRequestStarted

    expect((await session.steer('actually use the component test style instead')).accepted)
      .toBe(true)
    transport.release()
    await run

    expect(transport.requests).toHaveLength(2)
    const followUp = transport.requests[1]!
    // steering 进入了模型上下文，且是最后一个用户消息。
    expect(followUp.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'actually use the component test style instead',
    })
    // 引导轮不再有新的工具调用（否则就是「被引导后又跑去做原任务」）。
    expect(followUp.tools).toEqual([])
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

  it('holds the queue at turn boundaries when autoDrain is off and only releases a manually sent item', async () => {
    // 对齐 ZCode autoDrain=false：turn 边界不自动出队，队列项原地待命；
    // sendQueuedNow 把目标项提升到 steering 队首并放行一次（不依赖全局开关）。
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport, { autoDrain: false })
    const run = session.prompt('start')
    await transport.firstRequestStarted

    expect((await session.steer('queued while paused')).accepted).toBe(true)
    expect((await session.followUp('also paused')).accepted).toBe(true)
    expect(session.queuedMessages).toHaveLength(2)

    // 自动发送关闭时 run 正常结束（队列不参与续跑），队列项仍留在内存队列。
    transport.release()
    await run

    expect(transport.requests).toHaveLength(1)
    expect(session.queuedMessages.map((message) => message.content)).toEqual([
      'queued while paused',
      'also paused',
    ])
    expect(session.recoveredMessages).toEqual([])
  })

  it('releases exactly the targeted item on sendQueuedNow and keeps the rest queued', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport, { autoDrain: false })
    const run = session.prompt('start')
    await transport.firstRequestStarted

    expect((await session.steer('first')).accepted).toBe(true)
    expect((await session.followUp('second')).accepted).toBe(true)
    const second = session.queuedMessages.find((message) => message.content === 'second')!

    // 放行后目标项被提升到 steering 队首（不再按原 follow-up 顺序）。
    expect(await session.sendQueuedNow(second.id)).toEqual({ accepted: true, id: second.id })
    expect(session.queuedMessages.map((message) => message.kind)).toEqual(['steering', 'steering'])
    // 武装目标随放行暴露：UI 据此渲染「已放行，等待注入」的即时反馈。
    expect(session.armedQueueMessageId).toBe(second.id)

    transport.release()
    await run

    // 消费后武装目标清空；只有被放行的那条进入模型上下文，另一条仍留在队列（不自动跟进）。
    expect(session.armedQueueMessageId).toBeUndefined()
    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[1]?.messages.at(-1)?.content).toBe('second')
    expect(session.queuedMessages.map((message) => message.content)).toEqual(['first'])
  })

  it('clears the armed marker when an aborted run recovers leftovers as drafts (autoDrain on)', async () => {
    // 回归：autoDrain 开启时中断结算把残留搬运为恢复草稿，armed id 指向的已不是
    // 队列项——残留会让 armedQueueMessageId 投影携带跨 run 的脏目标。
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    const run = session.prompt('start')
    await transport.firstRequestStarted

    await session.steer('leftover-a')
    const armedAcceptance = await session.steer('leftover-b')
    if (!armedAcceptance.accepted) throw new Error('steer should be accepted')
    expect(await session.sendQueuedNow(armedAcceptance.id)).toEqual({
      accepted: true,
      id: armedAcceptance.id,
    })
    expect(session.armedQueueMessageId).toBe(armedAcceptance.id)

    session.abort()
    transport.release()
    await run

    expect(session.armedQueueMessageId).toBeUndefined()
    expect(session.recoveredMessages).toHaveLength(2)
  })

  it('exposes current queue modes for host-side settings reconciliation', () => {
    const session = createQueuedMessageSession(new QueuedMessageTransport(), {
      steeringMode: 'all',
      followUpMode: 'one-at-a-time',
      autoDrain: false,
    })
    expect(session.queueModes).toEqual({
      steering: 'all',
      followUp: 'one-at-a-time',
      autoDrain: false,
    })
    session.setQueueModes('one-at-a-time', 'all')
    session.setAutoDrain(true)
    expect(session.queueModes).toEqual({
      steering: 'one-at-a-time',
      followUp: 'all',
      autoDrain: true,
    })
  })

  it('reindexes queue orders when midpoint insertion exhausts float precision', async () => {
    // 回归：同两个邻居之间反复中点插值（每次插在上一个插入项与队首之间）约 52 次
    // 后触及 double 精度极限，order 不再严格介于两邻之间——此前会静默插错位置，
    // 现在触发整型重排兜底，插入位置始终与用户意图一致。
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport, { autoDrain: false })
    const run = session.prompt('start')
    await transport.firstRequestStarted

    expect((await session.steer('anchor-a')).accepted).toBe(true)
    expect((await session.steer('anchor-b')).accepted).toBe(true)
    const anchorA = session.queuedMessages[0]!.id

    for (let index = 0; index < 60; index += 1) {
      const accepted = await session.steer(`nested-${index}`)
      if (!accepted.accepted) throw new Error('steer should be accepted')
      const moved = await session.moveQueuedMessage(accepted.id, {
        kind: 'steering',
        placement: { position: 'below', anchorId: anchorA },
      })
      expect(moved.updated).toBe(true)
    }

    transport.release()
    const result = await run
    expect(result.reason).toBe('completed')

    const display = session.queuedMessages.map((message) => message.content)
    expect(display[0]).toBe('anchor-a')
    expect(display[1]).toBe('nested-59')
    expect(display[60]).toBe('nested-0')
    expect(display.at(-1)).toBe('anchor-b')
    expect(display).toHaveLength(62)
  })

  it('releases only the targeted item under the all delivery mode and keeps the rest queued', async () => {
    // 模式 `all` 的批量语义属于自动出队；逐条放行必须只消费一条，否则「立即发送这一条」
    // 会连带把队列整批塞进当前上下文。
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport, {
      steeringMode: 'all',
      autoDrain: false,
    })
    const run = session.prompt('start')
    await transport.firstRequestStarted

    expect((await session.steer('first')).accepted).toBe(true)
    expect((await session.steer('second')).accepted).toBe(true)
    const first = session.queuedMessages[0]!
    expect(await session.sendQueuedNow(first.id)).toEqual({ accepted: true, id: first.id })

    transport.release()
    await run

    // 第二轮的上下文只多出被放行的那一条（不是整批）。
    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[1]?.messages.map((message) => message.content)).toEqual([
      'start',
      'answer-1',
      'first',
    ])
    expect(session.queuedMessages.map((message) => message.content)).toEqual(['second'])
  })

  it('resumes automatic draining after setAutoDrain(true) and rejects sendQueuedNow while idle', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport, { autoDrain: false })
    const run = session.prompt('start')
    await transport.firstRequestStarted
    expect((await session.steer('resumed')).accepted).toBe(true)

    // 暂停期间队列项不出队；切换 autoDrain 作废悬挂的武装目标（方向切换后不得注入旧目标）。
    const idleArm = await session.sendQueuedNow()
    expect(idleArm).toEqual({ accepted: true, id: session.queuedMessages[0]?.id })
    session.setAutoDrain(true)
    expect(session.armedQueueMessageId).toBeUndefined()

    // 切回自动后按常规 turn 边界消费。
    transport.release()
    await run

    expect(transport.requests.at(-1)?.messages.at(-1)?.content).toBe('resumed')
    expect(session.queuedMessages).toEqual([])

    // 未运行时没有可注入的 run：立即发送按 runtime-not-accepting 拒绝（idle 路径由 store 层承担）。
    expect(await session.sendQueuedNow()).toEqual({
      accepted: false,
      reason: 'runtime-not-accepting',
    })
  })

  it('rejects queue writes with a reason instead of reporting a silent failure', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    const run = session.prompt('start')
    await transport.firstRequestStarted

    // 空输入：createQueuedMessage 无内容可入队。
    expect(await session.steer('   ')).toEqual({ accepted: false, reason: 'empty-input' })

    // 队列项不存在：编辑/移动/删除都按 unknown-message 拒绝（消息可能已被注入）。
    expect(await session.editQueuedMessage('missing', 'text')).toEqual({
      updated: false,
      reason: 'unknown-message',
    })
    expect(await session.moveQueuedMessage('missing', {      kind: 'steering',
      placement: { position: 'top' },
    })).toEqual({ updated: false, reason: 'unknown-message' })
    expect(await session.deleteQueuedMessage('missing')).toEqual({
      updated: false,
      reason: 'unknown-message',
    })

    session.abort()
    transport.release()
    await run

    // run 结束后结算窗口关闭：入队被拒（不再是「排了但没投递」的静默失败）。
    expect(await session.steer('too late')).toEqual({
      accepted: false,
      reason: 'runtime-not-accepting',
    })
  })

  it('edits a queued message in place, keeping its kind, position, images and id', async () => {
    const journal = new RecordingMutationJournal()
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    // 带图片的会话（journal 版便于核对 durable 重写）。
    const journalSession = new AgentSession({
      sessionId: 'queued-message-session',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      mutationJournal: journal,
    })
    void session
    const run = journalSession.prompt('start')
    await transport.firstRequestStarted

    const image = { type: 'image' as const, source: { type: 'base64' as const, mediaType: 'image/png', data: 'cG5n' } }
    await journalSession.steer('', [image])
    await journalSession.followUp('second')
    const [first] = journalSession.queuedMessages
    const originalEntryId = journal.entries.get([...journal.entries.keys()][0]!)?.id

    const result = await journalSession.editQueuedMessage(first!.id, 'edited text')
    expect(result).toEqual({ updated: true, messageId: first!.id, kind: 'steering' })

    // 编辑保留：id、kind、顺序位置与图片块。
    expect(journalSession.queuedMessages.map(({ id, kind, content }) => ({ id, kind, content }))).toEqual([
      { id: first!.id, kind: 'steering', content: 'edited text' },
      { id: journalSession.queuedMessages[1]!.id, kind: 'follow-up', content: 'second' },
    ])
    expect(journalSession.queuedMessages[0]!.images).toEqual([image])

    // durable 重写：新 entry 承载编辑后的 payload，旧 entry 已 discarded，同一 message.id
    // 不会留下两个 pending（恢复时会命中重复 ID 校验）。
    const pendingQueueEntries = [...journal.entries.values()].filter(
      (entry) => entry.kind === 'queue' && entry.status === 'pending',
    )
    expect(pendingQueueEntries).toHaveLength(2)
    const rewritten = pendingQueueEntries.find(
      (entry) => entry.kind === 'queue' && entry.message.id === first!.id,
    )
    expect(rewritten).toMatchObject({ message: { id: first!.id, content: 'edited text' } })
    expect((rewritten as { order?: number }).order).toBeDefined()
    const previous = [...journal.entries.values()].find((entry) => entry.id === originalEntryId)
    expect(previous?.status).toBe('discarded')

    journalSession.abort()
    transport.release()
    await run
  })

  it('reorders within a queue and promotes across queues against the displayed order', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    const run = session.prompt('start')
    await transport.firstRequestStarted

    await session.steer('steer-a')
    await session.followUp('follow-a')
    await session.followUp('follow-b')
    const contents = () => session.queuedMessages.map((message) => message.content)
    expect(contents()).toEqual(['steer-a', 'follow-a', 'follow-b'])

    // 同队列重排：follow-b 移到队首（同 kind，位置变）。
    const followB = session.queuedMessages.find((message) => message.content === 'follow-b')!
    expect(await session.moveQueuedMessage(followB.id, {
      kind: 'follow-up',
      placement: { position: 'top' },
    })).toEqual({ updated: true, messageId: followB.id, kind: 'follow-up' })
    expect(contents()).toEqual(['follow-b', 'steer-a', 'follow-a'])

    // 跨队列提升：follow-b → steering 队首（下一个 turn 边界即注入）。
    expect(await session.promoteQueuedMessage(followB.id)).toEqual({
      updated: true,
      messageId: followB.id,
      kind: 'steering',
    })
    expect(contents()).toEqual(['follow-b', 'steer-a', 'follow-a'])
    expect(session.queuedMessages[0]!.kind).toBe('steering')
    expect(session.pendingSteeringCount).toBe(2)
    expect(session.pendingFollowUpCount).toBe(1)

    // 删除：单条移除且不影响其它项。
    const steerA = session.queuedMessages.find((message) => message.content === 'steer-a')!
    expect(await session.deleteQueuedMessage(steerA.id)).toEqual({
      updated: true,
      messageId: steerA.id,
      kind: 'steering',
    })
    expect(contents()).toEqual(['follow-b', 'follow-a'])

    session.abort()
    transport.release()
    await run
  })

  it('promotes a queued follow-up so it drains on the next turn instead of at task end', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    const run = session.prompt('start')
    await transport.firstRequestStarted

    await session.followUp('bring this forward')
    const queued = session.queuedMessages[0]!
    expect(await session.promoteQueuedMessage(queued.id)).toMatchObject({ updated: true })

    transport.release()
    const result = await run

    expect(result.reason).not.toBe('aborted')
    // 提升后的项在下一个 turn 边界注入（与 steering 同一路径）。
    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'bring this forward',
    })
  })

  it('keeps a moved queue item at its explicit order after a restart', async () => {
    const journal = new RecordingMutationJournal()
    const transport = new QueuedMessageTransport()
    const session = new AgentSession({
      sessionId: 'queued-order-restart',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      mutationJournal: journal,
    })
    const run = session.prompt('start')
    await transport.firstRequestStarted

    await session.steer('first')
    await session.steer('second')
    const second = session.queuedMessages.find((message) => message.content === 'second')!
    await session.moveQueuedMessage(second.id, {
      kind: 'steering',
      placement: { position: 'top' },
    })
    expect(session.queuedMessages.map((message) => message.content)).toEqual(['second', 'first'])

    // 崩溃态：entry 停在 consuming（而非 abort 后的 recovered 草稿），恢复扫描会把它回退
    // 成 pending 并作为可运行队列项重建——此时顺序必须按 payload.order 而非 sequence。
    session.abort()
    transport.release()
    await run
    const pending = [...journal.entries.values()].filter(
      (entry) => entry.kind === 'queue' && entry.status === 'pending',
    )
    expect(pending).toHaveLength(2)

    const restarted = new AgentSession({
      sessionId: 'queued-order-restart',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport: new QueuedMessageTransport(),
      mutationJournal: journal,
      journalEntries: pending.map((entry) => ({
        ...entry,
        status: 'pending' as const,
        recoveredAt: undefined,
      })),
    })
    // 恢复顺序按 payload.order（重排后第二条的 order 小于第一条），而不是重写 entry 的 sequence。
    expect(restarted.queuedMessages.map((message) => message.content)).toEqual(['second', 'first'])
  })

  it('keeps both sides untouched when the previous queue entry cannot be discarded', async () => {
    // 重写 = 先 append 新 entry 再 discard 旧 entry。discard 失败必须补偿丢弃新 entry，
    // 否则同一 message.id 会留下两个 pending 条目（恢复时 fail-closed），且内存与
    // durable 状态分叉。
    class RejectingDiscardJournal extends RecordingMutationJournal {
      rejectDiscard = true

      override async discard(entryIds: string[]): Promise<void> {
        if (this.rejectDiscard) {
          // 只让「旧 entry 的 discard」失败一次：补偿路径（丢弃新 entry）必须放行。
          this.rejectDiscard = false
          throw new Error('discard unavailable')
        }
        return super.discard(entryIds)
      }
    }
    const journal = new RejectingDiscardJournal()
    const transport = new QueuedMessageTransport()
    const session = new AgentSession({
      sessionId: 'queued-rewrite-compensation',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      mutationJournal: journal,
    })
    const run = session.prompt('start')
    await transport.firstRequestStarted

    await session.steer('original')
    const messageId = session.queuedMessages[0]!.id
    await expect(session.editQueuedMessage(messageId, 'edited')).rejects.toThrow('discard unavailable')

    // 内存未被改写，且 journal 里没有残留 pending 的新 entry（补偿已丢弃它）。
    expect(session.queuedMessages.map((message) => message.content)).toEqual(['original'])
    const pending = [...journal.entries.values()].filter(
      (entry) => entry.kind === 'queue' && entry.status === 'pending',
    )
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ message: { id: messageId, content: 'original' } })

    session.abort()
    transport.release()
    await run
  })

  it('exposes queued images so restoring to the composer cannot silently drop them', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    const run = session.prompt('start')
    await transport.firstRequestStarted

    const image = { type: 'image' as const, source: { type: 'base64' as const, mediaType: 'image/png', data: 'cG5n' } }
    await session.steer('', [image])
    await session.followUp('text only')

    expect(session.queuedMessages[0]).toMatchObject({ content: '', images: [image] })
    expect(session.queuedMessages[1]).toMatchObject({ content: 'text only', images: [] })

    const restored = await session.restoreQueuedMessage(session.queuedMessages[0]!.id)
    expect(restored?.images).toEqual([image])

    session.abort()
    transport.release()
    await run
  })

  it('does not leave a drained queue consumption replayable when its persistence listener fails', async () => {
    // 锁定：store 持久化监听器抛错（「Session message 与 queue journal 消费事实
    // 不匹配」正是该抛错形态）时，emit 既不得跳过内存消费事实清理（否则
    // drainedQueueKinds / queueJournalEntryIds 会带着已结束 run 的消费事实跨 run
    // 边界存活，后续 run 重放它即被持久化校验再拒，每次重试必败），也不得把消息
    // 弄丢（journal 必须回退 pending 并重新入队，见文末断言）。
    class GatedTransport implements ModelTransport {
      readonly requests: ModelRequest[] = []
      private held = new Set<number>()
      private openings = new Map<number, Array<() => void>>()

      hold(index: number): void {
        this.held.add(index)
      }

      open(index: number): void {
        this.held.delete(index)
        for (const resolve of this.openings.get(index) ?? []) resolve()
        this.openings.delete(index)
      }

      private waitForOpen(index: number, signal: AbortSignal): Promise<void> | undefined {
        if (!this.held.has(index)) return undefined
        return new Promise<void>((resolve, reject) => {
          const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'))
          signal.addEventListener('abort', onAbort, { once: true })
          const waiters = this.openings.get(index) ?? []
          this.openings.set(index, waiters)
          waiters.push(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
          })
        })
      }

      async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
        const index = this.requests.push(request) - 1
        await this.waitForOpen(index, signal)
        yield { type: 'start' }
        yield { type: 'text_delta', contentIndex: 0, delta: `resp-${index}` }
        yield { type: 'done', stopReason: 'stop' }
      }
    }

    const messageEnds: Array<{ id: string; consumedJournalEntryId?: string }> = []
    const transport = new GatedTransport()
    const journal = new RecordingMutationJournal()
    const session = new AgentSession({
      sessionId: 'stale-drained-state',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      mutationJournal: journal,
    })
    // 监听器模拟 store 持久化：首次消费落库失败（真实形态——监听器抛错）。
    let failing = true
    session.subscribe((event) => {
      if (event.type !== 'message_end' || event.message.role !== 'user') return
      messageEnds.push({
        id: event.message.id,
        ...(event.consumedJournalEntryId
          ? { consumedJournalEntryId: event.consumedJournalEntryId }
          : {}),
      })
      if (failing && event.consumedJournalEntryId) {
        failing = false
        throw new Error('Session message 与 queue journal 消费事实不匹配')
      }
    })

    transport.hold(0)
    const first = session.prompt('start')
    await vi.waitFor(() => expect(transport.requests.length).toBe(1))
    await session.steer('继续')
    transport.open(0)
    // turn 2 起点：steering 被 drain 并 append，message_end 触发首次落库失败 →
    // run A 结束，该 append 留在内存未落库（drained 状态本应随之清理）
    await vi.waitFor(() => expect(messageEnds.length).toBeGreaterThan(0))
    await first.catch(() => undefined)

    const staleEntryId = messageEnds.find((entry) => entry.consumedJournalEntryId)
      ?.consumedJournalEntryId
    expect(staleEntryId).toBeDefined()

    // run A 失败后：消息不得丢，也不得把已结束 run 的消费事实留在 durable journal 里。
    // journal 回退 pending（不再停在 consuming / consumer_run_id=run A），消息在 run
    // 收尾时转为恢复草稿交回输入窗口，重启后仍可恢复。
    expect(journal.operations).toContain(`pending:${staleEntryId}`)
    expect(journal.operations).toContain(`recovered:${staleEntryId}`)
    const preserved = journal.entries.get(staleEntryId as string)
    expect(preserved).toMatchObject({ status: 'pending', recoveredAt: expect.any(Number) })
    expect(preserved?.consumerRunId).toBeUndefined()
    expect(await session.takeQueuedMessages()).toEqual([
      expect.objectContaining({ kind: 'steering', content: '继续' }),
    ])

    // 重试不得重放失效条目：已结束 run 的消费事实已随回退清除。
    messageEnds.length = 0
    await session.retry().catch(() => undefined)
    expect(messageEnds.filter((entry) => entry.consumedJournalEntryId === staleEntryId)).toEqual([])
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

    expect((await session.steer('drained before abort')).accepted).toBe(true)
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

    expect((await session.steer('recover despite event failure')).accepted).toBe(true)
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

    expect((await session.steer('already drained')).accepted).toBe(true)
    expect((await session.steer('still queued')).accepted).toBe(true)
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
    expect((await session.steer('too late')).accepted).toBe(false)
    expect((await session.followUp('also too late')).accepted).toBe(false)

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

describe('AgentSession turn aborted marker', () => {
  it('appends a turn-aborted marker when the user aborts mid-run', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    const run = session.prompt('start')
    await transport.firstRequestStarted
    session.abort()
    transport.release()
    const result = await run

    expect(result.reason).toBe('aborted')
    expect(result.turns).toBeGreaterThan(0)
    const marker = session.messages.at(-1)
    expect(marker).toMatchObject({ role: 'custom', customType: 'turn-aborted', data: { reason: 'user-abort' } })
  })

  it('does not append a marker when a run completes normally', async () => {
    const transport = new ResumeTransport()
    const session = new AgentSession({
      sessionId: 'no-abort-marker',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
    })
    const result = await session.prompt('hello')

    expect(result.reason).toBe('completed')
    expect(session.messages.some((message) => message.role === 'custom')).toBe(false)
  })

  it('surfaces the marker to the model on the next request as a wrapped user message', async () => {
    const transport = new QueuedMessageTransport()
    const session = createQueuedMessageSession(transport)
    const run = session.prompt('start')
    await transport.firstRequestStarted
    session.abort()
    transport.release()
    await run

    await session.prompt('continue from where it stopped')

    expect(transport.requests).toHaveLength(2)
    const marker = transport.requests[1]?.messages.find((message) =>
      message.role === 'user' && message.content.includes('<turn-aborted>'))
    expect(marker).toBeDefined()
    expect(marker?.content).toContain('被用户中断')
  })
})

describe('AgentSession post-turn idle compaction', () => {
  /** 构造落在「软水位之上、硬阈值之下」字节数的会话：seed 一条大消息，使请求
   * 字节 > requestByteThreshold × 0.9（软线）但 < requestByteThreshold（硬线）——
   * 运行中不压缩，run 正常收口后空闲压缩应当自动触发。 */
  const IDLE_COMPACTION_POLICY = {
    contextWindow: 1_000_000,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    requestByteThreshold: 512 * 1024,
    hardRequestByteLimit: 2 * 1024 * 1024,
  }

  it('compacts in the idle gap after a completed run at the soft watermark', async () => {
    const transport = new ResumeTransport()
    const session = new AgentSession({
      sessionId: 'idle-compaction',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      contextPolicy: IDLE_COMPACTION_POLICY,
      messages: [
        { id: 'big-u1', role: 'user', content: `history ${'x'.repeat(500_000)}`, createdAt: 1 },
        { id: 'big-a1', role: 'assistant', content: 'done reading', toolCalls: [], stopReason: 'stop', createdAt: 2 },
      ],
    })

    const result = await session.prompt('final check')

    expect(result.reason).toBe('completed')
    // 运行中没有触发压缩（请求未超硬线）：首个请求就是普通对话请求
    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[0]?.messages.some((message) => message.id.startsWith('context-summary:'))).toBe(false)
    // run 结算后的空隙里按软水位完成压缩（第二个请求是摘要请求）
    expect(transport.requests[1]?.systemPrompt.includes('上下文压缩器')).toBe(true)
    expect(session.checkpoint?.reason).toBe('byte_threshold')
    // 500KB 的大消息超出 keepRecent 尾窗，成为被摘要的压缩边界
    expect(session.checkpoint?.throughMessageId).toBe('big-u1')
  })

  it('does not compact after a run below the soft watermark', async () => {
    const transport = new ResumeTransport()
    const session = new AgentSession({
      sessionId: 'idle-compaction-below',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      contextPolicy: IDLE_COMPACTION_POLICY,
    })

    const result = await session.prompt('tiny prompt')

    expect(result.reason).toBe('completed')
    expect(transport.requests).toHaveLength(1)
    expect(session.checkpoint ?? null).toBeNull()
  })

  it('skips idle compaction when the run already compacted (no double summarize)', async () => {
    const transport = new CompactingTransport()
    const session = new AgentSession({
      sessionId: 'idle-compaction-after-run',
      systemPrompt: 'system',
      model: { provider: 'test', model: 'model' },
      transport,
      messages: [
        { id: 'old-u1', role: 'user', content: 'old goal', createdAt: 1 },
        { id: 'old-a1', role: 'assistant', content: 'old answer', toolCalls: [], stopReason: 'stop', createdAt: 2 },
      ],
    })

    await session.prompt('keep going')

    // 1 次普通请求（运行中同步压缩）+ 1 次摘要请求；空闲压缩因本 run 已压缩而跳过
    expect(transport.requests).toHaveLength(2)
  })
})
