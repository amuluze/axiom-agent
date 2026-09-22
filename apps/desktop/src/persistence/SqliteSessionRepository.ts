/**
 * SQLite 会话仓库（WebView 侧编码/回放层；实际 SQLite 执行在 Rust `session_repository`）。
 *
 * 依赖边界（第 3 项优化，2026-09）：本文件允许 import `agent/` 的领域纯函数与类型——
 * 消息编码/checkpoint 完整性校验/分支重试目标断言/会话标题生成等无副作用 schema 契约，
 * 它们随 agent 领域演进而同步属预期（AGENTS.md 导入规则已声明）；禁止依赖 agent 运行时
 * 副作用（AgentHarness/环境/审批协调器）。若未来 agent 领域模块继续膨胀导致本仓库过重，
 * 应把编解码与断言下沉为独立共享契约层（persistence 与 agent 共同依赖），而非反向依赖。
 * 对 `platform/` 的依赖仅限 Tauri 命令封装（artifacts/sessionMutations/sessionDatabase）。
 */
import { createId } from '@/agent/core/id'
import type {
  AgentEvent,
  AgentMutationBatch,
  AgentMutationReceipt,
  ModelReasoning,
} from '@/agent/core/types'
import type { ContextCheckpoint } from '@/agent/context/types'
import type {
  AgentSessionJournalEntry,
  DurableRuntimeUpdate,
} from '@/agent/runtime/mutationJournal'
import {
  decodeRuntimeDependencyManifest,
  type RuntimeDependencyManifest,
} from '@/agent/runtime/runtimeDependencyManifest'
import { assertCheckpointLedgerIntegrity, assertContextCheckpointIntegrity } from '@/agent/context/checkpointIntegrity'
import {
  assertBranchSummarySource,
  assertRetryTarget,
  branchSessionTitle,
  createBranchSummaryMessage,
  createBranchMessageCopies,
  normalizeSessionTitle,
} from '@/agent/session/branch'
import { promptSessionTitle } from '@/agent/session/title'
import {
  decodeProviderProfile,
  decodeProviderProfileWithMetadata,
  type ProviderProfile,
} from '@/agent/transport/provider'
import { getArtifactStorageStats, reconcileArtifacts, trashArtifacts } from '@/platform/artifacts'
import { commitSessionMutationBatch } from '@/platform/sessionMutations'
import { NativeSessionDatabase } from '@/platform/sessionDatabase'
import { decodeAgentMessage, encodeAgentMessage, isAgentMessage } from './messageCodec'
import type {
  SessionBranchRequest,
  SessionDefaults,
  SessionInitialization,
  AgentLifecycleEvent,
  SessionRepository,
  SessionSnapshot,
  RuntimeRecoveryResult,
  ProviderProfilePersistenceMigration,
  StorageStats,
  StoredAgentSession,
} from './types'

interface SessionRow {
  id: string
  title: string
  system_prompt: string
  model_provider: string
  model_id: string
  reasoning_json: string | null
  active_tool_names_json: string
  provider_config_json: string | null
  runtime_manifest_json: string | null
  workspace_path: string | null
  workspace_name: string | null
  status: string
  created_at: number
  updated_at: number
  message_count: number
  parent_session_id: string | null
  forked_from_message_id: string | null
  branch_kind: StoredAgentSession['branchKind']
  retried_message_id: string | null
  archived_at: number | null
}

interface MessageRow {
  content_json: string
}

const MUTATION_EVENT_TYPES = new Set<string>([
  'session_message_append',
  'runtime_system_prompt_update',
  'runtime_model_update',
  'runtime_reasoning_update',
  'runtime_tools_update',
])

interface JournalRow {
  id: string
  session_id: string
  sequence: number
  kind: AgentSessionJournalEntry['kind']
  queue_kind: 'steering' | 'follow-up' | 'next-turn' | null
  payload_json: string
  status: AgentSessionJournalEntry['status']
  consumer_run_id: string | null
  created_at: number
  recovered_at: number | null
}

interface ContextCheckpointRow {
  id: string
  session_id: string
  through_message_id: string
  summary: string
  summary_hash: string
  reason: ContextCheckpoint['reason']
  tokens_before: number
  estimated_tokens_after: number
  request_bytes_before: number
  request_bytes_after: number
  model_provider: string
  model_id: string
  prompt_version: number
  excluded_message_ids_json: string
  facts_json: string
  created_at: number
}

interface CountRow {
  count: number
}

interface ArtifactRow {
  id: string
  content_hash: string
  size_bytes: number
}

interface SumRow {
  total: number | null
}

interface PageCountRow {
  page_count: number
}

interface PageSizeRow {
  page_size: number
}

