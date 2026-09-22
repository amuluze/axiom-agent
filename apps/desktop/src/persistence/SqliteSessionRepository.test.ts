import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import type { AgentMutationBatch } from '@/agent/core/types'
import type { AgentLifecycleEvent } from '@/persistence/types'
import type { RuntimeDependencyManifest } from '@/agent/runtime/runtimeDependencyManifest'
import {
  NativeSessionDatabase,
  type NativeProviderProfileMigration,
} from '@/platform/sessionDatabase'
import { MemorySessionRepository } from './MemorySessionRepository'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

const artifactMocks = vi.hoisted(() => ({
  trashArtifacts: vi.fn(async () => {
    throw new Error('injected artifact GC failure')
  }),
}))

const runtimeManifest: RuntimeDependencyManifest = {
  schemaVersion: 4,
  provider: {
    providerId: 'test',
    apiFormat: 'openai-compatible',
    modelId: 'model',
    transportVersion: '1',
  },
  tools: [
    { name: 'discover_agent_tools', version: '1', recoveryPolicy: 'never' },
    { name: 'read', version: '2', recoveryPolicy: 'never' },
  ],
  hooks: [{ id: 'axiom.desktop.runtime-hooks', version: '5', fingerprint: 'test-runtime' }],
  skills: { schemaVersion: 1, skills: [] },
}

const runtimeToolsBatch = (sessionId: string): AgentMutationBatch => ({
  id: 'mutation:runtime-tools-contract',
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
})

interface RuntimeToolsContractAdapter {
  commit(manifest?: RuntimeDependencyManifest): Promise<{
    activeToolNames: string[]
    runtimeManifest: RuntimeDependencyManifest
  }>
}

const exerciseRuntimeToolsContract = async (
  adapter: RuntimeToolsContractAdapter,
): Promise<void> => {
  await expect(adapter.commit()).rejects.toThrow(
    'Runtime 工具更新必须原子携带 dependency manifest',
  )
  await expect(adapter.commit(runtimeManifest)).resolves.toEqual({
    activeToolNames: ['discover_agent_tools', 'read'],
    runtimeManifest,
  })
}

vi.mock('@/platform/artifacts', () => ({
  getArtifactStorageStats: vi.fn(async () => null),
  reconcileArtifacts: vi.fn(async () => undefined),
  trashArtifacts: artifactMocks.trashArtifacts,
}))

