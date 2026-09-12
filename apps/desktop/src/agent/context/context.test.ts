import type {
  AgentEvent,
  AgentMessage,
  ModelMessage,
  ModelRequest,
  ModelStreamEvent,
  ModelTransport,
} from '@/agent/core/types'
import { describe, expect, it } from 'vitest'
import {
  buildContextProjection,
  evaluateContextBudget,
  isContextSummaryMessage,
} from './budget'
import {
  compactModelRequest,
  groupContextMessages,
  prepareCompactionBoundary,
  serializeConversationForCompaction,
} from './compaction'
import { ContextWindowManager } from './ContextWindowManager'
import {
  createContextPolicy,
  DEFAULT_CONTEXT_POLICY_SETTINGS,
  HARD_MODEL_REQUEST_BYTES,
  MAX_REQUEST_BYTE_THRESHOLD,
  normalizeContextPolicySettings,
  resolveContextPolicySettings,
  type ContextCheckpoint,
} from './types'

class SummaryTransport implements ModelTransport {
  readonly requests: ModelRequest[] = []

  requestByteLength = (request: ModelRequest): number =>
    new TextEncoder().encode(JSON.stringify(request)).byteLength

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request)
    yield { type: 'start', responseId: 'summary-1' }
    yield { type: 'text_delta', delta: '## 目标\n继续实现 Axiom\n\n## 后续步骤\n1. 继续' }
    yield { type: 'done', stopReason: 'stop' }
  }
}

class HardLimitAfterCompactionTransport extends SummaryTransport {
  override requestByteLength = (request: ModelRequest): number =>
    request.systemPrompt.includes('上下文压缩器') ? 1_000 : 2_100_000
}

class AbortingSummaryTransport extends SummaryTransport {
  override requestByteLength = (request: ModelRequest): number =>
    request.systemPrompt.includes('上下文压缩器') ? 1_000 : 1_900_000

  override async *stream(): AsyncIterable<ModelStreamEvent> {
    throw new DOMException('Aborted', 'AbortError')
  }
}

const requestFor = (messages: AgentMessage[]): ModelRequest => ({
  sessionId: 'session-1',
  runId: 'run-1',
  systemPrompt: 'system',
  model: { provider: 'test', model: 'model' },
  messages: messages as unknown as ModelMessage[],
  tools: [],
})

const checkpoint = (throughMessageId: string): ContextCheckpoint => ({
  id: 'checkpoint-1',
  sessionId: 'session-1',
  throughMessageId,
  summary: 'old summary',
  summaryHash: 'hash',
  reason: 'manual',
  tokensBefore: 100,
  estimatedTokensAfter: 20,
  requestBytesBefore: 1000,
  requestBytesAfter: 200,
  modelProvider: 'test',
  modelId: 'model',
  promptVersion: 2,
  excludedMessageIds: [],
  facts: { readFiles: [], modifiedFiles: [] },
  createdAt: 10,
})