const decodeReasoning = (value: string | null): ModelReasoning | null => {
  if (value === null) return null
  const parsed = JSON.parse(value) as unknown
  const reasoning = parsed as Partial<ModelReasoning>
  if (typeof parsed !== 'object' || parsed === null
    || !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(reasoning.level))
    || (reasoning.mode !== undefined && !['effort', 'enabled', 'adaptive'].includes(reasoning.mode))
    || (reasoning.budgetTokens !== undefined
      && (!Number.isInteger(reasoning.budgetTokens) || reasoning.budgetTokens <= 0))) {
    throw new Error('SQLite 中存在格式无效的 Reasoning 状态')
  }
  return reasoning as ModelReasoning
}

const decodeActiveToolNames = (value: string): string[] => {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)
    || !parsed.every((name) => typeof name === 'string' && name.length > 0)
    || new Set(parsed).size !== parsed.length) {
    throw new Error('SQLite 中存在格式无效的活动工具状态')
  }
  return parsed
}

const decodeProviderProfileJson = async (value: string | null): Promise<ProviderProfile | null> => {
  if (value === null) return null
  try {
    return await decodeProviderProfile(JSON.parse(value) as unknown)
  } catch {
    throw new Error('SQLite 中存在格式无效的 Provider profile')
  }
}

const decodeRuntimeManifest = (value: string | null): RuntimeDependencyManifest | null => {
  if (value === null) return null
  try {
    return decodeRuntimeDependencyManifest(JSON.parse(value) as unknown)
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error('SQLite 中存在格式无效的 Runtime dependency manifest')
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const decodeDurableRuntimeUpdate = (value: unknown): DurableRuntimeUpdate => {
  if (!isRecord(value)) throw new Error('SQLite 中存在格式无效的 Runtime journal update')
  const allowed = new Set(['systemPrompt', 'model', 'reasoning', 'activeToolNames'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('SQLite Runtime journal update 包含未知字段')
  }
  if (value.systemPrompt !== undefined && typeof value.systemPrompt !== 'string') {
    throw new Error('SQLite Runtime journal System Prompt 无效')
  }
  if (value.model !== undefined) {
    const allowedModelFields = new Set([
      'provider',
      'model',
      'contextWindow',
      'maxOutputTokens',
      'input',
      'supportsReasoning',
    ])
    if (!isRecord(value.model)
      || Object.keys(value.model).some((key) => !allowedModelFields.has(key))
      || typeof value.model.provider !== 'string' || !value.model.provider
      || typeof value.model.model !== 'string' || !value.model.model
      || (value.model.contextWindow !== undefined
        && (!Number.isSafeInteger(value.model.contextWindow) || Number(value.model.contextWindow) <= 0))
      || (value.model.maxOutputTokens !== undefined
        && (!Number.isSafeInteger(value.model.maxOutputTokens) || Number(value.model.maxOutputTokens) <= 0))
      || (value.model.input !== undefined
        && (!Array.isArray(value.model.input)
          || value.model.input.length === 0
          || value.model.input.some((input) => input !== 'text' && input !== 'image')
          || new Set(value.model.input).size !== value.model.input.length))
      || (value.model.supportsReasoning !== undefined
        && typeof value.model.supportsReasoning !== 'boolean')) {
      throw new Error('SQLite Runtime journal 模型无效')
    }
  }
  let reasoning: ModelReasoning | null | undefined
  if (value.reasoning === null) reasoning = null
  else if (value.reasoning !== undefined) reasoning = decodeReasoning(JSON.stringify(value.reasoning))
  let activeToolNames: string[] | undefined
  if (value.activeToolNames !== undefined) {
    activeToolNames = decodeActiveToolNames(JSON.stringify(value.activeToolNames))
  }
  return {
    ...(value.systemPrompt !== undefined ? { systemPrompt: value.systemPrompt } : {}),
    ...(value.model !== undefined
      ? { model: structuredClone(value.model) as unknown as DurableRuntimeUpdate['model'] }
      : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(activeToolNames ? { activeToolNames } : {}),
  }
}

const encodeJournalPayload = (entry: AgentSessionJournalEntry): string => {
  if (entry.kind === 'runtime_update') return JSON.stringify({ update: entry.update })
  if (entry.kind === 'queue' && entry.order !== undefined) {
    return JSON.stringify({ message: entry.message, order: entry.order })
  }
  return JSON.stringify({ message: entry.message })
}

const decodeJournalEntry = (row: JournalRow): AgentSessionJournalEntry => {
  if (!row.id || !row.session_id
    || !Number.isSafeInteger(Number(row.sequence)) || Number(row.sequence) < 0
    || !Number.isSafeInteger(Number(row.created_at)) || Number(row.created_at) < 0
    || (row.recovered_at !== null
      && (!Number.isSafeInteger(Number(row.recovered_at)) || Number(row.recovered_at) < 0))
    || !['queue', 'message_append', 'runtime_update'].includes(row.kind)
    || !['pending', 'consuming', 'applied', 'discarded'].includes(row.status)
    || (row.queue_kind !== null
      && !['steering', 'follow-up', 'next-turn'].includes(row.queue_kind))) {
    throw new Error('SQLite 中存在格式无效的 Agent journal 元数据')
  }
  let payload: unknown
  try {
    payload = JSON.parse(row.payload_json)
  } catch {
    throw new Error('SQLite 中存在无法解析的 Agent journal payload')
  }
  if (!isRecord(payload)) throw new Error('SQLite 中存在格式无效的 Agent journal payload')
  const base = {
    id: row.id,
    sessionId: row.session_id,
    sequence: Number(row.sequence),
    status: row.status,
    createdAt: Number(row.created_at),
    ...(row.consumer_run_id ? { consumerRunId: row.consumer_run_id } : {}),
  }
  if (row.kind === 'runtime_update') {
    if (row.queue_kind !== null || row.recovered_at !== null) {
      throw new Error('SQLite Runtime journal queue/recovered 状态无效')
    }
    return { ...base, kind: 'runtime_update', update: decodeDurableRuntimeUpdate(payload.update) }
  }
  if (!isAgentMessage(payload.message)) throw new Error('SQLite Agent journal 消息格式无效')
  const message = structuredClone(payload.message)
  if (row.kind === 'message_append') {
    if (row.queue_kind !== null || row.recovered_at !== null) {
      throw new Error('SQLite message journal queue/recovered 状态无效')
    }
    return { ...base, kind: 'message_append', message }
  }
  if (!row.queue_kind) throw new Error('SQLite queue journal kind 缺失')
  if (row.recovered_at !== null
    && (row.status !== 'pending' || row.consumer_run_id !== null)) {
    throw new Error('SQLite queue journal 恢复草稿状态无效')
  }
  const order = payload.order
  if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order))) {
    throw new Error('SQLite queue journal order 无效')
  }
  return {
    ...base,
    kind: 'queue',
    queueKind: row.queue_kind,
    message,
    ...(order === undefined ? {} : { order }),
    ...(row.recovered_at !== null ? { recoveredAt: Number(row.recovered_at) } : {}),
  }
}

const toStoredSession = async (row: SessionRow): Promise<StoredAgentSession> => ({
  id: row.id,
  title: row.title,
  systemPrompt: row.system_prompt,
  modelProvider: row.model_provider,
  modelId: row.model_id,
  reasoning: decodeReasoning(row.reasoning_json),
  activeToolNames: decodeActiveToolNames(row.active_tool_names_json),
  providerConfig: await decodeProviderProfileJson(row.provider_config_json),
  runtimeManifest: decodeRuntimeManifest(row.runtime_manifest_json),
  status: row.status === 'running' ? 'running' : 'idle',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  messageCount: row.message_count,
  parentSessionId: row.parent_session_id ?? null,
  forkedFromMessageId: row.forked_from_message_id ?? null,
  branchKind: row.branch_kind === 'branch' || row.branch_kind === 'retry' ? row.branch_kind : null,
  retriedMessageId: row.retried_message_id ?? null,
  workspace: row.workspace_path && row.workspace_name
    ? { path: row.workspace_path, name: row.workspace_name }
    : null,
  archivedAt: row.archived_at,
})

const truncateUtf8 = (value: string, maxBytes: number): string => {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= maxBytes) return value
  return `${new TextDecoder().decode(encoded.slice(0, maxBytes))}…`
}

