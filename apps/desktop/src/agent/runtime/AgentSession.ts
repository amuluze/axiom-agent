import { createId } from '@/agent/core/id'
import {
  assertMessagePersistable,
  convertBuiltInCustomMessage,
  createTurnAbortedMessage,
  createUserMessage,
  defaultConvertToModelMessages,
  TURN_ABORTED_CUSTOM_TYPE,
} from '@/agent/core/messages'
import {
  activeToolsForContext,
  normalizeAgentContextTools,
  validateActiveToolNames,
  validateToolRegistry,
} from '@/agent/core/deferredTools'
import {
  runAgentLoop,
  type AgentLoopTurnUpdate,
  type AgentTurnSnapshot,
} from '@/agent/core/runAgentLoop'
import {
  snapshotAgentContext,
  snapshotAgentEvent,
  snapshotAgentMessage,
  snapshotAgentMessages,
  snapshotAgentTools,
} from '@/agent/core/snapshots'
import { applyStreamingEvent } from '@/agent/core/streamingDraft'
import { impliesMessageNotPersisted } from '@/agent/core/persistenceBarrier'
import { ContextWindowManager } from '@/agent/context/ContextWindowManager'
import { createContextPolicy } from '@/agent/context/types'
import type { ContextBudgetUsage, ContextCheckpoint, ContextPolicy } from '@/agent/context/types'
import type { SummaryInstructionOptions } from '@/agent/context/summaryInstructions'
import type { AfterCompactionHook, BeforeCompactionHook } from './summaryHooks'
import { isOverflowAssistant } from '@/agent/context/budget'
import { MessageQueue } from './messageQueue'
import { SessionJournal } from './sessionJournal'
import type { QueueDeliveryMode } from './queueSettings'
import {
  acceptedQueueMessage,
  rejectedQueueMessage,
  type QueueAcceptance,
  type QueueMoveTarget,
  type QueueMutationResult,
  type QueuePlacement,
} from './queueContracts'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import {
  createParentRunLedger,
  type SubAgentParentRunLedger,
  type SubAgentObservationSink,
  type SubAgentRuntime,
  type SubAgentRuntimeBinding,
} from '@/agent/subagent/contracts'
import type {
  AgentMutationJournal,
  AgentSessionJournalEntry,
  DurableRuntimeUpdate,
  QueuedMessageKind,
} from './mutationJournal'
export type { QueuedMessageKind } from './mutationJournal'
import type {
  AgentContext,
  AgentDelegationRequest,
  AgentDelegationResult,
  AgentEvent,
  AgentLimits,
  AgentLoopResult,
  AgentMessage,
  AgentMutationBatch,
  AgentMutationEvent,
  AgentMutationReceipt,
  AgentRunEndReason,
  RuntimeDependenciesSnapshot,
  AgentSavePoint,
  AgentTool,
  AfterToolCall,
  AssistantMessage,
  BeforeAgentStart,
  BeforeToolCall,
  ConvertToModelMessages,
  ImageContentBlock,
  ModelMessage,
  ModelReasoning,
  ModelRef,
  ModelRequest,
  ModelTransport,
  ModelTransportLifecycle,
  ResolveModelAuth,
  RuntimeUpdateSource,
  SubAgentDelegationContext,
  ToolExecutionMode,
  ToolResultExternalizer,
  TransformContext,
  UserContentBlock,
} from '@/agent/core/types'

/**
 * E2E-only runtime fault checkpoint identifiers.
 *
 * Defined here (L5) so the runtime layer owns the checkpoint vocabulary and
 * the platform layer (`platform/runtimeFaultInjection.ts`) imports it as a
 * type, keeping the dependency direction L5-agnostic. In production builds the
 * checkpoint callback is a no-op; it only terminates the process during E2E
 * fault-injection runs.
 */
export type RuntimeFaultCheckpoint =
  | 'queue_consuming'
  | 'queue_recovered'
  | 'tool_execution_started'
  | 'tool_execution_finished'
  | 'tool_result_committed'
  | 'workspace_audit_persisted'
  | 'mutation_batch_committed'
  | 'compaction_checkpoint_committed'
  | 'provider_response_received'
  | 'agent_end_before_settled'
  | 'intent_fsynced'
  | 'profile_committed'

export interface AgentSessionOptions {
  sessionId?: string
  systemPrompt: string
  model: ModelRef
  transport: ModelTransport
  tools?: AgentTool[]
  activeToolNames?: string[]
  messages?: AgentMessage[]
  limits?: Partial<AgentLimits>
  toolExecution?: ToolExecutionMode
  steeringMode?: QueueDeliveryMode
  followUpMode?: QueueDeliveryMode
  /** 队列自动出队开关（默认 true）：false 时 turn 边界不自动消费，仅手动放行。 */
  autoDrain?: boolean
  beforeToolCall?: BeforeToolCall
  afterToolCall?: AfterToolCall
  transformContext?: TransformContext
  convertToModelMessages?: ConvertToModelMessages
  resolveModelAuth?: ResolveModelAuth
  /** Provider 请求/响应观察回调（扩展点）：产品级「Provider 运行时」诊断区块已下线，
   *  当前无生产调用方；子 Agent 预算记账走 `runAgentLoop` 直连通道（SubAgentRuntime）。
   *  保留以承接后续轻量观测（如会话内 usage 展示）。 */
  onModelRequest?: (request: ModelRequest, signal: AbortSignal) => void | Promise<void>
  onModelResponse?: (
    message: AssistantMessage,
    request: ModelRequest,
    signal: AbortSignal,
  ) => void | Promise<void>
  providerLifecycle?: ModelTransportLifecycle
  beforeAgentStart?: BeforeAgentStart
  prepareNextTurn?: (
    snapshot: AgentTurnSnapshot,
    signal: AbortSignal,
  ) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>
  shouldStopAfterTurn?: (snapshot: AgentTurnSnapshot) => boolean | Promise<boolean>
  reasoning?: ModelReasoning
  contextWindow?: number
  contextPolicy?: ContextPolicy
  checkpoint?: ContextCheckpoint | null
  externalizeToolResult?: ToolResultExternalizer
  beforeCompaction?: BeforeCompactionHook
  afterCompaction?: AfterCompactionHook
  commitMutationBatch?: (
    batch: AgentMutationBatch,
  ) => AgentMutationReceipt | void | Promise<AgentMutationReceipt | void>
  autoRetry?: AgentAutoRetryOptions
  mutationJournal?: AgentMutationJournal
  journalEntries?: AgentSessionJournalEntry[]
  /** SubAgent 委派运行时（Explore）。缺失时当前宿主不支持 SubAgent 委派。 */
  subAgentRuntime?: SubAgentRuntime
  /** 父工作区 environment（SubAgentRuntime 基于它构造 scope 收窄的只读环境）。 */
  subAgentEnvironment?: AgentEnvironment
  /** 父授权工作区根目录绝对路径（相对路径解析根）；注入子 prompt 与 scope 快速校验诊断。 */
  subAgentWorkspacePath?: string
  /** 子会话 Provider 观察 sink（归并到父 run，不落 repository/父 mutation journal）。 */
  subAgentObservation?: SubAgentObservationSink
  /**
   * E2E fault-injection checkpoint hook. Injected by the host (L4 store) so
   * this layer stays free of any `@/platform/*` dependency. Defaults to a
   * no-op when not provided.
   */
  onRuntimeCheckpoint?: (checkpoint: RuntimeFaultCheckpoint) => void | Promise<void>
}

