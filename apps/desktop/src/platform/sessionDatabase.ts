import { invoke } from '@tauri-apps/api/core'
import type { ContextCheckpoint } from '@/agent/context/types'

export const DATABASE_VERSION = 15

export type SessionRepositoryQuery =
  | 'sessions'
  | 'settledRunCount'
  | 'sessionCount'
  | 'messageCount'
  | 'runCount'
  | 'toolExecutionCount'
  | 'providerRequestCount'
  | 'checkpointCount'
  | 'artifactCount'
  | 'artifactBytes'
  | 'pageCount'
  | 'pageSize'
  | 'unreferencedArtifacts'
  | 'artifacts'

export type SessionRepositoryMutation =
  | 'createSession'
  | 'renameSession'
  | 'renameSessionIfTitle'
  | 'archiveSession'
  | 'restoreSession'
  | 'clearWorkspaceForPath'

export type JournalTransition =
  | 'consuming'
  | 'restorePending'
  | 'recovered'
  | 'applied'
  | 'discarded'

export interface SessionDatabaseExecuteResult {
  rowsAffected: number
  lastInsertId: number
}

export interface NativeSessionRecoveryResult {
  recoveredRuns: number
}

export interface NativeSessionBranchMessage {
  id: string
  role: string
  contentJson: string
  createdAt: number
  sourceMessageId: string | null
  artifactId: string | null
}

export interface NativeSessionBranchRequest {
  id: string
  title: string
  systemPrompt: string
  modelProvider: string
  modelId: string
  reasoningJson: string | null
  activeToolNamesJson: string
  providerConfigJson: string | null
  runtimeManifestJson: string | null
  workspacePath: string | null
  workspaceName: string | null
  sourceSessionId: string
  throughMessageId: string
  kind: 'branch' | 'retry'
  retriedMessageId: string | null
  createdAt: number
  activatedAt: number
  messages: NativeSessionBranchMessage[]
}

export interface NativeSessionSettlementRequest {
  sessionId: string
  runId: string
  messageCount: number
  lastMessageId?: string
  checkpointId?: string
  now: number
}

export interface NativeSessionRuntimeConfigRequest {
  sessionId: string
  systemPrompt: string
  modelProvider: string
  modelId: string
  reasoningJson: string | null
  activeToolNamesJson: string
  providerConfigJson: string | null
  runtimeManifestJson: string | null
  now: number
}

export interface NativeProviderProfileMigration {
  sessionId: string
  expectedProviderConfigJson: string
  providerConfigJson: string
}

const MAX_PROVIDER_PROFILE_MIGRATIONS = 4096
const MAX_SESSION_REPOSITORY_REQUEST_BYTES = 2 * 1024 * 1024

const validateProviderProfileMigrationRequest = (
  migrations: NativeProviderProfileMigration[],
): void => {
  const request = { migrations }
  const encodedBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength
  if (migrations.length === 0
    || migrations.length > MAX_PROVIDER_PROFILE_MIGRATIONS
    || encodedBytes > MAX_SESSION_REPOSITORY_REQUEST_BYTES) {
    throw new Error('Provider Profile 迁移为空或超过安全上限')
  }
}

export interface NativeDeleteSessionWithSuccessorRequest {
  sessionId: string
  successorId: string
  systemPrompt: string
  modelProvider: string
  modelId: string
  reasoningJson: string | null
  activeToolNamesJson: string
  providerConfigJson: string | null
  runtimeManifestJson: string | null
  now: number
}

export interface NativeSessionRuntimeDefaultsRequest {
  modelProvider: string
  modelId: string
  providerConfigJson: string | null
  runtimeManifestJson: string | null
}

export interface NativeAppendSessionJournalEntryRequest {
  id: string
  sessionId: string
  sequence: number
  kind: 'queue' | 'message_append' | 'runtime_update'
  queueKind: 'steering' | 'follow-up' | 'next-turn' | null
  payloadJson: string
  createdAt: number
}

export interface NativeSessionFinishRunRequest {
  sessionId: string
  runId: string
  endReason: string
  errorMessage?: string
  now: number
}

export interface NativeProviderRequestStartRequest {
  requestId: string
  sessionId: string
  runId: string
  assistantMessageId: string
  modelProvider: string
  modelId: string
  messageCount: number
  toolCount: number
  startedAt: number
}

export interface NativeProviderResponseRequest {
  requestId: string
  sessionId: string
  runId: string
  assistantMessageId: string
  responseId?: string
  responseModel?: string
  responseMessageJson: string
  responseReceivedAt: number
}

export interface NativeToolExecutionStartRequest {
  sessionId: string
  runId: string
  toolCallId: string
  toolName: string
  argumentsJson: string
  approvalState: 'not_required' | 'pending'
  recoveryPolicy: 'never' | 'idempotent'
  idempotencyKey?: string
  startedAt: number
}

export interface NativeSessionTurnSavePointRequest {
  sessionId: string
  runId: string
  turn: number
  mutationBatchIds: string[]
  hadPendingMutations: boolean
  messageCount: number
  lastMessageId?: string
  checkpointId?: string
  createdAt: number
}