const toolExecutionKey = (runId: string, toolCallId: string): string => `${runId}:${toolCallId}`

type ToolExecutionEndEvent = Extract<AgentEvent, { type: 'tool_execution_end' }>

const decodeCheckpoint = (row: ContextCheckpointRow): ContextCheckpoint => {
  const excluded = JSON.parse(row.excluded_message_ids_json) as unknown
  const facts = JSON.parse(row.facts_json) as unknown
  if (!Array.isArray(excluded) || !excluded.every((value) => typeof value === 'string')) {
    throw new Error('SQLite 中存在格式无效的上下文排除列表')
  }
  if (
    typeof facts !== 'object'
    || facts === null
    || !Array.isArray((facts as ContextCheckpoint['facts']).readFiles)
    || !Array.isArray((facts as ContextCheckpoint['facts']).modifiedFiles)
    || !(facts as ContextCheckpoint['facts']).readFiles.every((value) => typeof value === 'string')
    || !(facts as ContextCheckpoint['facts']).modifiedFiles.every((value) => typeof value === 'string')
  ) {
    throw new Error('SQLite 中存在格式无效的上下文文件事实')
  }
  const decodedFacts = facts as ContextCheckpoint['facts']
  // 旧 checkpoint 可缺失工作账本字段（宽容，视为空）；存在则 fail-closed 校验形状。
  assertCheckpointLedgerIntegrity(decodedFacts, new Set(decodedFacts.modifiedFiles))
  return {
    id: row.id,
    sessionId: row.session_id,
    throughMessageId: row.through_message_id,
    summary: row.summary,
    summaryHash: row.summary_hash,
    reason: row.reason,
    tokensBefore: Number(row.tokens_before),
    estimatedTokensAfter: Number(row.estimated_tokens_after),
    requestBytesBefore: Number(row.request_bytes_before),
    requestBytesAfter: Number(row.request_bytes_after),
    modelProvider: row.model_provider,
    modelId: row.model_id,
    promptVersion: Number(row.prompt_version),
    excludedMessageIds: excluded,
    facts: {
      ...decodedFacts,
      readProgress: decodedFacts.readProgress ?? {},
      toolLedger: decodedFacts.toolLedger ?? [],
    },
    createdAt: Number(row.created_at),
  }
}

