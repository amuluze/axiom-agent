import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from '@/agent/core/types'
import { describe, expect, it } from 'vitest'
import { hashContextSummary, SUMMARY_PROMPT_VERSION } from '@/agent/context/compaction'
import { decodeAgentMessage, encodeAgentMessage, isAgentMessage } from './messageCodec'
import { MemorySessionRepository } from './MemorySessionRepository'
import type { ProviderConfig } from '@/agent/transport/provider'
import type { AgentSessionJournalEntry } from '@/agent/runtime/mutationJournal'
import {
  assertRuntimeDependenciesCompatible,
  type RuntimeDependencyManifest,
} from '@/agent/runtime/runtimeDependencyManifest'
import {
  INTERRUPTED_TOOL_RESULT_CONTENT,
  interruptedToolResultId,
} from './interruptedToolRecovery'

const runtimeManifest = (
  model = 'model',
  readVersion = '1',
): RuntimeDependencyManifest => ({
  schemaVersion: 4,
  provider: {
    providerId: 'test',
    apiFormat: 'openai-compatible',
    modelId: model,
    transportVersion: '1',
  },
  tools: [
    { name: 'discover_agent_tools', version: '1', recoveryPolicy: 'never' },
    { name: 'read', version: readVersion, recoveryPolicy: 'never' },
  ],
  hooks: [{ id: 'axiom.desktop.runtime-hooks', version: '5', fingerprint: 'test-runtime' }],
  skills: { schemaVersion: 1, skills: [] },
})

const defaults = {
  systemPrompt: 'system',
  modelProvider: 'test',
  modelId: 'model',
  reasoning: null,
  activeToolNames: ['discover_agent_tools'],
  runtimeManifest: runtimeManifest(),
}

const recordProviderAssistant = async (
  repository: MemorySessionRepository,
  sessionId: string,
  runId: string,
  message: AssistantMessage,
): Promise<void> => {
  const requestId = `provider:${runId}:${message.id}`
  await repository.recordEvent(sessionId, {
    type: 'provider_request_start',
    requestId,
    runId,
    assistantMessageId: message.id,
    modelProvider: 'test',
    modelId: 'model',
    messageCount: 0,
    toolCount: message.toolCalls.length,
  })
  await repository.recordEvent(sessionId, {
    type: 'provider_response_received',
    requestId,
    runId,
    assistantMessageId: message.id,
    message,
  })
  await repository.recordEvent(sessionId, { type: 'message_end', runId, message })
}

describe('Agent message codec', () => {
  it('round-trips every canonical message role', () => {
    const messages: AgentMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'hello',
        contentBlocks: [
          { type: 'text', text: 'hello', cacheControl: { type: 'ephemeral', ttl: '1h' } },
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'cG5n' } },
        ],
        createdAt: 1,
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'working',
        contentBlocks: [
          { type: 'thinking', thinking: 'private', thinkingSignature: 'signed' },
          { type: 'text', text: 'working' },
          {
            type: 'tool_call',
            id: 'c1',
            name: 'read',
            arguments: { path: '/tmp/a' },
            rawArguments: '{"path":"/tmp/a"}',
          },
        ],
        toolCalls: [{ id: 'c1', name: 'read', arguments: { path: '/tmp/a' }, rawArguments: '{"path":"/tmp/a"}' }],
        stopReason: 'tool_use',
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
          cacheReadTokens: 3,
          reasoningTokens: 2,
        },
        createdAt: 2,
      },
      {
        id: 't1',
        role: 'tool',
        toolCallId: 'c1',
        toolName: 'read',
        content: 'contents',
        contentBlocks: [
          { type: 'text', text: 'contents' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/result.png' } },
        ],
        details: { bytes: 8 },
        artifact: {
          id: `sha256:${'a'.repeat(64)}`,
          kind: 'text',
          mediaType: 'text/plain;charset=utf-8',
          relativePath: `artifacts/sha256/aa/${'a'.repeat(64)}`,
          contentHash: 'a'.repeat(64),
          sizeBytes: 300_000,
          createdAt: 3,
        },
        isError: false,
        createdAt: 3,
      },
      {
        id: 'custom-1',
        role: 'custom',
        customType: 'runtime-note',
        content: 'visible fallback',
        data: { priority: 1 },
        createdAt: 4,
      },
    ]
    for (const message of messages) expect(decodeAgentMessage(encodeAgentMessage(message))).toEqual(message)
  })

  it('rejects malformed persisted messages', () => {
    expect(isAgentMessage({ role: 'user', content: 'missing id' })).toBe(false)
    expect(() => decodeAgentMessage('{broken')).toThrow('无法解析')
    expect(() => decodeAgentMessage('{"role":"assistant"}')).toThrow('格式无效')
    expect(isAgentMessage({
      id: 'tool-bad-artifact',
      role: 'tool',
      toolCallId: 'call',
      toolName: 'read',
      content: 'preview',
      isError: false,
      createdAt: 1,
      artifact: {
        id: 'sha256:not-the-hash',
        kind: 'text',
        mediaType: 'text/plain',
        relativePath: '../escape',
        contentHash: 'a'.repeat(64),
        sizeBytes: 1,
        createdAt: 1,
      },
    })).toBe(false)
    expect(isAgentMessage({
      id: 'bad-image',
      role: 'user',
      content: '',
      contentBlocks: [{ type: 'image', source: { type: 'base64', data: 'missing media type' } }],
      createdAt: 1,
    })).toBe(false)
  })
})