export interface NativeSessionMessageRequest {
  sessionId: string
  runId?: string
  consumedJournalEntryId?: string
  messageId: string
  role: string
  contentJson: string
  createdAt: number
  sessionTitle?: string
  toolExecution?: {
    toolCallId: string
    toolName: string
    resultPreview: string
    detailsJson?: string
    isError: boolean
    approvalState: 'not_required' | 'approved' | 'denied'
    endedAt: number
  }
  now: number
}

export interface NativeSessionSnapshotRows<TSession, TMessage, TCheckpoint, TJournal> {
  session: TSession | null
  messages: TMessage[]
  latestCheckpoint: TCheckpoint | null
  pendingJournal: TJournal[]
}

export type NativeSessionCheckpointRequest = ContextCheckpoint

export class NativeSessionDatabase {
  static async open(): Promise<NativeSessionDatabase> {
    await invoke<void>('initialize_session_repository')
    return new NativeSessionDatabase()
  }

  select<T>(operation: SessionRepositoryQuery, parameters: unknown[] = []): Promise<T> {
    return invoke<T>('query_session_repository', { operation, parameters })
  }

  loadSessionSnapshot<TSession, TMessage, TCheckpoint, TJournal>(
    sessionId: string,
  ): Promise<NativeSessionSnapshotRows<TSession, TMessage, TCheckpoint, TJournal>> {
    return invoke('load_session_repository_snapshot', { sessionId })
  }

  execute(
    operation: SessionRepositoryMutation,
    parameters: unknown[] = [],
  ): Promise<SessionDatabaseExecuteResult> {
    return invoke<SessionDatabaseExecuteResult>('execute_session_repository', {
      operation,
      parameters,
    })
  }

  recoverSessionRepository(now: number): Promise<NativeSessionRecoveryResult> {
    return invoke<NativeSessionRecoveryResult>('recover_session_repository', { now })
  }

  /** 会话级局部恢复：只复位指定会话的卡死运行态，不影响其他会话。 */
  recoverSessionRepositoryFor(sessionId: string, now: number): Promise<NativeSessionRecoveryResult> {
    return invoke<NativeSessionRecoveryResult>('recover_session_repository_session', {
      sessionId,
      now,
    })
  }

  initializeSessionRuntimeDefaults(request: NativeSessionRuntimeDefaultsRequest): Promise<void> {
    return invoke<void>('initialize_session_runtime_defaults', { request })
  }

  clearSession(
    sessionId: string,
    options: { now: number; deleteSession?: boolean },
  ): Promise<void> {
    return invoke<void>('clear_session_repository', {
      request: {
        sessionId,
        now: options.now,
        deleteSession: options.deleteSession ?? false,
      },
    })
  }

  deleteSessionWithSuccessor(request: NativeDeleteSessionWithSuccessorRequest): Promise<void> {
    return invoke<void>('delete_session_with_successor', { request })
  }

  createSessionBranch(request: NativeSessionBranchRequest): Promise<void> {
    return invoke<void>('create_session_branch', { request })
  }

  updateSessionRuntimeConfig(request: NativeSessionRuntimeConfigRequest): Promise<void> {
    return invoke<void>('update_session_runtime_config', { request })
  }

  async migrateSessionProviderProfiles(migrations: NativeProviderProfileMigration[]): Promise<void> {
    validateProviderProfileMigrationRequest(migrations)
    await invoke<void>('migrate_session_provider_profiles', { request: { migrations } })
  }

  appendSessionJournalEntry(request: NativeAppendSessionJournalEntryRequest): Promise<void> {
    return invoke<void>('append_session_journal_entry', { request })
  }

  deleteUnreferencedArtifactMetadata(artifactId: string): Promise<void> {
    return invoke<void>('delete_unreferenced_artifact_metadata', { artifactId })
  }

  startSessionRun(runId: string, sessionId: string, now: number): Promise<void> {
    return invoke<void>('start_session_run', {
      request: { runId, sessionId, now },
    })
  }

  startProviderRequest(request: NativeProviderRequestStartRequest): Promise<void> {
    return invoke<void>('start_provider_request', { request })
  }

  receiveProviderResponse(request: NativeProviderResponseRequest): Promise<void> {
    return invoke<void>('receive_provider_response', { request })
  }

  startToolExecution(request: NativeToolExecutionStartRequest): Promise<void> {
    return invoke<void>('start_tool_execution', { request })
  }

  finishSessionRun(request: NativeSessionFinishRunRequest): Promise<void> {
    return invoke<void>('finish_session_run', { request })
  }

  saveSessionTurnPoint(request: NativeSessionTurnSavePointRequest): Promise<void> {
    return invoke<void>('save_session_turn_point', { request })
  }

  persistSessionMessage(request: NativeSessionMessageRequest): Promise<void> {
    return invoke<void>('persist_session_message', { request })
  }

  saveSessionCheckpoint(request: NativeSessionCheckpointRequest): Promise<void> {
    return invoke<void>('save_session_checkpoint', { request })
  }

  settleSessionRun(request: NativeSessionSettlementRequest): Promise<void> {
    return invoke<void>('settle_session_run', { request })
  }

  transitionJournalEntries(
    sessionId: string,
    entryIds: string[],
    transition: JournalTransition,
    options: { runId?: string; now?: number } = {},
  ): Promise<void> {
    return invoke<void>('transition_session_journal_entries', {
      request: {
        sessionId,
        entryIds,
        transition,
        ...options,
      },
    })
  }
}