export class SqliteSessionRepository implements SessionRepository {
  private artifactCleanupTail: Promise<void> = Promise.resolve()
  private lastArtifactCleanupError: string | undefined

  private readonly pendingToolCompletions = new Map<string, {
    sessionId: string
    event: ToolExecutionEndEvent
    endedAt: number
  }>()

  private constructor(private readonly database: NativeSessionDatabase) {}

  static async open(): Promise<SqliteSessionRepository> {
    return new SqliteSessionRepository(await NativeSessionDatabase.open())
  }

  async recoverRuntimeState(): Promise<RuntimeRecoveryResult> {
    const recovered = await this.database.recoverSessionRepository(Date.now())
    this.pendingToolCompletions.clear()
    return recovered
  }

  /** 会话级局部恢复：只复位指定会话的卡死运行态，不影响其他会话。 */
  async recoverRuntimeStateForSession(sessionId: string): Promise<RuntimeRecoveryResult> {
    const recovered = await this.database.recoverSessionRepositoryFor(sessionId, Date.now())
    for (const [key, pending] of this.pendingToolCompletions) {
      if (pending.sessionId === sessionId) this.pendingToolCompletions.delete(key)
    }
    return recovered
  }

  async initialize(defaults: SessionDefaults): Promise<SessionInitialization> {
    const recovered = await this.recoverRuntimeState()
    await this.database.initializeSessionRuntimeDefaults({
      modelProvider: defaults.modelProvider,
      modelId: defaults.modelId,
      providerConfigJson: defaults.providerConfig ? JSON.stringify(defaults.providerConfig) : null,
      runtimeManifestJson: defaults.runtimeManifest ? JSON.stringify(defaults.runtimeManifest) : null,
    })
    try {
      await this.reconcileArtifactFiles()
    } catch (error) {
      this.lastArtifactCleanupError = error instanceof Error ? error.message : String(error)
    }
    const artifactIntegrityWarning = this.lastArtifactCleanupError
    let sessions = await this.listSessions()
    const active = sessions[0]
      ? await this.loadSession(sessions[0].id)
      : await this.createSession(defaults)
    sessions = await this.listSessions()
    return {
      sessions,
      active,
      recoveredRuns: recovered.recoveredRuns,
      ...(artifactIntegrityWarning ? { artifactIntegrityWarning } : {}),
    }
  }

  async prepareProviderProfileMigrations(): Promise<ProviderProfilePersistenceMigration[]> {
    const rows = await this.database.select<SessionRow[]>('sessions')
    const migrations: ProviderProfilePersistenceMigration[] = []
    for (const row of rows) {
      if (row.provider_config_json === null) continue
      const decoded = await decodeProviderProfileWithMetadata(
        JSON.parse(row.provider_config_json) as unknown,
      )
      if (!decoded.requiresPersistenceMigration) continue
      migrations.push({
        sessionId: row.id,
        expectedProviderConfigJson: row.provider_config_json,
        profile: decoded.profile,
        ...(decoded.secretMigration ? { secretMigration: decoded.secretMigration } : {}),
      })
    }
    return migrations
  }

  async commitProviderProfileMigrations(
    migrations: ProviderProfilePersistenceMigration[],
  ): Promise<void> {
    if (migrations.length === 0) return
    await this.database.migrateSessionProviderProfiles(migrations.map((migration) => ({
      sessionId: migration.sessionId,
      expectedProviderConfigJson: migration.expectedProviderConfigJson,
      providerConfigJson: JSON.stringify(migration.profile),
    })))
  }

  async createSession(defaults: SessionDefaults): Promise<SessionSnapshot> {
    const now = Date.now()
    const id = createId('session')
    await this.database.execute(
      'createSession',
      [
        id,
        defaults.systemPrompt,
        defaults.modelProvider,
        defaults.modelId,
        defaults.reasoning ? JSON.stringify(defaults.reasoning) : null,
        JSON.stringify(defaults.activeToolNames ?? []),
        defaults.providerConfig ? JSON.stringify(defaults.providerConfig) : null,
        defaults.runtimeManifest ? JSON.stringify(defaults.runtimeManifest) : null,
        defaults.workspace?.path ?? null,
        defaults.workspace?.name ?? null,
        now,
        now,
      ],
    )
    return this.loadSession(id)
  }