describe('context budget and projection', () => {
  it('normalizes persisted advanced settings without exposing hard safety limits', () => {
    const normalized = normalizeContextPolicySettings({
      reserveTokens: 999_999,
      keepRecentTokens: -1,
      requestByteThreshold: HARD_MODEL_REQUEST_BYTES,
    }, 8_192)
    expect(normalized).toEqual({
      reserveTokens: 4_096,
      keepRecentTokens: 2_048,
      requestByteThreshold: MAX_REQUEST_BYTE_THRESHOLD,
    })
    expect(createContextPolicy(8_192, normalized)).toMatchObject({
      hardRequestByteLimit: HARD_MODEL_REQUEST_BYTES,
      requestByteThreshold: MAX_REQUEST_BYTE_THRESHOLD,
    })
    expect(resolveContextPolicySettings('{broken', 128_000)).toEqual(DEFAULT_CONTEXT_POLICY_SETTINGS)
    expect(createContextPolicy(128_000, {
      ...DEFAULT_CONTEXT_POLICY_SETTINGS,
      reserveTokens: 1_024,
    }, 32_000).reserveTokens).toBe(32_000)
  })

  it('rebuilds model context from a checkpoint without deleting full history', () => {
    const history: AgentMessage[] = [
      { id: 'u1', role: 'user', content: 'old', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'old answer', toolCalls: [], stopReason: 'stop', createdAt: 2 },
      { id: 'u2', role: 'user', content: 'recent', createdAt: 3 },
    ]
    const projection = buildContextProjection(history, checkpoint('a1'))

    expect(history).toHaveLength(3)
    expect(projection).toHaveLength(2)
    expect(isContextSummaryMessage(projection[0])).toBe(true)
    expect(projection[1]).toMatchObject({ id: 'u2', content: 'recent' })
  })

  it('injects the deterministic work ledger and recovery preamble into the projection', () => {
    const history: AgentMessage[] = [
      { id: 'u1', role: 'user', content: 'old', createdAt: 1 },
      {
        id: 'tool-interrupted-bash',
        role: 'tool',
        toolCallId: 'call-bash',
        toolName: 'bash',
        content: '工具调用未形成完整的持久化结果，应用可能在收尾阶段退出。',
        details: { reason: 'application_exit', runId: 'run-1', recoveryPolicy: 'never', replayed: false, eligibleForReplay: false },
        isError: true,
        createdAt: 2,
      },
      { id: 'u2', role: 'user', content: 'recent', createdAt: 3 },
    ]
    const projection = buildContextProjection(history, {
      ...checkpoint('u1'),
      id: 'checkpoint-ledger',
      facts: {
        readFiles: ['src/a.ts'],
        modifiedFiles: [],
        readProgress: { 'src/a.ts': { nextOffset: 201, totalLines: 500, truncated: true, sha256: 'a'.repeat(64) } },
        toolLedger: [{ id: 'call-bash', tool: 'bash', path: null, status: 'pending' }],
      },
    })

    expect(projection.map((message) => message.id)).toEqual([
      expect.stringMatching(/^context-recovery:/u),
      expect.stringMatching(/^context-summary:/u),
      expect.stringMatching(/^context-ledger:/u),
      'tool-interrupted-bash',
      'u2',
    ])
    expect(projection[0]?.content).toContain('恢复说明')
    expect(projection[2]?.content).toContain('<work-ledger>')
    expect(projection[2]?.content).toContain('"status":"pending"')
  })

  it('groupContextMessages ignores projection-injected messages', () => {
    const projectionMessages: AgentMessage[] = [
      { id: 'context-summary:ck', role: 'user', content: 'summary', createdAt: 1 },
      { id: 'context-ledger:ck', role: 'user', content: '<work-ledger>', createdAt: 1 },
      { id: 'context-recovery:abc', role: 'user', content: '[恢复说明]', createdAt: 1 },
      { id: 'u1', role: 'user', content: 'real', createdAt: 2 },
    ]
    const groups = groupContextMessages(projectionMessages as unknown as ModelMessage[])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.messages.map((message) => message.id)).toEqual(['u1'])
  })

  it('keeps durable retry failures in history while excluding them from restored model context', () => {
    const failed: AgentMessage = {
      id: 'a-failed',
      role: 'assistant',
      content: '',
      toolCalls: [],
      stopReason: 'error',
      errorMessage: 'provider overloaded',
      providerError: { kind: 'server', message: 'provider overloaded', retryable: true },
      excludeFromModelContext: true,
      createdAt: 2,
    }
    const history: AgentMessage[] = [
      { id: 'u1', role: 'user', content: 'retry me', createdAt: 1 },
      failed,
      { id: 'a2', role: 'assistant', content: 'done', toolCalls: [], stopReason: 'stop', createdAt: 3 },
    ]

    expect(buildContextProjection(history).map((message) => message.id)).toEqual(['u1', 'a2'])
    expect(history).toContainEqual(failed)
  })

  it('drops legacy empty assistant messages without an exclude marker from the projection', () => {
    // 早期版本落盘的旧空 assistant（成功终态空流，未标记 excludeFromModelContext）
    // 必须在投影层过滤：Anthropic-compatible 会对 { role:'assistant', content:[] } 返回 400。
    const history: AgentMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      { id: 'a-empty', role: 'assistant', content: '', toolCalls: [], stopReason: 'stop', createdAt: 2 },
      { id: 'u2', role: 'user', content: 'again', createdAt: 3 },
    ]
    expect(buildContextProjection(history).map((message) => message.id)).toEqual(['u1', 'u2'])
    // 历史保留供审计，仅投影过滤
    expect(history.map((message) => message.id)).toEqual(['u1', 'a-empty', 'u2'])
  })

  it('drops legacy thinking-only assistant messages (no visible text, no tool calls) from the projection', () => {
    // 早期版本落盘的 thinking-only 空 assistant：全部输出 token 消耗在 reasoning、
    // 命中 max_tokens 截断（stopReason 'length'），无可见文本、无工具调用。多数
    // Anthropic-compatible 中继会剥离历史中的 thinking 块，剥离后 content 为空 →
    // HTTP 400 "content or tool_calls must be set"。必须在投影层过滤。
    const history: AgentMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      {
        id: 'a-thinking-only',
        role: 'assistant',
        content: '',
        stopReason: 'length',
        createdAt: 2,
        contentBlocks: [{ type: 'thinking', thinking: '设计实施路径...' }],
        toolCalls: [],
      },
      { id: 'u2', role: 'user', content: 'again', createdAt: 3 },
    ]
    expect(buildContextProjection(history).map((message) => message.id)).toEqual(['u1', 'u2'])
    // 历史保留供审计，仅投影过滤
    expect(history.map((message) => message.id)).toEqual(['u1', 'a-thinking-only', 'u2'])
  })

  it('keeps assistant messages that pair thinking with visible text or tool calls', () => {
    // 有可见文本或工具调用的消息不得被误删：thinking 块只是补充，wire 上 content 非空。
    const history: AgentMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      {
        id: 'a-thinking-text',
        role: 'assistant',
        content: '可见文本',
        stopReason: 'stop',
        createdAt: 2,
        contentBlocks: [{ type: 'thinking', thinking: 'reason' }, { type: 'text', text: '可见文本' }],
        toolCalls: [],
      },
      {
        id: 'a-thinking-tool',
        role: 'assistant',
        content: '',
        stopReason: 'tool_use',
        createdAt: 3,
        contentBlocks: [{ type: 'thinking', thinking: 'reason' }],
        toolCalls: [{ id: 'call-1', name: 'echo', rawArguments: '{}', arguments: {} }],
      },
    ]
    expect(buildContextProjection(history).map((message) => message.id)).toEqual(['u1', 'a-thinking-text', 'a-thinking-tool'])
  })

  it('fails closed when a restored checkpoint boundary is missing or splits tool results', () => {
    const history: AgentMessage[] = [
      { id: 'u1', role: 'user', content: 'read', createdAt: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read', arguments: {}, rawArguments: '{}' }],
        stopReason: 'tool_use',
        createdAt: 2,
      },
      {
        id: 't1',
        role: 'tool',
        toolCallId: 'call-1',
        toolName: 'read',
        content: 'done',
        isError: false,
        createdAt: 3,
      },
    ]

    expect(() => buildContextProjection(history, checkpoint('missing')))
      .toThrow('边界消息不存在于恢复历史')
    expect(() => buildContextProjection(history, checkpoint('a1')))
      .toThrow('拆分 ToolCall/ToolResult')
    expect(() => buildContextProjection(history, {
      ...checkpoint('u1'),
      excludedMessageIds: ['missing-excluded'],
    })).toThrow('排除消息不存在于恢复历史')
  })

  it('restores only the latest checkpoint projection after repeated compaction', () => {
    const history: AgentMessage[] = [
      { id: 'u1', role: 'user', content: 'old', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'old answer', toolCalls: [], stopReason: 'stop', createdAt: 2 },
      { id: 'u2', role: 'user', content: 'middle', createdAt: 3 },
      { id: 'a2', role: 'assistant', content: 'middle answer', toolCalls: [], stopReason: 'stop', createdAt: 4 },
      { id: 'u3', role: 'user', content: 'recent', createdAt: 5 },
    ]
    const latest = {
      ...checkpoint('a2'),
      id: 'checkpoint-2',
      summary: 'latest rolling summary',
      createdAt: 6,
    }

    const projection = buildContextProjection(history, latest)

    expect(history).toHaveLength(5)
    expect(projection).toHaveLength(2)
    expect(projection[0]).toMatchObject({
      id: 'context-summary:checkpoint-2',
      content: expect.stringContaining('latest rolling summary'),
    })
    expect(projection[1]).toMatchObject({ id: 'u3' })
  })

  it('uses token and exact serialized-byte pressure independently', () => {
    const transport: ModelTransport = {
      requestByteLength: () => 1_900_000,
      async *stream() { yield { type: 'done', stopReason: 'stop' } },
    }
    const usage = evaluateContextBudget(
      requestFor([{ id: 'u1', role: 'user', content: 'small', createdAt: 1 }]),
      transport,
      createContextPolicy(1_000_000),
    )

    expect(usage.reason).toBe('byte_threshold')
    expect(usage.requestBytes).toBe(1_900_000)
    expect(usage.needsCompaction).toBe(true)
  })
})