describe('MemorySessionRepository', () => {
  it('keeps run ownership unique and allows only one active run per session', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const firstSessionId = initialized.active.session.id
    const second = await repository.createSession(defaults)

    await repository.recordEvent(firstSessionId, {
      type: 'agent_start',
      sessionId: firstSessionId,
      runId: 'owned-run',
    })
    await expect(repository.recordEvent(second.session.id, {
      type: 'agent_start',
      sessionId: second.session.id,
      runId: 'owned-run',
    })).rejects.toThrow('其他 Session')
    await expect(repository.recordEvent(firstSessionId, {
      type: 'agent_start',
      sessionId: firstSessionId,
      runId: 'parallel-run',
    })).rejects.toThrow('其他活动 Agent Run')

    expect((await repository.loadSession(firstSessionId)).session.status).toBe('running')
    expect((await repository.loadSession(second.session.id)).session.status).toBe('idle')
  })

  it('replays only the same running Run and Tool start canonical facts', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const runId = 'canonical-start-run'
    const startRun = { type: 'agent_start' as const, sessionId, runId }
    await repository.recordEvent(sessionId, startRun)
    await expect(repository.recordEvent(sessionId, startRun)).resolves.toBeUndefined()

    const startTool = {
      type: 'tool_execution_start' as const,
      runId,
      toolCallId: 'canonical-start-tool',
      toolName: 'read',
      arguments: { path: 'a', options: { limit: 1 } },
      approvalState: 'not_required' as const,
      recoveryPolicy: 'idempotent' as const,
      idempotencyKey: 'read:a',
    }
    await repository.recordEvent(sessionId, startTool)
    await expect(repository.recordEvent(sessionId, {
      ...startTool,
      arguments: { options: { limit: 1 }, path: 'a' },
    })).resolves.toBeUndefined()

    for (const changed of [
      { ...startTool, toolName: 'write' },
      { ...startTool, arguments: { path: 'b', options: { limit: 1 } } },
      { ...startTool, approvalState: 'pending' as const },
      { ...startTool, recoveryPolicy: 'never' as const },
      { ...startTool, idempotencyKey: 'read:changed' },
    ]) {
      await expect(repository.recordEvent(sessionId, changed)).rejects.toThrow('canonical effect')
    }

    await repository.recordEvent(sessionId, {
      type: 'tool_execution_end',
      runId,
      toolCallId: startTool.toolCallId,
      toolName: startTool.toolName,
      result: { content: 'done' },
      isError: false,
      approvalState: 'not_required',
    })
    await repository.recordEvent(sessionId, {
      type: 'message_end',
      runId,
      message: {
        id: 'canonical-tool-result',
        role: 'tool',
        toolCallId: startTool.toolCallId,
        toolName: startTool.toolName,
        content: 'done',
        isError: false,
        createdAt: 2,
      },
    })
    await expect(repository.recordEvent(sessionId, startTool)).rejects.toThrow('终态')

    await repository.recordEvent(sessionId, {
      type: 'agent_end',
      sessionId,
      runId,
      reason: 'completed',
      messages: [],
    })
    await expect(repository.recordEvent(sessionId, startRun)).rejects.toThrow('终态')
  })

  it('finishes a run idempotently only for the same canonical terminal effect', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const runId = 'run-terminal-replay'
    const completed = {
      type: 'agent_end' as const,
      sessionId,
      runId,
      reason: 'completed' as const,
      messages: [],
    }
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId })

    await repository.recordEvent(sessionId, completed)
    await expect(repository.recordEvent(sessionId, completed)).resolves.toBeUndefined()
    await expect(repository.recordEvent(sessionId, {
      ...completed,
      reason: 'error',
      errorMessage: 'changed terminal effect',
    })).rejects.toThrow('不同终态')
  })

  it('keeps finalized messages immutable and replays only their canonical effect', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const runId = 'run-finalized-message'
    const message: UserMessage = {
      id: 'finalized-message',
      role: 'user',
      content: 'original',
      createdAt: 2,
    }
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId })
    await repository.recordEvent(sessionId, { type: 'message_end', runId, message })
    await expect(repository.recordEvent(sessionId, {
      type: 'message_end',
      runId,
      message: structuredClone(message),
    })).resolves.toBeUndefined()
    await expect(repository.recordEvent(sessionId, {
      type: 'message_end',
      runId,
      message: { ...message, content: 'changed' },
    })).rejects.toThrow('canonical effect')
    expect((await repository.loadSession(sessionId)).messages).toEqual([message])
  })

  it('accepts exact Turn Save Point replay and rejects drift or turn regression', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const runId = 'run-turn-save-point-order'
    const message: UserMessage = {
      id: 'turn-save-point-message',
      role: 'user',
      content: 'boundary',
      createdAt: 1,
    }
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId })
    await repository.recordEvent(sessionId, { type: 'message_end', runId, message })
    const first = {
      sessionId,
      runId,
      turn: 1,
      mutationBatchIds: [],
      hadPendingMutations: false,
      messageCount: 1,
      lastMessageId: message.id,
      createdAt: 2,
    }
    await repository.recordEvent(sessionId, { type: 'turn_save_point', savePoint: first })
    await expect(repository.recordEvent(sessionId, {
      type: 'turn_save_point',
      savePoint: structuredClone(first),
    })).resolves.toBeUndefined()
    await expect(repository.recordEvent(sessionId, {
      type: 'turn_save_point',
      savePoint: { ...first, createdAt: 3 },
    })).rejects.toThrow('canonical effect')

    const second = { ...first, turn: 2, createdAt: 4 }
    await repository.recordEvent(sessionId, { type: 'turn_save_point', savePoint: second })
    await expect(repository.recordEvent(sessionId, {
      type: 'turn_save_point',
      savePoint: first,
    })).rejects.toThrow('轮次不能回退')
  })

  it('keeps a run active while Provider or Tool ledgers are unfinished', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const providerRunId = 'run-provider-finish-guard'
    const assistant: AssistantMessage = {
      id: 'assistant-finish-guard',
      role: 'assistant',
      content: 'done',
      toolCalls: [],
      stopReason: 'stop',
      createdAt: 2,
    }
    await repository.recordEvent(sessionId, {
      type: 'agent_start',
      sessionId,
      runId: providerRunId,
    })
    await repository.recordEvent(sessionId, {
      type: 'provider_request_start',
      requestId: 'provider-finish-guard',
      runId: providerRunId,
      assistantMessageId: assistant.id,
      modelProvider: 'test',
      modelId: 'model',
      messageCount: 0,
      toolCount: 0,
    })
    const providerEnd = {
      type: 'agent_end' as const,
      sessionId,
      runId: providerRunId,
      reason: 'completed' as const,
      messages: [assistant],
    }
    await expect(repository.recordEvent(sessionId, providerEnd))
      .rejects.toThrow('Provider ledger')
    await repository.recordEvent(sessionId, {
      type: 'provider_response_received',
      requestId: 'provider-finish-guard',
      runId: providerRunId,
      assistantMessageId: assistant.id,
      message: assistant,
    })
    await expect(repository.recordEvent(sessionId, providerEnd))
      .rejects.toThrow('Provider ledger')
    await repository.recordEvent(sessionId, {
      type: 'message_end',
      runId: providerRunId,
      message: assistant,
    })
    await expect(repository.recordEvent(sessionId, providerEnd)).resolves.toBeUndefined()
    await repository.recordEvent(sessionId, {
      type: 'agent_settled',
      savePoint: {
        sessionId,
        runId: providerRunId,
        messageCount: 1,
        lastMessageId: assistant.id,
        createdAt: 3,
      },
    })

    const toolRunId = 'run-tool-finish-guard'
    await repository.recordEvent(sessionId, {
      type: 'agent_start',
      sessionId,
      runId: toolRunId,
    })
    await repository.recordEvent(sessionId, {
      type: 'tool_execution_start',
      runId: toolRunId,
      toolCallId: 'tool-finish-guard',
      toolName: 'read',
      arguments: {},
      approvalState: 'not_required',
      recoveryPolicy: 'never',
    })
    await expect(repository.recordEvent(sessionId, {
      type: 'agent_end',
      sessionId,
      runId: toolRunId,
      reason: 'completed',
      messages: [],
    })).rejects.toThrow('Tool ledger')
  })

  it('recovers consuming queues after a crash and does not duplicate one already persisted in the transcript', async () => {
    const pendingRepository = new MemorySessionRepository()
    const pending = await pendingRepository.initialize(defaults)
    const pendingSessionId = pending.active.session.id
    const pendingMessage: UserMessage = {
      id: 'queued-pending',
      role: 'user',
      content: 'recover me',
      createdAt: 1,
    }
    const pendingEntry: AgentSessionJournalEntry = {
      id: 'journal-queued-pending',
      sessionId: pendingSessionId,
      sequence: 0,
      kind: 'queue',
      queueKind: 'steering',
      message: pendingMessage,
      status: 'pending',
      createdAt: 1,
    }
    await pendingRepository.recordEvent(pendingSessionId, {
      type: 'agent_start',
      sessionId: pendingSessionId,
      runId: 'run-queued-pending',
    })
    await pendingRepository.appendJournalEntry(pendingSessionId, pendingEntry)
    await pendingRepository.markJournalEntriesConsuming(
      pendingSessionId,
      [pendingEntry.id],
      'run-queued-pending',
    )

    const recovered = await pendingRepository.initialize(defaults)
    expect(recovered.active.journalEntries).toEqual([
      expect.objectContaining({ id: pendingEntry.id, status: 'pending', consumerRunId: undefined }),
    ])
    expect(recovered.active.messages).toEqual([])

    const appliedRepository = new MemorySessionRepository()
    const applied = await appliedRepository.initialize(defaults)
    const appliedSessionId = applied.active.session.id
    const appliedMessage: UserMessage = { ...pendingMessage, id: 'queued-applied' }
    const appliedEntry: AgentSessionJournalEntry = {
      ...pendingEntry,
      id: 'journal-queued-applied',
      sessionId: appliedSessionId,
      message: appliedMessage,
    }
    await appliedRepository.recordEvent(appliedSessionId, {
      type: 'agent_start',
      sessionId: appliedSessionId,
      runId: 'run-queued-applied',
    })
    await appliedRepository.appendJournalEntry(appliedSessionId, appliedEntry)
    await appliedRepository.markJournalEntriesConsuming(
      appliedSessionId,
      [appliedEntry.id],
      'run-queued-applied',
    )
    await appliedRepository.recordEvent(appliedSessionId, {
      type: 'message_end',
      runId: 'run-queued-applied',
      consumedJournalEntryId: appliedEntry.id,
      message: appliedMessage,
    })

    const restored = await appliedRepository.initialize(defaults)
    expect(restored.active.messages).toEqual([appliedMessage])
    expect(restored.active.journalEntries).toEqual([])
    await expect(appliedRepository.markJournalEntriesApplied(appliedSessionId, [appliedEntry.id]))
      .rejects.toThrow('不存在')
  })

  it('rolls back a consumed queue message when its journal acknowledgement is invalid', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const runId = 'run-invalid-queue-ack'
    const message: UserMessage = {
      id: 'queued-invalid-ack',
      role: 'user',
      content: 'must remain atomic',
      createdAt: 1,
    }
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId })

    await expect(repository.recordEvent(sessionId, {
      type: 'message_end',
      runId,
      consumedJournalEntryId: 'missing-journal-entry',
      message,
    })).rejects.toThrow('queue journal')
    expect((await repository.loadSession(sessionId)).messages).toEqual([])
  })

  it('rejects a queue acknowledgement and recovery with the same ID but a different message', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const runId = 'run-conflicting-queue-recovery'
    const expected: UserMessage = {
      id: 'queue-recovery-conflict',
      role: 'user',
      content: 'expected',
      createdAt: 1,
    }
    const changed: UserMessage = { ...expected, content: 'changed' }
    const entry: AgentSessionJournalEntry = {
      id: 'journal-queue-recovery-conflict',
      sessionId,
      sequence: 0,
      kind: 'queue',
      queueKind: 'steering',
      message: expected,
      status: 'pending',
      createdAt: 1,
    }
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId })
    await repository.appendJournalEntry(sessionId, entry)
    await repository.markJournalEntriesConsuming(sessionId, [entry.id], runId)

    await expect(repository.recordEvent(sessionId, {
      type: 'message_end',
      runId,
      consumedJournalEntryId: entry.id,
      message: changed,
    })).rejects.toThrow('消费事实不匹配')
    await repository.recordEvent(sessionId, { type: 'message_end', runId, message: changed })
    await expect(repository.initialize(defaults)).rejects.toThrow('canonical effect 冲突')
    expect((await repository.loadSession(sessionId)).session.status).toBe('running')
    await expect(repository.recordEvent(sessionId, {
      type: 'agent_start',
      sessionId,
      runId: 'run-after-failed-recovery',
    })).rejects.toThrow('活动 Agent Run')
  })

  it('keeps recovered queue entries as durable drafts across repository initialization', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const entry: AgentSessionJournalEntry = {
      id: 'journal-recovered-draft',
      sessionId,
      sequence: 0,
      kind: 'queue',
      queueKind: 'follow-up',
      message: { id: 'recovered-draft', role: 'user', content: 'keep me', createdAt: 1 },
      status: 'pending',
      createdAt: 1,
    }
    await repository.appendJournalEntry(sessionId, entry)
    await repository.markJournalEntriesRecovered(sessionId, [entry.id])

    const restarted = await repository.initialize(defaults)
    expect(restarted.active.journalEntries).toEqual([
      expect.objectContaining({
        id: entry.id,
        status: 'pending',
        recoveredAt: expect.any(Number),
      }),
    ])
    await expect(repository.markJournalEntriesConsuming(sessionId, [entry.id], 'run-journal'))
      .rejects.toThrow()

    await repository.discardJournalEntries(sessionId, [entry.id])
    expect((await repository.loadSession(sessionId)).journalEntries).toEqual([])
  })

  it('restores pending append/runtime mutations and applies their journal entries atomically', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const message: UserMessage = {
      id: 'journal-append-message',
      role: 'user',
      content: 'durable append',
      createdAt: 2,
    }
    const entries: AgentSessionJournalEntry[] = [
      {
        id: 'journal-append',
        sessionId,
        sequence: 0,
        kind: 'message_append',
        message,
        status: 'pending',
        createdAt: 2,
      },
      {
        id: 'journal-runtime',
        sessionId,
        sequence: 1,
        kind: 'runtime_update',
        update: { systemPrompt: 'durable system' },
        status: 'pending',
        createdAt: 3,
      },
    ]
    for (const entry of entries) await repository.appendJournalEntry(sessionId, entry)

    expect((await repository.initialize(defaults)).active.journalEntries).toEqual(entries)
    const events = [
      { type: 'session_message_append' as const, sessionId, message },
      {
        type: 'runtime_system_prompt_update' as const,
        previous: 'system',
        current: 'durable system',
        source: 'scheduled' as const,
      },
    ]
    await expect(repository.commitMutationBatch(sessionId, {
      id: 'journal-invalid-batch',
      sessionId,
      events,
      journalEntryIds: [entries[0]!.id, 'missing-journal-entry'],
      createdAt: 4,
    })).rejects.toThrow('不可应用')
    expect((await repository.loadSession(sessionId))).toMatchObject({
      messages: [],
      journalEntries: entries,
    })

    const batch = {
      id: 'mutation:journal-append',
      sessionId,
      events,
      journalEntryIds: entries.map((entry) => entry.id),
      createdAt: 4,
    }
    await repository.commitMutationBatch(sessionId, batch)
    await repository.commitMutationBatch(sessionId, batch)
    const committed = await repository.loadSession(sessionId)
    expect(committed.messages).toEqual([message])
    expect(committed.session.systemPrompt).toBe('durable system')
    expect(committed.journalEntries).toEqual([])
    await repository.markJournalEntriesApplied(sessionId, entries.map((entry) => entry.id))
    await repository.initialize(defaults)
    await expect(repository.markJournalEntriesApplied(sessionId, [entries[0]!.id]))
      .rejects.toThrow('不存在')
  })

  it('cleans applied/discarded journal entries after a durable agent settlement', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const entry: AgentSessionJournalEntry = {
      id: 'journal-settled',
      sessionId,
      sequence: 0,
      kind: 'queue',
      queueKind: 'follow-up',
      message: { id: 'queued-settled', role: 'user', content: 'done', createdAt: 1 },
      status: 'pending',
      createdAt: 1,
    }
    await repository.appendJournalEntry(sessionId, entry)
    await repository.markJournalEntriesApplied(sessionId, [entry.id])
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId: 'run-settled' })
    await repository.recordEvent(sessionId, {
      type: 'agent_end',
      sessionId,
      runId: 'run-settled',
      reason: 'completed',
      messages: [],
    })
    await repository.recordEvent(sessionId, {
      type: 'agent_settled',
      savePoint: { sessionId, runId: 'run-settled', messageCount: 0, createdAt: 2 },
    })

    await expect(repository.markJournalEntriesApplied(sessionId, [entry.id]))
      .rejects.toThrow('不存在')
  })

  it('recovers unfinished tools conservatively with one deterministic error ToolResult', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const user: UserMessage = { id: 'tool-user', role: 'user', content: 'inspect', createdAt: 1 }
    const assistant: AssistantMessage = {
      id: 'tool-assistant',
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call-complete', name: 'read', arguments: {}, rawArguments: '{}' },
        { id: 'call-interrupted', name: 'write', arguments: {}, rawArguments: '{}' },
      ],
      stopReason: 'tool_use',
      createdAt: 2,
    }
    const completed: ToolResultMessage = {
      id: 'tool-completed',
      role: 'tool',
      toolCallId: 'call-complete',
      toolName: 'read',
      content: 'done',
      isError: false,
      createdAt: 3,
    }
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId: 'run-tools' })
    await repository.recordEvent(sessionId, { type: 'message_end', runId: 'run-tools', message: user })
    await recordProviderAssistant(repository, sessionId, 'run-tools', assistant)
    for (const [toolCallId, toolName] of [['call-complete', 'read'], ['call-interrupted', 'write']] as const) {
      await repository.recordEvent(sessionId, {
        type: 'tool_execution_start',
        runId: 'run-tools',
        toolCallId,
        toolName,
        arguments: {},
        approvalState: 'not_required',
        recoveryPolicy: 'never',
      })
    }
    await repository.recordEvent(sessionId, {
      type: 'tool_execution_end',
      runId: 'run-tools',
      toolCallId: completed.toolCallId,
      toolName: completed.toolName,
      result: { content: completed.content },
      isError: completed.isError,
      approvalState: 'not_required',
    })
    await repository.recordEvent(sessionId, { type: 'message_end', runId: 'run-tools', message: completed })

    const recovered = await repository.initialize(defaults)
    const interrupted = recovered.active.messages.at(-1)
    expect(recovered.recoveredRuns).toBe(1)
    expect(recovered.active.messages.slice(0, -1)).toEqual([user, assistant, completed])
    expect(interrupted).toMatchObject({
      id: await interruptedToolResultId('run-tools', 'call-interrupted'),
      role: 'tool',
      toolCallId: 'call-interrupted',
      toolName: 'write',
      content: INTERRUPTED_TOOL_RESULT_CONTENT,
      details: { reason: 'application_exit', runId: 'run-tools' },
      isError: true,
    })

    const restarted = await repository.initialize(defaults)
    expect(restarted.active.messages).toEqual(recovered.active.messages)
    expect(restarted.active.messages.filter((message) =>
      message.role === 'tool' && message.toolCallId === 'call-interrupted')).toHaveLength(1)
  })

  it('refuses to finish a run until Tool completion and ToolResult commit together', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const runId = 'run-atomic-tool'
    const result: ToolResultMessage = {
      id: 'tool-atomic-result',
      role: 'tool',
      toolCallId: 'call-atomic',
      toolName: 'read',
      content: 'done',
      isError: false,
      createdAt: 3,
    }
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId })
    await repository.recordEvent(sessionId, {
      type: 'tool_execution_start',
      runId,
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      arguments: {},
      approvalState: 'not_required',
      recoveryPolicy: 'never',
    })
    await repository.recordEvent(sessionId, {
      type: 'tool_execution_end',
      runId,
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      result: { content: result.content },
      isError: false,
      approvalState: 'not_required',
    })
    const agentEnd = {
      type: 'agent_end' as const,
      sessionId,
      runId,
      reason: 'completed' as const,
      messages: [result],
    }

    await expect(repository.recordEvent(sessionId, agentEnd))
      .rejects.toThrow('未与 ToolResult 原子落盘')
    expect((await repository.loadSession(sessionId)).messages).toEqual([])

    await repository.recordEvent(sessionId, { type: 'message_end', runId, message: result })
    await repository.recordEvent(sessionId, agentEnd)
    expect((await repository.loadSession(sessionId)).messages).toEqual([result])
  })

  it('recovers a failed tool finalization and allows the next run to start', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const runId = 'run-failed-finalization'
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId })
    await repository.recordEvent(sessionId, {
      type: 'tool_execution_start',
      runId,
      toolCallId: 'call-failed-finalization',
      toolName: 'write',
      arguments: {},
      approvalState: 'not_required',
      recoveryPolicy: 'never',
    })
    await repository.recordEvent(sessionId, {
      type: 'tool_execution_end',
      runId,
      toolCallId: 'call-failed-finalization',
      toolName: 'write',
      result: { content: 'side effect completed' },
      isError: false,
      approvalState: 'not_required',
    })
    await expect(repository.recordEvent(sessionId, {
      type: 'agent_end',
      sessionId,
      runId,
      reason: 'completed',
      messages: [],
    })).rejects.toThrow('未与 ToolResult 原子落盘')

    await expect(repository.recoverRuntimeState()).resolves.toEqual({ recoveredRuns: 1 })
    expect((await repository.loadSession(sessionId)).session.status).toBe('idle')
    await expect(repository.recordEvent(sessionId, {
      type: 'agent_start',
      sessionId,
      runId: 'run-after-recovery',
    })).resolves.toBeUndefined()
  })

  it('recovers only the target session without disturbing another running session', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionA = initialized.active.session.id
    const sessionB = (await repository.createSession(defaults)).session.id

    await repository.recordEvent(sessionA, { type: 'agent_start', sessionId: sessionA, runId: 'run-a' })
    await repository.recordEvent(sessionB, { type: 'agent_start', sessionId: sessionB, runId: 'run-b' })

    await expect(repository.recoverRuntimeStateForSession(sessionA)).resolves.toEqual({ recoveredRuns: 1 })

    const a = await repository.loadSession(sessionA)
    const b = await repository.loadSession(sessionB)
    expect(a.session.status).toBe('idle')
    // 局部恢复不触碰其他会话的活动 run。
    expect(b.session.status).toBe('running')
    // 目标会话可重新启动新的 Agent Run。
    await expect(repository.recordEvent(sessionA, {
      type: 'agent_start',
      sessionId: sessionA,
      runId: 'run-a2',
    })).resolves.toBeUndefined()
    // 其他会话的活动 run 仍可正常终结。
    await expect(repository.recordEvent(sessionB, {
      type: 'agent_end',
      sessionId: sessionB,
      runId: 'run-b',
      reason: 'completed',
      messages: [],
    })).resolves.toBeUndefined()
  })

  it('commits a fully received Provider response exactly once without replaying unfinished requests', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const assistant: AssistantMessage = {
      id: 'provider-assistant',
      role: 'assistant',
      content: 'durable response',
      toolCalls: [],
      stopReason: 'stop',
      responseId: 'provider-response-1',
      createdAt: 2,
    }
    await repository.recordEvent(sessionId, {
      type: 'agent_start',
      sessionId,
      runId: 'run-provider-response',
    })
    const providerStart = {
      type: 'provider_request_start',
      requestId: 'provider-request-1',
      runId: 'run-provider-response',
      assistantMessageId: assistant.id,
      modelProvider: 'test',
      modelId: 'model',
      messageCount: 1,
      toolCount: 0,
    } as const
    await repository.recordEvent(sessionId, providerStart)
    await expect(repository.recordEvent(sessionId, providerStart)).resolves.toBeUndefined()
    await expect(repository.recordEvent(sessionId, {
      ...providerStart,
      modelId: 'changed-model',
    })).rejects.toThrow('canonical effect')
    const providerResponse = {
      type: 'provider_response_received',
      requestId: 'provider-request-1',
      runId: 'run-provider-response',
      assistantMessageId: assistant.id,
      message: assistant,
    } as const
    await repository.recordEvent(sessionId, providerResponse)
    await expect(repository.recordEvent(sessionId, providerResponse)).resolves.toBeUndefined()
    await expect(repository.recordEvent(sessionId, {
      ...providerResponse,
      message: { ...assistant, content: 'changed response' },
    })).rejects.toThrow('canonical effect')
    await expect(repository.recordEvent(sessionId, {
      type: 'message_end',
      runId: 'run-provider-response',
      message: { ...assistant, content: 'changed response' },
    })).rejects.toThrow('canonical effect')
    expect((await repository.loadSession(sessionId)).messages).toEqual([])
    await expect(repository.recordEvent(sessionId, providerStart)).rejects.toThrow('终态')

    expect((await repository.loadSession(sessionId)).messages).toEqual([])
    expect(await repository.getStats()).toMatchObject({ messageCount: 0, providerRequestCount: 1 })

    const recovered = await repository.initialize(defaults)
    expect(recovered.recoveredRuns).toBe(1)
    expect(recovered.active.messages).toEqual([assistant])
    expect(recovered.active.session.messageCount).toBe(1)
    expect(await repository.getStats()).toMatchObject({ messageCount: 1, providerRequestCount: 1 })
    await expect(repository.recordEvent(sessionId, providerResponse)).resolves.toBeUndefined()

    const restarted = await repository.initialize(defaults)
    expect(restarted.active.messages).toEqual([assistant])
    expect(restarted.active.messages.filter((message) => message.id === assistant.id)).toHaveLength(1)

    await repository.recordEvent(sessionId, {
      type: 'agent_start',
      sessionId,
      runId: 'run-provider-unfinished',
    })
    await repository.recordEvent(sessionId, {
      type: 'provider_request_start',
      requestId: 'provider-request-2',
      runId: 'run-provider-unfinished',
      assistantMessageId: 'provider-assistant-never-received',
      modelProvider: 'test',
      modelId: 'model',
      messageCount: 2,
      toolCount: 0,
    })

    expect((await repository.initialize(defaults)).active.messages).toEqual([assistant])
    expect(await repository.getStats()).toMatchObject({ messageCount: 1, providerRequestCount: 2 })
  })

  it('closes interrupted-run ToolCalls even across pre-start and post-execution crash windows', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const assistant: AssistantMessage = {
      id: 'crash-window-assistant',
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call-before-start', name: 'read', arguments: {}, rawArguments: '{}' },
        { id: 'call-after-end', name: 'write', arguments: {}, rawArguments: '{}' },
      ],
      stopReason: 'tool_use',
      createdAt: 1,
    }
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId: 'run-crash-windows' })
    await recordProviderAssistant(repository, sessionId, 'run-crash-windows', assistant)
    await repository.recordEvent(sessionId, {
      type: 'tool_execution_start',
      runId: 'run-crash-windows',
      toolCallId: 'call-after-end',
      toolName: 'write',
      arguments: {},
      approvalState: 'not_required',
        recoveryPolicy: 'never',
    })
    await repository.recordEvent(sessionId, {
      type: 'tool_execution_end',
      runId: 'run-crash-windows',
      toolCallId: 'call-after-end',
      toolName: 'write',
      result: { content: 'side effect may have completed' },
      isError: false,
      approvalState: 'not_required',
    })

    const recovered = await repository.initialize(defaults)
    expect(recovered.active.messages.slice(1)).toEqual([
      expect.objectContaining({ role: 'tool', toolCallId: 'call-before-start', isError: true }),
      expect.objectContaining({ role: 'tool', toolCallId: 'call-after-end', isError: true }),
    ])
    expect((await repository.initialize(defaults)).active.messages).toEqual(recovered.active.messages)
  })

  it('commits Runtime mutations atomically and retries a stable batch ID idempotently', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const note: UserMessage = {
      id: 'atomic-note',
      role: 'user',
      content: 'atomic',
      createdAt: 1,
    }
    const failedBatch = {
      id: 'mutation-rollback',
      sessionId,
      events: [
        { type: 'session_message_append' as const, sessionId, message: note },
        {
          type: 'session_message_append' as const,
          sessionId: 'another-session',
          message: { ...note, id: 'wrong-session-note' },
        },
      ],
      createdAt: 2,
    }

    await expect(repository.commitMutationBatch(sessionId, failedBatch))
      .rejects.toThrow('不属于当前会话')
    expect((await repository.loadSession(sessionId)).messages).toEqual([])

    await expect(repository.commitMutationBatch(sessionId, {
      id: 'mutation-assistant-injection',
      sessionId,
      events: [{
        type: 'session_message_append',
        sessionId,
        message: {
          id: 'assistant-injection',
          role: 'assistant',
          content: 'forged',
          toolCalls: [],
          stopReason: 'stop',
          createdAt: 2,
        },
      }],
      createdAt: 2,
    })).rejects.toThrow('只允许追加 User 或 Custom')

    const stableBatch = {
      id: 'mutation-stable',
      sessionId,
      events: [
        { type: 'session_message_append' as const, sessionId, message: note },
        {
          type: 'runtime_model_update' as const,
          previous: { provider: 'test', model: 'model' },
          current: { provider: 'test', model: 'model-2' },
          source: 'scheduled' as const,
        },
      ],
      createdAt: 3,
    }
    const committedReceipt = await repository.commitMutationBatch(sessionId, stableBatch)
    expect(committedReceipt).toMatchObject({
      batchId: stableBatch.id,
      sessionId,
      committedAt: stableBatch.createdAt,
      replayed: false,
    })
    const replayedReceipt = await repository.commitMutationBatch(sessionId, {
      ...stableBatch,
      createdAt: stableBatch.createdAt + 100,
    })
    expect(replayedReceipt).toMatchObject({
      batchId: stableBatch.id,
      committedAt: stableBatch.createdAt,
      replayed: true,
    })
    await expect(repository.commitMutationBatch(sessionId, {
      ...stableBatch,
      events: stableBatch.events.slice(1),
    })).rejects.toThrow('canonical effect')
    const restored = await repository.loadSession(sessionId)
    expect(restored.messages).toEqual([note])
    expect(restored.session).toMatchObject({ modelId: 'model-2', messageCount: 1 })
  })

  it('preserves independent Provider profiles across create, update, and branch operations', async () => {
    const providerA: ProviderConfig = {
      schemaVersion: 4,
      profileId: 'test.provider-a',
      providerId: 'generic-anthropic-compatible',
      apiFormat: 'anthropic-compatible',
      endpoint: 'https://provider-a.example/v1/messages',
      modelId: 'model-a',
      timeoutMs: 30_000,
      maxOutputTokens: 4_096,
      contextWindow: 128_000,
      capabilities: { toolReferences: true, toolSearch: false },
    }
    const providerB: ProviderConfig = {
      schemaVersion: 4,
      profileId: 'test.provider-b',
      providerId: 'openai',
      apiFormat: 'openai-responses',
      endpoint: 'https://provider-b.example/v1/responses',
      modelId: 'model-b',
      timeoutMs: 45_000,
      maxOutputTokens: 8_192,
      contextWindow: 256_000,
      capabilities: { toolReferences: false, toolSearch: true },
    }
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize({ ...defaults, providerConfig: providerA })
    const sessionA = initialized.active.session.id
    const createdB = await repository.createSession({
      ...defaults,
      modelProvider: providerB.providerId,
      modelId: providerB.modelId,
      providerConfig: providerB,
    })
    expect((await repository.loadSession(sessionA)).session.providerConfig).toEqual(providerA)
    expect(createdB.session.providerConfig).toEqual(providerB)

    await repository.updateSessionModel(sessionA, {
      ...defaults,
      modelProvider: providerA.providerId,
      modelId: 'model-a-2',
      providerConfig: { ...providerA, modelId: 'model-a-2' },
    })
    const branchBoundary: UserMessage = {
      id: 'provider-b-boundary',
      role: 'user',
      content: 'branch provider B',
      createdAt: 4,
    }
    await repository.commitMutationBatch(createdB.session.id, {
      id: 'mutation:provider-branch-boundary',
      sessionId: createdB.session.id,
      events: [{
        type: 'session_message_append',
        sessionId: createdB.session.id,
        message: branchBoundary,
      }],
      createdAt: branchBoundary.createdAt,
    })
    const branched = await repository.branchSession({
      sourceSessionId: createdB.session.id,
      throughMessageId: branchBoundary.id,
      kind: 'branch',
      defaults: {
        ...defaults,
        modelProvider: providerB.providerId,
        modelId: providerB.modelId,
        providerConfig: providerB,
      },
    })
    expect(branched.session.providerConfig).toEqual(providerB)
    expect((await repository.loadSession(sessionA)).session.providerConfig)
      .toEqual({ ...providerA, modelId: 'model-a-2' })
    expect((await repository.loadSession(createdB.session.id)).session.providerConfig).toEqual(providerB)
  })
  it('persists idle message append and stable Runtime state only through a mutation batch', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const note: UserMessage = {
      id: 'idle-note',
      role: 'user',
      content: 'persisted outside a run',
      createdAt: 1,
    }

    const unsafeRecordEvent = repository.recordEvent.bind(repository) as unknown as (
      targetSessionId: string,
      event: AgentEvent,
    ) => Promise<void>
    await expect(unsafeRecordEvent(sessionId, {
      type: 'session_message_append',
      sessionId,
      message: note,
    })).rejects.toThrow('commitMutationBatch')
    expect((await repository.loadSession(sessionId)).messages).toEqual([])

    await repository.commitMutationBatch(sessionId, {
      id: 'mutation:idle-runtime-state',
      sessionId,
      events: [
        { type: 'session_message_append', sessionId, message: note },
        {
          type: 'runtime_model_update',
          previous: { provider: 'test', model: 'model' },
          current: { provider: 'test', model: 'model-2' },
          source: 'set',
        },
        {
          type: 'runtime_reasoning_update',
          previous: null,
          current: { level: 'high', mode: 'effort' },
          source: 'set',
        },
        {
          type: 'runtime_tools_update',
          previous: { toolNames: [], activeToolNames: [] },
          current: { toolNames: ['read'], activeToolNames: ['read'] },
          source: 'set',
        },
      ],
      createdAt: 2,
    }, runtimeManifest('model-2'))

    const restored = await repository.loadSession(sessionId)
    expect(restored.messages).toEqual([note])
    expect(restored.session).toMatchObject({
      modelId: 'model-2',
      reasoning: { level: 'high', mode: 'effort' },
      activeToolNames: ['read'],
      runtimeManifest: runtimeManifest('model-2'),
    })
  })

  it('atomically replaces dependencies via runtime_dependencies_update (systemPrompt + activeToolNames + manifest)', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const previous = initialized.active.session.runtimeManifest
    if (!previous) throw new Error('missing runtime manifest')
    const currentManifest = runtimeManifest('model', '2')

    await repository.commitMutationBatch(sessionId, {
      id: 'mutation:dependencies-update',
      sessionId,
      events: [{
        type: 'runtime_dependencies_update',
        previous: {
          systemPrompt: 'system',
          activeToolNames: ['discover_agent_tools'],
          runtimeManifest: previous,
        },
        current: {
          systemPrompt: 'system-reloaded',
          activeToolNames: ['discover_agent_tools', 'read'],
          runtimeManifest: currentManifest,
        },
        source: 'set',
        invalidateCheckpoint: true,
      }],
      createdAt: 2,
    }, currentManifest)

    const restored = await repository.loadSession(sessionId)
    expect(restored.session).toMatchObject({
      systemPrompt: 'system-reloaded',
      activeToolNames: ['discover_agent_tools', 'read'],
      runtimeManifest: currentManifest,
    })
  })

  it('rejects runtime_dependencies_update when previous does not match persisted state (CAS)', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const previous = initialized.active.session.runtimeManifest
    if (!previous) throw new Error('missing runtime manifest')

    await expect(repository.commitMutationBatch(sessionId, {
      id: 'mutation:dependencies-cas-fail',
      sessionId,
      events: [{
        type: 'runtime_dependencies_update',
        previous: {
          systemPrompt: 'stale-prompt', // 与持久化 'system' 不匹配
          activeToolNames: ['discover_agent_tools'],
          runtimeManifest: previous,
        },
        current: {
          systemPrompt: 'system-reloaded',
          activeToolNames: ['discover_agent_tools', 'read'],
          runtimeManifest: runtimeManifest('model', '2'),
        },
        source: 'set',
        invalidateCheckpoint: true,
      }],
      createdAt: 2,
    }, runtimeManifest('model', '2'))).rejects.toThrow('CAS 拒绝')
  })

  it('atomically advances the manifest when a previously inactive tool is activated', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const currentManifest = runtimeManifest('model', '2')

    expect(() => assertRuntimeDependenciesCompatible(
      initialized.active.session.runtimeManifest,
      currentManifest,
      ['discover_agent_tools'],
    )).not.toThrow()

    await repository.commitMutationBatch(sessionId, {
      id: 'mutation:activate-upgraded-tool',
      sessionId,
      events: [{
        type: 'runtime_tools_update',
        previous: {
          toolNames: ['discover_agent_tools', 'read'],
          activeToolNames: ['discover_agent_tools'],
        },
        current: {
          toolNames: ['discover_agent_tools', 'read'],
          activeToolNames: ['discover_agent_tools', 'read'],
        },
        source: 'set',
      }],
      createdAt: 2,
    }, currentManifest)

    const restored = await repository.loadSession(sessionId)
    expect(restored.session.runtimeManifest).toEqual(currentManifest)
    expect(() => assertRuntimeDependenciesCompatible(
      restored.session.runtimeManifest,
      currentManifest,
      restored.session.activeToolNames,
    )).not.toThrow()
  })

  it('rejects idle writers while the Session has a running Run', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    await repository.recordEvent(sessionId, {
      type: 'agent_start',
      sessionId,
      runId: 'run-idle-writer-gate',
    })

    await expect(repository.updateSessionModel(sessionId, defaults))
      .rejects.toThrow('只能在空闲状态更新')
    await expect(repository.commitMutationBatch(sessionId, {
      id: 'mutation:runless-writer-gate',
      sessionId,
      events: [{
        type: 'runtime_system_prompt_update',
        previous: defaults.systemPrompt,
        current: 'changed',
        source: 'set',
      }],
      createdAt: 2,
    })).rejects.toThrow('Runless Runtime mutation')
  })

  it('persists lifecycle events and restores the latest session', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const start: AgentEvent = { type: 'agent_start', sessionId, runId: 'run-1' }
    const user: UserMessage = { id: 'u1', role: 'user', content: 'first persisted prompt', createdAt: 1 }
    await repository.recordEvent(sessionId, start)
    await repository.recordEvent(sessionId, { type: 'message_end', runId: 'run-1', message: user })

    const recovered = await repository.initialize(defaults)

    expect(recovered.recoveredRuns).toBe(1)
    expect(recovered.active.messages).toEqual([user])
    expect(recovered.active.session.title).toBe('first persisted prompt')
    expect(recovered.active.session.status).toBe('idle')
  })

  it('atomically replaces the final Memory Session with one empty successor', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const deletedSessionId = initialized.active.session.id

    const successor = await repository.deleteSessionWithSuccessor(deletedSessionId, defaults)

    await expect(repository.loadSession(deletedSessionId)).rejects.toThrow('不存在')
    expect(successor).toMatchObject({ messages: [], checkpoint: null, journalEntries: [] })
    expect(successor.session.id).not.toBe(deletedSessionId)
    expect(await repository.listSessions()).toEqual([successor.session])
  })

  it('clears messages without deleting the active session', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const user: UserMessage = { id: 'u1', role: 'user', content: 'hello', createdAt: 1 }
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId: 'run-1' })
    await repository.recordEvent(sessionId, {
      type: 'tool_execution_start',
      runId: 'run-1',
      toolCallId: 'tool-1',
      toolName: 'read',
      arguments: {},
      approvalState: 'not_required',
        recoveryPolicy: 'never',
    })
    await repository.recordEvent(sessionId, { type: 'message_end', runId: 'run-1', message: user })

    await repository.clearSession(sessionId)
    const snapshot = await repository.loadSession(sessionId)

    expect(snapshot.messages).toEqual([])
    expect(snapshot.session.title).toBe('新会话')
    expect(await repository.getStats()).toMatchObject({
      sessionCount: 1,
      messageCount: 0,
      runCount: 0,
      toolExecutionCount: 0,
    })
  })

  it('keeps the session running until a matching durable Save Point settles it', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const user: UserMessage = { id: 'u-save', role: 'user', content: 'persist me', createdAt: 1 }
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId: 'run-save' })
    await repository.recordEvent(sessionId, { type: 'message_end', runId: 'run-save', message: user })
    await repository.recordEvent(sessionId, {
      type: 'agent_end',
      sessionId,
      runId: 'run-save',
      reason: 'completed',
      messages: [user],
    })

    expect((await repository.loadSession(sessionId)).session.status).toBe('running')
    await expect(repository.recordEvent(sessionId, {
      type: 'agent_settled',
      savePoint: {
        sessionId,
        runId: 'run-save',
        messageCount: 0,
        createdAt: 2,
      },
    })).rejects.toThrow('消息边界不一致')
    expect((await repository.loadSession(sessionId)).session.status).toBe('running')

    await repository.recordEvent(sessionId, {
      type: 'agent_settled',
      savePoint: {
        sessionId,
        runId: 'run-save',
        messageCount: 1,
        lastMessageId: user.id,
        createdAt: 2,
      },
    })
    expect((await repository.loadSession(sessionId)).session.status).toBe('idle')
  })

  it('accepts a turn Save Point only after its mutation batches and message boundary are durable', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const user: UserMessage = { id: 'turn-user', role: 'user', content: 'run', createdAt: 1 }
    const note: UserMessage = { id: 'turn-note', role: 'user', content: 'scheduled', createdAt: 2 }
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId: 'run-turn' })
    await repository.recordEvent(sessionId, { type: 'message_end', runId: 'run-turn', message: user })
    await repository.commitMutationBatch(sessionId, {
      id: 'mutation-turn',
      sessionId,
      runId: 'run-turn',
      turn: 1,
      events: [{ type: 'session_message_append', sessionId, message: note }],
      createdAt: 2,
    })
    const savePoint = {
      sessionId,
      runId: 'run-turn',
      turn: 1,
      mutationBatchIds: ['mutation-turn'],
      hadPendingMutations: true,
      messageCount: 2,
      lastMessageId: note.id,
      createdAt: 3,
    }
    await expect(repository.recordEvent(sessionId, {
      type: 'turn_save_point',
      savePoint: { ...savePoint, mutationBatchIds: ['missing'] },
    })).rejects.toThrow('mutation batch 边界无效')
    await repository.recordEvent(sessionId, { type: 'turn_save_point', savePoint })
    expect((await repository.loadSession(sessionId)).messages).toEqual([user, note])
  })

  it('applies generated titles only while the prompt title is unchanged', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    await repository.renameSession(sessionId, 'first prompt')

    expect(await repository.renameSessionIfTitle(sessionId, 'first prompt', 'Generated title')).toBe(true)
    expect((await repository.loadSession(sessionId)).session.title).toBe('Generated title')

    await repository.renameSession(sessionId, 'User title')
    expect(await repository.renameSessionIfTitle(sessionId, 'Generated title', 'Late model title')).toBe(false)
    expect((await repository.loadSession(sessionId)).session.title).toBe('User title')
  })

  it('persists and clears the latest context checkpoint independently from history', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const user: UserMessage = { id: 'u1', role: 'user', content: 'old prompt', createdAt: 1 }
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId: 'run-1' })
    await repository.recordEvent(sessionId, { type: 'message_end', runId: 'run-1', message: user })
    await repository.recordEvent(sessionId, {
      type: 'compaction_end',
      compactionId: 'compact-1',
      reason: 'manual',
      aborted: false,
      checkpoint: {
        id: 'checkpoint-1',
        sessionId,
        throughMessageId: user.id,
        summary: 'summary',
        summaryHash: await hashContextSummary('summary'),
        reason: 'manual',
        tokensBefore: 100,
        estimatedTokensAfter: 10,
        requestBytesBefore: 1000,
        requestBytesAfter: 100,
        modelProvider: 'test',
        modelId: 'model',
        // 当前版本：projection 正常加载（旧版本会按代际判定过期而丢弃 projection）
        promptVersion: SUMMARY_PROMPT_VERSION,
        excludedMessageIds: [],
        facts: { readFiles: [], modifiedFiles: [] },
        createdAt: 2,
      },
    })

    expect((await repository.loadSession(sessionId)).checkpoint?.summary).toBe('summary')
    expect((await repository.getStats()).checkpointCount).toBe(1)
    await repository.clearSession(sessionId)
    expect((await repository.loadSession(sessionId)).checkpoint).toBeNull()
  })

  it('rejects a checkpoint whose boundary message is not persisted', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id

    await expect(repository.recordEvent(sessionId, {
      type: 'compaction_end',
      compactionId: 'compact-invalid',
      reason: 'manual',
      aborted: false,
      checkpoint: {
        id: 'checkpoint-invalid',
        sessionId,
        throughMessageId: 'missing-message',
        summary: 'summary',
        summaryHash: await hashContextSummary('summary'),
        reason: 'manual',
        tokensBefore: 100,
        estimatedTokensAfter: 10,
        requestBytesBefore: 1000,
        requestBytesAfter: 100,
        modelProvider: 'test',
        modelId: 'model',
        promptVersion: 2,
        excludedMessageIds: [],
        facts: { readFiles: [], modifiedFiles: [] },
        createdAt: 2,
      },
    })).rejects.toThrow('边界消息尚未持久化')
    expect((await repository.getStats()).checkpointCount).toBe(0)
  })

  it('binds a durable Save Point to the latest persisted checkpoint', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const messages: AgentMessage[] = [
      { id: 'u-checkpoint', role: 'user', content: 'old prompt', createdAt: 1 },
      {
        id: 'a-checkpoint',
        role: 'assistant',
        content: 'answer',
        toolCalls: [],
        stopReason: 'stop',
        createdAt: 2,
      },
    ]
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId: 'run-checkpoint' })
    for (const message of messages) {
      if (message.role === 'assistant') {
        await recordProviderAssistant(repository, sessionId, 'run-checkpoint', message)
      } else {
        await repository.recordEvent(sessionId, { type: 'message_end', runId: 'run-checkpoint', message })
      }
    }
    const summary = 'durable summary'
    await repository.recordEvent(sessionId, {
      type: 'compaction_end',
      compactionId: 'compact-save-point',
      reason: 'manual',
      aborted: false,
      checkpoint: {
        id: 'checkpoint-save-point',
        sessionId,
        throughMessageId: 'u-checkpoint',
        summary,
        summaryHash: await hashContextSummary(summary),
        reason: 'manual',
        tokensBefore: 100,
        estimatedTokensAfter: 10,
        requestBytesBefore: 1000,
        requestBytesAfter: 100,
        modelProvider: 'test',
        modelId: 'model',
        promptVersion: 2,
        excludedMessageIds: [],
        facts: { readFiles: [], modifiedFiles: [] },
        createdAt: 3,
      },
    })
    await repository.recordEvent(sessionId, {
      type: 'agent_end',
      sessionId,
      runId: 'run-checkpoint',
      reason: 'completed',
      messages,
    })

    const savePoint = {
      sessionId,
      runId: 'run-checkpoint',
      messageCount: messages.length,
      lastMessageId: 'a-checkpoint',
      createdAt: 4,
    }
    await expect(repository.recordEvent(sessionId, {
      type: 'agent_settled',
      savePoint,
    })).rejects.toThrow('已持久化上下文检查点不一致')
    expect((await repository.loadSession(sessionId)).session.status).toBe('running')

    await repository.recordEvent(sessionId, {
      type: 'agent_settled',
      savePoint: { ...savePoint, checkpointId: 'checkpoint-save-point' },
    })
    expect((await repository.loadSession(sessionId)).session.status).toBe('idle')
  })

  it('rejects corrupted hashes and checkpoint boundaries that split tool results', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const messages: AgentMessage[] = [
      { id: 'u1', role: 'user', content: 'read', createdAt: 1 },
      {
        id: 'a-tools',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read', arguments: {}, rawArguments: '{}' }],
        stopReason: 'tool_use',
        createdAt: 2,
      },
      {
        id: 't-tools',
        role: 'tool',
        toolCallId: 'call-1',
        toolName: 'read',
        content: 'done',
        isError: false,
        createdAt: 3,
      },
    ]
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId: 'run-invalid-checkpoint' })
    for (const message of messages) {
      if (message.role === 'tool') {
        await repository.recordEvent(sessionId, {
          type: 'tool_execution_start',
          runId: 'run-invalid-checkpoint',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          arguments: {},
          approvalState: 'not_required',
          recoveryPolicy: 'never',
        })
        await repository.recordEvent(sessionId, {
          type: 'tool_execution_end',
          runId: 'run-invalid-checkpoint',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          result: { content: message.content },
          isError: message.isError,
          approvalState: 'not_required',
        })
      }
      if (message.role === 'assistant') {
        await recordProviderAssistant(repository, sessionId, 'run-invalid-checkpoint', message)
      } else {
        await repository.recordEvent(sessionId, {
          type: 'message_end',
          runId: 'run-invalid-checkpoint',
          message,
        })
      }
    }
    const baseCheckpoint = {
      id: 'checkpoint-invalid-integrity',
      sessionId,
      throughMessageId: 'u1',
      summary: 'summary',
      summaryHash: await hashContextSummary('summary'),
      reason: 'manual' as const,
      tokensBefore: 100,
      estimatedTokensAfter: 10,
      requestBytesBefore: 1000,
      requestBytesAfter: 100,
      modelProvider: 'test',
      modelId: 'model',
      promptVersion: 2,
      excludedMessageIds: [],
      facts: { readFiles: [], modifiedFiles: [] },
      createdAt: 4,
    }

    await expect(repository.recordEvent(sessionId, {
      type: 'compaction_end',
      compactionId: 'compact-bad-hash',
      reason: 'manual',
      aborted: false,
      checkpoint: { ...baseCheckpoint, summaryHash: '0'.repeat(64) },
    })).rejects.toThrow('摘要哈希校验失败')
    await expect(repository.recordEvent(sessionId, {
      type: 'compaction_end',
      compactionId: 'compact-split-tools',
      reason: 'manual',
      aborted: false,
      checkpoint: { ...baseCheckpoint, id: 'checkpoint-split', throughMessageId: 'a-tools' },
    })).rejects.toThrow('拆分 ToolCall/ToolResult')
    expect((await repository.getStats()).checkpointCount).toBe(0)
  })

  it('creates branch and retry sessions without copying runs, tools, or checkpoints', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const user: UserMessage = { id: 'u1', role: 'user', content: 'inspect', createdAt: 1 }
    const assistant: AssistantMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'read',
      toolCalls: [{ id: 'call-1', name: 'read', arguments: {}, rawArguments: '{}' }],
      stopReason: 'tool_use',
      createdAt: 2,
    }
    const tool: ToolResultMessage = {
      id: 't1',
      role: 'tool',
      toolCallId: 'call-1',
      toolName: 'read',
      content: 'contents',
      artifact: {
        id: `sha256:${'b'.repeat(64)}`,
        kind: 'text',
        mediaType: 'text/plain;charset=utf-8',
        relativePath: `artifacts/sha256/bb/${'b'.repeat(64)}`,
        contentHash: 'b'.repeat(64),
        sizeBytes: 300_000,
        createdAt: 3,
      },
      isError: false,
      createdAt: 3,
    }
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId: 'run-1' })
    await repository.recordEvent(sessionId, { type: 'message_end', runId: 'run-1', message: user })
    await recordProviderAssistant(repository, sessionId, 'run-1', assistant)
    await repository.recordEvent(sessionId, {
      type: 'tool_execution_start',
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'read',
      arguments: {},
      approvalState: 'not_required',
        recoveryPolicy: 'never',
    })
    await repository.recordEvent(sessionId, {
      type: 'tool_execution_end',
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'read',
      result: { content: tool.content },
      isError: false,
      approvalState: 'not_required',
    })
    await repository.recordEvent(sessionId, { type: 'message_end', runId: 'run-1', message: tool })
    await repository.recordEvent(sessionId, {
      type: 'agent_end',
      sessionId,
      runId: 'run-1',
      reason: 'completed',
      messages: [user, assistant, tool],
    })
    await repository.recordEvent(sessionId, {
      type: 'agent_settled',
      savePoint: {
        sessionId,
        runId: 'run-1',
        messageCount: 3,
        lastMessageId: tool.id,
        createdAt: 4,
      },
    })

    const branch = await repository.branchSession({
      sourceSessionId: sessionId,
      throughMessageId: tool.id,
      kind: 'branch',
      defaults,
    })
    const retry = await repository.branchSession({
      sourceSessionId: sessionId,
      throughMessageId: user.id,
      kind: 'retry',
      retriedMessageId: assistant.id,
      defaults,
    })
    const summarized = await repository.branchSession({
      sourceSessionId: sessionId,
      throughMessageId: user.id,
      kind: 'branch',
      summary: {
        content: '## 目标\nremember the abandoned tool exploration',
        sourceFromMessageId: assistant.id,
        sourceThroughMessageId: tool.id,
        readFiles: ['src/read.ts'],
        modifiedFiles: [],
      },
      defaults,
    })

    expect(branch.session).toMatchObject({
      parentSessionId: sessionId,
      forkedFromMessageId: tool.id,
      branchKind: 'branch',
      retriedMessageId: null,
      messageCount: 3,
    })
    expect(branch.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool'])
    expect(branch.messages[2]).toMatchObject({
      role: 'tool',
      artifact: { id: tool.artifact?.id },
    })
    expect(branch.messages.every((message, index) => message.id !== [user, assistant, tool][index]?.id)).toBe(true)
    expect(branch.checkpoint).toBeNull()
    expect(retry.session).toMatchObject({
      parentSessionId: sessionId,
      forkedFromMessageId: user.id,
      branchKind: 'retry',
      retriedMessageId: assistant.id,
      messageCount: 1,
    })
    expect(summarized.session).toMatchObject({ branchKind: 'branch', messageCount: 2 })
    expect(summarized.messages[1]).toMatchObject({
      role: 'custom',
      customType: 'branch-summary',
      data: { sourceFromMessageId: assistant.id, sourceThroughMessageId: tool.id },
    })
    expect(await repository.getStats()).toMatchObject({
      runCount: 1,
      toolExecutionCount: 1,
      checkpointCount: 0,
      artifactCount: 1,
      artifactBytes: 300_000,
    })

    await repository.renameSession(branch.session.id, '  Renamed branch  ')
    expect((await repository.loadSession(branch.session.id)).session.title).toBe('Renamed branch')

    await repository.deleteSession(sessionId)
    expect((await repository.loadSession(branch.session.id)).session).toMatchObject({
      parentSessionId: null,
      forkedFromMessageId: null,
    })
    expect(await repository.getStats()).toMatchObject({ artifactCount: 1, artifactBytes: 300_000 })
    await repository.deleteSession(branch.session.id)
    expect(await repository.getStats()).toMatchObject({ artifactCount: 0, artifactBytes: 0 })
  })

  it('rejects a branch that ends inside a tool result batch', async () => {
    const repository = new MemorySessionRepository()
    const initialized = await repository.initialize(defaults)
    const sessionId = initialized.active.session.id
    const messages: AgentMessage[] = [
      { id: 'u1', role: 'user', content: 'inspect', createdAt: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call-1', name: 'read', arguments: {}, rawArguments: '{}' },
          { id: 'call-2', name: 'read', arguments: {}, rawArguments: '{}' },
        ],
        stopReason: 'tool_use',
        createdAt: 2,
      },
      { id: 't1', role: 'tool', toolCallId: 'call-1', toolName: 'read', content: 'one', isError: false, createdAt: 3 },
    ]
    await repository.recordEvent(sessionId, { type: 'agent_start', sessionId, runId: 'run-1' })
    for (const message of messages) {
      if (message.role === 'tool') {
        await repository.recordEvent(sessionId, {
          type: 'tool_execution_start',
          runId: 'run-1',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          arguments: {},
          approvalState: 'not_required',
          recoveryPolicy: 'never',
        })
        await repository.recordEvent(sessionId, {
          type: 'tool_execution_end',
          runId: 'run-1',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          result: { content: message.content },
          isError: message.isError,
          approvalState: 'not_required',
        })
      }
      if (message.role === 'assistant') {
        await recordProviderAssistant(repository, sessionId, 'run-1', message)
      } else {
        await repository.recordEvent(sessionId, { type: 'message_end', runId: 'run-1', message })
      }
    }
    await repository.recordEvent(sessionId, {
      type: 'agent_end',
      sessionId,
      runId: 'run-1',
      reason: 'completed',
      messages,
    })
    await repository.recordEvent(sessionId, {
      type: 'agent_settled',
      savePoint: {
        sessionId,
        runId: 'run-1',
        messageCount: messages.length,
        lastMessageId: 't1',
        createdAt: 4,
      },
    })

    await expect(repository.branchSession({
      sourceSessionId: sessionId,
      throughMessageId: 't1',
      kind: 'branch',
      defaults,
    })).rejects.toThrow('ToolResult 完成前')
  })
})