  async branchSession(request: SessionBranchRequest): Promise<SessionSnapshot> {
    const source = await this.loadSession(request.sourceSessionId)
    if (source.session.status === 'running') throw new Error('Agent 运行期间不能创建会话分支')
    if (request.kind === 'retry') {
      assertRetryTarget(source.messages, request.throughMessageId, request.retriedMessageId)
    }
    if (request.summary) {
      assertBranchSummarySource(source.messages, request.throughMessageId, request.summary)
    }
    const copies = createBranchMessageCopies(source.messages, request.throughMessageId)
    if (request.kind === 'retry' && request.summary) {
      throw new Error('Retry 分支不能附加 Branch Summary')
    }
    const summaryMessage = request.summary ? createBranchSummaryMessage(request.summary) : undefined
    const id = createId('session')
    const now = Date.now()
    await this.database.createSessionBranch({
      id,
      title: branchSessionTitle(source.session.title, request.kind),
      systemPrompt: request.defaults.systemPrompt,
      modelProvider: request.defaults.modelProvider,
      modelId: request.defaults.modelId,
      reasoningJson: request.defaults.reasoning ? JSON.stringify(request.defaults.reasoning) : null,
      activeToolNamesJson: JSON.stringify(request.defaults.activeToolNames ?? []),
      providerConfigJson: request.defaults.providerConfig
        ? JSON.stringify(request.defaults.providerConfig)
        : null,
      runtimeManifestJson: request.defaults.runtimeManifest
        ? JSON.stringify(request.defaults.runtimeManifest)
        : null,
      workspacePath: request.defaults.workspace?.path ?? source.session.workspace?.path ?? null,
      workspaceName: request.defaults.workspace?.name ?? source.session.workspace?.name ?? null,
      sourceSessionId: request.sourceSessionId,
      throughMessageId: request.throughMessageId,
      kind: request.kind,
      retriedMessageId: request.retriedMessageId ?? null,
      createdAt: now,
      activatedAt: now,
      messages: [
        ...copies.map((copy) => ({
          id: copy.message.id,
          role: copy.message.role,
          contentJson: encodeAgentMessage(copy.message),
          createdAt: copy.message.createdAt,
          sourceMessageId: copy.sourceMessageId,
          artifactId: copy.message.role === 'tool' ? copy.message.artifact?.id ?? null : null,
        })),
        ...(summaryMessage ? [{
          id: summaryMessage.id,
          role: summaryMessage.role,
          contentJson: encodeAgentMessage(summaryMessage),
          createdAt: summaryMessage.createdAt,
          sourceMessageId: null,
          artifactId: null,
        }] : []),
      ],
    })
    return this.loadSession(id)
  }

  async loadSession(sessionId: string): Promise<SessionSnapshot> {
    const snapshot = await this.database.loadSessionSnapshot<
      SessionRow,
      MessageRow,
      ContextCheckpointRow,
      JournalRow
    >(sessionId)
    const row = snapshot.session
    if (!row) throw new Error('会话不存在或已被删除')
    const messages = snapshot.messages.map((message) => decodeAgentMessage(message.content_json))
    let checkpoint = snapshot.latestCheckpoint ? decodeCheckpoint(snapshot.latestCheckpoint) : null
    if (checkpoint) {
      // 过期 checkpoint（promptVersion < 当前）不阻断会话恢复：丢弃其投影，
      // 由上下文管理器在下次模型调用前用当前提示词版本重新压缩。
      const isCurrent = await assertContextCheckpointIntegrity(checkpoint, sessionId, messages)
      if (!isCurrent) checkpoint = null
    }
    return {
      session: await toStoredSession(row),
      messages,
      checkpoint,
      journalEntries: snapshot.pendingJournal.map(decodeJournalEntry),
    }
  }

  async listSessions(): Promise<StoredAgentSession[]> {
    const rows = await this.database.select<SessionRow[]>(
      'sessions',
    )
    return Promise.all(rows.map(toStoredSession))
  }

  async updateSessionModel(sessionId: string, defaults: SessionDefaults): Promise<void> {
    await this.database.updateSessionRuntimeConfig({
      sessionId,
      systemPrompt: defaults.systemPrompt,
      modelProvider: defaults.modelProvider,
      modelId: defaults.modelId,
      reasoningJson: defaults.reasoning ? JSON.stringify(defaults.reasoning) : null,
      activeToolNamesJson: JSON.stringify(defaults.activeToolNames ?? []),
      providerConfigJson: defaults.providerConfig ? JSON.stringify(defaults.providerConfig) : null,
      runtimeManifestJson: defaults.runtimeManifest ? JSON.stringify(defaults.runtimeManifest) : null,
      now: Date.now(),
    })
  }

