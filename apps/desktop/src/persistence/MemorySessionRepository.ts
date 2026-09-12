import { createId } from '@/agent/core/id'
import type {
  AgentEvent,
  AgentMessage,
  AgentMutationBatch,
  AgentMutationReceipt,
  AgentRunEndReason,
  AgentTurnSavePoint,
} from '@/agent/core/types'
import type { ContextCheckpoint } from '@/agent/context/types'
import type { AgentSessionJournalEntry } from '@/agent/runtime/mutationJournal'
import {
  decodeRuntimeDependencyManifest,
  runtimeDependencyManifestsEqual,
  type RuntimeDependencyManifest,
} from '@/agent/runtime/runtimeDependencyManifest'
import { assertContextCheckpointIntegrity } from '@/agent/context/checkpointIntegrity'
import {
  assertBranchSummarySource,
  assertRetryTarget,
  branchSessionTitle,
  createBranchSummaryMessage,
  createBranchMessageCopies,
  normalizeSessionTitle,
} from '@/agent/session/branch'
import { promptSessionTitle } from '@/agent/session/title'
import { createSessionMutationEffectIdentity } from '@/platform/sessionMutations'
import { createInterruptedToolResult, type InterruptedExecutionState } from './interruptedToolRecovery'
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

interface MemoryRun {
  sessionId: string
  status: 'running' | 'finished' | 'interrupted'
  endReason?: AgentRunEndReason
  errorMessage?: string
  latestTurnSavePoint?: AgentTurnSavePoint
}

interface MemoryToolExecution {
  sessionId: string
  runId: string
  toolCallId: string
  toolName: string
  argumentsIdentity: string
  status: 'running' | 'completed' | 'error' | 'interrupted'
  approvalState: 'not_required' | 'pending'
  recoveryPolicy: 'never' | 'idempotent'
  idempotencyKey?: string
  completion?: ToolExecutionEndEvent
}

interface MemoryProviderRequest {
  sessionId: string
  runId: string
  assistantMessageId: string
  modelProvider: string
  modelId: string
  messageCount: number
  toolCount: number
  status: 'running' | 'response_received' | 'committed' | 'interrupted'
  responseId?: string
  responseModel?: string
  responseMessageIdentity?: string
  message?: AgentMessage
}

type ToolExecutionEndEvent = Extract<AgentEvent, { type: 'tool_execution_end' }>

const memoryToolExecutionKey = (runId: string, toolCallId: string): string =>
  `${runId}:${toolCallId}`

const canonicalJsonValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonValue).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJsonValue(record[key])}`
    )).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Tool execution arguments 不是合法 JSON')
  return encoded
}

const canonicalJsonIdentity = (value: unknown): string => {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Tool execution arguments 不是合法 JSON')
  return canonicalJsonValue(JSON.parse(encoded))
}

const MUTATION_EVENT_TYPES = new Set<string>([
  'session_message_append',
  'runtime_system_prompt_update',
  'runtime_model_update',
  'runtime_reasoning_update',
  'runtime_tools_update',
  'runtime_dependencies_update',
])

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false
  const other = new Set(right)
  for (const value of left) if (!other.has(value)) return false
  return true
}

const cloneStoredSession = (session: StoredAgentSession): StoredAgentSession => ({
  ...session,
  reasoning: session.reasoning ? structuredClone(session.reasoning) : null,
  activeToolNames: session.activeToolNames.slice(),
  providerConfig: session.providerConfig ? structuredClone(session.providerConfig) : null,
  runtimeManifest: session.runtimeManifest ? structuredClone(session.runtimeManifest) : null,
  workspace: session.workspace ? structuredClone(session.workspace) : null,
})

const isOrchestrationFailureMessage = (message: AgentMessage): boolean =>
  message.role === 'assistant'
  && (message.stopReason === 'error' || message.stopReason === 'aborted')
  && message.diagnostics?.some((diagnostic) => diagnostic.type === 'agent-orchestration-error') === true

export class MemorySessionRepository implements SessionRepository {
  private sessions = new Map<string, StoredAgentSession>()
  private messages = new Map<string, AgentMessage[]>()
  private messageRuns = new Map<string, string>()
  private runs = new Map<string, MemoryRun>()
  private tools = new Map<string, MemoryToolExecution>()
  private providerRequests = new Map<string, MemoryProviderRequest>()
  private pendingToolCompletions = new Map<string, {
    sessionId: string
    event: ToolExecutionEndEvent
  }>()
  private checkpoints = new Map<string, ContextCheckpoint[]>()
  private mutationBatches = new Map<string, {
    sessionId: string
    effectIdentity: string
    runId?: string
    turn?: number
    committedAt: number
  }>()
  private journal = new Map<string, AgentSessionJournalEntry[]>()

  async recoverRuntimeState(): Promise<RuntimeRecoveryResult> {
    const original = {
      sessions: this.sessions,
      messages: this.messages,
      messageRuns: this.messageRuns,
      runs: this.runs,
      tools: this.tools,
      providerRequests: this.providerRequests,
      pendingToolCompletions: this.pendingToolCompletions,
      checkpoints: this.checkpoints,
      mutationBatches: this.mutationBatches,
      journal: this.journal,
    }
    this.sessions = structuredClone(this.sessions)
    this.messages = structuredClone(this.messages)
    this.messageRuns = structuredClone(this.messageRuns)
    this.runs = structuredClone(this.runs)
    this.tools = structuredClone(this.tools)
    this.providerRequests = structuredClone(this.providerRequests)
    this.pendingToolCompletions = structuredClone(this.pendingToolCompletions)
    this.checkpoints = structuredClone(this.checkpoints)
    this.mutationBatches = structuredClone(this.mutationBatches)
    this.journal = structuredClone(this.journal)
    try {
      return await this.recoverRuntimeStateInPlace()
    } catch (error) {
      Object.assign(this, original)
      throw error
    }
  }

  private async recoverRuntimeStateInPlace(): Promise<RuntimeRecoveryResult> {
    this.pendingToolCompletions.clear()
    let recoveredRuns = 0
    for (const run of this.runs.values()) {
      if (run.status === 'running') {
        run.status = 'interrupted'
        recoveredRuns += 1
      }
    }
    for (const request of this.providerRequests.values()) {
      if (request.status === 'running') {
        request.status = 'interrupted'
        continue
      }
      if (request.status !== 'response_received') continue
      if (!request.message || request.message.role !== 'assistant'
        || request.message.id !== request.assistantMessageId) {
        throw new Error('Memory Provider response ledger 包含无效 Assistant 消息')
      }
      const messages = this.messages.get(request.sessionId) ?? []
      const existingMessage = messages.find((message) => message.id === request.assistantMessageId)
      if (existingMessage && (this.messageRuns.get(existingMessage.id) !== request.runId
        || canonicalJsonIdentity(existingMessage) !== canonicalJsonIdentity(request.message))) {
        throw new Error('Memory Provider response 恢复消息与 canonical effect 冲突')
      }
      if (!existingMessage) {
        messages.push(structuredClone(request.message))
        this.messages.set(request.sessionId, messages)
        this.messageRuns.set(request.assistantMessageId, request.runId)
        const session = this.sessions.get(request.sessionId)
        if (session) {
          session.messageCount = messages.length
          session.updatedAt = Math.max(session.updatedAt, request.message.createdAt)
        }
      }
      request.status = 'committed'
    }
    for (const [sessionId, messages] of this.messages) {
      for (const message of messages) {
        if (message.role !== 'assistant' || isOrchestrationFailureMessage(message)) continue
        const runId = this.messageRuns.get(message.id)
        const provider = Array.from(this.providerRequests.values()).find((request) => (
          request.sessionId === sessionId && request.runId === runId
          && request.assistantMessageId === message.id
        ))
        if (!runId || !provider || provider.status !== 'committed'
          || provider.responseMessageIdentity !== canonicalJsonIdentity(message)) {
          throw new Error('Memory Assistant message 与 Provider response ledger 不一致')
        }
      }
    }
    for (const session of this.sessions.values()) session.status = 'idle'
    for (const execution of this.tools.values()) {
      if (execution.status === 'running') execution.status = 'interrupted'
    }
    const recoveryCandidates = new Map<string, {
      sessionId: string
      runId: string
      toolCallId: string
      recoveryPolicy?: 'never' | 'idempotent'
      executionState: InterruptedExecutionState
    }>()
    for (const [runId, run] of this.runs) {
      if (run.status !== 'interrupted') continue
      for (const message of this.messages.get(run.sessionId) ?? []) {
        if (this.messageRuns.get(message.id) !== runId
          || message.role !== 'assistant'
          || (message.stopReason !== 'tool_use' && message.stopReason !== 'length')) continue
        for (const toolCall of message.toolCalls) {
          recoveryCandidates.set(`${runId}\0${toolCall.id}`, {
            sessionId: run.sessionId,
            runId,
            toolCallId: toolCall.id,
            // 仅来自 assistant ToolCall 无对应执行记录：工具可能从未执行。
            executionState: 'interrupted',
          })
        }
      }
    }
    for (const execution of this.tools.values()) {
      if (execution.status === 'running') continue
      recoveryCandidates.set(`${execution.runId}\0${execution.toolCallId}`, {
        ...execution,
        // completed/error 视为"已尝试执行、结果未保存"；interrupted 为可能未执行。
        executionState: execution.status === 'interrupted' ? 'interrupted' : 'completed',
      })
    }
    const recoveryTime = Date.now()
    for (const candidate of recoveryCandidates.values()) {
      const messages = this.messages.get(candidate.sessionId) ?? []
      const result = await createInterruptedToolResult(
        messages.map((message) => ({ message, runId: this.messageRuns.get(message.id) })),
        candidate.runId,
        candidate.toolCallId,
        recoveryTime,
        candidate.recoveryPolicy ?? 'never',
        candidate.executionState,
      )
      if (!result || messages.some((message) => message.id === result.id)) continue
      messages.push(result)
      this.messageRuns.set(result.id, candidate.runId)
      const session = this.sessions.get(candidate.sessionId)
      if (session) {
        session.messageCount = messages.length
        session.updatedAt = result.createdAt
      }
    }
    for (const [sessionId, entries] of this.journal) {
      const recovered = entries.flatMap((entry) => {
        if (entry.status === 'applied' || entry.status === 'discarded') return []
        if (entry.status === 'consuming') {
          if (entry.kind !== 'queue') {
            throw new Error('Memory repository 中存在非法 consuming 非队列 journal entry')
          }
          if (!entry.consumerRunId) {
            throw new Error('Memory consuming queue journal 缺少 consumer Run')
          }
          const stored = Array.from(this.messages.entries()).flatMap(([storedSessionId, messages]) => (
            messages
              .filter((message) => message.id === entry.message.id)
              .map((message) => ({ storedSessionId, message }))
          ))
          if (stored.length === 0) {
            return [{ ...entry, status: 'pending' as const, consumerRunId: undefined }]
          }
          if (stored.length !== 1 || stored[0].storedSessionId !== sessionId
            || this.messageRuns.get(entry.message.id) !== entry.consumerRunId
            || canonicalJsonIdentity(stored[0].message) !== canonicalJsonIdentity(entry.message)) {
            throw new Error('Memory consuming queue journal 与已持久化消息 canonical effect 冲突')
          }
          return []
        }
        return [structuredClone(entry)]
      })
      this.journal.set(sessionId, recovered)
    }
    return { recoveredRuns }
  }

  /**
   * 会话级最小恢复：只把指定会话的 running run / provider request / tool
   * execution 标为 interrupted、session 复位 idle，并清理该会话未落盘的
   * pending tool completion。不复位 response_received ledger、不合成
   * interrupted tool results（这些职责保留给应用启动的全局恢复）。
   * 用于 send 失败恢复路径：其他会话仍在运行时，避免全局恢复干扰它们。
   */
  async recoverRuntimeStateForSession(sessionId: string): Promise<RuntimeRecoveryResult> {
    let recoveredRuns = 0
    for (const run of this.runs.values()) {
      if (run.sessionId === sessionId && run.status === 'running') {
        run.status = 'interrupted'
        recoveredRuns += 1
      }
    }
    for (const request of this.providerRequests.values()) {
      if (request.sessionId === sessionId && request.status === 'running') {
        request.status = 'interrupted'
      }
    }
    for (const execution of this.tools.values()) {
      if (execution.sessionId === sessionId && execution.status === 'running') {
        execution.status = 'interrupted'
      }
    }
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在或已被删除')
    session.status = 'idle'
    for (const [key, pending] of this.pendingToolCompletions) {
      if (pending.sessionId === sessionId) this.pendingToolCompletions.delete(key)
    }
    return { recoveredRuns }
  }

  async initialize(defaults: SessionDefaults): Promise<SessionInitialization> {
    const { recoveredRuns } = await this.recoverRuntimeState()
    if (defaults.providerConfig) {
      for (const session of this.sessions.values()) {
        if (session.providerConfig === null
          && session.modelProvider === defaults.modelProvider
          && session.modelId === defaults.modelId) {
          session.providerConfig = structuredClone(defaults.providerConfig)
        }
      }
    }
    if (defaults.runtimeManifest) {
      for (const session of this.sessions.values()) {
        if (!session.runtimeManifest
          && session.modelProvider === defaults.modelProvider
          && session.modelId === defaults.modelId) {
          session.runtimeManifest = structuredClone(defaults.runtimeManifest)
        }
      }
    }
    const sessions = await this.listSessions()
    const active = sessions[0]
      ? await this.loadSession(sessions[0].id)
      : await this.createSession(defaults)
    return { sessions: await this.listSessions(), active, recoveredRuns }
  }

  async createSession(defaults: SessionDefaults): Promise<SessionSnapshot> {
    const now = Date.now()
    const session: StoredAgentSession = {
      id: createId('session'),
      title: '新会话',
      systemPrompt: defaults.systemPrompt,
      modelProvider: defaults.modelProvider,
      modelId: defaults.modelId,
      reasoning: defaults.reasoning ? structuredClone(defaults.reasoning) : null,
      activeToolNames: defaults.activeToolNames?.slice() ?? [],
      providerConfig: defaults.providerConfig ? structuredClone(defaults.providerConfig) : null,
      runtimeManifest: defaults.runtimeManifest ? structuredClone(defaults.runtimeManifest) : null,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      parentSessionId: null,
      forkedFromMessageId: null,
      branchKind: null,
      retriedMessageId: null,
      workspace: defaults.workspace ? structuredClone(defaults.workspace) : null,
    }
    this.sessions.set(session.id, session)
    this.messages.set(session.id, [])
    this.checkpoints.set(session.id, [])
    this.journal.set(session.id, [])
    return { session: cloneStoredSession(session), messages: [], checkpoint: null, journalEntries: [] }
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
    const branchMessages = [
      ...copies.map((copy) => copy.message),
      ...(request.summary ? [createBranchSummaryMessage(request.summary)] : []),
    ]
    const now = Date.now()
    const session: StoredAgentSession = {
      id: createId('session'),
      title: branchSessionTitle(source.session.title, request.kind),
      systemPrompt: request.defaults.systemPrompt,
      modelProvider: request.defaults.modelProvider,
      modelId: request.defaults.modelId,
      reasoning: request.defaults.reasoning ? structuredClone(request.defaults.reasoning) : null,
      activeToolNames: request.defaults.activeToolNames?.slice() ?? [],
      providerConfig: request.defaults.providerConfig
        ? structuredClone(request.defaults.providerConfig)
        : null,
      runtimeManifest: request.defaults.runtimeManifest
        ? structuredClone(request.defaults.runtimeManifest)
        : null,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      messageCount: branchMessages.length,
      parentSessionId: request.sourceSessionId,
      forkedFromMessageId: request.throughMessageId,
      branchKind: request.kind,
      retriedMessageId: request.retriedMessageId ?? null,
      workspace: request.defaults.workspace
        ? structuredClone(request.defaults.workspace)
        : source.session.workspace
          ? structuredClone(source.session.workspace)
          : null,
    }
    this.sessions.set(session.id, session)
    this.messages.set(session.id, branchMessages)
    this.checkpoints.set(session.id, [])
    this.journal.set(session.id, [])
    return this.loadSession(session.id)
  }

  async loadSession(sessionId: string): Promise<SessionSnapshot> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在或已被删除')
    const checkpoints = this.checkpoints.get(sessionId) ?? []
    let checkpoint = checkpoints[checkpoints.length - 1]
      ? structuredClone(checkpoints[checkpoints.length - 1])
      : null
    if (checkpoint) {
      const isCurrent = await assertContextCheckpointIntegrity(
        checkpoint,
        sessionId,
        this.messages.get(sessionId) ?? [],
      )
      if (!isCurrent) checkpoint = null
    }
    return {
      session: cloneStoredSession(session),
      messages: (this.messages.get(sessionId) ?? []).slice(),
      checkpoint,
      journalEntries: structuredClone(this.journal.get(sessionId) ?? [])
        .filter((entry) => entry.status === 'pending')
        .sort((left, right) => left.sequence - right.sequence),
    }
  }

  async listSessions(): Promise<StoredAgentSession[]> {
    return Array.from(this.sessions.values())
      .map(cloneStoredSession)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  async updateSessionModel(sessionId: string, defaults: SessionDefaults): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在或已被删除')
    if (session.status !== 'idle' || Array.from(this.runs.values()).some((run) => (
      run.sessionId === sessionId && run.status === 'running'
    ))) {
      throw new Error('Session Runtime 配置只能在空闲状态更新')
    }
    Object.assign(session, {
      systemPrompt: defaults.systemPrompt,
      modelProvider: defaults.modelProvider,
      modelId: defaults.modelId,
      reasoning: defaults.reasoning ? structuredClone(defaults.reasoning) : null,
      activeToolNames: defaults.activeToolNames?.slice() ?? [],
      providerConfig: defaults.providerConfig ? structuredClone(defaults.providerConfig) : null,
      runtimeManifest: defaults.runtimeManifest ? structuredClone(defaults.runtimeManifest) : null,
      updatedAt: Date.now(),
    })
  }

  async commitMutationBatch(
    sessionId: string,
    batch: AgentMutationBatch,
    runtimeManifest?: RuntimeDependencyManifest,
  ): Promise<AgentMutationReceipt> {
    if (batch.sessionId !== sessionId) throw new Error('Runtime mutation batch 不属于当前会话')
    const updatesTools = batch.events.some((event) => event.type === 'runtime_tools_update')
    const updatesDependencies = batch.events.some((event) => event.type === 'runtime_dependencies_update')
    if ((updatesTools || updatesDependencies) !== (runtimeManifest !== undefined)) {
      throw new Error('Runtime 工具更新必须原子携带 dependency manifest')
    }
    const normalizedManifest = runtimeManifest
      ? decodeRuntimeDependencyManifest(structuredClone(runtimeManifest))
      : undefined
    const effectIdentity = createSessionMutationEffectIdentity(batch, normalizedManifest)
    const committed = this.mutationBatches.get(batch.id)
    if (committed) {
      if (committed.sessionId !== sessionId) throw new Error('Runtime mutation batch ID 已被其他会话占用')
      if (committed.runId !== batch.runId || committed.turn !== batch.turn) {
        throw new Error('Runtime mutation batch ID 已被其他 Run/Turn ownership 占用')
      }
      if (committed.effectIdentity !== effectIdentity) {
        throw new Error('Runtime mutation batch ID 已被不一致的 canonical effect 占用')
      }
      return {
        batchId: batch.id,
        sessionId,
        ...(committed.runId ? { runId: committed.runId } : {}),
        ...(committed.turn !== undefined ? { turn: committed.turn } : {}),
        committedAt: committed.committedAt,
        replayed: true,
      }
    }
    if (batch.events.length === 0) throw new Error('Runtime mutation batch 不能为空')
    if (batch.runId) {
      const run = this.runs.get(batch.runId)
      if (!run || run.sessionId !== sessionId || run.status !== 'running') {
        throw new Error('Runtime mutation batch 对应的运行不可提交')
      }
    }
    const stored = this.sessions.get(sessionId)
    if (!stored) throw new Error('会话不存在或已被删除')
    if (batch.runId) {
      if (stored.status !== 'running') {
        throw new Error('Runtime mutation batch 对应的运行不可提交')
      }
    } else if (stored.status !== 'idle' || Array.from(this.runs.values()).some((run) => (
      run.sessionId === sessionId && run.status === 'running'
    ))) {
      throw new Error('Runless Runtime mutation 只能提交到空闲会话')
    }
    const stagedSession = cloneStoredSession(stored)
    const stagedMessages = structuredClone(this.messages.get(sessionId) ?? [])
    const messageRunUpdates = new Map<string, string | undefined>()
    const stagedJournal = structuredClone(this.journal.get(sessionId) ?? [])
    for (const entryId of batch.journalEntryIds ?? []) {
      const entry = stagedJournal.find((candidate) => candidate.id === entryId)
      if (!entry || entry.sessionId !== sessionId || entry.kind === 'queue'
        || (entry.status !== 'pending' && entry.status !== 'consuming')) {
        throw new Error('Runtime mutation batch 引用了不可应用的 journal entry')
      }
      entry.status = 'applied'
    }
    for (const event of batch.events) {
      if (event.type === 'session_message_append') {
        if (event.sessionId !== sessionId) throw new Error('Runtime mutation 消息不属于当前会话')
        if (event.message.role !== 'user' && event.message.role !== 'custom') {
          throw new Error('Runtime mutation 只允许追加 User 或 Custom 消息')
        }
        if (stagedMessages.some((message) => message.id === event.message.id)) {
          throw new Error(`Runtime mutation 包含重复消息 ID：${event.message.id}`)
        }
        stagedMessages.push(structuredClone(event.message))
        messageRunUpdates.set(event.message.id, batch.runId)
        if (stagedSession.title === '新会话' && event.message.role === 'user') {
          stagedSession.title = promptSessionTitle(event.message.content)
        }
        continue
      }
      if (event.type === 'runtime_system_prompt_update') {
        stagedSession.systemPrompt = event.current
        continue
      }
      if (event.type === 'runtime_model_update') {
        stagedSession.modelProvider = event.current.provider
        stagedSession.modelId = event.current.model
        continue
      }
      if (event.type === 'runtime_reasoning_update') {
        stagedSession.reasoning = event.current ? structuredClone(event.current) : null
        continue
      }
      if (event.type === 'runtime_dependencies_update') {
        // previous CAS（docs/skills-extension.md §7.4）：比对当前持久化值，
        // 不匹配说明扫描确认期间状态已变化，整批拒绝并要求重新展示 diff。
        const previousManifest = decodeRuntimeDependencyManifest(
          structuredClone(event.previous.runtimeManifest),
        )
        if (stored.systemPrompt !== event.previous.systemPrompt
          || !sameStringSet(stored.activeToolNames, event.previous.activeToolNames)
          || !runtimeDependencyManifestsEqual(stored.runtimeManifest, previousManifest)) {
          throw new Error('Runtime dependencies 已变化（CAS 拒绝），请重新展示差异')
        }
        if (!normalizedManifest) {
          throw new Error('Runtime dependencies 更新缺少 dependency manifest')
        }
        const manifestToolNames = new Set(normalizedManifest.tools.map((tool) => tool.name))
        if (event.current.activeToolNames.some((name) => !manifestToolNames.has(name))) {
          throw new Error('Runtime dependency manifest 缺少活动工具')
        }
        stagedSession.systemPrompt = event.current.systemPrompt
        stagedSession.activeToolNames = event.current.activeToolNames.slice()
        stagedSession.runtimeManifest = structuredClone(normalizedManifest)
        // 该事件使 context checkpoint 失效：清空该会话持久化 checkpoint。
        this.checkpoints.set(sessionId, [])
        continue
      }
      const activeToolNames = event.current.activeToolNames
      if (activeToolNames.some((name) => !name) || new Set(activeToolNames).size !== activeToolNames.length) {
        throw new Error('Runtime mutation 包含无效的活动工具状态')
      }
      if (!normalizedManifest) {
        throw new Error('Runtime 工具更新缺少 dependency manifest')
      }
      const manifestToolNames = new Set(normalizedManifest.tools.map((tool) => tool.name))
      if (activeToolNames.some((name) => !manifestToolNames.has(name))) {
        throw new Error('Runtime dependency manifest 缺少活动工具')
      }
      stagedSession.activeToolNames = activeToolNames.slice()
      stagedSession.runtimeManifest = structuredClone(normalizedManifest)
    }
    stagedSession.messageCount = stagedMessages.length
    stagedSession.updatedAt = Date.now()
    this.sessions.set(sessionId, stagedSession)
    this.messages.set(sessionId, stagedMessages)
    for (const [messageId, runId] of messageRunUpdates) {
      if (runId) this.messageRuns.set(messageId, runId)
      else this.messageRuns.delete(messageId)
    }
    this.journal.set(sessionId, stagedJournal)
    this.mutationBatches.set(batch.id, {
      sessionId,
      effectIdentity,
      ...(batch.runId ? { runId: batch.runId } : {}),
      ...(batch.turn !== undefined ? { turn: batch.turn } : {}),
      committedAt: batch.createdAt,
    })
    return {
      batchId: batch.id,
      sessionId,
      ...(batch.runId ? { runId: batch.runId } : {}),
      ...(batch.turn !== undefined ? { turn: batch.turn } : {}),
      committedAt: batch.createdAt,
      replayed: false,
    }
  }

  async appendJournalEntry(sessionId: string, entry: AgentSessionJournalEntry): Promise<void> {
    if (!this.sessions.has(sessionId) || entry.sessionId !== sessionId || entry.status !== 'pending') {
      throw new Error('Agent journal entry 不属于当前会话或初始状态无效')
    }
    const entries = this.journal.get(sessionId) ?? []
    if (entries.some((candidate) => candidate.id === entry.id
      || candidate.sequence === entry.sequence)) {
      throw new Error('Agent journal entry ID 或 sequence 已存在')
    }
    if (new TextEncoder().encode(JSON.stringify(entry)).byteLength > 1024 * 1024) {
      throw new Error('Agent journal payload 超过 1 MiB 安全上限')
    }
    entries.push(structuredClone(entry))
    this.journal.set(sessionId, entries)
  }

  async markJournalEntriesConsuming(
    sessionId: string,
    entryIds: string[],
    runId: string,
  ): Promise<void> {
    const entries = this.requireJournalEntries(sessionId, entryIds)
    const run = this.runs.get(runId)
    if (!run || run.sessionId !== sessionId || run.status !== 'running') {
      throw new Error('Agent journal queue consumer run 无效')
    }
    if (entries.some((entry) => entry.kind !== 'queue'
      || entry.status !== 'pending'
      || entry.recoveredAt !== undefined)) {
      throw new Error('只有 pending queue journal entry 可以进入 consuming')
    }
    for (const entry of entries) {
      entry.status = 'consuming'
      entry.consumerRunId = runId
    }
  }

  async restoreJournalEntries(sessionId: string, entryIds: string[]): Promise<void> {
    for (const entry of this.requireJournalEntries(sessionId, entryIds)) {
      if (entry.kind !== 'queue' || entry.status !== 'consuming') continue
      entry.status = 'pending'
      entry.consumerRunId = undefined
    }
  }

  async markJournalEntriesRecovered(sessionId: string, entryIds: string[]): Promise<void> {
    const now = Date.now()
    const entries = this.requireJournalEntries(sessionId, entryIds)
    if (entries.some((entry) => entry.kind !== 'queue'
      || (entry.status !== 'pending' && entry.status !== 'consuming')
      || entry.recoveredAt !== undefined)) {
      throw new Error('只有活动 queue journal entry 可以转为恢复草稿')
    }
    for (const entry of entries) {
      if (entry.kind !== 'queue') continue
      entry.status = 'pending'
      entry.consumerRunId = undefined
      entry.recoveredAt = now
    }
  }

  async markJournalEntriesApplied(sessionId: string, entryIds: string[]): Promise<void> {
    const entries = this.requireJournalEntries(sessionId, entryIds)
    if (entries.some((entry) => entry.status === 'discarded')) {
      throw new Error('已丢弃的 Agent journal entry 不能应用')
    }
    for (const entry of entries) {
      entry.status = 'applied'
      if (entry.kind === 'queue') entry.recoveredAt = undefined
    }
  }

  async discardJournalEntries(sessionId: string, entryIds: string[]): Promise<void> {
    for (const entry of this.requireJournalEntries(sessionId, entryIds)) {
      if (entry.status === 'applied') continue
      entry.status = 'discarded'
      entry.consumerRunId = undefined
      if (entry.kind === 'queue') entry.recoveredAt = undefined
    }
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在或已被删除')
    session.title = normalizeSessionTitle(title)
    session.updatedAt = Date.now()
  }

  async renameSessionIfTitle(sessionId: string, expectedTitle: string, title: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session || session.title !== normalizeSessionTitle(expectedTitle)) return false
    session.title = normalizeSessionTitle(title)
    session.updatedAt = Date.now()
    return true
  }

  async archiveSession(sessionId: string, archivedAt: number): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在或已被删除')
    session.archivedAt = archivedAt
    session.updatedAt = Date.now()
  }

  async restoreSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在或已被删除')
    session.archivedAt = null
    session.updatedAt = Date.now()
  }

  async clearWorkspaceForPath(path: string): Promise<number> {
    let affected = 0
    const now = Date.now()
    for (const session of this.sessions.values()) {
      if (session.workspace?.path === path) {
        session.workspace = null
        session.updatedAt = now
        affected += 1
      }
    }
    return affected
  }

  async recordEvent(sessionId: string, event: AgentLifecycleEvent): Promise<void> {
    if (MUTATION_EVENT_TYPES.has(event.type)) {
      throw new Error('Runtime mutation 只能通过 commitMutationBatch 持久化')
    }
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在或已被删除')
    const now = Date.now()
    if (event.type === 'agent_start') {
      const existing = this.runs.get(event.runId)
      if (existing && existing.sessionId !== sessionId) {
        throw new Error('Agent Run ID 已被其他 Session 占用')
      }
      if (existing) {
        if (existing.status !== 'running') {
          throw new Error('Agent Run 已进入终态，拒绝重新启动')
        }
        if (session.status !== 'running') {
          throw new Error('Agent Run 幂等重放与 Session 状态不一致')
        }
        return
      }
      if (Array.from(this.runs.entries()).some(([runId, run]) => (
        runId !== event.runId && run.sessionId === sessionId && run.status === 'running'
      ))) {
        throw new Error('Session 已存在其他活动 Agent Run')
      }
      if (session.status !== 'idle') {
        throw new Error('Session 不在空闲状态，拒绝启动新的 Agent Run')
      }
      this.runs.set(event.runId, { sessionId, status: 'running' })
      session.status = 'running'
    }
    if (event.type === 'provider_request_start') {
      const run = this.runs.get(event.runId)
      if (!run || run.sessionId !== sessionId || run.status !== 'running') {
        throw new Error('Provider request 无法关联到活动运行')
      }
      const existing = this.providerRequests.get(event.requestId)
        ?? Array.from(this.providerRequests.values()).find((request) => (
          request.runId === event.runId && request.assistantMessageId === event.assistantMessageId
        ))
      if (existing) {
        if (existing.sessionId !== sessionId
          || existing.runId !== event.runId
          || existing.assistantMessageId !== event.assistantMessageId
          || existing.modelProvider !== event.modelProvider
          || existing.modelId !== event.modelId
          || existing.messageCount !== event.messageCount
          || existing.toolCount !== event.toolCount) {
          throw new Error('Provider request start replay 与 canonical effect 不一致')
        }
        if (existing.status !== 'running') {
          throw new Error('Provider request 已进入终态，拒绝重新启动')
        }
        return
      }
      this.providerRequests.set(event.requestId, {
        sessionId,
        runId: event.runId,
        assistantMessageId: event.assistantMessageId,
        modelProvider: event.modelProvider,
        modelId: event.modelId,
        messageCount: event.messageCount,
        toolCount: event.toolCount,
        status: 'running',
      })
    }
    if (event.type === 'provider_response_received') {
      const request = this.providerRequests.get(event.requestId)
      if (!request || request.sessionId !== sessionId || request.runId !== event.runId
        || request.assistantMessageId !== event.assistantMessageId
        || event.message.id !== event.assistantMessageId) {
        throw new Error('Provider response 没有对应的活动请求')
      }
      const responseMessageIdentity = canonicalJsonIdentity(event.message)
      if (request.status === 'response_received' || request.status === 'committed') {
        if (request.responseId !== event.message.responseId
          || request.responseModel !== event.message.responseModel
          || request.responseMessageIdentity !== responseMessageIdentity) {
          throw new Error('Provider response replay 与 canonical effect 不一致')
        }
        return
      }
      if (request.status !== 'running') {
        throw new Error('Provider request 已中断，拒绝接收过期 response')
      }
      request.status = 'response_received'
      request.responseId = event.message.responseId
      request.responseModel = event.message.responseModel
      request.responseMessageIdentity = responseMessageIdentity
      request.message = structuredClone(event.message)
    }
    if (event.type === 'message_end') {
      const messages = this.messages.get(sessionId) ?? []
      const run = this.runs.get(event.runId)
      if (!run || run.sessionId !== sessionId || run.status !== 'running'
        || session.status !== 'running') {
        throw new Error('Session message 对应的运行不在执行中')
      }
      const index = messages.findIndex((message) => message.id === event.message.id)
      const storedMessage = index >= 0 ? messages[index] : undefined
      const messageReplayed = storedMessage !== undefined
      if (messageReplayed && (this.messageRuns.get(event.message.id) !== event.runId
        || canonicalJsonIdentity(storedMessage) !== canonicalJsonIdentity(event.message))) {
        throw new Error('Session message ID 已被不一致的 canonical effect 占用')
      }
      if (!messageReplayed && Array.from(this.messages.entries()).some(([storedSessionId, stored]) => (
        storedSessionId !== sessionId && stored.some((message) => message.id === event.message.id)
      ))) {
        throw new Error('Session message ID 已被其他 Session 占用')
      }
      const consumedJournalEntry = event.consumedJournalEntryId
        ? (this.journal.get(sessionId) ?? [])
            .find((entry) => entry.id === event.consumedJournalEntryId)
        : undefined
      if (event.consumedJournalEntryId) {
        const isAppliedReplay = consumedJournalEntry?.status === 'applied'
          && messageReplayed
        if (event.message.role !== 'user'
          || consumedJournalEntry?.kind !== 'queue'
          || consumedJournalEntry.message.id !== event.message.id
          || canonicalJsonIdentity(consumedJournalEntry.message) !== canonicalJsonIdentity(event.message)
          || consumedJournalEntry.consumerRunId !== event.runId
          || (consumedJournalEntry.status !== 'consuming' && !isAppliedReplay)) {
          throw new Error('Session message 与 queue journal 消费事实不匹配')
        }
      }
      let pendingToolCompletion: {
        key: string
        event: ToolExecutionEndEvent
        execution: MemoryToolExecution
      } | undefined
      if (event.message.role === 'tool') {
        const key = memoryToolExecutionKey(event.runId, event.message.toolCallId)
        const pending = this.pendingToolCompletions.get(key)
        const execution = this.tools.get(key)
        if (messageReplayed) {
          if (pending || !execution || execution.sessionId !== sessionId
            || !execution.completion || execution.completion.toolName !== event.message.toolName
            || execution.completion.isError !== event.message.isError
            || execution.status !== (event.message.isError ? 'error' : 'completed')) {
            throw new Error('ToolResult message 与已完成工具 canonical effect 不一致')
          }
        } else {
          if (!pending || !execution || pending.sessionId !== sessionId
            || execution.sessionId !== sessionId || execution.status !== 'running'
            || pending.event.toolName !== event.message.toolName
            || pending.event.isError !== event.message.isError) {
            throw new Error('ToolResult message 缺少匹配的待完成工具执行')
          }
          pendingToolCompletion = { key, event: pending.event, execution }
        }
      }
      const assistantProvider = event.message.role === 'assistant'
        ? Array.from(this.providerRequests.values()).find((request) => (
            request.sessionId === sessionId && request.runId === event.runId
            && request.assistantMessageId === event.message.id
          ))
        : undefined
      if (event.message.role === 'assistant' && !assistantProvider
        && !isOrchestrationFailureMessage(event.message)) {
        throw new Error('Assistant message 缺少 Provider response ledger')
      }
      if (assistantProvider && (
        assistantProvider.responseMessageIdentity !== canonicalJsonIdentity(event.message)
        || (messageReplayed
          ? assistantProvider.status !== 'committed'
          : assistantProvider.status !== 'response_received')
      )) {
        throw new Error('Assistant message 与 Provider response canonical effect 不一致')
      }
      if (messageReplayed) {
        return
      }
      messages.push(structuredClone(event.message))
      this.messages.set(sessionId, messages)
      this.messageRuns.set(event.message.id, event.runId)
      session.messageCount = messages.length
      if (session.title === '新会话' && event.message.role === 'user') {
        session.title = promptSessionTitle(event.message.content)
      }
      if (assistantProvider) assistantProvider.status = 'committed'
      if (pendingToolCompletion) {
        pendingToolCompletion.execution.status = pendingToolCompletion.event.isError
          ? 'error'
          : 'completed'
        pendingToolCompletion.execution.completion = structuredClone(pendingToolCompletion.event)
        this.pendingToolCompletions.delete(pendingToolCompletion.key)
      }
      if (consumedJournalEntry?.kind === 'queue') {
        consumedJournalEntry.status = 'applied'
        consumedJournalEntry.recoveredAt = undefined
      }
    }
    if (event.type === 'tool_execution_start') {
      const key = memoryToolExecutionKey(event.runId, event.toolCallId)
      const run = this.runs.get(event.runId)
      if (!run || run.sessionId !== sessionId || run.status !== 'running') {
        throw new Error('Tool execution 无法关联到活动 Run')
      }
      const argumentsIdentity = canonicalJsonIdentity(event.arguments)
      const existing = this.tools.get(key)
      if (existing) {
        if (existing.sessionId !== sessionId) {
          throw new Error('Tool execution Run 不属于当前 Session')
        }
        if (existing.status !== 'running') {
          throw new Error('Tool execution 已进入终态，拒绝重新启动')
        }
        if (existing.toolName !== event.toolName
          || existing.argumentsIdentity !== argumentsIdentity
          || existing.approvalState !== event.approvalState
          || existing.recoveryPolicy !== event.recoveryPolicy
          || existing.idempotencyKey !== event.idempotencyKey) {
          throw new Error('Tool execution start replay 与 canonical effect 不一致')
        }
        return
      }
      this.tools.set(key, {
        sessionId,
        runId: event.runId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        argumentsIdentity,
        status: 'running',
        approvalState: event.approvalState,
        recoveryPolicy: event.recoveryPolicy,
        ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
      })
    }
    if (event.type === 'tool_execution_end') {
      const key = memoryToolExecutionKey(event.runId, event.toolCallId)
      const execution = this.tools.get(key)
      if (!execution || execution.sessionId !== sessionId || execution.status !== 'running') {
        throw new Error('工具完成事实缺少对应的活动工具执行')
      }
      const pending = { sessionId, event: structuredClone(event) }
      const existing = this.pendingToolCompletions.get(key)
      if (existing && canonicalJsonIdentity(existing) !== canonicalJsonIdentity(pending)) {
        throw new Error('工具完成事实在 ToolResult 持久化前发生变化')
      }
      this.pendingToolCompletions.set(key, pending)
    }
    if (event.type === 'compaction_end' && event.checkpoint) {
      await assertContextCheckpointIntegrity(
        event.checkpoint,
        sessionId,
        this.messages.get(sessionId) ?? [],
      )
      const checkpoints = this.checkpoints.get(sessionId) ?? []
      checkpoints.push(structuredClone(event.checkpoint))
      this.checkpoints.set(sessionId, checkpoints)
    }
    if (event.type === 'agent_end') {
      const run = this.runs.get(event.runId)
      if (!run) throw new Error('Agent Run 不存在或尚未启动')
      if (run.sessionId !== sessionId) throw new Error('Agent Run 不属于当前 Session')
      if (run.status !== 'running') {
        if (run.status === 'finished'
          && run.endReason === event.reason
          && run.errorMessage === event.errorMessage) return
        throw new Error('Agent Run 已以不同终态结束，拒绝过期终结重放')
      }
      if (session.status !== 'running') throw new Error('Agent Run 所属 Session 不在运行中')
      if (Array.from(this.pendingToolCompletions.values()).some((pending) => (
        pending.sessionId === sessionId && pending.event.runId === event.runId
      ))) {
        throw new Error('Agent Run 仍有未与 ToolResult 原子落盘的工具完成事实')
      }
      if (Array.from(this.providerRequests.values()).some((request) => (
        request.sessionId === sessionId
        && request.runId === event.runId
        && (request.status === 'running' || request.status === 'response_received')
      ))) {
        throw new Error('Agent Run 仍有未完成的 Provider ledger')
      }
      if (Array.from(this.tools.values()).some((execution) => (
        execution.sessionId === sessionId
        && execution.runId === event.runId
        && execution.status === 'running'
      ))) {
        throw new Error('Agent Run 仍有未完成的 Tool ledger')
      }
      this.runs.set(event.runId, {
        sessionId,
        status: 'finished',
        endReason: event.reason,
        ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
        ...(run.latestTurnSavePoint
          ? { latestTurnSavePoint: structuredClone(run.latestTurnSavePoint) }
          : {}),
      })
    }
    if (event.type === 'turn_save_point') {
      const run = this.runs.get(event.savePoint.runId)
      const latest = run?.latestTurnSavePoint
      if (latest) {
        if (event.savePoint.turn < latest.turn) {
          throw new Error('Turn Save Point 轮次不能回退')
        }
        if (event.savePoint.turn === latest.turn) {
          if (canonicalJsonIdentity(event.savePoint) !== canonicalJsonIdentity(latest)) {
            throw new Error('同轮 Turn Save Point replay 与 canonical effect 不一致')
          }
          return
        }
      }
      this.assertTurnSavePoint(sessionId, event.savePoint)
      this.runs.get(event.savePoint.runId)!.latestTurnSavePoint = structuredClone(event.savePoint)
    }
    if (event.type === 'agent_settled') {
      if (event.savePoint.sessionId !== sessionId) {
        throw new Error('Agent Save Point 不属于当前会话')
      }
      const run = this.runs.get(event.savePoint.runId)
      if (!run || run.sessionId !== sessionId || run.status !== 'finished') {
        throw new Error('Agent Save Point 对应的运行尚未完成')
      }
      const messages = this.messages.get(sessionId) ?? []
      if (messages.length !== event.savePoint.messageCount
        || (event.savePoint.lastMessageId !== undefined
          && messages[messages.length - 1]?.id !== event.savePoint.lastMessageId)) {
        throw new Error('Agent Save Point 与已持久化消息边界不一致')
      }
      const checkpoints = this.checkpoints.get(sessionId) ?? []
      const latestCheckpointId = checkpoints[checkpoints.length - 1]?.id
      if (latestCheckpointId !== event.savePoint.checkpointId) {
        throw new Error('Agent Save Point 与已持久化上下文检查点不一致')
      }
      session.status = 'idle'
      this.journal.set(sessionId, (this.journal.get(sessionId) ?? [])
        .filter((entry) => entry.status !== 'applied' && entry.status !== 'discarded'))
    }
    session.updatedAt = now
  }

  async clearSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('会话不存在或已被删除')
    const removedMessageIds = new Set((this.messages.get(sessionId) ?? []).map((message) => message.id))
    this.messages.set(sessionId, [])
    this.checkpoints.set(sessionId, [])
    this.journal.set(sessionId, [])
    for (const [runId, run] of this.runs) {
      if (run.sessionId === sessionId) this.runs.delete(runId)
    }
    for (const messageId of removedMessageIds) this.messageRuns.delete(messageId)
    for (const [toolId, execution] of this.tools) {
      if (execution.sessionId === sessionId) this.tools.delete(toolId)
    }
    for (const [requestId, request] of this.providerRequests) {
      if (request.sessionId === sessionId) this.providerRequests.delete(requestId)
    }
    for (const [batchId, stored] of this.mutationBatches) {
      if (stored.sessionId === sessionId) this.mutationBatches.delete(batchId)
    }
    session.title = '新会话'
    session.messageCount = 0
    session.updatedAt = Date.now()
    for (const stored of this.sessions.values()) {
      if (stored.forkedFromMessageId && removedMessageIds.has(stored.forkedFromMessageId)) {
        stored.forkedFromMessageId = null
      }
      if (stored.retriedMessageId && removedMessageIds.has(stored.retriedMessageId)) {
        stored.retriedMessageId = null
      }
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.clearSession(sessionId)
    this.sessions.delete(sessionId)
    this.messages.delete(sessionId)
    this.checkpoints.delete(sessionId)
    this.journal.delete(sessionId)
    for (const stored of this.sessions.values()) {
      if (stored.parentSessionId === sessionId) stored.parentSessionId = null
    }
  }

  async deleteSessionWithSuccessor(
    sessionId: string,
    defaults: SessionDefaults,
  ): Promise<SessionSnapshot> {
    const target = this.sessions.get(sessionId)
    if (!target) throw new Error('会话不存在或已被删除')
    if (this.sessions.size !== 1 || target.status !== 'idle'
      || Array.from(this.runs.values()).some((run) => (
        run.sessionId === sessionId && run.status === 'running'
      ))) {
      throw new Error('只有最后一个空闲 Session 可以原子替换')
    }
    const now = Date.now()
    const successor: StoredAgentSession = {
      id: createId('session'),
      title: '新会话',
      systemPrompt: defaults.systemPrompt,
      modelProvider: defaults.modelProvider,
      modelId: defaults.modelId,
      reasoning: defaults.reasoning ? structuredClone(defaults.reasoning) : null,
      activeToolNames: defaults.activeToolNames?.slice() ?? [],
      providerConfig: defaults.providerConfig ? structuredClone(defaults.providerConfig) : null,
      runtimeManifest: defaults.runtimeManifest ? structuredClone(defaults.runtimeManifest) : null,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      parentSessionId: null,
      forkedFromMessageId: null,
      branchKind: null,
      retriedMessageId: null,
      workspace: defaults.workspace ? structuredClone(defaults.workspace) : null,
    }
    await this.deleteSession(sessionId)
    this.sessions.set(successor.id, successor)
    this.messages.set(successor.id, [])
    this.checkpoints.set(successor.id, [])
    this.journal.set(successor.id, [])
    return {
      session: cloneStoredSession(successor),
      messages: [],
      checkpoint: null,
      journalEntries: [],
    }
  }

  async getStats(): Promise<StorageStats> {
    const artifacts = new Map<string, number>()
    for (const messages of this.messages.values()) {
      for (const message of messages) {
        if (message.role === 'tool' && message.artifact) {
          artifacts.set(message.artifact.id, message.artifact.sizeBytes)
        }
      }
    }
    return {
      sessionCount: this.sessions.size,
      messageCount: Array.from(this.messages.values()).reduce((sum, messages) => sum + messages.length, 0),
      runCount: this.runs.size,
      toolExecutionCount: this.tools.size,
      providerRequestCount: this.providerRequests.size,
      checkpointCount: Array.from(this.checkpoints.values()).reduce((sum, checkpoints) => sum + checkpoints.length, 0),
      artifactCount: artifacts.size,
      artifactBytes: Array.from(artifacts.values()).reduce((sum, bytes) => sum + bytes, 0),
      artifactTrashCount: 0,
      artifactTrashBytes: 0,
      databaseBytes: 0,
    }
  }

  private assertTurnSavePoint(sessionId: string, savePoint: AgentTurnSavePoint): void {
    if (savePoint.sessionId !== sessionId || savePoint.turn < 1) {
      throw new Error('Turn Save Point 不属于当前会话或轮次无效')
    }
    const run = this.runs.get(savePoint.runId)
    if (!run || run.sessionId !== sessionId || run.status !== 'running') {
      throw new Error('Turn Save Point 对应的运行不在执行中')
    }
    if (savePoint.hadPendingMutations !== (savePoint.mutationBatchIds.length > 0)
      || new Set(savePoint.mutationBatchIds).size !== savePoint.mutationBatchIds.length
      || savePoint.mutationBatchIds.some((batchId) => {
        const batch = this.mutationBatches.get(batchId)
        return batch?.sessionId !== sessionId
          || batch.runId !== savePoint.runId
          || batch.turn !== savePoint.turn
      })) {
      throw new Error('Turn Save Point 的 mutation batch 边界无效')
    }
    const messages = this.messages.get(sessionId) ?? []
    if (messages.length !== savePoint.messageCount
      || (savePoint.lastMessageId !== undefined
        && messages[messages.length - 1]?.id !== savePoint.lastMessageId)) {
      throw new Error('Turn Save Point 与已持久化消息边界不一致')
    }
    const checkpoints = this.checkpoints.get(sessionId) ?? []
    if (checkpoints[checkpoints.length - 1]?.id !== savePoint.checkpointId) {
      throw new Error('Turn Save Point 与已持久化上下文检查点不一致')
    }
  }

  async prepareProviderProfileMigrations(): Promise<ProviderProfilePersistenceMigration[]> {
    return []
  }

  async commitProviderProfileMigrations(
    migrations: ProviderProfilePersistenceMigration[],
  ): Promise<void> {
    if (migrations.length > 0) throw new Error('Memory Session Repository 不接受持久化迁移')
  }

  private requireJournalEntries(
    sessionId: string,
    entryIds: string[],
  ): AgentSessionJournalEntry[] {
    if (new Set(entryIds).size !== entryIds.length) throw new Error('Agent journal entry ID 重复')
    const entries = this.journal.get(sessionId) ?? []
    return entryIds.map((entryId) => {
      const entry = entries.find((candidate) => candidate.id === entryId)
      if (!entry || entry.sessionId !== sessionId) throw new Error('Agent journal entry 不存在或不属于当前会话')
      return entry
    })
  }
}