describe('SqliteSessionRepository destructive commit boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('recovers an interrupted Session before persisting its V2 Provider Profile as V4', async () => {
    const legacyProfile = {
      schemaVersion: 2,
      profileId: 'legacy.minimax',
      providerId: 'minimax',
      apiFormat: 'anthropic-compatible',
      endpoint: 'https://api.minimaxi.com/anthropic/v1/messages',
      modelId: 'MiniMax-M3',
      timeoutMs: 60_000,
      maxOutputTokens: 4_096,
      contextWindow: 128_000,
      capabilities: { toolReferences: false, toolSearch: false },
    }
    const row = {
      id: 'session-v2-provider',
      title: 'Legacy Provider',
      system_prompt: 'system',
      model_provider: 'minimax',
      model_id: 'MiniMax-M3',
      reasoning_json: null,
      active_tool_names_json: '[]',
      provider_config_json: JSON.stringify(legacyProfile),
      runtime_manifest_json: null,
      status: 'running',
      created_at: 10,
      updated_at: 20,
      message_count: 0,
      parent_session_id: null,
      forked_from_message_id: null,
      branch_kind: null,
      retried_message_id: null,
    }
    const migrateSessionProviderProfiles = vi.fn(async (
      migrations: NativeProviderProfileMigration[],
    ) => {
      expect(row.status).toBe('idle')
      expect(migrations[0]?.expectedProviderConfigJson).toBe(row.provider_config_json)
      row.provider_config_json = migrations[0]?.providerConfigJson ?? null
    })
    const database = {
      recoverSessionRepository: vi.fn(async () => {
        row.status = 'idle'
        return { recoveredRuns: 1 }
      }),
      initializeSessionRuntimeDefaults: vi.fn(async () => undefined),
      migrateSessionProviderProfiles,
      select: vi.fn(async (operation: string) => operation === 'sessions' ? [row] : []),
      loadSessionSnapshot: vi.fn(async () => ({
        session: row,
        messages: [],
        latestCheckpoint: null,
        pendingJournal: [],
      })),
    }
    vi.spyOn(NativeSessionDatabase, 'open')
      .mockResolvedValue(database as unknown as NativeSessionDatabase)
    const { SqliteSessionRepository } = await import('./SqliteSessionRepository')
    const repository = await SqliteSessionRepository.open()

    const initialized = await repository.initialize({
      systemPrompt: 'system',
      modelProvider: 'minimax',
      modelId: 'MiniMax-M3',
      activeToolNames: [],
    })
    const migrations = await repository.prepareProviderProfileMigrations()
    expect(migrations).toMatchObject([{
      sessionId: 'session-v2-provider',
      secretMigration: {
        sourceSecretId: 'provider.anthropic-compatible.api-key',
        targetSecretId: 'provider.generic-anthropic-compatible.api-key',
      },
    }])
    await repository.commitProviderProfileMigrations(migrations)

    expect(database.recoverSessionRepository).toHaveBeenCalledOnce()
    expect(initialized.recoveredRuns).toBe(1)
    expect(migrateSessionProviderProfiles).toHaveBeenCalledOnce()
    expect(JSON.parse(row.provider_config_json)).toMatchObject({
      schemaVersion: 4,
      providerId: 'generic-anthropic-compatible',
      secretId: 'provider.generic-anthropic-compatible.api-key',
    })
    expect(initialized.active.session.providerConfig).toMatchObject({
      schemaVersion: 4,
      providerId: 'generic-anthropic-compatible',
      secretId: 'provider.generic-anthropic-compatible.api-key',
    })
  })

  it('does not report committed clear/delete operations as failed when Artifact GC fails', async () => {
    const database = {
      clearSession: vi.fn(async () => undefined),
      select: vi.fn(async (operation: string) => operation === 'unreferencedArtifacts'
        ? [{ id: 'artifact-1', content_hash: 'a'.repeat(64) }]
        : []),
      execute: vi.fn(async () => ({ rowsAffected: 1, lastInsertId: 0 })),
    }
    vi.spyOn(NativeSessionDatabase, 'open')
      .mockResolvedValue(database as unknown as NativeSessionDatabase)
    const { SqliteSessionRepository } = await import('./SqliteSessionRepository')
    const repository = await SqliteSessionRepository.open()

    await expect(repository.clearSession('session-clear')).resolves.toBeUndefined()
    await expect(repository.deleteSession('session-delete')).resolves.toBeUndefined()
    expect(database.clearSession).toHaveBeenNthCalledWith(
      1,
      'session-clear',
      expect.objectContaining({ now: expect.any(Number) }),
    )
    expect(database.clearSession).toHaveBeenNthCalledWith(
      2,
      'session-delete',
      expect.objectContaining({ now: expect.any(Number), deleteSession: true }),
    )
    await vi.waitFor(() => expect(artifactMocks.trashArtifacts).toHaveBeenCalledTimes(2))
    await expect(repository.getStats()).resolves.toMatchObject({
      artifactCleanupWarning: 'injected artifact GC failure',
    })
  })

  it('retries an idempotent settlement once and preserves both failures', async () => {
    const settleSessionRun = vi.fn()
      .mockRejectedValueOnce(new Error('transient invoke failure'))
      .mockResolvedValueOnce(undefined)
    vi.spyOn(NativeSessionDatabase, 'open').mockResolvedValue({
      settleSessionRun,
    } as unknown as NativeSessionDatabase)
    const { SqliteSessionRepository } = await import('./SqliteSessionRepository')
    const repository = await SqliteSessionRepository.open()
    const event = {
      type: 'agent_settled' as const,
      savePoint: {
        sessionId: 'session-settle',
        runId: 'run-settle',
        messageCount: 0,
        createdAt: 1,
      },
    }

    await expect(repository.recordEvent('session-settle', event)).resolves.toBeUndefined()
    expect(settleSessionRun).toHaveBeenCalledTimes(2)

    settleSessionRun.mockReset()
    settleSessionRun
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
    await expect(repository.recordEvent('session-settle', event)).rejects.toThrow(
      'Agent settlement 首次失败：first failure；幂等重试失败：second failure',
    )
    expect(settleSessionRun).toHaveBeenCalledTimes(2)
  })

  it('shares the atomic Runtime tools contract across Memory and SQLite adapters', async () => {
    const memory = new MemorySessionRepository()
    const initialized = await memory.initialize({
      systemPrompt: 'system',
      modelProvider: 'test',
      modelId: 'model',
      activeToolNames: ['discover_agent_tools'],
      runtimeManifest: {
        ...runtimeManifest,
        tools: runtimeManifest.tools.map((tool) => (
          tool.name === 'read' ? { ...tool, version: '1' } : { ...tool }
        )),
      },
    })
    const memorySessionId = initialized.active.session.id
    await exerciseRuntimeToolsContract({
      commit: async (manifest) => {
        await memory.commitMutationBatch(
          memorySessionId,
          runtimeToolsBatch(memorySessionId),
          manifest,
        )
        const restored = await memory.loadSession(memorySessionId)
        if (!restored.session.runtimeManifest) throw new Error('Memory manifest missing')
        return {
          activeToolNames: restored.session.activeToolNames,
          runtimeManifest: restored.session.runtimeManifest,
        }
      },
    })

    vi.spyOn(NativeSessionDatabase, 'open').mockResolvedValue({} as unknown as NativeSessionDatabase)
    const { SqliteSessionRepository } = await import('./SqliteSessionRepository')
    const sqliteRepository = await SqliteSessionRepository.open()
    const sqliteSessionId = 'session-runtime-tools-contract'
    await exerciseRuntimeToolsContract({
      commit: async (manifest) => {
        mockedInvoke.mockResolvedValueOnce({
          batchId: 'mutation:runtime-tools-contract',
          sessionId: sqliteSessionId,
          committedAt: 2,
          replayed: false,
        })
        await sqliteRepository.commitMutationBatch(
          sqliteSessionId,
          runtimeToolsBatch(sqliteSessionId),
          manifest,
        )
        const payload = mockedInvoke.mock.calls.at(-1)?.[1] as {
          request: { activeToolNames: string[]; runtimeManifestJson: string }
        }
        return {
          activeToolNames: payload.request.activeToolNames,
          runtimeManifest: JSON.parse(payload.request.runtimeManifestJson) as RuntimeDependencyManifest,
        }
      },
    })
  })
})