  async commitMutationBatch(
    sessionId: string,
    batch: AgentMutationBatch,
    runtimeManifest?: RuntimeDependencyManifest,
  ): Promise<AgentMutationReceipt> {
    if (batch.sessionId !== sessionId) throw new Error('Runtime mutation batch 不属于当前会话')
    return commitSessionMutationBatch(batch, runtimeManifest)
  }

  async appendJournalEntry(sessionId: string, entry: AgentSessionJournalEntry): Promise<void> {
    if (entry.sessionId !== sessionId || entry.status !== 'pending') {
      throw new Error('Agent journal entry 不属于当前会话或初始状态无效')
    }
    const payload = encodeJournalPayload(entry)
    if (new TextEncoder().encode(payload).byteLength > 1024 * 1024) {
      throw new Error('Agent journal payload 超过 1 MiB 安全上限')
    }
    await this.database.appendSessionJournalEntry({
      id: entry.id,
      sessionId,
      sequence: entry.sequence,
      kind: entry.kind,
      queueKind: entry.kind === 'queue' ? entry.queueKind : null,
      payloadJson: payload,
      createdAt: entry.createdAt,
    })
  }

  async markJournalEntriesConsuming(
    sessionId: string,
    entryIds: string[],
    runId: string,
  ): Promise<void> {
    await this.database.transitionJournalEntries(
      sessionId,
      entryIds,
      'consuming',
      { runId },
    )
  }

  async restoreJournalEntries(sessionId: string, entryIds: string[]): Promise<void> {
    await this.database.transitionJournalEntries(
      sessionId,
      entryIds,
      'restorePending',
    )
  }

  async markJournalEntriesRecovered(sessionId: string, entryIds: string[]): Promise<void> {
    await this.database.transitionJournalEntries(
      sessionId,
      entryIds,
      'recovered',
      { now: Date.now() },
    )
  }

  async markJournalEntriesApplied(sessionId: string, entryIds: string[]): Promise<void> {
    await this.database.transitionJournalEntries(
      sessionId,
      entryIds,
      'applied',
      { now: Date.now() },
    )
  }

  async discardJournalEntries(sessionId: string, entryIds: string[]): Promise<void> {
    await this.database.transitionJournalEntries(
      sessionId,
      entryIds,
      'discarded',
      { now: Date.now() },
    )
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const result = await this.database.execute(
      'renameSession',
      [normalizeSessionTitle(title), Date.now(), sessionId],
    )
    if (result.rowsAffected !== 1) throw new Error('会话不存在或已被删除')
  }

  async renameSessionIfTitle(sessionId: string, expectedTitle: string, title: string): Promise<boolean> {
    const result = await this.database.execute(
      'renameSessionIfTitle',
      [normalizeSessionTitle(title), Date.now(), sessionId, normalizeSessionTitle(expectedTitle)],
    )
    return result.rowsAffected === 1
  }

  async archiveSession(sessionId: string, archivedAt: number): Promise<void> {
    const result = await this.database.execute(
      'archiveSession',
      [archivedAt, Date.now(), sessionId],
    )
    if (result.rowsAffected !== 1) throw new Error('会话不存在或已被删除')
  }

  async restoreSession(sessionId: string): Promise<void> {
    const result = await this.database.execute(
      'restoreSession',
      [Date.now(), sessionId],
    )
    if (result.rowsAffected !== 1) throw new Error('会话不存在或已被删除')
  }

  async clearWorkspaceForPath(path: string): Promise<number> {
    const result = await this.database.execute(
      'clearWorkspaceForPath',
      [Date.now(), path],
    )
    return result.rowsAffected
  }

