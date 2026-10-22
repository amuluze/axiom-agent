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
import type { AccessMode } from '@/agent/approval/ApprovalCoordinator'

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
  accessMode?: AccessMode
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
  /** 启动恢复摘要（已完成/已失败/状态未知 + 受影响会话）；无恢复时全零。 */
  recoverySummary: RecoverySummary
  artifactIntegrityWarning?: string
}

export interface ProviderProfilePersistenceMigration {
  sessionId: string
  expectedProviderConfigJson: string
  profile: ProviderProfile
  secretMigration?: ProviderSecretMigration
}

/** 恢复摘要：区分中断 run 的处置，并给出可能已落地的工具调用与受影响会话。 */
export interface RecoverySummary {
  recoveredRuns: number
  /** 已收到 Provider response（成果会被结算）的中断 run。 */
  completedRuns: number
  /** 最后一次持久化信号为工具失败的中断 run。 */
  failedRuns: number
  /** 在途、无持久化结果可判定的中断 run。 */
  unknownRuns: number
  /** 被中断、可能从未执行的工具调用。 */
  interruptedToolExecutions: number
  /** 已执行（完成或失败）但结果未保存、可能已产生落地副作用的工具调用。 */
  possiblyExecutedToolExecutions: number
  /** 受影响会话（含中断 run）的 id。 */
  recoveredSessions: string[]
}

export const EMPTY_RECOVERY_SUMMARY: RecoverySummary = {
  recoveredRuns: 0,
  completedRuns: 0,
  failedRuns: 0,
  unknownRuns: 0,
  interruptedToolExecutions: 0,
  possiblyExecutedToolExecutions: 0,
  recoveredSessions: [],
}

export const mergeRecoverySummaries = (
  base: RecoverySummary,
  next: RecoverySummary,
): RecoverySummary => ({
  recoveredRuns: base.recoveredRuns + next.recoveredRuns,
  completedRuns: base.completedRuns + next.completedRuns,
  failedRuns: base.failedRuns + next.failedRuns,
  unknownRuns: base.unknownRuns + next.unknownRuns,
  interruptedToolExecutions: base.interruptedToolExecutions + next.interruptedToolExecutions,
  possiblyExecutedToolExecutions:
    base.possiblyExecutedToolExecutions + next.possiblyExecutedToolExecutions,
  recoveredSessions: [...new Set([...base.recoveredSessions, ...next.recoveredSessions])].sort(),
})

export type RuntimeRecoveryResult = RecoverySummary

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
  updateSessionAccessMode(sessionId: string, mode: AccessMode): Promise<void>
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