describe('SqliteSessionRepository recordEvent ledger', () => {
  const RUN = 'run-ledger'
  const TOOL_CALL = 'call-ledger-1'

  const createRepository = async (): Promise<{
    repository: import('./SqliteSessionRepository').SqliteSessionRepository
    database: Record<string, ReturnType<typeof vi.fn>>
  }> => {
    const database = {
      startSessionRun: vi.fn(async () => undefined),
      startProviderRequest: vi.fn(async () => undefined),
      receiveProviderResponse: vi.fn(async () => undefined),
      persistSessionMessage: vi.fn(async () => undefined),
      startToolExecution: vi.fn(async () => undefined),
      saveSessionCheckpoint: vi.fn(async () => undefined),
      finishSessionRun: vi.fn(async () => undefined),
      saveSessionTurnPoint: vi.fn(async () => undefined),
      settleSessionRun: vi.fn(async () => undefined),
    }
    vi.spyOn(NativeSessionDatabase, 'open')
      .mockResolvedValue(database as unknown as NativeSessionDatabase)
    const { SqliteSessionRepository } = await import('./SqliteSessionRepository')
    const repository = await SqliteSessionRepository.open()
    return { repository, database }
  }

  const toolStart = (_sessionId: string): AgentLifecycleEvent => ({
    type: 'tool_execution_start',
    runId: RUN,
    toolCallId: TOOL_CALL,
    toolName: 'echo',
    arguments: { value: 'x' },
    approvalState: 'not_required',
    recoveryPolicy: 'never',
  })

  const toolEnd = (_sessionId: string, content: string): AgentLifecycleEvent => ({
    type: 'tool_execution_end',
    runId: RUN,
    toolCallId: TOOL_CALL,
    toolName: 'echo',
    result: { content },
    isError: false,
    approvalState: 'not_required',
  })

  const toolMessageEnd = (_sessionId: string, content: string): AgentLifecycleEvent => ({
    type: 'message_end',
    runId: RUN,
    message: {
      id: 'tool-message-1',
      role: 'tool',
      toolCallId: TOOL_CALL,
      toolName: 'echo',
      content,
      isError: false,
      createdAt: 10,
    },
  })

  it('translates agent_start into startSessionRun', async () => {
    const { repository, database } = await createRepository()
    await repository.recordEvent('session-1', { type: 'agent_start', sessionId: 'session-1', runId: RUN })
    expect(database.startSessionRun).toHaveBeenCalledWith('run-ledger', 'session-1', expect.any(Number))
  })

  it('rejects mutation event types through recordEvent (persistence barrier)', async () => {
    const { repository, database } = await createRepository()
    await expect(repository.recordEvent('session-1', {
      type: 'runtime_tools_update',
      previous: { toolNames: ['read'], activeToolNames: ['read'] },
      current: { toolNames: ['read', 'bash'], activeToolNames: ['read'] },
    } as unknown as AgentLifecycleEvent)).rejects.toThrow('只能通过 commitMutationBatch 持久化')
    expect(database.startToolExecution).not.toHaveBeenCalled()
  })

  it('rejects a provider response whose assistant message ID mismatches', async () => {
    const { repository } = await createRepository()
    await expect(repository.recordEvent('session-1', {
      type: 'provider_response_received',
      requestId: 'req-1',
      runId: RUN,
      assistantMessageId: 'assistant-1',
      message: { id: 'other-message', role: 'assistant', content: '', toolCalls: [], stopReason: 'stop', provider: 'test', model: 'm', createdAt: 1 } as never,
    })).rejects.toThrow('Assistant message ID 不匹配')
  })

  it('rejects a tool result message without a matching pending tool execution', async () => {
    const { repository, database } = await createRepository()
    await expect(repository.recordEvent('session-1', toolMessageEnd('session-1', 'orphan')))
      .rejects.toThrow('缺少匹配的待完成工具执行')
    expect(database.persistSessionMessage).not.toHaveBeenCalled()
  })

  it('persists a tool result atomically with its tool execution fact', async () => {
    const { repository, database } = await createRepository()
    await repository.recordEvent('session-1', toolStart('session-1'))
    await repository.recordEvent('session-1', toolEnd('session-1', 'done'))
    await repository.recordEvent('session-1', toolMessageEnd('session-1', 'done'))
    expect(database.startToolExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        runId: RUN,
        toolCallId: TOOL_CALL,
        toolName: 'echo',
      }),
    )
    expect(database.persistSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        runId: RUN,
        toolExecution: expect.objectContaining({
          toolCallId: TOOL_CALL,
          toolName: 'echo',
          resultPreview: 'done',
          isError: false,
        }),
      }),
    )
  })

  it('rejects an agent_end while tool completion facts are still pending', async () => {
    const { repository, database } = await createRepository()
    await repository.recordEvent('session-1', toolStart('session-1'))
    await repository.recordEvent('session-1', toolEnd('session-1', 'pending-result'))
    await expect(repository.recordEvent('session-1', {
      type: 'agent_end',
      sessionId: 'session-1',
      runId: RUN,
      reason: 'completed',
      messages: [],
    })).rejects.toThrow('仍有未与 ToolResult 原子落盘的工具完成事实')
    expect(database.finishSessionRun).not.toHaveBeenCalled()
  })

  it('rejects a changed tool execution fact before its ToolResult is persisted', async () => {
    const { repository, database } = await createRepository()
    await repository.recordEvent('session-1', toolStart('session-1'))
    await repository.recordEvent('session-1', toolEnd('session-1', 'first'))
    await expect(repository.recordEvent('session-1', toolEnd('session-1', 'changed')))
      .rejects.toThrow('工具完成事实在 ToolResult 持久化前发生变化')
    expect(database.persistSessionMessage).not.toHaveBeenCalled()
  })

  it('rejects a checkpoint bound to another session', async () => {
    const { repository, database } = await createRepository()
    await expect(repository.recordEvent('session-1', {
      type: 'compaction_end',
      compactionId: 'cp-1',
      reason: 'token_threshold' as const,
      aborted: false,
      checkpoint: {
        id: 'cp-1',
        sessionId: 'session-other',
        throughMessageId: 'm-1',
        summary: 's',
        summaryHash: 'h',
        reason: 'token_threshold',
        tokensBefore: 1,
        estimatedTokensAfter: 2,
        requestBytesBefore: 3,
        requestBytesAfter: 4,
        modelProvider: 'p',
        modelId: 'm',
        promptVersion: 2,
        excludedMessageIds: [],
        facts: { readFiles: [], modifiedFiles: [] },
        createdAt: 5,
      },
    })).rejects.toThrow('上下文检查点不属于当前会话')
    expect(database.saveSessionCheckpoint).not.toHaveBeenCalled()
  })

  it('finishes the run only after all tool facts are persisted', async () => {
    const { repository, database } = await createRepository()
    await repository.recordEvent('session-1', toolStart('session-1'))
    await repository.recordEvent('session-1', toolEnd('session-1', 'done'))
    await repository.recordEvent('session-1', toolMessageEnd('session-1', 'done'))
    await repository.recordEvent('session-1', {
      type: 'agent_end',
      sessionId: 'session-1',
      runId: RUN,
      reason: 'completed',
      messages: [],
    })
    expect(database.finishSessionRun).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      runId: RUN,
      endReason: 'completed',
    }))
  })
})