  async recordEvent(sessionId: string, event: AgentLifecycleEvent): Promise<void> {
    if (MUTATION_EVENT_TYPES.has(event.type)) {
      throw new Error('Runtime mutation 只能通过 commitMutationBatch 持久化')
    }
    const now = Date.now()
    if (event.type === 'agent_start') {
      await this.database.startSessionRun(event.runId, sessionId, now)
      return
    }

    if (event.type === 'provider_request_start') {
      await this.database.startProviderRequest({
        requestId: event.requestId,
        sessionId,
        runId: event.runId,
        assistantMessageId: event.assistantMessageId,
        modelProvider: event.modelProvider,
        modelId: event.modelId,
        messageCount: event.messageCount,
        toolCount: event.toolCount,
        startedAt: now,
      })
      return
    }

    if (event.type === 'provider_response_received') {
      if (event.message.id !== event.assistantMessageId) {
        throw new Error('Provider response 的 Assistant message ID 不匹配')
      }
      await this.database.receiveProviderResponse({
        requestId: event.requestId,
        sessionId,
        runId: event.runId,
        assistantMessageId: event.assistantMessageId,
        ...(event.message.responseId ? { responseId: event.message.responseId } : {}),
        ...(event.message.responseModel ? { responseModel: event.message.responseModel } : {}),
        responseMessageJson: encodeAgentMessage(event.message),
        responseReceivedAt: now,
      })
      return
    }

    if (event.type === 'message_end') {
      const runId = event.runId
      let pendingToolCompletion: {
        key: string
        value: { sessionId: string; event: ToolExecutionEndEvent; endedAt: number }
      } | undefined
      if (event.message.role === 'tool') {
        const key = toolExecutionKey(runId, event.message.toolCallId)
        const pending = this.pendingToolCompletions.get(key)
        if (!pending || pending.sessionId !== sessionId
          || pending.event.toolName !== event.message.toolName
          || pending.event.isError !== event.message.isError) {
          throw new Error('ToolResult message 缺少匹配的待完成工具执行')
        }
        pendingToolCompletion = { key, value: pending }
      }
      await this.database.persistSessionMessage({
        sessionId,
        runId,
        ...(event.consumedJournalEntryId
          ? { consumedJournalEntryId: event.consumedJournalEntryId }
          : {}),
        messageId: event.message.id,
        role: event.message.role,
        contentJson: encodeAgentMessage(event.message),
        createdAt: event.message.createdAt,
        ...(event.message.role === 'user'
          ? { sessionTitle: promptSessionTitle(event.message.content) }
          : {}),
        ...(pendingToolCompletion
          ? {
              toolExecution: {
                toolCallId: pendingToolCompletion.value.event.toolCallId,
                toolName: pendingToolCompletion.value.event.toolName,
                resultPreview: truncateUtf8(pendingToolCompletion.value.event.result.content, 4096),
                ...(pendingToolCompletion.value.event.result.details === undefined
                  ? {}
                  : { detailsJson: JSON.stringify(pendingToolCompletion.value.event.result.details) }),
                isError: pendingToolCompletion.value.event.isError,
                approvalState: pendingToolCompletion.value.event.approvalState,
                endedAt: pendingToolCompletion.value.endedAt,
              },
            }
          : {}),
        now,
      })
      if (pendingToolCompletion) this.pendingToolCompletions.delete(pendingToolCompletion.key)
      return
    }

    if (event.type === 'tool_execution_start') {
      await this.database.startToolExecution({
        sessionId,
        runId: event.runId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        argumentsJson: JSON.stringify(event.arguments),
        approvalState: event.approvalState,
        recoveryPolicy: event.recoveryPolicy,
        ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
        startedAt: now,
      })
      return
    }

    if (event.type === 'compaction_end' && event.checkpoint) {
      if (event.checkpoint.sessionId !== sessionId) {
        throw new Error('上下文检查点不属于当前会话')
      }
      await this.database.saveSessionCheckpoint(event.checkpoint)
      return
    }

    if (event.type === 'tool_execution_end') {
      const key = toolExecutionKey(event.runId, event.toolCallId)
      const existing = this.pendingToolCompletions.get(key)
      const pending = { sessionId, event: structuredClone(event), endedAt: now }
      if (existing && JSON.stringify(existing) !== JSON.stringify(pending)) {
        throw new Error('工具完成事实在 ToolResult 持久化前发生变化')
      }
      this.pendingToolCompletions.set(key, pending)
      return
    }

    if (event.type === 'agent_end') {
      if (Array.from(this.pendingToolCompletions.values()).some((pending) => (
        pending.sessionId === sessionId && pending.event.runId === event.runId
      ))) {
        throw new Error('Agent Run 仍有未与 ToolResult 原子落盘的工具完成事实')
      }
      await this.database.finishSessionRun({
        sessionId,
        runId: event.runId,
        endReason: event.reason,
        ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
        now,
      })
      return
    }

    if (event.type === 'turn_save_point') {
      const savePoint = event.savePoint
      if (savePoint.sessionId !== sessionId) throw new Error('Turn Save Point 不属于当前会话')
      await this.database.saveSessionTurnPoint(savePoint)
      return
    }

    if (event.type === 'agent_settled') {
      if (event.savePoint.sessionId !== sessionId) {
        throw new Error('Agent Save Point 不属于当前会话')
      }
      const request = {
        sessionId: event.savePoint.sessionId,
        runId: event.savePoint.runId,
        messageCount: event.savePoint.messageCount,
        ...(event.savePoint.lastMessageId !== undefined
          ? { lastMessageId: event.savePoint.lastMessageId }
          : {}),
        ...(event.savePoint.checkpointId !== undefined
          ? { checkpointId: event.savePoint.checkpointId }
          : {}),
        now,
      }
      try {
        await this.database.settleSessionRun(request)
      } catch (firstError) {
        try {
          await this.database.settleSessionRun(request)
        } catch (retryError) {
          const first = firstError instanceof Error ? firstError.message : String(firstError)
          const retry = retryError instanceof Error ? retryError.message : String(retryError)
          throw new Error(`Agent settlement 首次失败：${first}；幂等重试失败：${retry}`)
        }
      }
    }
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.database.clearSession(sessionId, { now: Date.now() })
    this.scheduleArtifactCleanup()
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.database.clearSession(sessionId, {
      now: Date.now(),
      deleteSession: true,
    })
    this.scheduleArtifactCleanup()
  }