describe('context compaction', () => {
  it('serializes rich assistant blocks in their original order', () => {
    const serialized = serializeConversationForCompaction([{
      id: 'a-rich',
      role: 'assistant',
      content: 'beforeafter',
      contentBlocks: [
        { type: 'thinking', thinking: 'reason' },
        { type: 'text', text: 'before' },
        {
          type: 'tool_call',
          id: 'call-1',
          name: 'read_file',
          arguments: { path: '/tmp/a' },
          rawArguments: '{"path":"/tmp/a"}',
        },
        { type: 'text', text: 'after' },
      ],
      toolCalls: [{
        id: 'call-1',
        name: 'read_file',
        arguments: { path: '/tmp/a' },
        rawArguments: '{"path":"/tmp/a"}',
      }],
      stopReason: 'tool_use',
      createdAt: 1,
    }])

    expect(serialized).toBe([
      '[Assistant thinking]: reason',
      '[Assistant]: before',
      '[Assistant tool call]: read_file({"path":"/tmp/a"})',
      '[Assistant]: after',
    ].join('\n'))
  })

  const messages: AgentMessage[] = [
    { id: 'u1', role: 'user', content: 'create a note', createdAt: 1 },
    {
      id: 'a1',
      role: 'assistant',
      content: 'creating',
      toolCalls: [{
        id: 'call-1',
        name: 'create_workspace_file',
        arguments: { path: 'note.md', content: 'private body' },
        rawArguments: '{"path":"note.md","content":"private body"}',
      }],
      stopReason: 'tool_use',
      createdAt: 2,
    },
    {
      id: 't1',
      role: 'tool',
      toolCallId: 'call-1',
      toolName: 'create_workspace_file',
      content: 'created',
      details: { path: 'note.md', operation: 'created' },
      isError: false,
      createdAt: 3,
    },
    { id: 'u2', role: 'user', content: 'now continue', createdAt: 4 },
  ]

  it('keeps assistant tool calls and their results in one atomic group', () => {
    const groups = groupContextMessages(messages as unknown as ModelMessage[])
    expect(groups).toHaveLength(3)
    expect(groups[1]?.messages.map((message) => message.id)).toEqual(['a1', 't1'])
  })

  it('preserves the active turn prefix when compaction keeps an assistant suffix', async () => {
    const splitTurnMessages: AgentMessage[] = [
      { id: 'u-old', role: 'user', content: 'older request', createdAt: 1 },
      {
        id: 'a-old',
        role: 'assistant',
        content: 'older answer',
        toolCalls: [],
        stopReason: 'stop',
        createdAt: 2,
      },
      { id: 'u-active', role: 'user', content: 'inspect the project', createdAt: 3 },
      {
        id: 'a-tool',
        role: 'assistant',
        content: 'reading',
        toolCalls: [{
          id: 'call-read',
          name: 'read_workspace_file',
          arguments: { path: 'src/runtime.ts' },
          rawArguments: '{"path":"src/runtime.ts"}',
        }],
        stopReason: 'tool_use',
        createdAt: 4,
      },
      {
        id: 't-read',
        role: 'tool',
        toolCallId: 'call-read',
        toolName: 'read_workspace_file',
        content: 'runtime source',
        details: { path: 'src/runtime.ts', operation: 'read' },
        isError: false,
        createdAt: 5,
      },
      {
        id: 'a-final',
        role: 'assistant',
        content: 'analysis complete',
        toolCalls: [],
        stopReason: 'stop',
        createdAt: 6,
      },
    ]
    const groups = groupContextMessages(splitTurnMessages as unknown as ModelMessage[])
    const boundary = prepareCompactionBoundary(groups, groups.length - 1)

    expect(boundary.isSplitTurn).toBe(true)
    expect(boundary.historyMessages.map((message) => message.id)).toEqual(['u-old', 'a-old'])
    expect(boundary.turnPrefixMessages.map((message) => message.id)).toEqual([
      'u-active',
      'a-tool',
      't-read',
    ])
    expect(boundary.keptMessages.map((message) => message.id)).toEqual(['a-final'])
    expect(boundary.turnPrefixMessages.some((message) => message.id === 'a-tool')).toBe(true)
    expect(boundary.turnPrefixMessages.some((message) => message.id === 't-read')).toBe(true)

    const transport = new SummaryTransport()
    const result = await compactModelRequest({
      request: requestFor(splitTurnMessages),
      transport,
      policy: { ...createContextPolicy(128_000), keepRecentTokens: 1 },
      reason: 'manual',
      signal: new AbortController().signal,
    })

    expect(transport.requests).toHaveLength(2)
    expect(transport.requests[1]?.messages[0]).toMatchObject({ role: 'user' })
    expect(transport.requests[1]?.messages[0]?.content).toContain('保留后缀所需上下文')
    expect(result?.request.messages.map((message) => message.id)).toEqual([
      expect.stringMatching(/^context-summary:/u),
      expect.stringMatching(/^context-ledger:/u),
      'a-final',
    ])
    expect(result?.checkpoint.throughMessageId).toBe('t-read')
    expect(result?.checkpoint.summary).toContain('## 轮次上下文（分片轮）')
    expect(result?.checkpoint.facts.readFiles).toEqual(['src/runtime.ts'])
    expect(result?.checkpoint.facts.toolLedger).toMatchObject([
      { id: 'call-read', tool: 'read_workspace_file', path: 'src/runtime.ts', status: 'done' },
    ])
  })

  it('redacts full workspace write content from summarization input', () => {
    const serialized = serializeConversationForCompaction(messages as unknown as ModelMessage[])
    expect(serialized).not.toContain('private body')
    expect(serialized).toContain('contentBytes')
    expect(serialized).toContain('note.md')
  })

  it('creates a hashed checkpoint and keeps recent raw messages', async () => {
    const transport = new SummaryTransport()
    const result = await compactModelRequest({
      request: requestFor(messages),
      transport,
      policy: { ...createContextPolicy(128_000), keepRecentTokens: 1 },
      reason: 'manual',
      signal: new AbortController().signal,
    })

    expect(result?.checkpoint.throughMessageId).toBe('t1')
    expect(result?.checkpoint.summaryHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(result?.checkpoint.facts.modifiedFiles).toEqual(['note.md'])
    expect(result?.request.messages.map((message) => message.id)).toEqual([
      expect.stringMatching(/^context-summary:/u),
      expect.stringMatching(/^context-ledger:/u),
      'u2',
    ])
    expect(result?.request.messages[1]).toMatchObject({ role: 'user' })
    expect(transport.requests[0]?.messages[0]?.content).not.toContain('private body')
    expect(messages).toHaveLength(4)
  })

  it('adds bounded custom focus to manual compaction instructions', async () => {
    const transport = new SummaryTransport()
    await compactModelRequest({
      request: requestFor(messages),
      transport,
      policy: { ...createContextPolicy(128_000), keepRecentTokens: 1 },
      reason: 'manual',
      signal: new AbortController().signal,
      summaryInstructions: { customInstructions: '保留工具审批和失败恢复细节' },
    })

    const summaryInput = transport.requests[0]?.messages[0]
    const content = summaryInput?.role === 'user' ? summaryInput.content : ''
    expect(content).toContain('请把以上对话压缩为结构化检查点。')
    expect(content).toContain('额外关注事项：\n保留工具审批和失败恢复细节')

    await expect(compactModelRequest({
      request: requestFor(messages),
      transport: new SummaryTransport(),
      policy: { ...createContextPolicy(128_000), keepRecentTokens: 1 },
      reason: 'manual',
      signal: new AbortController().signal,
      summaryInstructions: { customInstructions: '界'.repeat(6_000) },
    })).rejects.toThrow('自定义摘要指令超过 16 KiB 安全上限')
  })

  it('does not feed deterministic file facts back into rolling summaries', async () => {
    const transport = new SummaryTransport()
    const previous = {
      ...checkpoint('a-old'),
      summary: [
        '## 目标\n保留目标',
        '<modified-files>\nnote.md\n</modified-files>',
        '<modified-files>\nnote.md\n</modified-files>',
      ].join('\n\n'),
      facts: { readFiles: [], modifiedFiles: ['note.md'] },
    }
    const result = await compactModelRequest({
      request: requestFor([
        { id: 'u-next', role: 'user', content: 'continue', createdAt: 20 },
        { id: 'a-next', role: 'assistant', content: 'done', toolCalls: [], stopReason: 'stop', createdAt: 21 },
      ]),
      transport,
      policy: { ...createContextPolicy(128_000), keepRecentTokens: 1 },
      checkpoint: previous,
      reason: 'manual',
      signal: new AbortController().signal,
    })

    const summaryInput = transport.requests[0]?.messages[0]
    expect(summaryInput?.role === 'user' ? summaryInput.content : '').not.toContain('<modified-files>')
    expect(result?.checkpoint.summary.match(/<modified-files>/gu)).toHaveLength(1)
    expect(result?.checkpoint.facts.modifiedFiles).toEqual(['note.md'])
  })

  it('propagates AbortSignal while generating a summary', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(compactModelRequest({
      request: requestFor(messages),
      transport: new SummaryTransport(),
      policy: { ...createContextPolicy(128_000), keepRecentTokens: 1 },
      reason: 'manual',
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects a request that remains above 2 MiB after compaction', async () => {
    await expect(compactModelRequest({
      request: requestFor(messages),
      transport: new HardLimitAfterCompactionTransport(),
      policy: { ...createContextPolicy(1_000_000), keepRecentTokens: 1 },
      reason: 'byte_threshold',
      signal: new AbortController().signal,
    })).rejects.toThrow('Compaction 后模型请求仍超过 Rust 2 MiB 硬上限')
  })

  it('does not switch checkpoint when persistence listeners fail', async () => {
    const transport = new SummaryTransport()
    const events: AgentEvent[] = []
    const manager = new ContextWindowManager({
      transport,
      policy: { ...createContextPolicy(128_000), keepRecentTokens: 1 },
      emit: async (event) => {
        events.push(event)
        if (event.type === 'compaction_end' && event.checkpoint) throw new Error('sqlite failed')
      },
    })

    await expect(manager.compactManually(
      requestFor(messages),
      new AbortController().signal,
    )).rejects.toThrow('sqlite failed')
    expect(manager.currentCheckpoint).toBeUndefined()
    expect(events.some((event) => event.type === 'compaction_end' && event.errorMessage === 'sqlite failed')).toBe(true)
  })

  it('runs compaction hooks and safely builds a checkpoint from a replacement narrative', async () => {
    const transport = new SummaryTransport()
    const lifecycle: string[] = []
    const manager = new ContextWindowManager({
      transport,
      policy: { ...createContextPolicy(128_000), keepRecentTokens: 1 },
      emit: () => undefined,
      beforeCompaction: (context) => {
        lifecycle.push(`before:${context.reason}`)
        return {
          replacement: {
            summary: '## 目标\n使用 Hook 提供的摘要',
            throughMessageId: 't1',
          },
        }
      },
      afterCompaction: (context) => {
        lifecycle.push(`after:${context.replaced}:${context.result.checkpoint.throughMessageId}`)
        context.result.checkpoint.summary = 'after hook mutation'
      },
    })

    const projected = await manager.compactManually(
      requestFor(messages),
      new AbortController().signal,
    )

    expect(transport.requests).toHaveLength(0)
    expect(lifecycle).toEqual(['before:manual', 'after:true:t1'])
    expect(manager.currentCheckpoint).toMatchObject({
      throughMessageId: 't1',
      facts: { modifiedFiles: ['note.md'] },
    })
    expect(manager.currentCheckpoint?.summary).toContain('使用 Hook 提供的摘要')
    expect(manager.currentCheckpoint?.summary).not.toContain('after hook mutation')
    expect(manager.currentCheckpoint?.summaryHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(projected.messages.map((message) => message.id)).toEqual([
      expect.stringMatching(/^context-summary:/u),
      expect.stringMatching(/^context-ledger:/u),
      'u2',
    ])
  })

  it('lets a before-compaction hook cancel without creating a checkpoint', async () => {
    const events: AgentEvent[] = []
    let afterCalled = false
    const manager = new ContextWindowManager({
      transport: new SummaryTransport(),
      policy: { ...createContextPolicy(128_000), keepRecentTokens: 1 },
      emit: (event) => { events.push(event) },
      beforeCompaction: () => ({ cancel: true }),
      afterCompaction: () => { afterCalled = true },
    })

    await expect(manager.compactManually(
      requestFor(messages),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(manager.currentCheckpoint).toBeUndefined()
    expect(afterCalled).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'compaction_end',
      aborted: true,
    }))
  })

  it('rejects a replacement boundary that would split a tool-call group', async () => {
    await expect(compactModelRequest({
      request: requestFor(messages),
      transport: new SummaryTransport(),
      policy: { ...createContextPolicy(128_000), keepRecentTokens: 1 },
      reason: 'manual',
      signal: new AbortController().signal,
      replacement: { summary: 'unsafe boundary', throughMessageId: 'a1' },
    })).rejects.toThrow('完整消息组的末尾')
  })

  it('propagates summary Abort instead of falling through to the original request', async () => {
    const transport = new AbortingSummaryTransport()
    const manager = new ContextWindowManager({
      transport,
      policy: { ...createContextPolicy(1_000_000), keepRecentTokens: 1 },
      emit: () => undefined,
    })

    await expect(manager.prepareModelRequest(
      requestFor(messages),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: 'AbortError' })
    expect(manager.currentCheckpoint).toBeUndefined()
  })
})
