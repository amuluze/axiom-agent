import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeSessionDatabase } from './sessionDatabase'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

describe('NativeSessionDatabase', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('initializes the native repository before exposing the port', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    const database = await NativeSessionDatabase.open()
    expect(database).toBeInstanceOf(NativeSessionDatabase)
    expect(mockedInvoke).toHaveBeenCalledWith('initialize_session_repository')
  })

  it('sends only named operations and scalar parameter arrays', async () => {
    mockedInvoke.mockResolvedValueOnce([{ count: 1 }])
    const database = new NativeSessionDatabase()
    await database.select('settledRunCount', ['run-1', 'session-1'])
    expect(mockedInvoke).toHaveBeenCalledWith('query_session_repository', {
      operation: 'settledRunCount',
      parameters: ['run-1', 'session-1'],
    })

    mockedInvoke.mockResolvedValueOnce({ rowsAffected: 1, lastInsertId: 0 })
    await database.execute('renameSession', ['Title', 1, 'session-1'])
    expect(mockedInvoke).toHaveBeenLastCalledWith('execute_session_repository', {
      operation: 'renameSession',
      parameters: ['Title', 1, 'session-1'],
    })
  })

  it('loads one complete session snapshot through one native transaction command', async () => {
    const snapshot = {
      session: { id: 'session-1' },
      messages: [{ content_json: '{}' }],
      latestCheckpoint: null,
      pendingJournal: [],
    }
    mockedInvoke.mockResolvedValueOnce(snapshot)
    const database = new NativeSessionDatabase()

    await expect(database.loadSessionSnapshot('session-1')).resolves.toEqual(snapshot)
    expect(mockedInvoke).toHaveBeenCalledWith('load_session_repository_snapshot', {
      sessionId: 'session-1',
    })
  })

  it('uses a dedicated journal transition command for dynamic entry sets', async () => {
    mockedInvoke.mockResolvedValueOnce(undefined)
    const database = new NativeSessionDatabase()
    await database.transitionJournalEntries(
      'session-1',
      ['journal-1', 'journal-2'],
      'consuming',
      { runId: 'run-1' },
    )
    expect(mockedInvoke).toHaveBeenCalledWith('transition_session_journal_entries', {
      request: {
        sessionId: 'session-1',
        entryIds: ['journal-1', 'journal-2'],
        transition: 'consuming',
        runId: 'run-1',
      },
    })
  })

  it('recovers the complete repository graph through one native transaction command', async () => {
    mockedInvoke.mockResolvedValueOnce({ recoveredRuns: 2 })
    const database = new NativeSessionDatabase()

    await expect(database.recoverSessionRepository(42)).resolves.toEqual({ recoveredRuns: 2 })
    expect(mockedInvoke).toHaveBeenCalledWith('recover_session_repository', { now: 42 })
  })

  it('uses dedicated commands for initialization backfill, journal append, and Artifact cleanup', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    const database = new NativeSessionDatabase()
    const defaults = {
      modelProvider: 'test',
      modelId: 'model',
      providerConfigJson: '{"kind":"test"}',
      runtimeManifestJson: '{"provider":{"kind":"test","model":"model"}}',
    }
    await database.initializeSessionRuntimeDefaults(defaults)
    expect(mockedInvoke).toHaveBeenLastCalledWith('initialize_session_runtime_defaults', {
      request: defaults,
    })

    const journal = {
      id: 'journal-1',
      sessionId: 'session-1',
      sequence: 0,
      kind: 'message_append' as const,
      queueKind: null,
      payloadJson: '{"message":{"id":"message-1"}}',
      createdAt: 1,
    }
    await database.appendSessionJournalEntry(journal)
    expect(mockedInvoke).toHaveBeenLastCalledWith('append_session_journal_entry', {
      request: journal,
    })

    await database.deleteUnreferencedArtifactMetadata('artifact-1')
    expect(mockedInvoke).toHaveBeenLastCalledWith('delete_unreferenced_artifact_metadata', {
      artifactId: 'artifact-1',
    })
  })

  it('uses one native transaction command to clear or delete a session', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    const database = new NativeSessionDatabase()

    await database.clearSession('session-1', { now: 42 })
    expect(mockedInvoke).toHaveBeenLastCalledWith('clear_session_repository', {
      request: {
        sessionId: 'session-1',
        now: 42,
        deleteSession: false,
      },
    })

    await database.clearSession('session-1', { now: 43, deleteSession: true })
    expect(mockedInvoke).toHaveBeenLastCalledWith('clear_session_repository', {
      request: {
        sessionId: 'session-1',
        now: 43,
        deleteSession: true,
      },
    })
  })

  it('atomically replaces the final Session through one native command', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    const database = new NativeSessionDatabase()
    const request = {
      sessionId: 'session-1',
      successorId: 'session-2',
      systemPrompt: 'system',
      modelProvider: 'test',
      modelId: 'model',
      reasoningJson: null,
      activeToolNamesJson: '[]',
      providerConfigJson: null,
      runtimeManifestJson: null,
      now: 42,
    }

    await database.deleteSessionWithSuccessor(request)
    expect(mockedInvoke).toHaveBeenCalledWith('delete_session_with_successor', { request })
  })

  it('sends the complete branch graph through one native transaction command', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    const database = new NativeSessionDatabase()
    const request = {
      id: 'session-branch',
      title: 'Session · 分支',
      systemPrompt: 'system',
      modelProvider: 'test',
      modelId: 'model',
      reasoningJson: null,
      activeToolNamesJson: '[]',
      providerConfigJson: null,
      runtimeManifestJson: null,
      workspacePath: '/repo',
      workspaceName: 'repo',
      sourceSessionId: 'session-1',
      throughMessageId: 'message-1',
      kind: 'branch' as const,
      retriedMessageId: null,
      createdAt: 42,
      activatedAt: 42,
      messages: [{
        id: 'message-copy-1',
        role: 'user',
        contentJson: '{"id":"message-copy-1","role":"user","content":"hi","createdAt":1}',
        createdAt: 1,
        sourceMessageId: 'message-1',
        artifactId: null,
      }],
    }

    await database.createSessionBranch(request)
    expect(mockedInvoke).toHaveBeenCalledWith('create_session_branch', { request })
  })

  it('updates Runtime configuration through a dedicated native command', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    const database = new NativeSessionDatabase()
    const request = {
      sessionId: 'session-1',
      systemPrompt: 'system',
      modelProvider: 'test',
      modelId: 'model-2',
      reasoningJson: null,
      activeToolNamesJson: '[]',
      providerConfigJson: null,
      runtimeManifestJson: null,
      now: 42,
    }

    await database.updateSessionRuntimeConfig(request)
    expect(mockedInvoke).toHaveBeenCalledWith('update_session_runtime_config', { request })
  })

  it('migrates Provider Profiles through one native transaction command', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    const database = new NativeSessionDatabase()
    const migrations = [{
      sessionId: 'session-1',
      expectedProviderConfigJson: '{"schemaVersion":2}',
      providerConfigJson: '{"schemaVersion":3}',
    }]

    await database.migrateSessionProviderProfiles(migrations)

    expect(mockedInvoke).toHaveBeenCalledWith('migrate_session_provider_profiles', {
      request: { migrations },
    })
  })

  it('rejects Provider Profile migration count and payloads above native limits', async () => {
    const database = new NativeSessionDatabase()
    const migration = (index: number) => ({
      sessionId: `session-${index}`,
      expectedProviderConfigJson: '{"schemaVersion":2}',
      providerConfigJson: '{"schemaVersion":3}',
    })

    await expect(database.migrateSessionProviderProfiles(
      Array.from({ length: 4097 }, (_, index) => migration(index)),
    )).rejects.toThrow('超过安全上限')
    await expect(database.migrateSessionProviderProfiles([{
      ...migration(1),
      providerConfigJson: JSON.stringify({ value: 'x'.repeat(2 * 1024 * 1024) }),
    }])).rejects.toThrow('超过安全上限')
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('starts the run and session through one native transaction command', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    const database = new NativeSessionDatabase()

    await database.startSessionRun('run-1', 'session-1', 42)
    expect(mockedInvoke).toHaveBeenCalledWith('start_session_run', {
      request: { runId: 'run-1', sessionId: 'session-1', now: 42 },
    })
  })

  it('finishes the run through one native transaction command', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    const database = new NativeSessionDatabase()
    const request = {
      sessionId: 'session-1',
      runId: 'run-1',
      endReason: 'error',
      errorMessage: 'provider failed',
      now: 42,
    }

    await database.finishSessionRun(request)
    expect(mockedInvoke).toHaveBeenCalledWith('finish_session_run', { request })
  })

  it('validates and persists a turn save point through one native transaction command', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    const database = new NativeSessionDatabase()
    const request = {
      sessionId: 'session-1',
      runId: 'run-1',
      turn: 2,
      mutationBatchIds: ['mutation-1'],
      hadPendingMutations: true,
      messageCount: 4,
      lastMessageId: 'message-4',
      checkpointId: 'checkpoint-1',
      createdAt: 42,
    }

    await database.saveSessionTurnPoint(request)
    expect(mockedInvoke).toHaveBeenCalledWith('save_session_turn_point', { request })
  })

  it('persists a finalized message through one native transaction command', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    const database = new NativeSessionDatabase()
    const request = {
      sessionId: 'session-1',
      runId: 'run-1',
      consumedJournalEntryId: 'journal-1',
      messageId: 'message-1',
      role: 'user',
      contentJson: '{"id":"message-1","role":"user","content":"hello","createdAt":1}',
      createdAt: 1,
      sessionTitle: 'hello',
      now: 42,
    }

    await database.persistSessionMessage(request)
    expect(mockedInvoke).toHaveBeenCalledWith('persist_session_message', { request })
  })

  it('validates and persists a checkpoint through one native transaction command', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    const database = new NativeSessionDatabase()
    const request = {
      id: 'checkpoint-1',
      sessionId: 'session-1',
      throughMessageId: 'message-1',
      summary: 'summary',
      summaryHash: '0'.repeat(64),
      reason: 'manual' as const,
      tokensBefore: 10,
      estimatedTokensAfter: 5,
      requestBytesBefore: 100,
      requestBytesAfter: 50,
      modelProvider: 'test',
      modelId: 'model',
      promptVersion: 2,
      excludedMessageIds: [],
      facts: { readFiles: [], modifiedFiles: [] },
      createdAt: 42,
    }

    await database.saveSessionCheckpoint(request)
    expect(mockedInvoke).toHaveBeenCalledWith('save_session_checkpoint', { request })
  })

  it('validates the save point and settles the session through one native transaction command', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    const database = new NativeSessionDatabase()
    const request = {
      sessionId: 'session-1',
      runId: 'run-1',
      messageCount: 2,
      lastMessageId: 'message-2',
      checkpointId: 'checkpoint-1',
      now: 42,
    }

    await database.settleSessionRun(request)
    expect(mockedInvoke).toHaveBeenCalledWith('settle_session_run', { request })
  })
})