  async deleteSessionWithSuccessor(
    sessionId: string,
    defaults: SessionDefaults,
  ): Promise<SessionSnapshot> {
    const successorId = createId('session')
    await this.database.deleteSessionWithSuccessor({
      sessionId,
      successorId,
      systemPrompt: defaults.systemPrompt,
      modelProvider: defaults.modelProvider,
      modelId: defaults.modelId,
      reasoningJson: defaults.reasoning ? JSON.stringify(defaults.reasoning) : null,
      activeToolNamesJson: JSON.stringify(defaults.activeToolNames ?? []),
      providerConfigJson: defaults.providerConfig ? JSON.stringify(defaults.providerConfig) : null,
      runtimeManifestJson: defaults.runtimeManifest ? JSON.stringify(defaults.runtimeManifest) : null,
      now: Date.now(),
    })
    this.scheduleArtifactCleanup()
    return this.loadSession(successorId)
  }

  async getStats(): Promise<StorageStats> {
    await this.artifactCleanupTail
    try {
      await this.reconcileArtifactFiles()
    } catch (error) {
      this.lastArtifactCleanupError = error instanceof Error ? error.message : String(error)
    }
    const [sessions, messages, runs, tools, providerRequests, checkpoints, artifacts, artifactBytes, pageCounts, pageSizes, diskStats] = await Promise.all([
      this.database.select<CountRow[]>('sessionCount'),
      this.database.select<CountRow[]>('messageCount'),
      this.database.select<CountRow[]>('runCount'),
      this.database.select<CountRow[]>('toolExecutionCount'),
      this.database.select<CountRow[]>('providerRequestCount'),
      this.database.select<CountRow[]>('checkpointCount'),
      this.database.select<CountRow[]>('artifactCount'),
      this.database.select<SumRow[]>('artifactBytes'),
      this.database.select<PageCountRow[]>('pageCount'),
      this.database.select<PageSizeRow[]>('pageSize'),
      getArtifactStorageStats().catch(() => null),
    ])
    return {
      sessionCount: Number(sessions[0]?.count ?? 0),
      messageCount: Number(messages[0]?.count ?? 0),
      runCount: Number(runs[0]?.count ?? 0),
      toolExecutionCount: Number(tools[0]?.count ?? 0),
      providerRequestCount: Number(providerRequests[0]?.count ?? 0),
      checkpointCount: Number(checkpoints[0]?.count ?? 0),
      artifactCount: Number(diskStats?.activeCount ?? artifacts[0]?.count ?? 0),
      artifactBytes: Number(diskStats?.activeBytes ?? artifactBytes[0]?.total ?? 0),
      artifactTrashCount: Number(diskStats?.trashCount ?? 0),
      artifactTrashBytes: Number(diskStats?.trashBytes ?? 0),
      databaseBytes: Number(pageCounts[0]?.page_count ?? 0) * Number(pageSizes[0]?.page_size ?? 0),
      ...(this.lastArtifactCleanupError
        ? { artifactCleanupWarning: this.lastArtifactCleanupError }
        : {}),
    }
  }

  private async cleanupUnreferencedArtifacts(): Promise<void> {
    const unreferenced = await this.database.select<ArtifactRow[]>(
      'unreferencedArtifacts',
    )
    if (unreferenced.length === 0) return
    await trashArtifacts(unreferenced.map((artifact) => artifact.content_hash))
    for (const artifact of unreferenced) {
      await this.database.deleteUnreferencedArtifactMetadata(artifact.id)
    }
  }

  private scheduleArtifactCleanup(): void {
    this.artifactCleanupTail = this.artifactCleanupTail
      .then(() => this.cleanupUnreferencedArtifacts())
      .catch((error) => {
        this.lastArtifactCleanupError = error instanceof Error ? error.message : String(error)
      })
  }

  private async reconcileArtifactFiles(): Promise<void> {
    await this.cleanupUnreferencedArtifacts()
    const artifacts = await this.database.select<ArtifactRow[]>(
      'artifacts',
    )
    await reconcileArtifacts(artifacts.map((artifact) => artifact.content_hash))
  }
}
