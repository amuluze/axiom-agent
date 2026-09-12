import type {
  AgentEvent,
  AgentMessage,
  AgentMutationBatch,
  AgentMutationEvent,
  AgentMutationReceipt,
  ModelReasoning,
} from '@/agent/core/types'
import type { ContextCheckpoint } from '@/agent/context/types'
import type { BranchSummarySource } from '@/agent/session/branch'
import type { ProviderProfile, ProviderSecretMigration } from '@/agent/transport/provider'
import type { AgentSessionJournalEntry } from '@/agent/runtime/mutationJournal'
import type { RuntimeDependencyManifest } from '@/agent/runtime/runtimeDependencyManifest'

export type AgentLifecycleEvent = Exclude<AgentEvent, AgentMutationEvent>

export interface SessionDefaults {
  systemPrompt: string
  modelProvider: string
  modelId: string
  reasoning?: ModelReasoning | null
  activeToolNames?: string[]
  providerConfig?: ProviderProfile
  runtimeManifest?: RuntimeDependencyManifest
  workspace?: {
    path: string
    name: string
    gitBranch?: string | null
  } | null
}

export interface StoredAgentSession {
  id: string
  title: string
  systemPrompt: string
  modelProvider: string
  modelId: string
  reasoning: ModelReasoning | null
  activeToolNames: string[]
  providerConfig: ProviderProfile | null
  runtimeManifest: RuntimeDependencyManifest | null
  status: 'idle' | 'running'
  createdAt: number
  updatedAt: number
  messageCount: number
  parentSessionId: string | null
  forkedFromMessageId: string | null
  branchKind: 'branch' | 'retry' | null
  retriedMessageId: string | null
  workspace?: {
    path: string
    name: string
    gitBranch?: string | null
  } | null
  archivedAt?: number | null
}

export interface SessionBranchRequest {
  sourceSessionId: string
  throughMessageId: string
  kind: 'branch' | 'retry'
  retriedMessageId?: string
  summary?: BranchSummarySource
  defaults: SessionDefaults
}

export interface SessionSnapshot {
  session: StoredAgentSession
  messages: AgentMessage[]
  checkpoint: ContextCheckpoint | null
  journalEntries: AgentSessionJournalEntry[]
}

export interface SessionInitialization {
  sessions: StoredAgentSession[]
  active: SessionSnapshot
  recoveredRuns: number
  artifactIntegrityWarning?: string
}

export interface ProviderProfilePersistenceMigration {
  sessionId: string
  expectedProviderConfigJson: string
  profile: ProviderProfile
  secretMigration?: ProviderSecretMigration
}

export interface RuntimeRecoveryResult {
  recoveredRuns: number
}

export interface StorageStats {
  sessionCount: number
  messageCount: number
  runCount: number
  toolExecutionCount: number
  providerRequestCount: number
  checkpointCount: number
  artifactCount: number
  artifactBytes: number
  artifactTrashCount: number
  artifactTrashBytes: number
  databaseBytes: number
  artifactCleanupWarning?: string
}

export interface SessionRepository {
  prepareProviderProfileMigrations(): Promise<ProviderProfilePersistenceMigration[]>
  commitProviderProfileMigrations(migrations: ProviderProfilePersistenceMigration[]): Promise<void>
  initialize(defaults: SessionDefaults): Promise<SessionInitialization>
  recoverRuntimeState(): Promise<RuntimeRecoveryResult>
  /** 只复位指定会话的卡死运行态（run→interrupted、session→idle），不影响其他会话。 */
  recoverRuntimeStateForSession(sessionId: string): Promise<RuntimeRecoveryResult>
  createSession(defaults: SessionDefaults): Promise<SessionSnapshot>
  branchSession(request: SessionBranchRequest): Promise<SessionSnapshot>
  loadSession(sessionId: string): Promise<SessionSnapshot>
  listSessions(): Promise<StoredAgentSession[]>
  updateSessionModel(sessionId: string, defaults: SessionDefaults): Promise<void>
  commitMutationBatch(
    sessionId: string,
    batch: AgentMutationBatch,
    runtimeManifest?: RuntimeDependencyManifest,
  ): Promise<AgentMutationReceipt>
  appendJournalEntry(sessionId: string, entry: AgentSessionJournalEntry): Promise<void>
  markJournalEntriesConsuming(sessionId: string, entryIds: string[], runId: string): Promise<void>
  restoreJournalEntries(sessionId: string, entryIds: string[]): Promise<void>
  markJournalEntriesRecovered(sessionId: string, entryIds: string[]): Promise<void>
  markJournalEntriesApplied(sessionId: string, entryIds: string[]): Promise<void>
  discardJournalEntries(sessionId: string, entryIds: string[]): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>
  renameSessionIfTitle(sessionId: string, expectedTitle: string, title: string): Promise<boolean>
  archiveSession(sessionId: string, archivedAt: number): Promise<void>
  restoreSession(sessionId: string): Promise<void>
  /**
   * 清空所有引用该 path 的 session 的 workspace 字段。撤销授权时调用，
   * 避免 DB 残留导致重启时被 hydrateSessionMetadata 反向写回 localStorage。
   * 返回受影响的 session 数。
   */
  clearWorkspaceForPath(path: string): Promise<number>
  recordEvent(sessionId: string, event: AgentLifecycleEvent): Promise<void>
  clearSession(sessionId: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  deleteSessionWithSuccessor(sessionId: string, defaults: SessionDefaults): Promise<SessionSnapshot>
  getStats(): Promise<StorageStats>
}