export interface AgentAutoRetryOptions {
  enabled?: boolean
  /** Number of automatic retries after the original failed request. */
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

type AgentEventListener = (event: AgentEvent, signal: AbortSignal) => void | Promise<void>

export interface QueuedMessageSnapshot {
  id: string
  kind: QueuedMessageKind
  content: string
  /**
   * 队列项的图片块（只读投影：与队列内消息共享块对象，调用方不得就地修改）。
   * 回填输入框必须带上它，否则「恢复编辑」会静默丢图。
   */
  images: ImageContentBlock[]
  createdAt: number
}

export interface AgentAbortSettlement {
  sessionId: string
  requestedAt: number
  settledAt: number
  hadActiveRun: boolean
  settled: boolean
  durable: boolean
  runId?: string
  reason?: AgentRunEndReason
  savePoint?: AgentSavePoint
  queues: {
    consumedMessageIds: string[]
    recovered: QueuedMessageSnapshot[]
    preservedNextTurn: QueuedMessageSnapshot[]
    discardedMessageIds: string[]
  }
  errors: string[]
}

export interface AgentRuntimeUpdate {
  systemPrompt?: string
  model?: ModelRef
  reasoning?: ModelReasoning | null
  tools?: AgentTool[]
  activeToolNames?: string[]
  transport?: ModelTransport
}

interface ActiveRun {
  controller: AbortController
  promise: Promise<unknown>
}

interface ResolvedAutoRetryOptions {
  enabled: boolean
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
}

const DEFAULT_AUTO_RETRY: ResolvedAutoRetryOptions = {
  enabled: true,
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
}

const resolveAutoRetryOptions = (options?: AgentAutoRetryOptions): ResolvedAutoRetryOptions => {
  const resolved = { ...DEFAULT_AUTO_RETRY, ...options }
  if (!Number.isInteger(resolved.maxRetries) || resolved.maxRetries < 0) {
    throw new Error('autoRetry.maxRetries 必须是非负整数')
  }
  if (!Number.isFinite(resolved.baseDelayMs) || resolved.baseDelayMs < 0) {
    throw new Error('autoRetry.baseDelayMs 必须是非负数')
  }
  if (!Number.isFinite(resolved.maxDelayMs) || resolved.maxDelayMs < resolved.baseDelayMs) {
    throw new Error('autoRetry.maxDelayMs 不能小于 baseDelayMs')
  }
  return resolved
}

const waitForRetryDelay = (delayMs: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  if (delayMs === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, delayMs)
    const abort = (): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

const isSafeAutoRetryFailure = (message: AgentMessage | undefined): message is AssistantMessage =>
  message?.role === 'assistant'
  && message.stopReason === 'error'
  && message.providerError?.retryable === true
  // rate_limit 不再触发前端二次自动重试：Rust model_http 已对 429 退避重试最多 5 次，
  // 幸存 429 应直接呈现给用户，避免再向已限流的 provider 追加请求。
  && message.providerError?.kind !== 'rate_limit'
  && message.excludeFromModelContext === true
  && message.toolCalls.length === 0
  && message.content.length === 0
  && !message.contentBlocks?.some((block) => block.type === 'thinking')

/** 队列项的图片块投影：共享块对象，只读消费（回填输入框时按需再克隆）。 */
const queuedMessageImages = (message: AgentMessage): ImageContentBlock[] =>
  message.role === 'user' && message.contentBlocks
    ? message.contentBlocks.filter((block): block is ImageContentBlock => block.type === 'image')
    : []

const QUEUE_KINDS: readonly QueuedMessageKind[] = ['steering', 'follow-up', 'next-turn']

export class AgentSession {
  readonly id: string
  private readonly listeners = new Set<AgentEventListener>()
  private readonly steeringQueue: MessageQueue
  private readonly followUpQueue: MessageQueue
  private readonly nextTurnQueue: MessageQueue
  private transport: ModelTransport
  private readonly limits?: Partial<AgentLimits>
  private readonly toolExecution?: ToolExecutionMode
  private readonly beforeToolCall?: BeforeToolCall
  private readonly afterToolCall?: AfterToolCall
  private readonly transformContext?: TransformContext
  private readonly convertToModelMessages?: ConvertToModelMessages
  private readonly resolveModelAuth?: ResolveModelAuth
  private readonly onModelRequest?: AgentSessionOptions['onModelRequest']
  private readonly onModelResponse?: AgentSessionOptions['onModelResponse']
  private readonly providerLifecycle?: ModelTransportLifecycle
  private readonly subAgentRuntime?: SubAgentRuntime
  private readonly subAgentEnvironment?: AgentEnvironment
  /** 父授权工作区根目录绝对路径（相对路径解析根）；注入子 prompt 与 scope 快速校验。 */
  private readonly subAgentWorkspacePath?: string
  private readonly subAgentObservation?: SubAgentObservationSink
  private readonly beforeAgentStart?: BeforeAgentStart
  private readonly prepareNextTurn?: AgentSessionOptions['prepareNextTurn']
  private readonly shouldStopAfterTurn?: AgentSessionOptions['shouldStopAfterTurn']
  private readonly externalizeToolResult?: ToolResultExternalizer
  private readonly commitMutationBatch?: AgentSessionOptions['commitMutationBatch']
  private readonly autoRetry: ResolvedAutoRetryOptions
  private readonly mutationJournal?: AgentMutationJournal
  private readonly onRuntimeCheckpoint?: AgentSessionOptions['onRuntimeCheckpoint']
  private readonly contextWindow: number
  private readonly contextWindowManager: ContextWindowManager
  private historyMessages: AgentMessage[]
  private context: AgentContext
  private baseActiveToolNames: string[]
  private activeRun?: ActiveRun
  private acceptingQueuedMessages = false
  private readonly drainedQueueKinds = new Map<string, QueuedMessageKind>()
  private readonly queuedMessageOrder = new Map<string, number>()
  private nextQueuedMessageOrder = 0
  private recoveredQueuedMessages: QueuedMessageSnapshot[] = []
  private currentStreamingMessage?: AgentMessage
  /** currentStreamingMessage 各 contentBlock 的 contentIndex 升序列表（流式重放阴影）。 */
  private streamingContentIndexes: number[] = []
  private activeToolCallIds = new Set<string>()
  private lastErrorMessage?: string
  private lastSavePoint?: AgentSavePoint
  private lastRunResult?: AgentLoopResult
  private pendingAppendedMessages: Array<{ message: AgentMessage; journalEntryId?: string }> = []
  private pendingRuntimeUpdates: Array<{
    update: AgentRuntimeUpdate
    source: RuntimeUpdateSource
    journalEntryId?: string
  }> = []
  private pendingMutationBatch?: {
    id: string
    appendedCount: number
    runtimeCount: number
    journalEntryIds: string[]
    update: AgentLoopTurnUpdate
  }
  private pendingIdleMutationBatch?: AgentMutationBatch
  private pendingIdleMutationApply?: () => void | Promise<void>
  private idleMutationCommitInFlight = false
  private currentRetryAttempt = 0
  private retryWaiting = false
  private readonly queueJournalEntryIds = new Map<string, string>()
  private readonly sessionJournal: SessionJournal
  /** 队列自动出队开关（默认 true）：false 时 turn 边界不消费，仅 sendQueuedNow 放行。 */
  private autoDrainEnabled = true
  /** 手动放行待注入的队列项 id：命中 steering 队首时放行一次，消费/换条后失效。 */
  private immediateDispatchId?: string
  /** 中点插值触及 double 精度极限的标记：下一次跨队列移动前先整型重排。 */
  private orderPrecisionDegraded = false

  constructor(options: AgentSessionOptions) {
    this.id = options.sessionId ?? createId('session')
    this.historyMessages = snapshotAgentMessages(options.messages ?? [])
    const tools = snapshotAgentTools(options.tools ?? [])
    this.baseActiveToolNames = validateActiveToolNames(
      options.activeToolNames ?? tools.map((tool) => tool.name),
      tools,
    )
    this.context = normalizeAgentContextTools({
      sessionId: this.id,
      systemPrompt: options.systemPrompt,
      model: structuredClone(options.model),
      reasoning: options.reasoning ? structuredClone(options.reasoning) : undefined,
      messages: this.historyMessages,
      tools,
      activeToolNames: this.baseActiveToolNames,
    })
    this.transport = options.transport
    this.limits = options.limits
    this.toolExecution = options.toolExecution
    this.beforeToolCall = options.beforeToolCall
    this.afterToolCall = options.afterToolCall
    this.transformContext = options.transformContext
    this.convertToModelMessages = options.convertToModelMessages
    this.resolveModelAuth = options.resolveModelAuth
    this.onModelRequest = options.onModelRequest
    this.onModelResponse = options.onModelResponse
    this.providerLifecycle = options.providerLifecycle
    this.subAgentRuntime = options.subAgentRuntime
    this.subAgentEnvironment = options.subAgentEnvironment
    this.subAgentWorkspacePath = options.subAgentWorkspacePath
    this.subAgentObservation = options.subAgentObservation
    this.beforeAgentStart = options.beforeAgentStart
    this.prepareNextTurn = options.prepareNextTurn
    this.shouldStopAfterTurn = options.shouldStopAfterTurn
    this.externalizeToolResult = options.externalizeToolResult
    this.commitMutationBatch = options.commitMutationBatch
    this.autoRetry = resolveAutoRetryOptions(options.autoRetry)
    this.mutationJournal = options.mutationJournal
    this.sessionJournal = new SessionJournal(this.id, options.mutationJournal)
    this.onRuntimeCheckpoint = options.onRuntimeCheckpoint
    // contextWindow 来源优先级：ModelRef（ProviderRegistry.resolveModel 已优先使用
    // 模型目录值）> profile 值 > 硬编码兜底。确保 SubAgentBudgetLedger 的 token 估算
    // 与 ContextWindowManager 的压缩阈值使用准确窗口（如 phi4=16K 而非 provider 默认 128K）。
    this.contextWindow = this.context.model.contextWindow
      ?? options.contextWindow
      ?? 128_000
    this.contextWindowManager = new ContextWindowManager({
      transport: options.transport,
      policy: options.contextPolicy ?? createContextPolicy(this.contextWindow),
      checkpoint: options.checkpoint,
      emit: (event) => this.emit(event),
      beforeCompaction: options.beforeCompaction,
      afterCompaction: options.afterCompaction,
    })
    this.context.messages = this.contextWindowManager.buildProjection(this.historyMessages)
    this.steeringQueue = new MessageQueue(options.steeringMode ?? 'one-at-a-time')
    this.followUpQueue = new MessageQueue(options.followUpMode ?? 'one-at-a-time')
    this.nextTurnQueue = new MessageQueue('all')
    this.autoDrainEnabled = options.autoDrain ?? true
    this.restoreJournalEntries(options.journalEntries ?? [])
  }

  get isRunning(): boolean {
    return Boolean(this.activeRun)
  }

  get canQueueMessages(): boolean {
    return this.acceptingQueuedMessages
  }

  /**
   * sendQueuedNow 的武装目标（未消费/未作废时非空）：UI 据此渲染「已放行，
   * 等待 turn 边界注入」的即时反馈——否则点击接受与注入之间的窗口对用户不可见。
   */
  get armedQueueMessageId(): string | undefined {
    return this.immediateDispatchId
  }

  /** 当前队列模式（steering/follow-up 投递档 + autoDrain）：宿主在缓存激活等边界对齐全局设置用。 */
  get queueModes(): { steering: QueueDeliveryMode; followUp: QueueDeliveryMode; autoDrain: boolean } {
    return {
      steering: this.steeringQueue.deliveryMode,
      followUp: this.followUpQueue.deliveryMode,
      autoDrain: this.autoDrainEnabled,
    }
  }

  get signal(): AbortSignal | undefined {
    return this.activeRun?.controller.signal
  }

  get streamingMessage(): AgentMessage | undefined {
    return this.currentStreamingMessage
      ? snapshotAgentMessage(this.currentStreamingMessage)
      : undefined
  }

  get pendingToolCalls(): ReadonlySet<string> {
    return new Set(this.activeToolCallIds)
  }

  get errorMessage(): string | undefined {
    return this.lastErrorMessage
  }

  get retryAttempt(): number {
    return this.currentRetryAttempt
  }

  get isRetrying(): boolean {
    return this.retryWaiting
  }

  get pendingSteeringCount(): number {
    return this.steeringQueue.size
  }

  get pendingFollowUpCount(): number {
    return this.followUpQueue.size
  }

  get pendingNextTurnCount(): number {
    return this.nextTurnQueue.size
  }

  hasQueuedMessages(): boolean {
    return this.steeringQueue.size > 0 || this.followUpQueue.size > 0
  }

  get queuedMessages(): QueuedMessageSnapshot[] {
    return this.sortQueuedMessages([
      ...this.steeringQueue.snapshot().map((message) => this.queueSnapshot(message, 'steering')),
      ...this.followUpQueue.snapshot().map((message) => this.queueSnapshot(message, 'follow-up')),
      ...this.nextTurnQueue.snapshot().map((message) => this.queueSnapshot(message, 'next-turn')),
    ])
  }

  get recoveredMessages(): QueuedMessageSnapshot[] {
    return this.sortQueuedMessages(this.recoveredQueuedMessages.map((message) => ({ ...message })))
  }

  get messages(): AgentMessage[] {
    return snapshotAgentMessages(this.historyMessages)
  }

  get runtimeContext(): AgentContext {
    return snapshotAgentContext(this.context)
  }

  getTools(): AgentTool[] {
    return snapshotAgentTools(this.context.tools)
  }

  getActiveTools(): AgentTool[] {
    return snapshotAgentTools(activeToolsForContext(this.context))
  }

  /** 当前 live systemPrompt（reload 构造 previous snapshot 用）。 */
  get systemPrompt(): string {
    return this.context.systemPrompt
  }

  /** 当前激活工具名（reload 构造 previous snapshot 用）。 */
  get activeToolNames(): readonly string[] {
    return this.baseActiveToolNames.slice()
  }

  setTools(tools: AgentTool[], activeToolNames?: string[]): Promise<void> {
    if (this.activeRun) throw new Error('Agent 运行期间请使用 prepareNextTurn 更新 Runtime')
    return this.updateRuntime({ tools, activeToolNames })
  }

  setActiveTools(toolNames: string[]): Promise<void> {
    if (this.activeRun) throw new Error('Agent 运行期间请使用 prepareNextTurn 更新 Runtime')
    return this.updateRuntime({ activeToolNames: toolNames })
  }

  updateRuntime(
    update: AgentRuntimeUpdate,
    source: RuntimeUpdateSource = 'set',
  ): Promise<void> {
    if (this.activeRun) throw new Error('Agent 运行期间请使用 prepareNextTurn 更新 Runtime')
    const previous = snapshotAgentContext(this.context)
    const { context, activeToolNames } = this.resolveRuntimeUpdate(previous, update)
    const events = this.createRuntimeMutationEvents(previous, context, source)
    const apply = async (): Promise<void> => {
      this.baseActiveToolNames = activeToolNames
      this.context = { ...context, messages: this.context.messages.slice() }
      this.transport = update.transport ?? this.transport
      await this.emitExternalEvents(events)
    }
    return this.commitThenApply(this.createMutationBatch(events), apply)
  }

  /**
   * 原子替换 Runtime dependencies（systemPrompt + activeToolNames + manifest），
   * 生成唯一的 `runtime_dependencies_update` mutation event（对齐
   * docs/skills-extension.md §7.4）。即使 systemPrompt/activeToolNames 未变化，
   * 只要 canonical manifest 不同也由调用方保证生成该事件；事件使当前 context
   * checkpoint 失效（持久化侧随 batch 同事务删除，live 侧 reset）。
   */
  async updateRuntimeDependencies(input: {
    previous: RuntimeDependenciesSnapshot
    current: RuntimeDependenciesSnapshot
  }): Promise<void> {
    if (this.activeRun) throw new Error('Agent 运行期间不能原子替换 Runtime dependencies')
    const event: AgentMutationEvent = {
      type: 'runtime_dependencies_update',
      previous: input.previous,
      current: input.current,
      source: 'set',
      invalidateCheckpoint: true,
    }
    const apply = async (): Promise<void> => {
      this.baseActiveToolNames = input.current.activeToolNames.slice()
      this.context = {
        ...this.context,
        systemPrompt: input.current.systemPrompt,
        activeToolNames: input.current.activeToolNames.slice(),
      }
      this.contextWindowManager.reset()
      this.context.messages = this.contextWindowManager.buildProjection(this.historyMessages)
      await this.emitExternal(event)
    }
    await this.commitThenApply(this.createMutationBatch([event]), apply)
  }

  async appendMessage(message: AgentMessage): Promise<void> {
    const appended = snapshotAgentMessage(message)
    if (this.activeRun) {
      if (!this.acceptingQueuedMessages) throw new Error('Agent 结算已关闭，不能再追加消息')
      this.assertAppendableMessages([appended], this.projectedPendingMessageIds())
      const journalEntry = this.sessionJournal.createEntry({ kind: 'message_append', message: appended })
      await this.sessionJournal.write(async () => {
        if (journalEntry) await this.mutationJournal?.append(journalEntry)
        this.pendingAppendedMessages.push({
          message: appended,
          ...(journalEntry ? { journalEntryId: journalEntry.id } : {}),
        })
      })
      return
    }
    this.assertAppendableMessages([appended], new Set(this.historyMessages.map((item) => item.id)))
    const event: AgentMutationEvent = {
      type: 'session_message_append',
      sessionId: this.id,
      message: appended,
    }
    await this.commitThenApply(this.createMutationBatch([event]), async () => {
      this.historyMessages.push(appended)
      this.context = {
        ...this.context,
        messages: this.contextWindowManager.buildProjection(this.historyMessages),
      }
      this.lastSavePoint = undefined
      await this.emitExternal(event)
    })
  }

  async scheduleRuntimeUpdate(update: AgentRuntimeUpdate): Promise<void> {
    if (!this.activeRun) {
      await this.updateRuntime(update, 'scheduled')
      return
    }
    if (!this.acceptingQueuedMessages) throw new Error('Agent 结算已关闭，不能再调度 Runtime 更新')
    let projected = snapshotAgentContext(this.context)
    for (const pending of this.pendingRuntimeUpdates) {
      projected = this.resolveRuntimeUpdate(projected, pending.update).context
    }
    const resolved = this.resolveRuntimeUpdate(projected, update)
    if (this.mutationJournal && (update.tools !== undefined || update.transport !== undefined)) {
      throw new Error('运行中的动态 Tool registry/Transport 更新无法安全序列化到 durable journal')
    }
    if (this.mutationJournal
      && this.createRuntimeMutationEvents(projected, resolved.context, 'scheduled').length === 0) {
      return
    }
    const durableUpdate: DurableRuntimeUpdate = {
      ...(update.systemPrompt !== undefined ? { systemPrompt: update.systemPrompt } : {}),
      ...(update.model ? { model: structuredClone(update.model) } : {}),
      ...(update.reasoning !== undefined
        ? { reasoning: update.reasoning ? structuredClone(update.reasoning) : null }
        : {}),
      ...(update.activeToolNames !== undefined
        ? { activeToolNames: resolved.activeToolNames.slice() }
        : {}),
    }
    const journalEntry = this.sessionJournal.createEntry({ kind: 'runtime_update', update: durableUpdate })
    await this.sessionJournal.write(async () => {
      if (journalEntry) await this.mutationJournal?.append(journalEntry)
      this.pendingRuntimeUpdates.push({
        update: this.snapshotRuntimeUpdate(update),
        source: 'scheduled',
        ...(journalEntry ? { journalEntryId: journalEntry.id } : {}),
      })
    })
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async prompt(content: string, images?: ImageContentBlock[]): Promise<AgentLoopResult> {
    const normalized = content.trim()
    if (!normalized && (!images || images.length === 0)) throw new Error('消息不能为空')
    const blocks: UserContentBlock[] | undefined = images?.length
      ? [
          ...(normalized ? [{ type: 'text' as const, text: normalized }] : []),
          ...images,
        ]
      : undefined
    return this.startPromptRun([createUserMessage(blocks ?? normalized)])
  }

  async promptMessages(messages: AgentMessage[]): Promise<AgentLoopResult> {
    if (messages.length === 0) throw new Error('消息不能为空')
    return this.startPromptRun(snapshotAgentMessages(messages))
  }

  /** Continue without adding a user message. Used by retry/branch recovery only. */
  async continue(): Promise<AgentLoopResult> {
    if (this.historyMessages.length === 0) throw new Error('空会话不能直接继续生成')
    const lastModelMessage = [...this.context.messages]
      .reverse()
      .find((message) => message.role !== 'custom')
    if (!lastModelMessage) throw new Error('当前上下文没有可继续的模型消息')
    if (lastModelMessage.role === 'assistant') {
      throw new Error('不能从 Assistant 消息直接继续；普通继续请发送新的 User 消息，重试请先恢复到安全边界')
    }
    return this.startRun([])
  }

  /** Retry a failed/aborted assistant response while retaining it in durable history. */
  async retry(): Promise<AgentLoopResult> {
    if (this.activeRun) throw new Error('Agent 正在运行，请等待当前运行结束')
    const lastHistoryMessage = this.historyMessages[this.historyMessages.length - 1]
    if (lastHistoryMessage?.role !== 'assistant'
      || (lastHistoryMessage.stopReason !== 'error' && lastHistoryMessage.stopReason !== 'aborted')) {
      throw new Error('只有失败或已中止的 Assistant 响应可以直接重试')
    }
    let retryBoundaryIndex = this.context.messages.length
    while (retryBoundaryIndex > 0) {
      const candidate = this.context.messages[retryBoundaryIndex - 1]
      if (candidate?.role === 'custom'
        || candidate?.role === 'assistant'
          && (candidate.stopReason === 'error' || candidate.stopReason === 'aborted')) {
        retryBoundaryIndex -= 1
        continue
      }
      break
    }
    const retryMessages = this.context.messages.slice(0, retryBoundaryIndex)
    const retryBoundary = [...retryMessages].reverse().find((message) => message.role !== 'custom')
    if (!retryBoundary || retryBoundary.role === 'assistant') {
      throw new Error('失败响应之前没有可安全重试的 User 或 ToolResult 边界')
    }
    this.context = { ...this.context, messages: retryMessages }
    // 被截断的失败 assistant 仍留在 historyMessages 供审计，但必须标记为
    // excludeFromModelContext：否则 retry run 结束后 buildProjection(historyMessages)
    // 会把不完整的失败响应重新放回模型上下文——部分文本被重放，空响应触发 Anthropic 400。
    const failedAssistant = this.historyMessages[this.historyMessages.length - 1]
    if (failedAssistant.role === 'assistant' && failedAssistant.excludeFromModelContext !== true) {
      this.historyMessages[this.historyMessages.length - 1] = {
        ...failedAssistant,
        excludeFromModelContext: true,
      }
    }
    return this.continue()
  }

  private async startPromptRun(prompts: AgentMessage[]): Promise<AgentLoopResult> {
    if (this.activeRun) throw new Error('Agent 正在运行，请使用 steering 或等待当前运行结束')
    // 在 run 启动前 fail-fast：超预算消息一旦入列，message_end 持久化屏障才会失败，
    // 会话已被留在半持久化状态；此处拒绝则什么都没写，用户拆分/精简后直接重发。
    for (const message of prompts) assertMessagePersistable(message)
    return this.startRun(prompts, true)
  }

  private async startRun(
    prompts: AgentMessage[],
    includeNextTurnMessages = false,
  ): Promise<AgentLoopResult> {
    if (this.activeRun) throw new Error('Agent 正在运行，请使用 steering 或等待当前运行结束')

    const controller = new AbortController()
    this.acceptingQueuedMessages = true
    this.currentStreamingMessage = undefined
    this.streamingContentIndexes = []
    this.activeToolCallIds = new Set()
    this.lastErrorMessage = undefined
    this.lastRunResult = undefined
    const promise = Promise.resolve()
      .then(async () => {
        const claimedNextTurnMessages: AgentMessage[] = []
        let initialMessagesClaimed = false
        try {
          return await this.runPrompt(
            prompts,
            controller.signal,
            includeNextTurnMessages
              ? async (runId) => {
                  if (initialMessagesClaimed) return []
                  initialMessagesClaimed = true
                  const messages = await this.drainQueue(this.nextTurnQueue, 'next-turn', runId)
                  claimedNextTurnMessages.push(...messages)
                  return messages
                }
              : undefined,
          )
        } finally {
          await this.restoreDrainedMessages(claimedNextTurnMessages)
        }
      })
      .finally(async () => {
        this.acceptingQueuedMessages = false
        try {
          await this.recoverActiveQueuedMessages()
        } finally {
          this.currentStreamingMessage = undefined
          this.streamingContentIndexes = []
          this.activeToolCallIds = new Set()
          this.activeRun = undefined
        }
      })
    this.activeRun = { controller, promise }
    return promise
  }

  /**
   * post-turn 空闲压缩触发点（P0-3a）。仅正常收口的 run 触发：aborted/time_limit
   * 的上下文马上可能被用户继续（且中断标记紧跟其后），error 的历史可能有毒，
   * 都交给下一个请求 prepareModelRequest 的硬阈值兜底。若本次 prompt 期间已经
   * 压缩过（checkpoint 创建于本次 prompt 内），跳过——压缩刚做过，立即按更低的
   * 软水位重复压缩只会多花一次摘要调用。失败静默：空闲压缩是优化而非正确性依赖。
   */
  private async runIdleCompactionIfDue(
    result: AgentLoopResult,
    signal: AbortSignal,
    promptStartedAt: number,
  ): Promise<void> {
    if (
      result.reason !== 'completed'
      && result.reason !== 'tool_limit'
      && result.reason !== 'turn_limit'
      && result.reason !== 'stopped'
    ) {
      return
    }
    const checkpoint = this.contextWindowManager.currentCheckpoint
    if (checkpoint && checkpoint.createdAt >= promptStartedAt) return
    try {
      const request = this.createModelRequest('context-usage', this.context)
      await this.contextWindowManager.compactIfIdleDue(request, signal, this.transport)
    } catch {
      // best-effort：空闲压缩失败不毒化已结算的 run
    }
  }

  /**
   * 中断仪式（对齐 codex 的 interrupted_turn_history_marker）：被中断/超时的 run
   * 在历史尾部写入 turn-aborted 标记，下一轮模型能看到上一轮未正常收口、不假设
   * 中断前的工作已完成。调用时机在 runPrompt 收尾处（savePoint 之前），此时
   * activeRun 仍挂着，因此不走 appendMessage 的 pending 队列分支（会被
   * recoverActiveQueuedMessages 误标为恢复草稿），而是复用其空闲分支的提交路径
   * 立即落库——标记计入 savePoint 边界，终态事件发出前已落库。
   * 标记是 best-effort：写失败不把一次已成功结算的中断变成失败的 run。
   */
  private async appendTurnAbortedMarkerIfInterrupted(result: AgentLoopResult): Promise<void> {
    if (result.reason !== 'aborted' && result.reason !== 'time_limit') return
    // 没有产生任何 turn 的中断（采样尚未开始）不写标记——没有「被中断的工作」可言。
    if (result.turns <= 0) return
    const last = this.historyMessages[this.historyMessages.length - 1]
    if (last?.role === 'custom' && last.customType === TURN_ABORTED_CUSTOM_TYPE) return
    const message = createTurnAbortedMessage(result.reason === 'time_limit' ? 'time-limit' : 'user-abort')
    try {
      const appended = snapshotAgentMessage(message)
      this.assertAppendableMessages([appended], new Set(this.historyMessages.map((item) => item.id)))
      const event: AgentMutationEvent = {
        type: 'session_message_append',
        sessionId: this.id,
        message: appended,
      }
      await this.commitThenApply(this.createMutationBatch([event]), async () => {
        this.historyMessages.push(appended)
        this.context = {
          ...this.context,
          messages: this.contextWindowManager.buildProjection(this.historyMessages),
        }
        await this.emitExternal(event)
      })
    } catch (error) {
      console.warn('turn-aborted 标记写入失败（不影响已结算的运行结果）', error)
    }
  }

  steer(message: AgentMessage): Promise<QueueAcceptance>
  steer(content: string, images?: ImageContentBlock[]): Promise<QueueAcceptance>
  async steer(
    input: string | AgentMessage,
    images?: ImageContentBlock[],
  ): Promise<QueueAcceptance> {
    const message = this.createQueuedMessage(input, images)
    if (!message) return rejectedQueueMessage('empty-input')
    const acceptedRun = this.acceptingQueuedMessages ? this.activeRun : undefined
    if (!acceptedRun) return rejectedQueueMessage('runtime-not-accepting')
    return this.enqueueQueuedMessage(this.steeringQueue, 'steering', message, acceptedRun)
  }

  followUp(message: AgentMessage): Promise<QueueAcceptance>
  followUp(content: string, images?: ImageContentBlock[]): Promise<QueueAcceptance>
  async followUp(
    input: string | AgentMessage,
    images?: ImageContentBlock[],
  ): Promise<QueueAcceptance> {
    const message = this.createQueuedMessage(input, images)
    if (!message) return rejectedQueueMessage('empty-input')
    const acceptedRun = this.acceptingQueuedMessages ? this.activeRun : undefined
    if (!acceptedRun) return rejectedQueueMessage('runtime-not-accepting')
    return this.enqueueQueuedMessage(this.followUpQueue, 'follow-up', message, acceptedRun)
  }

  /** Queue context that is injected only alongside the next explicit prompt. */
  nextTurn(message: AgentMessage): Promise<QueueAcceptance>
  nextTurn(content: string, images?: ImageContentBlock[]): Promise<QueueAcceptance>
  async nextTurn(
    input: string | AgentMessage,
    images?: ImageContentBlock[],
  ): Promise<QueueAcceptance> {
    const message = this.createQueuedMessage(input, images)
    if (!message) return rejectedQueueMessage('empty-input')
    return this.enqueueQueuedMessage(this.nextTurnQueue, 'next-turn', message)
  }

  async clearQueuedMessages(): Promise<void> {
    await this.clearQueues([
      this.steeringQueue,
      this.followUpQueue,
      this.nextTurnQueue,
    ])
  }

  async clearSteeringQueue(): Promise<void> {
    await this.clearQueues([this.steeringQueue])
  }

  async clearFollowUpQueue(): Promise<void> {
    await this.clearQueues([this.followUpQueue])
  }

  async clearNextTurnQueue(): Promise<void> {
    await this.clearQueues([this.nextTurnQueue])
  }

  setQueueModes(steering: QueueDeliveryMode, followUp: QueueDeliveryMode): void {
    this.steeringQueue.setMode(steering)
    this.followUpQueue.setMode(followUp)
  }

  /** 切换队列自动出队：切换即作废悬挂的手动放行，避免方向切换后意外注入旧目标。 */
  setAutoDrain(enabled: boolean): void {
    this.autoDrainEnabled = enabled
    this.immediateDispatchId = undefined
  }

  /**
   * 手动放行一条队列项（对齐 ZCode sendQueuedNow）：运行中把目标项移到 steering 队首
   * 并武装单次立即注入——即使 autoDrain=false 也会在下一个 turn 边界被消费；未指定 id
   * 时取显示序第一条。run 未运行时拒绝（idle 发送由 store 层组合恢复草稿 + prompt）。
   */
  async sendQueuedNow(messageId?: string): Promise<QueueAcceptance> {
    if (!this.activeRun || !this.acceptingQueuedMessages) {
      return rejectedQueueMessage('runtime-not-accepting')
    }
    const target = messageId ?? this.queuedMessages[0]?.id
    if (!target) return rejectedQueueMessage('unknown-message')
    const moved = await this.moveQueuedMessage(target, {
      kind: 'steering',
      placement: { position: 'top' },
    })
    if (!moved.updated) return rejectedQueueMessage(moved.reason)
    this.immediateDispatchId = target
    return acceptedQueueMessage(target)
  }

  /**
   * 原位改写队列项（保留消息 id、kind 与位置）。队列项 id 是 journal 消费事实的锚点，
   * 因此编辑必须复用同一 id——新建消息会让已落盘的消费事实与队列项失联。
   */
  async editQueuedMessage(
    messageId: string,
    content: string,
    images?: ImageContentBlock[],
  ): Promise<QueueMutationResult> {
    const location = this.queuedMessageLocation(messageId)
    if (!location) return { updated: false, reason: 'unknown-message' }
    const current = location.queue.find(messageId)
    if (!current) return { updated: false, reason: 'unknown-message' }
    const edited = this.applyQueuedMessageContent(current, content, images)
    if (!edited) return { updated: false, reason: 'empty-input' }
    return this.rewriteQueuedMessage(
      messageId,
      location.kind,
      edited,
      this.orderOf(messageId),
    )
  }

  /**
   * 移动队列项：可在同一队列内重排，也可跨队列提升（follow-up / next-turn → steering）。
   * 位置相对「显示序」表达，order 由运行时插值计算，只需重写一条 entry。
   */
  async moveQueuedMessage(
    messageId: string,
    target: QueueMoveTarget,
  ): Promise<QueueMutationResult> {
    const location = this.queuedMessageLocation(messageId)
    if (!location) return { updated: false, reason: 'unknown-message' }
    const current = location.queue.find(messageId)
    if (!current) return { updated: false, reason: 'unknown-message' }
    let order = this.resolveQueueOrder(messageId, target.placement)
    if (order === undefined) return { updated: false, reason: 'unknown-message' }
    if (this.orderPrecisionDegraded) {
      // 中点插值已无法在既有 order 之间表达新位置（double 精度耗尽）：先整型重排
      // 全部队列项腾出空间，再重算目标位置——顺序语义与用户意图保持一致。
      await this.reindexQueueOrders()
      order = this.resolveQueueOrder(messageId, target.placement)
      if (order === undefined) return { updated: false, reason: 'unknown-message' }
    }
    return this.rewriteQueuedMessage(messageId, target.kind, current, order)
  }

  /**
   * 整型重排全部队列项（0..n-1，按当前显示序）：单点中点插值的精度兜底。
   * journal 侧与 rewriteQueuedMessage 同向——先 append 全部新 entry（承载新 order）
   * 再 discard 全部旧 entry；discard 失败补偿丢弃新 entry，append 半途失败则新旧
   * 并存，恢复按重复 ID fail-closed，不丢数据。内存侧最后统一重建，不领先于 durable。
   */
  private async reindexQueueOrders(): Promise<void> {
    await this.sessionJournal.write(() => this.reindexQueueOrdersLocked())
  }

  /** reindex 内核：必须已在 sessionJournal.write 内调用（write 串行链不可重入）。 */
  private async reindexQueueOrdersLocked(): Promise<void> {
    const ordered = this.queuedMessages.slice()
    const rewrites: Array<{ id: string; kind: QueuedMessageKind; message: AgentMessage }> = []
    for (const snapshot of ordered) {
      const location = this.queuedMessageLocation(snapshot.id)
      const message = location?.queue.find(snapshot.id)
      if (!location || !message) continue
      rewrites.push({ id: snapshot.id, kind: location.kind, message })
    }
    const entries = rewrites.map(({ kind, message }, index) =>
      this.sessionJournal.createEntry({ kind: 'queue', queueKind: kind, message, order: index }))
    for (const entry of entries) {
      if (entry) await this.mutationJournal?.append(entry)
    }
    try {
      const previousEntryIds = rewrites.flatMap(({ id }) => {
        const entryId = this.queueJournalEntryIds.get(id)
        return entryId ? [entryId] : []
      })
      if (previousEntryIds.length > 0) await this.mutationJournal?.discard(previousEntryIds)
    } catch (error) {
      const appendedIds = entries.flatMap((entry) => (entry ? [entry.id] : []))
      for (const entryId of appendedIds) {
        try {
          await this.mutationJournal?.discard([entryId])
        } catch {
          // fail-soft：与 rewriteQueuedMessage 同款补偿；残留 pending 携带同一
          // message.id，恢复时按重复 ID fail-closed 暴露。
        }
      }
      throw error
    }
    rewrites.forEach(({ id, message }, index) => {
      const entry = entries[index]
      if (entry) this.queueJournalEntryIds.set(id, entry.id)
      this.recordQueuedMessage(message, index)
    })
    // 按新显示序重建各队列数组：drain 顺序（数组头）必须与显示序一致。
    for (const kind of QUEUE_KINDS) {
      const queue = this.queueForKind(kind)
      const queueItems = rewrites
        .filter(({ id }) => this.queuedMessageLocation(id)?.kind === kind)
        .map(({ message }) => message)
      queue.clear()
      for (const message of queueItems) queue.enqueue(message)
    }
    this.orderPrecisionDegraded = false
  }

  /** 提升为引导：移到 steering 队首（下一个 turn 边界注入，不中断当前 turn）。 */
  promoteQueuedMessage(messageId: string): Promise<QueueMutationResult> {
    return this.moveQueuedMessage(messageId, { kind: 'steering', placement: { position: 'top' } })
  }

  /** 删除单条队列项（恢复草稿走 discardRecoveredMessage，语义不同）。 */
  async deleteQueuedMessage(messageId: string): Promise<QueueMutationResult> {
    const location = this.queuedMessageLocation(messageId)
    if (!location) return { updated: false, reason: 'unknown-message' }
    await this.sessionJournal.write(async () => {
      // 直接用不嵌套 write 的内核：sessionJournal.write 是串行链，写入中再发起写入会互等死锁。
      await this.discardQueuedMessagesLocked([messageId])
      location.queue.remove(messageId)
    })
    return { updated: true, messageId, kind: location.kind }
  }

  async restoreQueuedMessage(messageId: string): Promise<QueuedMessageSnapshot | undefined> {
    const recovered = this.recoveredQueuedMessages.find((message) => message.id === messageId)
    if (recovered) {
      await this.discardQueuedMessage(messageId)
      this.recoveredQueuedMessages = this.recoveredQueuedMessages
        .filter((message) => message.id !== messageId)
      return { ...recovered }
    }
    const steering = this.steeringQueue.snapshot().find((message) => message.id === messageId)
    if (steering) {
      const snapshot = this.queueSnapshot(steering, 'steering')
      await this.discardQueuedMessage(messageId)
      this.steeringQueue.remove(messageId)
      return snapshot
    }
    const followUp = this.followUpQueue.snapshot().find((message) => message.id === messageId)
    if (followUp) {
      const snapshot = this.queueSnapshot(followUp, 'follow-up')
      await this.discardQueuedMessage(messageId)
      this.followUpQueue.remove(messageId)
      return snapshot
    }
    const nextTurn = this.nextTurnQueue.snapshot().find((message) => message.id === messageId)
    if (!nextTurn) return undefined
    const snapshot = this.queueSnapshot(nextTurn, 'next-turn')
    await this.discardQueuedMessage(messageId)
    this.nextTurnQueue.remove(messageId)
    return snapshot
  }

  async takeQueuedMessages(): Promise<QueuedMessageSnapshot[]> {
    if (this.activeRun) return []
    await this.recoverActiveQueuedMessages()
    return this.recoveredMessages
  }

  async discardRecoveredMessage(messageId: string): Promise<boolean> {
    if (!this.recoveredQueuedMessages.some((message) => message.id === messageId)) return false
    await this.discardQueuedMessage(messageId)
    this.recoveredQueuedMessages = this.recoveredQueuedMessages
      .filter((message) => message.id !== messageId)
    return true
  }

  requestAbort(reason: unknown = new DOMException('User aborted the run', 'AbortError')): boolean {
    const activeRun = this.activeRun
    if (!activeRun || activeRun.controller.signal.aborted) return false
    activeRun.controller.abort(reason)
    return true
  }

  private async recoverActiveQueuedMessages(): Promise<QueuedMessageSnapshot[]> {
    // 手动模式（autoDrain=false）是「队列暂停」而非「结算回收」：run 结束残留保留在
    // 队列跨 run 存活（下一个 run 的 turn 边界或手动放行继续消费），不搬运为恢复草稿。
    // 两个分支都要作废武装标记：autoDrain 分支队列整体转为恢复草稿，armed id 指向的
    // 已不是队列项，残留会让 armedQueueMessageId 投影携带跨 run 的脏目标。
    this.immediateDispatchId = undefined
    if (!this.autoDrainEnabled) {
      return []
    }
    const messages = this.sortQueuedMessages([
      ...this.steeringQueue.snapshot().map((message) => this.queueSnapshot(message, 'steering')),
      ...this.followUpQueue.snapshot().map((message) => this.queueSnapshot(message, 'follow-up')),
    ])
    if (messages.length === 0) return []
    const entryIds = messages.flatMap((message) => {
      const entryId = this.queueJournalEntryIds.get(message.id)
      return entryId ? [entryId] : []
    })
    await this.sessionJournal.write(async () => {
      if (entryIds.length > 0) {
        await this.mutationJournal?.markRecovered(entryIds)
        await this.onRuntimeCheckpoint?.('queue_recovered')
      }
      const recoveredIds = new Set(messages.map((message) => message.id))
      this.steeringQueue.takeAll()
      this.followUpQueue.takeAll()
      for (const messageId of recoveredIds) this.drainedQueueKinds.delete(messageId)
      const existingIds = new Set(this.recoveredQueuedMessages.map((message) => message.id))
      this.recoveredQueuedMessages.push(...messages.filter((message) => !existingIds.has(message.id)))
    })
    return messages.map((message) => ({ ...message }))
  }

  async abort(): Promise<AgentAbortSettlement> {
    const requestedAt = Date.now()
    const activeRun = this.activeRun
    const queuedAtRequest = new Set(this.queueJournalEntryIds.keys())
    const errors: string[] = []
    if (activeRun) {
      this.requestAbort()
      try {
        await activeRun.promise
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    const result = activeRun ? this.lastRunResult : undefined
    const consumedMessageIds = this.historyMessages
      .filter((message) => queuedAtRequest.has(message.id))
      .map((message) => message.id)
    return {
      sessionId: this.id,
      requestedAt,
      settledAt: Date.now(),
      hadActiveRun: Boolean(activeRun),
      settled: !this.activeRun,
      durable: errors.length === 0,
      ...(result ? { runId: result.runId, reason: result.reason } : {}),
      ...(activeRun && this.lastSavePoint ? { savePoint: { ...this.lastSavePoint } } : {}),
      queues: {
        consumedMessageIds,
        recovered: this.recoveredMessages,
        preservedNextTurn: this.nextTurnQueue.snapshot()
          .map((message) => this.queueSnapshot(message, 'next-turn')),
        discardedMessageIds: [],
      },
      errors,
    }
  }

  async waitForIdle(): Promise<void> {
    await this.activeRun?.promise
  }

  reset(): void {
    if (this.activeRun) throw new Error('Agent 运行期间不能重置会话')
    if (this.idleMutationCommitInFlight) throw new Error('空闲 Runtime mutation 提交期间不能重置会话')
    this.historyMessages = []
    this.context = normalizeAgentContextTools({
      ...this.context,
      messages: [],
      activeToolNames: this.baseActiveToolNames,
    })
    this.currentStreamingMessage = undefined
    this.streamingContentIndexes = []
    this.activeToolCallIds = new Set()
    this.lastErrorMessage = undefined
    this.contextWindowManager.reset()
    this.steeringQueue.clear()
    this.followUpQueue.clear()
    this.nextTurnQueue.clear()
    this.drainedQueueKinds.clear()
    this.queuedMessageOrder.clear()
    this.nextQueuedMessageOrder = 0
    this.recoveredQueuedMessages = []
    this.lastSavePoint = undefined
    this.lastRunResult = undefined
    this.pendingAppendedMessages = []
    this.pendingRuntimeUpdates = []
    this.pendingMutationBatch = undefined
    this.pendingIdleMutationBatch = undefined
    this.pendingIdleMutationApply = undefined
    this.queueJournalEntryIds.clear()
    this.immediateDispatchId = undefined
    this.orderPrecisionDegraded = false
    this.sessionJournal.reset()
  }

  get checkpoint(): ContextCheckpoint | null {
    return this.contextWindowManager.currentCheckpoint ?? null
  }

  get savePoint(): AgentSavePoint | null {
    return this.lastSavePoint ? { ...this.lastSavePoint } : null
  }

  getContextUsage(): ContextBudgetUsage {
    return this.contextWindowManager.evaluate(this.createModelRequest('context-usage'), this.transport)
  }

  async compact(summaryInstructions?: SummaryInstructionOptions): Promise<void> {
    if (this.activeRun) throw new Error('Agent 运行期间不能手动压缩上下文')
    const controller = new AbortController()
    const promise = Promise.resolve()
      .then(async () => {
        const request = await this.createPreparedModelRequest(createId('manual-compaction'), controller.signal)
        const compacted = await this.contextWindowManager.compactManually(
          request,
          controller.signal,
          this.transport,
          summaryInstructions,
        )
        this.context = { ...this.context, messages: compacted.messages.slice() }
      })
      .finally(() => {
        this.activeRun = undefined
      })
    this.activeRun = { controller, promise }
    await promise
  }

  private createModelRequest(runId: string, context: AgentContext = this.context) {
    return {
      sessionId: this.id,
      runId,
      systemPrompt: context.systemPrompt,
      model: context.model,
      messages: context.messages.flatMap((message): ModelMessage[] => {
        if (message.role !== 'custom') return [message]
        const converted = convertBuiltInCustomMessage(message)
        return converted ? [converted] : []
      }),
      tools: activeToolsForContext(context).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      reasoning: context.reasoning,
      maxOutputTokens: context.model.maxOutputTokens,
    }
  }

  private async createPreparedModelRequest(runId: string, signal: AbortSignal) {
    const transformed = this.transformContext
      ? await this.transformContext(
          this.context.messages.slice(),
          signal,
          snapshotAgentContext(this.context),
          runId,
        )
      : this.context.messages.slice()
    const messages = await (this.convertToModelMessages ?? defaultConvertToModelMessages)(transformed, signal)
    return {
      ...this.createModelRequest(runId),
      messages,
      auth: await this.resolveModelAuth?.(this.context.model, signal),
    }
  }

  private async runPrompt(
    initialPrompts: AgentMessage[],
    signal: AbortSignal,
    getInitialMessages?: (runId: string) => Promise<AgentMessage[]>,
  ): Promise<AgentLoopResult> {
    const promptStartedAt = Date.now()
    let overflowRecoveryAttempted = false
    let retryAttempt = 0
    let prompts = initialPrompts
    let finalResult: AgentLoopResult
    // 父 run 累计 Explore ledger：本次 prompt 调用内所有 runAgentLoop 尝试（含 retry）
    // 共享同一绝对预算，run finally 后自然释放（闭包捕获，无外部引用）。
    const runLedger = createParentRunLedger()

    try {
      while (true) {
        const result = await runAgentLoop({
        context: this.context,
        prompts,
        transport: this.transport,
        signal,
        limits: this.limits,
        toolExecution: this.toolExecution,
        getInitialMessages,
        beforeToolCall: this.beforeToolCall,
        afterToolCall: this.afterToolCall,
        transformContext: this.transformContext,
        convertToModelMessages: this.convertToModelMessages,
        resolveModelAuth: this.resolveModelAuth,
        onModelRequest: this.onModelRequest,
        onModelResponse: this.onModelResponse,
        providerLifecycle: this.providerLifecycle,
        beforeAgentStart: this.beforeAgentStart,
        prepareNextTurn: this.prepareNextTurn,
        peekPendingMutations: async () => this.peekPendingMutations(),
        acknowledgePendingMutations: async (batchId) => this.acknowledgePendingMutations(batchId),
        commitMutationBatch: this.commitMutationBatch
          ? async (batch) => {
              const receipt = await this.commitMutationBatch?.(batch)
              await this.onRuntimeCheckpoint?.('mutation_batch_committed')
              return receipt
            }
          : undefined,
        historyMessageCount: this.historyMessages.length,
        historyLastMessageId: this.historyMessages[this.historyMessages.length - 1]?.id,
        getCheckpointId: () => this.contextWindowManager.currentCheckpoint?.id,
        shouldStopAfterTurn: this.shouldStopAfterTurn,
        externalizeToolResult: this.externalizeToolResult,
        prepareModelRequest: this.contextWindowManager.prepareModelRequest,
        beforeAgentEnd: async (context, transport) => {
          const request = this.createModelRequest('context-usage', context)
          await this.emit({
            type: 'context_usage',
            usage: this.contextWindowManager.evaluate(request, transport),
            checkpointId: this.contextWindowManager.currentCheckpoint?.id,
          })
        },
        emit: (event) => this.emit(event),
        getSteeringMessages: async (runId) => this.drainQueue(this.steeringQueue, 'steering', runId),
        getFollowUpMessages: async (runId) => this.drainQueue(this.followUpQueue, 'follow-up', runId),
        onUnconsumedMessages: async (messages) => this.restoreUnconsumedMessages(messages),
        runDelegate: (request, ctx) => this.executeDelegate(request, ctx, runLedger),
        })
        this.historyMessages.push(...snapshotAgentMessages(result.newMessages))
        const resultContext = snapshotAgentContext(result.context)
        this.context = {
          ...resultContext,
          messages: this.contextWindowManager.buildProjection(this.historyMessages),
        }
        this.transport = result.transport
        this.baseActiveToolNames = this.context.activeToolNames?.slice()
          ?? this.context.tools.map((tool) => tool.name)
        finalResult = result

        const lastMessage = result.newMessages[result.newMessages.length - 1]
        if (signal.aborted) break

        if (!overflowRecoveryAttempted && isOverflowAssistant(lastMessage)) {
          overflowRecoveryAttempted = true
          this.context = {
            ...this.context,
            messages: this.context.messages.filter((message) => message.id !== lastMessage.id),
          }
          this.contextWindowManager.requestOverflowRecovery(lastMessage.id)
          prompts = []
          continue
        }

        if (isSafeAutoRetryFailure(lastMessage)
          && this.autoRetry.enabled
          && retryAttempt < this.autoRetry.maxRetries) {
          retryAttempt += 1
          this.currentRetryAttempt = retryAttempt
          const delayMs = Math.min(
            this.autoRetry.maxDelayMs,
            this.autoRetry.baseDelayMs * 2 ** (retryAttempt - 1),
          )
          await this.emit({
            type: 'auto_retry_start',
            attempt: retryAttempt,
            maxAttempts: this.autoRetry.maxRetries,
            delayMs,
            errorMessage: lastMessage.errorMessage ?? lastMessage.providerError?.message ?? '未知 Provider 错误',
            failedMessageId: lastMessage.id,
          })
          this.retryWaiting = true
          try {
            await waitForRetryDelay(delayMs, signal)
          } catch {
            await this.emit({
              type: 'auto_retry_end',
              success: false,
              attempt: retryAttempt,
              finalError: '自动重试已取消',
            })
            break
          } finally {
            this.retryWaiting = false
          }
          prompts = []
          continue
        }

        if (retryAttempt > 0) {
          const succeeded = lastMessage?.role === 'assistant'
            && lastMessage.stopReason !== 'error'
            && lastMessage.stopReason !== 'aborted'
          await this.emit({
            type: 'auto_retry_end',
            success: succeeded,
            attempt: retryAttempt,
            ...(!succeeded
              ? {
                  finalError: lastMessage?.role === 'assistant'
                    ? lastMessage.errorMessage ?? lastMessage.providerError?.message ?? '自动重试失败'
                    : '自动重试没有产生 Assistant 响应',
                }
              : {}),
          })
        }
        break
      }
    } finally {
      this.currentRetryAttempt = 0
      this.retryWaiting = false
    }

    this.lastRunResult = finalResult
    // 中断仪式：被中断/超时的 run 在历史尾部写入 turn-aborted 标记。必须在
    // savePoint/agent_settled 之前直接提交——标记计入 savePoint 边界，终态事件
    // 发出前已落库（先落库后终态）；空闲压缩也基于含标记的上下文评估。
    await this.appendTurnAbortedMarkerIfInterrupted(finalResult)
    // post-turn 空闲压缩：正常收口的 run 在回合间隙按软水位提前压缩，避免下一个
    // 请求为上一轮历史膨胀同步买单（对齐 codex 的 post-turn compaction slot）。
    await this.runIdleCompactionIfDue(finalResult, signal, promptStartedAt)
    await this.onRuntimeCheckpoint?.('agent_end_before_settled')
    const lastMessage = this.historyMessages[this.historyMessages.length - 1]
    this.lastSavePoint = {
      sessionId: this.id,
      runId: finalResult.runId,
      messageCount: this.historyMessages.length,
      ...(lastMessage ? { lastMessageId: lastMessage.id } : {}),
      ...(this.contextWindowManager.currentCheckpoint
        ? { checkpointId: this.contextWindowManager.currentCheckpoint.id }
        : {}),
      createdAt: Date.now(),
    }
    await this.emit({ type: 'agent_settled', savePoint: this.lastSavePoint })
    return finalResult
  }

  /**
   * 以当前权威状态构造 SubAgentRuntimeBinding 并委派。工具只看到
   * AgentToolExecutionContext.delegateAgent 窄接口；本方法持有 model/transport/
   * environment/预算 ledger/observation sink，不暴露给工具层。
   */
  private async executeDelegate(
    request: AgentDelegationRequest,
    ctx: SubAgentDelegationContext,
    runLedger: SubAgentParentRunLedger,
  ): Promise<AgentDelegationResult> {
    if (!this.subAgentRuntime || !this.subAgentEnvironment) {
      throw new Error('当前宿主不支持 SubAgent 委派')
    }
    const binding: SubAgentRuntimeBinding = {
      parentSessionId: this.id,
      parentRunId: ctx.parentRunId,
      parentToolCallId: ctx.parentToolCallId,
      model: this.context.model,
      transport: this.transport,
      providerLifecycle: this.providerLifecycle,
      resolveModelAuth: this.resolveModelAuth,
      environment: this.subAgentEnvironment,
      observation: this.subAgentObservation,
      ...(this.subAgentWorkspacePath ? { workspacePath: this.subAgentWorkspacePath } : {}),
      parentRunLedger: runLedger,
      contextWindow: this.contextWindow,
      ...(ctx.deadlineMs !== undefined ? { deadlineMs: ctx.deadlineMs } : {}),
      ...(ctx.reportProgress ? { reportProgress: ctx.reportProgress } : {}),
    }
    return this.subAgentRuntime.delegate(request, binding, ctx.signal)
  }

  private async emit(event: AgentEvent): Promise<void> {
    const completedQueueMessageId = event.type === 'message_end'
      && event.message.role === 'user'
      && this.drainedQueueKinds.has(event.message.id)
      ? event.message.id
      : undefined
    const consumedJournalEntryId = completedQueueMessageId
      ? this.queueJournalEntryIds.get(completedQueueMessageId)
      : undefined
    const observedEvent = snapshotAgentEvent(
      event.type === 'message_end' && consumedJournalEntryId
        ? { ...event, consumedJournalEntryId }
        : event,
    )
    // 已 drain 的队列消息：message_end 落库失败要回收，message_start 未能送达同样要回收
    // （此时 journal 已是 consuming，但消息尚未 append）。
    const drainedQueueMessage = (observedEvent.type === 'message_start'
      || observedEvent.type === 'message_end')
      && this.drainedQueueKinds.has(observedEvent.message.id)
      ? snapshotAgentMessage(observedEvent.message)
      : undefined
    let restoredToQueue = false
    if (observedEvent.type === 'agent_start') {
      this.acceptingQueuedMessages = true
      this.lastErrorMessage = undefined
    } else if (observedEvent.type === 'agent_end') {
      this.acceptingQueuedMessages = false
      this.currentStreamingMessage = undefined
      this.streamingContentIndexes = []
      this.lastErrorMessage = observedEvent.errorMessage
    } else if (observedEvent.type === 'message_start') {
      this.currentStreamingMessage = snapshotAgentMessage(observedEvent.message)
      this.streamingContentIndexes = []
    } else if (observedEvent.type === 'message_update') {
      if (this.currentStreamingMessage?.role === 'assistant') {
        const replayed = applyStreamingEvent(
          this.currentStreamingMessage,
          this.streamingContentIndexes,
          observedEvent.assistantMessageEvent,
        )
        this.currentStreamingMessage = replayed.message
        this.streamingContentIndexes = replayed.contentIndexes
      }
    } else if (observedEvent.type === 'message_end') {
      this.currentStreamingMessage = undefined
      this.streamingContentIndexes = []
    } else if (observedEvent.type === 'tool_execution_start') {
      this.activeToolCallIds = new Set(this.activeToolCallIds).add(observedEvent.toolCallId)
    } else if (observedEvent.type === 'tool_execution_end') {
      const pending = new Set(this.activeToolCallIds)
      pending.delete(observedEvent.toolCallId)
      this.activeToolCallIds = pending
    } else if (observedEvent.type === 'turn_end' && observedEvent.message.stopReason === 'error') {
      this.lastErrorMessage = observedEvent.message.errorMessage
    }
    const signal = this.activeRun?.controller.signal
    if (!signal) throw new Error('Agent 事件不能在活动运行之外发送')
    try {
      for (const listener of this.listeners) {
        await listener(snapshotAgentEvent(observedEvent), signal)
      }
      if (observedEvent.type === 'tool_execution_start') {
        await this.onRuntimeCheckpoint?.('tool_execution_started')
      } else if (observedEvent.type === 'tool_execution_end') {
        await this.onRuntimeCheckpoint?.('tool_execution_finished')
        if ((observedEvent.toolName === 'apply_changes'
          || observedEvent.toolName === 'apply_workspace_changes')
          && !observedEvent.isError
          && observedEvent.result.artifact) {
          await this.onRuntimeCheckpoint?.('workspace_audit_persisted')
        }
      } else if (observedEvent.type === 'message_end' && observedEvent.message.role === 'tool') {
        await this.onRuntimeCheckpoint?.('tool_result_committed')
      } else if (observedEvent.type === 'provider_response_received') {
        await this.onRuntimeCheckpoint?.('provider_response_received')
      } else if (observedEvent.type === 'compaction_end' && observedEvent.checkpoint) {
        await this.onRuntimeCheckpoint?.('compaction_checkpoint_committed')
      }
    } catch (error) {
      // 落库失败（监听器抛错）时不能只清内存事实：durable journal 会停在 consuming 且
      // consumer_run_id 指向已终结的 run，消息既不在库也不在队列——进程内没有任何路径
      // 再回收它，只有重启恢复才会把它回退 pending 重放。这里主动把 entry 回退 pending
      // 并把消息重新入队：下一次 run 以全新消费事实重新 drain、落库。
      // 回收失败不遮蔽原始错误：entry 留在 consuming，重启恢复仍会回退 pending 重放，
      // 消息不丢；消息实际已落库（journal 已 applied，或错误与落库无关）时回退是 no-op，
      // 不会重复投递。
      if (drainedQueueMessage && impliesMessageNotPersisted(error)) {
        try {
          await this.restoreDrainedMessages([drainedQueueMessage])
          restoredToQueue = true
        } catch {
          // fail-soft：原始落库错误优先，见上。
        }
      }
      throw error
    } finally {
      // 清理必须无条件执行：监听器（store 持久化）抛错正是「消息未落库」的常见形态，
      // 此时若跳过清理，drainedQueueKinds / queueJournalEntryIds 会带着已结束 run 的
      // 消费事实跨越 run 边界存活——之后每次重试 flush 该消息都会重放失效条目，
      // 持久化校验以「Session message 与 queue journal 消费事实不匹配」拒绝，
      // 并连带 save point 边界补偿失败，形成每次重试必败的死循环。
      // 例外：消息已随 journal 回退重新入队（restoredToQueue）时必须保留
      // queueJournalEntryIds 与 queuedMessageOrder——下一次 drain 要用同一 entry 重新
      // markConsuming。
      if (completedQueueMessageId && !restoredToQueue) {
        if (consumedJournalEntryId) this.queueJournalEntryIds.delete(completedQueueMessageId)
        this.drainedQueueKinds.delete(completedQueueMessageId)
        this.queuedMessageOrder.delete(completedQueueMessageId)
      }
    }
  }

  private async emitExternal(event: AgentEvent): Promise<void> {
    const observedEvent = snapshotAgentEvent(event)
    const signal = new AbortController().signal
    for (const listener of this.listeners) {
      await listener(snapshotAgentEvent(observedEvent), signal)
    }
  }

  private resolveRuntimeUpdate(
    current: AgentContext,
    update: AgentRuntimeUpdate,
  ): { context: AgentContext; activeToolNames: string[] } {
    const tools = update.tools ? snapshotAgentTools(update.tools) : current.tools
    const activeToolNames = update.activeToolNames?.slice()
      ?? (update.tools ? tools.map((tool) => tool.name) : current.activeToolNames?.slice()
        ?? tools.map((tool) => tool.name))
    validateToolRegistry(tools)
    validateActiveToolNames(activeToolNames, tools)
    return {
      context: normalizeAgentContextTools({
        ...current,
        systemPrompt: update.systemPrompt ?? current.systemPrompt,
        model: update.model ? structuredClone(update.model) : current.model,
        reasoning: update.reasoning === null
          ? undefined
          : update.reasoning
            ? structuredClone(update.reasoning)
            : current.reasoning,
        messages: current.messages,
        tools,
        activeToolNames,
      }),
      activeToolNames,
    }
  }

  private snapshotRuntimeUpdate(update: AgentRuntimeUpdate): AgentRuntimeUpdate {
    return {
      ...(update.systemPrompt !== undefined ? { systemPrompt: update.systemPrompt } : {}),
      ...(update.model ? { model: structuredClone(update.model) } : {}),
      ...(update.reasoning === null
        ? { reasoning: null }
        : update.reasoning ? { reasoning: structuredClone(update.reasoning) } : {}),
      ...(update.tools ? { tools: snapshotAgentTools(update.tools) } : {}),
      ...(update.activeToolNames ? { activeToolNames: update.activeToolNames.slice() } : {}),
      ...(update.transport ? { transport: update.transport } : {}),
    }
  }

  private peekPendingMutations(): {
    id: string
    update: AgentLoopTurnUpdate
    journalEntryIds?: string[]
  } | undefined {
    if (this.pendingMutationBatch) {
      return {
        id: this.pendingMutationBatch.id,
        update: structuredClone(this.pendingMutationBatch.update),
        journalEntryIds: this.pendingMutationBatch.journalEntryIds.slice(),
      }
    }
    if (this.pendingAppendedMessages.length === 0 && this.pendingRuntimeUpdates.length === 0) {
      return undefined
    }
    const appendMessages = snapshotAgentMessages(
      this.pendingAppendedMessages.map(({ message }) => message),
    )
    const runtimeUpdates = this.pendingRuntimeUpdates.map(({ update, source }) => ({
      ...this.snapshotRuntimeUpdate(update),
      source,
    }))
    const update: AgentLoopTurnUpdate = {
      ...(appendMessages.length ? { appendMessages } : {}),
      ...(runtimeUpdates.length ? { runtimeUpdates } : {}),
    }
    const journalEntryIds = [
      ...this.pendingAppendedMessages.flatMap(({ journalEntryId }) => journalEntryId ? [journalEntryId] : []),
      ...this.pendingRuntimeUpdates.flatMap(({ journalEntryId }) => journalEntryId ? [journalEntryId] : []),
    ]
    this.pendingMutationBatch = {
      id: journalEntryIds[0] ? `mutation:${journalEntryIds[0]}` : createId('mutation'),
      appendedCount: appendMessages.length,
      runtimeCount: runtimeUpdates.length,
      journalEntryIds,
      update,
    }
    return {
      id: this.pendingMutationBatch.id,
      update: structuredClone(update),
      journalEntryIds: journalEntryIds.slice(),
    }
  }

  private acknowledgePendingMutations(batchId: string): void {
    const pending = this.pendingMutationBatch
    if (!pending || pending.id !== batchId) {
      throw new Error('Save Point pending mutation batch 已变化，拒绝错误确认')
    }
    this.pendingAppendedMessages.splice(0, pending.appendedCount)
    this.pendingRuntimeUpdates.splice(0, pending.runtimeCount)
    this.pendingMutationBatch = undefined
  }

  private projectedPendingMessageIds(): Set<string> {
    return new Set([
      ...this.context.messages.map((message) => message.id),
      ...this.historyMessages.map((message) => message.id),
      ...this.pendingAppendedMessages.map(({ message }) => message.id),
    ])
  }

  private assertAppendableMessages(messages: AgentMessage[], ids: Set<string>): void {
    for (const message of messages) {
      if (!message.id || !Number.isFinite(message.createdAt) || typeof message.content !== 'string') {
        throw new Error('appendMessage() 收到格式无效的消息')
      }
      if (message.role !== 'user' && message.role !== 'custom') {
        throw new Error('appendMessage() 只允许追加 User 或 Custom 消息')
      }
      if (ids.has(message.id)) throw new Error(`appendMessage() 收到重复消息 ID：${message.id}`)
      ids.add(message.id)
    }
  }

  private createRuntimeMutationEvents(
    previous: AgentContext,
    current: AgentContext,
    source: RuntimeUpdateSource,
  ): AgentMutationEvent[] {
    const events: AgentMutationEvent[] = []
    if (previous.systemPrompt !== current.systemPrompt) {
      events.push({
        type: 'runtime_system_prompt_update',
        previous: previous.systemPrompt,
        current: current.systemPrompt,
        source,
      })
    }
    if (JSON.stringify(previous.model) !== JSON.stringify(current.model)) {
      events.push({
        type: 'runtime_model_update',
        previous: previous.model,
        current: current.model,
        source,
      })
    }
    if (JSON.stringify(previous.reasoning ?? null) !== JSON.stringify(current.reasoning ?? null)) {
      events.push({
        type: 'runtime_reasoning_update',
        previous: previous.reasoning ?? null,
        current: current.reasoning ?? null,
        source,
      })
    }
    const tools = (context: AgentContext) => ({
      toolNames: context.tools.map((tool) => tool.name),
      activeToolNames: context.activeToolNames?.slice() ?? context.tools.map((tool) => tool.name),
    })
    const previousTools = tools(previous)
    const currentTools = tools(current)
    if (JSON.stringify(previousTools) !== JSON.stringify(currentTools)) {
      events.push({
        type: 'runtime_tools_update',
        previous: previousTools,
        current: currentTools,
        source,
      })
    }
    return events
  }

  private createMutationBatch(events: AgentMutationEvent[]): AgentMutationBatch | undefined {
    if (events.length === 0) return undefined
    return {
      id: createId('mutation'),
      sessionId: this.id,
      events: structuredClone(events),
      createdAt: Date.now(),
    }
  }

  private async commitThenApply(
    batch: AgentMutationBatch | undefined,
    apply: () => void | Promise<void>,
  ): Promise<void> {
    if (!batch || !this.commitMutationBatch) return apply()
    if (this.idleMutationCommitInFlight) {
      throw new Error('已有空闲 Runtime mutation 正在提交')
    }
    const pending = this.pendingIdleMutationBatch
    if (pending && (
      pending.sessionId !== batch.sessionId
      || JSON.stringify(pending.events) !== JSON.stringify(batch.events)
    )) {
      // 挂起的 batch 与本次操作内容不同：此前直接抛「结果未知」永久卡死——UI 没有
      // 「重试原操作」入口，而事件嵌着 previous 快照，不同时点的重试内容必然不同。
      // 改为先幂等重放解决「结果未知」：已落库的 batch 以 replay 收据返回，补跑它的
      // apply 完成原操作；重放失败则证明它从未持久化（已落库的幂等查询不会失败），
      // 安全丢弃后放行本次操作。
      await this.resolvePendingIdleMutation(pending)
    }
    const durableBatch = this.pendingIdleMutationBatch ?? structuredClone(batch)
    this.pendingIdleMutationBatch = durableBatch
    this.pendingIdleMutationApply = apply
    this.idleMutationCommitInFlight = true
    try {
      let receipt: AgentMutationReceipt | void = undefined
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          receipt = await this.commitMutationBatch(structuredClone(durableBatch))
          break
        } catch (error) {
          if (attempt > 0) throw error
        }
      }
      if (receipt && (
        receipt.batchId !== durableBatch.id
        || receipt.sessionId !== durableBatch.sessionId
        || receipt.runId !== undefined
        || receipt.turn !== undefined
      )) {
        throw new Error('空闲 Runtime mutation receipt 与提交 batch ownership 不一致')
      }
      this.pendingIdleMutationBatch = undefined
      this.pendingIdleMutationApply = undefined
      await apply()
    } finally {
      this.idleMutationCommitInFlight = false
    }
  }

  /**
   * 幂等重放挂起的 batch 以消除「结果未知」：提交成功（含 replay 收据）则补跑它的
   * apply，让原操作真正完成；重放失败说明该 batch 从未持久化（若已落库，Rust 侧
   * 幂等查询会先命中并返回 replay 收据），丢弃是安全的——apply 未运行，live 状态
   * 保持原值，不存在半套状态。
   */
  private async resolvePendingIdleMutation(pending: AgentMutationBatch): Promise<void> {
    const apply = this.pendingIdleMutationApply
    let receipt: AgentMutationReceipt | void
    try {
      receipt = await this.commitMutationBatch?.(structuredClone(pending))
    } catch {
      this.pendingIdleMutationBatch = undefined
      this.pendingIdleMutationApply = undefined
      return
    }
    if (receipt && (
      receipt.batchId !== pending.id
      || receipt.sessionId !== pending.sessionId
      || receipt.runId !== undefined
      || receipt.turn !== undefined
    )) {
      // receipt 指向别的 batch：不动挂起状态，把不一致暴露给本次操作。
      throw new Error('空闲 Runtime mutation receipt 与提交 batch ownership 不一致')
    }
    this.pendingIdleMutationBatch = undefined
    this.pendingIdleMutationApply = undefined
    if (apply) await apply()
  }

  private async emitExternalEvents(events: AgentMutationEvent[]): Promise<void> {
    for (const event of events) await this.emitExternal(event)
  }

  private queueSnapshot(
    message: AgentMessage,
    kind: QueuedMessageKind,
  ): QueuedMessageSnapshot {
    return {
      id: message.id,
      kind,
      content: message.content,
      images: queuedMessageImages(message),
      createdAt: message.createdAt,
    }
  }

  private queueForKind(kind: QueuedMessageKind): MessageQueue {
    if (kind === 'steering') return this.steeringQueue
    if (kind === 'follow-up') return this.followUpQueue
    return this.nextTurnQueue
  }

  private queuedMessageLocation(
    messageId: string,
  ): { queue: MessageQueue; kind: QueuedMessageKind } | undefined {
    for (const kind of QUEUE_KINDS) {
      const queue = this.queueForKind(kind)
      if (queue.find(messageId)) return { queue, kind }
    }
    return undefined
  }

  private orderOf(messageId: string): number {
    return this.queuedMessageOrder.get(messageId) ?? Number.MAX_SAFE_INTEGER
  }

  /**
   * 以「显示序」为坐标系解析目标 order：显示序即三队列按 order 归并的顺序，用户看到的
   * 就是这个顺序。相邻项之间取中点（首次/末次则取 ±1），因此一次移动只重写一条 entry。
   */
  private resolveQueueOrder(messageId: string, placement: QueuePlacement): number | undefined {
    const others = this.queuedMessages.filter((message) => message.id !== messageId)
    if (placement.position === 'top') {
      return others.length === 0 ? this.orderOf(messageId) : this.orderOf(others[0].id) - 1
    }
    if (placement.position === 'bottom') {
      return others.length === 0
        ? this.orderOf(messageId)
        : this.orderOf(others[others.length - 1].id) + 1
    }
    const anchorIndex = others.findIndex((message) => message.id === placement.anchorId)
    if (anchorIndex < 0) return undefined
    const index = placement.position === 'above' ? anchorIndex : anchorIndex + 1
    const previous = others[index - 1]
    const next = others[index]
    if (!previous) return this.orderOf(next.id) - 1
    if (!next) return this.orderOf(previous.id) + 1
    const mid = (this.orderOf(previous.id) + this.orderOf(next.id)) / 2
    // 中点不再严格介于两邻之间 = float 精度耗尽：标记待整型重排（moveQueuedMessage 消费）。
    if (!(mid > this.orderOf(previous.id) && mid < this.orderOf(next.id))) {
      this.orderPrecisionDegraded = true
    }
    return mid
  }

  /** 重写队列项内容（保留 id 与 createdAt），空文本且无图片时返回 undefined。 */
  private applyQueuedMessageContent(
    message: AgentMessage,
    content: string,
    images?: ImageContentBlock[],
  ): AgentMessage | undefined {
    const normalized = content.trim()
    const blocks = images ?? queuedMessageImages(message)
    if (!normalized && blocks.length === 0) return undefined
    if (message.role !== 'user') return { ...message, content: normalized || message.content }
    return {
      ...message,
      content: normalized,
      contentBlocks: blocks.length > 0
        ? [
            ...(normalized ? [{ type: 'text' as const, text: normalized }] : []),
            ...blocks.map((block) => (block.type === 'image'
              ? { ...block, source: { ...block.source } }
              : { ...block })),
          ]
        : undefined,
    }
  }

  /**
   * 队列项重写：journal 是 append-only + 状态机，不支持 payload 原地更新，因此一次重写
   * 表现为「先 append 承载新 payload/新位置的新 entry，再 discard 旧 entry」。
   * 顺序不可颠倒——先 discard 再 append 时若 append 失败，队列项在库里已消失而内存还在，
   * 崩溃恢复即静默丢消息；反之若两个 pending entry 携带同一 message.id，恢复会命中既有的
   * 重复 ID 校验（fail-closed，不丢数据）。discard 失败时补偿丢弃新 entry，保证
   * 「要么新旧都在、要么两边都不在」，内存状态始终不领先于 durable 状态。
   */
  private async rewriteQueuedMessage(
    messageId: string,
    kind: QueuedMessageKind,
    next: AgentMessage,
    order: number,
  ): Promise<QueueMutationResult> {
    return this.sessionJournal.write(async () => {
      const location = this.queuedMessageLocation(messageId)
      if (!location) return { updated: false, reason: 'unknown-message' }
      const previousEntryId = this.queueJournalEntryIds.get(messageId)
      const entry = this.sessionJournal.createEntry({ kind: 'queue', queueKind: kind, message: next, order })
      if (entry) {
        await this.mutationJournal?.append(entry)
        if (previousEntryId) {
          try {
            await this.mutationJournal?.discard([previousEntryId])
          } catch (error) {
            try {
              await this.mutationJournal?.discard([entry.id])
            } catch {
              // fail-soft：原始错误优先；残留的 pending entry 仍携带同一 message.id，
              // 恢复时按重复 ID fail-closed 暴露，不会静默丢消息。
            }
            throw error
          }
        }
        this.queueJournalEntryIds.set(messageId, entry.id)
      }
      this.recordQueuedMessage(next, order)
      if (location.kind === kind) {
        const queue = this.queueForKind(kind)
        const index = this.queueIndexForOrder(queue, order, messageId)
        queue.remove(messageId)
        queue.insertAt(next, index)
      } else {
        location.queue.remove(messageId)
        const target = this.queueForKind(kind)
        target.insertAt(next, this.queueIndexForOrder(target, order, messageId))
      }
      return { updated: true, messageId, kind }
    })
  }

  /** 目标队列内按 order 的插入位（排除被移动项自身；队列内数组按 order 升序维护）。 */
  private queueIndexForOrder(
    queue: MessageQueue,
    order: number,
    excludedId: string,
  ): number {
    return queue.snapshot()
      .filter((message) => message.id !== excludedId && this.orderOf(message.id) < order)
      .length
  }

  private recordQueuedMessage(message: AgentMessage, order?: number): void {
    const resolvedOrder = order ?? this.nextQueuedMessageOrder
    this.queuedMessageOrder.set(message.id, resolvedOrder)
    this.nextQueuedMessageOrder = Math.max(this.nextQueuedMessageOrder, resolvedOrder + 1)
  }

  private sortQueuedMessages(messages: QueuedMessageSnapshot[]): QueuedMessageSnapshot[] {
    return messages.sort((left, right) =>
      (this.queuedMessageOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
      - (this.queuedMessageOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER))
  }

  private async drainQueue(
    queue: MessageQueue,
    kind: QueuedMessageKind,
    runId: string,
  ): Promise<AgentMessage[]> {
    // 手动模式门控（对齐 ZCode autoDrain=false）：turn 边界不自动出队，仅当
    // sendQueuedNow 武装的目标恰为该队列队首时放行一次（放行即作废武装标记）。
    // next-turn 队列不在此通道消费，不受门控影响。放行**只消费这一条**——模式 `all`
    // 的批量语义属于自动出队，逐条放行若整批出队就违背了「立即发送这一条」的承诺。
    const manualRelease = !this.autoDrainEnabled && kind !== 'next-turn'
    if (manualRelease) {
      const head = queue.snapshot()[0]
      if (!head || this.immediateDispatchId !== head.id) return []
      this.immediateDispatchId = undefined
    }
    return this.sessionJournal.write(async () => {
      const pending = manualRelease ? queue.snapshot().slice(0, 1) : queue.peekDrain()
      const entryIds = pending.flatMap((message) => {
        const entryId = this.queueJournalEntryIds.get(message.id)
        return entryId ? [entryId] : []
      })
      if (entryIds.length > 0) {
        await this.mutationJournal?.markConsuming(entryIds, runId)
        await this.onRuntimeCheckpoint?.('queue_consuming')
      }
      const messages = manualRelease ? queue.drainOne() : queue.drain()
      for (const message of messages) this.drainedQueueKinds.set(message.id, kind)
      return messages
    })
  }

  private async restoreUnconsumedMessages(messages: AgentMessage[]): Promise<void> {
    await this.restoreDrainedMessages(messages)
  }

  private async restoreDrainedMessages(messages: AgentMessage[]): Promise<void> {
    const steering: AgentMessage[] = []
    const followUp: AgentMessage[] = []
    const nextTurn: AgentMessage[] = []
    await this.sessionJournal.write(async () => {
      const restorable = messages.filter((message) => this.drainedQueueKinds.has(message.id))
      const entryIds = restorable.flatMap((message) => {
        const entryId = this.queueJournalEntryIds.get(message.id)
        return entryId ? [entryId] : []
      })
      if (entryIds.length > 0) await this.mutationJournal?.restorePending(entryIds)
      for (const message of restorable) {
        const kind = this.drainedQueueKinds.get(message.id)
        this.drainedQueueKinds.delete(message.id)
        if (kind === 'steering') steering.push(message)
        if (kind === 'follow-up') followUp.push(message)
        if (kind === 'next-turn') nextTurn.push(message)
      }
      this.steeringQueue.prepend(steering)
      this.followUpQueue.prepend(followUp)
      this.nextTurnQueue.prepend(nextTurn)
    })
  }

  private async enqueueQueuedMessage(
    queue: MessageQueue,
    kind: QueuedMessageKind,
    message: AgentMessage,
    acceptedRun?: ActiveRun,
  ): Promise<QueueAcceptance> {
    const entry = this.sessionJournal.createEntry({ kind: 'queue', queueKind: kind, message })
    await this.sessionJournal.write(async () => {
      if (entry) await this.mutationJournal?.append(entry)
      this.recordQueuedMessage(message, entry?.sequence)
      if (entry) this.queueJournalEntryIds.set(message.id, entry.id)
      if (acceptedRun && (this.activeRun !== acceptedRun || !this.acceptingQueuedMessages)) {
        if (entry) await this.mutationJournal?.markRecovered([entry.id])
        this.recoveredQueuedMessages.push(this.queueSnapshot(message, kind))
      } else {
        queue.enqueue(message)
      }
    })
    return acceptedQueueMessage(message.id)
  }

  private async clearQueues(queues: MessageQueue[]): Promise<void> {
    const messages = queues.flatMap((queue) => queue.snapshot())
    await this.sessionJournal.write(async () => {
      const entryIds = messages.flatMap((message) => {
        const entryId = this.queueJournalEntryIds.get(message.id)
        return entryId ? [entryId] : []
      })
      if (entryIds.length > 0) await this.mutationJournal?.discard(entryIds)
      for (const queue of queues) queue.clear()
      for (const message of messages) {
        this.queueJournalEntryIds.delete(message.id)
        this.drainedQueueKinds.delete(message.id)
        this.queuedMessageOrder.delete(message.id)
      }
    })
  }

  private async discardQueuedMessage(messageId: string): Promise<void> {
    await this.discardQueuedMessages([messageId])
  }

  private async discardQueuedMessages(messageIds: string[]): Promise<void> {
    await this.sessionJournal.write(() => this.discardQueuedMessagesLocked(messageIds))
  }

  /** discard 内核：必须已在 sessionJournal.write 内调用（write 是串行链，不可重入）。 */
  private async discardQueuedMessagesLocked(messageIds: string[]): Promise<void> {
    const entryIds = messageIds.flatMap((messageId) => {
      const entryId = this.queueJournalEntryIds.get(messageId)
      return entryId ? [entryId] : []
    })
    if (entryIds.length > 0) await this.mutationJournal?.discard(entryIds)
    for (const messageId of messageIds) {
      this.queueJournalEntryIds.delete(messageId)
      this.drainedQueueKinds.delete(messageId)
      this.queuedMessageOrder.delete(messageId)
    }
  }

  private restoreJournalEntries(entries: AgentSessionJournalEntry[]): void {
    if (entries.length > 0 && !this.mutationJournal) {
      throw new Error('恢复 Agent journal entries 时缺少 durable journal adapter')
    }
    let projected = snapshotAgentContext(this.context)
    for (const entry of entries.slice().sort((left, right) => left.sequence - right.sequence)) {
      if (entry.sessionId !== this.id || entry.status !== 'pending') {
        throw new Error('恢复的 Agent journal entry 不属于当前会话或状态无效')
      }
      this.sessionJournal.syncSequence(entry.sequence)
      if (entry.kind === 'queue') {
        const message = snapshotAgentMessage(entry.message)
        if (this.queueJournalEntryIds.has(message.id)) throw new Error('恢复的 queue journal 消息 ID 重复')
        this.queueJournalEntryIds.set(message.id, entry.id)
        // 重排/编辑重写过的队列项，其位置由 payload.order 承载（新 entry 的 sequence 不再
        // 反映用户期望的位置）；旧版本 payload 无 order，回落到 sequence 保持原顺序。
        this.recordQueuedMessage(message, entry.order ?? entry.sequence)
        if (entry.recoveredAt !== undefined) {
          this.recoveredQueuedMessages.push(this.queueSnapshot(message, entry.queueKind))
          continue
        }
        const queue = entry.queueKind === 'steering'
          ? this.steeringQueue
          : entry.queueKind === 'follow-up' ? this.followUpQueue : this.nextTurnQueue
        queue.enqueue(message)
        continue
      }
      if (entry.kind === 'message_append') {
        const message = snapshotAgentMessage(entry.message)
        this.assertAppendableMessages([message], this.projectedPendingMessageIds())
        this.pendingAppendedMessages.push({ message, journalEntryId: entry.id })
        continue
      }
      const update: AgentRuntimeUpdate = {
        ...(entry.update.systemPrompt !== undefined ? { systemPrompt: entry.update.systemPrompt } : {}),
        ...(entry.update.model ? { model: structuredClone(entry.update.model) } : {}),
        ...(entry.update.reasoning !== undefined
          ? { reasoning: entry.update.reasoning ? structuredClone(entry.update.reasoning) : null }
          : {}),
        ...(entry.update.activeToolNames
          ? { activeToolNames: entry.update.activeToolNames.slice() }
          : {}),
      }
      projected = this.resolveRuntimeUpdate(projected, update).context
      this.pendingRuntimeUpdates.push({ update, source: 'scheduled', journalEntryId: entry.id })
    }
  }

  private createQueuedMessage(
    input: string | AgentMessage,
    images?: ImageContentBlock[],
  ): AgentMessage | undefined {
    if (typeof input !== 'string') return snapshotAgentMessage(input)
    const normalized = input.trim()
    if (!normalized && (!images || images.length === 0)) return undefined
    return createUserMessage(images?.length
      ? [
          ...(normalized ? [{ type: 'text' as const, text: normalized }] : []),
          ...images,
        ]
      : normalized)
  }
}