describe('SqliteSessionRepository 队列项顺序（payload.order）', () => {
  const sessionRow = (id: string) => ({
    id,
    title: 't',
    system_prompt: 'system',
    model_provider: 'test',
    model_id: 'model',
    reasoning_json: null,
    active_tool_names_json: '[]',
    provider_config_json: null,
    runtime_manifest_json: null,
    status: 'idle',
    created_at: 1,
    updated_at: 2,
    message_count: 0,
    parent_session_id: null,
    forked_from_message_id: null,
    branch_kind: null,
    retried_message_id: null,
  })

  const createRepository = async (pendingJournal: unknown[] = []) => {
    const database = {
      recoverSessionRepository: vi.fn(async () => ({ recoveredRuns: 0 })),
      initializeSessionRuntimeDefaults: vi.fn(async () => undefined),
      migrateSessionProviderProfiles: vi.fn(async () => undefined),
      select: vi.fn(async (operation: string) => operation === 'sessions' ? [sessionRow('s-order')] : []),
      loadSessionSnapshot: vi.fn(async () => ({
        session: sessionRow('s-order'),
        messages: [],
        latestCheckpoint: null,
        pendingJournal,
      })),
      appendSessionJournalEntry: vi.fn(async (_request: {
        id: string
        sessionId: string
        sequence: number
        kind: string
        queueKind: string | null
        payloadJson: string
        createdAt: number
      }) => undefined),
    }
    vi.spyOn(NativeSessionDatabase, 'open')
      .mockResolvedValue(database as unknown as NativeSessionDatabase)
    const { SqliteSessionRepository } = await import('./SqliteSessionRepository')
    const repository = await SqliteSessionRepository.open()
    return { repository, database }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('把显式 order 编入 payload_json（重排后位置不再由 sequence 决定）', async () => {
    const { repository, database } = await createRepository()
    await repository.appendJournalEntry('s-order', {
      id: 'journal-order',
      sessionId: 's-order',
      sequence: 7,
      kind: 'queue',
      queueKind: 'steering',
      message: { id: 'm1', role: 'user', content: 'moved', createdAt: 1 },
      order: 2.5,
      status: 'pending',
      createdAt: 3,
    })
    const request = database.appendSessionJournalEntry.mock.calls[0]?.[0] as {
      sequence: number
      payloadJson: string
    }
    expect(request.sequence).toBe(7)
    expect(JSON.parse(request.payloadJson)).toEqual({
      message: { id: 'm1', role: 'user', content: 'moved', createdAt: 1 },
      order: 2.5,
    })
  })

  it('恢复时读出 order；无 order 的旧 payload 回落到 undefined 以兼容旧会话', async () => {
    const pendingJournal = [
      {
        id: 'journal-with-order',
        session_id: 's-order',
        sequence: 5,
        kind: 'queue',
        queue_kind: 'steering',
        payload_json: JSON.stringify({
          message: { id: 'm-moved', role: 'user', content: 'moved', createdAt: 1 },
          order: 0.5,
        }),
        status: 'pending',
        consumer_run_id: null,
        created_at: 4,
        recovered_at: null,
      },
      {
        id: 'journal-legacy',
        session_id: 's-order',
        sequence: 6,
        kind: 'queue',
        queue_kind: 'follow-up',
        payload_json: JSON.stringify({
          message: { id: 'm-legacy', role: 'user', content: 'legacy', createdAt: 2 },
        }),
        status: 'pending',
        consumer_run_id: null,
        created_at: 5,
        recovered_at: null,
      },
    ]
    const { repository } = await createRepository(pendingJournal)
    const snapshot = await repository.loadSession('s-order')
    expect(snapshot.journalEntries).toEqual([
      expect.objectContaining({ id: 'journal-with-order', order: 0.5 }),
      expect.objectContaining({ id: 'journal-legacy' }),
    ])
    expect((snapshot.journalEntries[1] as { order?: number }).order).toBeUndefined()
  })

  it('拒绝格式非法的 order（不静默丢弃损坏的队列顺序）', async () => {
    const pendingJournal = [{
      id: 'journal-bad-order',
      session_id: 's-order',
      sequence: 5,
      kind: 'queue',
      queue_kind: 'steering',
      payload_json: JSON.stringify({
        message: { id: 'm1', role: 'user', content: 'bad', createdAt: 1 },
        order: 'first',
      }),
      status: 'pending',
      consumer_run_id: null,
      created_at: 4,
      recovered_at: null,
    }]
    const { repository } = await createRepository(pendingJournal)
    await expect(repository.loadSession('s-order')).rejects.toThrow('queue journal order 无效')
  })
})
