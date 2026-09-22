import type {
  CompactionReason,
  ContextBudgetUsage,
  ContextCheckpoint,
} from '@/agent/context/types'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type ArtifactKind = 'text' | 'json' | 'image'

export interface ArtifactReference {
  id: string
  kind: ArtifactKind
  mediaType: string
  relativePath: string
  contentHash: string
  sizeBytes: number
  createdAt: number
}

export interface ToolResultArtifactRequest {
  runId: string
  toolCallId: string
  toolName: string
  content: string
}

export type ToolResultExternalizer = (
  request: ToolResultArtifactRequest,
) => Promise<ArtifactReference>

export interface ModelRef {
  provider: string
  model: string
  contextWindow?: number
  maxOutputTokens?: number
  input?: Array<'text' | 'image'>
  supportsReasoning?: boolean
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelReasoning {
  level: Exclude<ThinkingLevel, 'off'>
  mode?: 'effort' | 'enabled' | 'adaptive'
  budgetTokens?: number
}

export interface ModelRequestAuth {
  /** Keychain-backed identifier resolved by the Rust model HTTP boundary. */
  secretId?: string
}

export interface CacheControl {
  type: 'ephemeral'
  ttl?: '5m' | '1h'
}

export interface TextContentBlock {
  type: 'text'
  text: string
  /** Opaque provider metadata required when replaying this text block. */
  textSignature?: string
  cacheControl?: CacheControl
}

export interface ImageContentBlock {
  type: 'image'
  source:
    | { type: 'base64'; mediaType: string; data: string }
    | { type: 'url'; url: string }
  cacheControl?: CacheControl
}

export interface ThinkingContentBlock {
  type: 'thinking'
  thinking: string
  /** Opaque provider metadata required when replaying this thinking block. */
  thinkingSignature?: string
  /** @deprecated Legacy persisted name. Decoders normalize it to thinkingSignature. */
  signature?: string
  redacted?: boolean
}

export type UserContentBlock = TextContentBlock | ImageContentBlock
export interface ToolCallContentBlock extends ToolCall {
  type: 'tool_call'
}

export type AssistantContentBlock = TextContentBlock | ThinkingContentBlock | ToolCallContentBlock
export type ToolResultContentBlock = TextContentBlock | ImageContentBlock

export interface TokenCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** Subset of cacheWriteTokens retained for one hour when reported by the provider. */
  cacheWrite1hTokens?: number
  reasoningTokens?: number
  /** Optional provider/model pricing projection. Tokens remain authoritative when absent. */
  cost?: TokenCost
}

export interface DiagnosticErrorInfo {
  name?: string
  message: string
  stack?: string
  code?: string | number
}

export interface AssistantMessageDiagnostic {
  type: string
  timestamp: number
  error?: DiagnosticErrorInfo
  /** Redacted, JSON-safe provider/runtime metadata only. */
  details?: { [key: string]: JsonValue }
}

export type ProviderErrorKind =
  | 'context_overflow'
  | 'rate_limit'
  | 'authentication'
  | 'invalid_request'
  | 'network'
  | 'server'
  | 'unknown'

export interface ProviderError {
  kind: ProviderErrorKind
  message: string
  code?: string
  type?: string
  status?: number
  retryable: boolean
  /** 面向用户展示的友好文案；缺失时展示层回退到 message。 */
  userMessage?: string
}

interface MessageBase {
  id: string
  createdAt: number
}

export interface UserMessage extends MessageBase {
  role: 'user'
  /** Plain-text projection retained for UI, title generation, and legacy sessions. */
  content: string
  contentBlocks?: UserContentBlock[]
}

export interface ToolCall {
  id: string
  name: string
  arguments: JsonValue
  rawArguments: string
  argumentError?: string
  /** Opaque provider signature associated with the thought that produced this call. */
  thoughtSignature?: string
}

export type AssistantStopReason = 'stop' | 'tool_use' | 'length' | 'error' | 'aborted'

export interface AssistantMessage extends MessageBase {
  role: 'assistant'
  /** Plain-text projection of text blocks only. */
  content: string
  contentBlocks?: AssistantContentBlock[]
  toolCalls: ToolCall[]
  stopReason: AssistantStopReason
  responseId?: string
  provider?: string
  model?: string
  /** Concrete model returned by a router/provider when it differs from the request. */
  responseModel?: string
  diagnostics?: AssistantMessageDiagnostic[]
  usage?: TokenUsage
  errorMessage?: string
  providerError?: ProviderError
  /** Persisted marker for failures that must remain visible in history but never be replayed to a model. */
  excludeFromModelContext?: boolean
}

/**
 * 增量 assistant 内容生命周期事件，供 Runtime 消费者基于 {@link message_update}
 * 中的 delta 重放渲染。每个事件只携带增量字段，不再携带整条消息快照。
 */
export type AssistantMessageEvent =
  | { type: 'text_start'; contentIndex: number }
  | { type: 'text_delta'; contentIndex: number; delta: string }
  | { type: 'text_end'; contentIndex: number; content: string }
  | { type: 'thinking_start'; contentIndex: number }
  | { type: 'thinking_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_signature_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_end'; contentIndex: number; content: string }
  | { type: 'toolcall_start'; contentIndex: number; id: string; name: string }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCall }

export interface ToolResultMessage extends MessageBase {
  role: 'tool'
  toolCallId: string
  toolName: string
  content: string
  contentBlocks?: ToolResultContentBlock[]
  details?: JsonValue
  artifact?: ArtifactReference
  artifactError?: string
  /** Registry tools that become active after this persisted result. */
  addedToolNames?: string[]
  isError: boolean
}

export interface CustomAgentMessage extends MessageBase {
  role: 'custom'
  customType: string
  /** Human-readable fallback used by the desktop transcript. */
  content: string
  data?: JsonValue
}

export type ModelMessage = UserMessage | AssistantMessage | ToolResultMessage
export type AgentMessage = ModelMessage | CustomAgentMessage

export interface ModelToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, JsonValue>
}

export interface ModelRequest {
  sessionId: string
  runId: string
  systemPrompt: string
  model: ModelRef
  messages: ModelMessage[]
  tools: ModelToolDefinition[]
  maxOutputTokens?: number
  reasoning?: ModelReasoning
  auth?: ModelRequestAuth
}

export type ProviderApiFormat =
  | 'demo'
  | 'openai-compatible'
  | 'openai-responses'
  | 'anthropic-compatible'

export interface BeforeProviderRequestContext {
  sessionId: string
  runId: string
  model: ModelRef
  apiFormat: ProviderApiFormat
  endpoint: string
  timeoutMs?: number
  signal: AbortSignal
}

export interface BeforeProviderRequestResult {
  /** The only mutable request-envelope field. Endpoint and auth remain Runtime-owned. */
  timeoutMs?: number
}

export interface BeforeProviderPayloadContext extends BeforeProviderRequestContext {
  /** Isolated JSON payload snapshot. Mutations are ignored without an explicit return value. */
  payload: JsonValue
}

export interface BeforeProviderPayloadResult {
  /** Explicit replacement. Runtime revalidates protocol identity and byte limits. */
  payload: JsonValue
}

export interface AfterProviderResponseContext {
  sessionId: string
  runId: string
  model: ModelRef
  apiFormat: ProviderApiFormat
  endpoint: string
  status: number
  signal: AbortSignal
}

export interface ModelTransportLifecycle {
  beforeRequest?: (
    context: BeforeProviderRequestContext,
  ) => BeforeProviderRequestResult | undefined | Promise<BeforeProviderRequestResult | undefined>
  beforePayload?: (
    context: BeforeProviderPayloadContext,
  ) => BeforeProviderPayloadResult | undefined | Promise<BeforeProviderPayloadResult | undefined>
  afterResponse?: (context: AfterProviderResponseContext) => void | Promise<void>
}

export type ModelDoneReason = 'stop' | 'tool_use' | 'length'

export type ModelStreamEvent =
  | { type: 'start'; responseId?: string; responseModel?: string }
  | { type: 'text_delta'; delta: string; contentIndex?: number; textSignature?: string }
  | {
      type: 'thinking_start'
      contentIndex: number
      thinkingSignature?: string
      /** @deprecated Compatibility name accepted from older transports. */
      signature?: string
      redacted?: boolean
    }
  | { type: 'thinking_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_signature_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_end'; contentIndex: number }
  | {
      type: 'tool_call_start'
      index: number
      contentIndex?: number
      id: string
      name: string
      thoughtSignature?: string
    }
  | { type: 'tool_call_delta'; index: number; argumentsDelta: string; nameDelta?: string }
  | { type: 'tool_call_end'; index: number }
  | { type: 'diagnostic'; diagnostic: AssistantMessageDiagnostic }
  | { type: 'done'; stopReason: ModelDoneReason; usage?: TokenUsage }
  | { type: 'error'; message: string; error?: ProviderError }

export interface ModelTransport {
  stream(
    request: ModelRequest,
    signal: AbortSignal,
    lifecycle?: ModelTransportLifecycle,
  ): AsyncIterable<ModelStreamEvent>
  requestByteLength?: (request: ModelRequest) => number
}

export type ToolExecutionMode = 'sequential' | 'parallel'

export type ToolRecoveryPolicy = 'never' | 'idempotent'

export type ToolValidationResult<TInput> =
  | { ok: true; value: TInput }
  | { ok: false; error: string }

export interface AgentToolResult {
  content: string
  contentBlocks?: ToolResultContentBlock[]
  details?: JsonValue
  artifact?: ArtifactReference
  artifactContent?: string
  /** Registered tools to activate for subsequent model turns. */
  addedToolNames?: string[]
  terminate?: boolean
}

export interface AgentToolExecutionContext {
  sessionId: string
  runId: string
  toolCallId: string
  approvalLease?: string
  signal: AbortSignal
  reportProgress: (content: string, details?: JsonValue) => Promise<void>
  /** Whether the active model accepts image inputs. Tools may degrade image output when false. */
  modelAcceptsImage?: boolean
  /**
   * 本工具调用的硬性截止时间（epoch ms）。工具若忽略 signal 不响应，执行层会在该时刻
   * 以 ToolExecutionTimeoutError 切断调用；可让自身有长任务语义的工具据此自节奏。
   */
  deadlineMs?: number
  /**
   * SubAgent 委派能力（仅 Axiom 内置工具可用；项目 Skill 不能注册代码工具）。
   * 当前宿主不支持 SubAgent 时缺失，工具必须明确报错。实现由父 AgentSession
   * 以当前 runtime binding 提供，工具不持有 model/transport。
   */
  delegateAgent?: (
    request: AgentDelegationRequest,
  ) => Promise<AgentDelegationResult>
}

export type ToolApprovalState = 'not_required' | 'pending' | 'approved' | 'denied'

export interface ToolApprovalPresentation {
  category?: 'workspace-write' | 'workspace-command'
  title: string
  description: string
  path?: string
  preview?: string
  changes?: Array<{ path: string; preview: string }>
  /**
   * 高危操作标记（如 bash 命中危险命令关键字）。为 true 时审批卡要求用户
   * 显式勾选确认后才允许放行，作为对逐次审批的额外提示层。
   */
  danger?: boolean
}

/** bash 命令安全分级（镜像 Rust `CommandTier`）。仅用于审批展示与 UI 分流；
 * Rust 签发 lease 时会重新权威分类（见 docs/os-sandbox-plan.md §6.1），本值不参与安全决策。 */
export type CommandTier = 'sandboxSafe' | 'networkRequired'

export interface BeforeToolCallContext {
  sessionId: string
  runId: string
  assistantMessage: AssistantMessage
  toolCall: ToolCall
  toolCallId: string
  toolName: string
  toolLabel: string
  requiresApproval: boolean
  /** bash 分级提示，由工具 `resolveTier` 注入；不污染 `input`。 */
  tier?: CommandTier
  /** Isolated validated-input snapshot. Mutating it never changes the approved execution. */
  input: JsonValue
  /** Isolated runtime snapshot for policy inspection. */
  context: AgentContext
  /** Isolated approval projection. */
  presentation: ToolApprovalPresentation
  signal: AbortSignal
}

export interface BeforeToolCallResult {
  decision: 'approved' | 'denied'
  reason?: string
  approvalLease?: string
}

export type BeforeToolCall = (
  context: BeforeToolCallContext,
) => BeforeToolCallResult | Promise<BeforeToolCallResult>

export interface AfterToolCallContext {
  sessionId: string
  runId: string
  assistantMessage: AssistantMessage
  toolCall: ToolCall
  tool: AgentTool
  /** Isolated executed-input snapshot. */
  input: JsonValue
  /** Isolated result snapshot. Return an explicit override to change model feedback. */
  result: AgentToolResult
  isError: boolean
  /** Isolated runtime snapshot for post-execution inspection. */
  context: AgentContext
  signal: AbortSignal
}

export interface AfterToolCallResult {
  result?: AgentToolResult
  isError?: boolean
}

export type AfterToolCall = (
  context: AfterToolCallContext,
) => AfterToolCallResult | undefined | Promise<AfterToolCallResult | undefined>

export interface AgentTool {
  name: string
  label: string
  description: string
  /** Concise summary folded into the available-tools block of the system prompt. */
  promptSnippet?: string
  /** Optional usage rules appended when the tool becomes active. */
  promptGuidelines?: string[]
  /** Stable host-defined implementation version used by strict Session restore. */
  runtimeVersion: string
  /** Crash recovery defaults to never replaying a Tool. */
  recoveryPolicy?: ToolRecoveryPolicy
  /** Required for idempotent recovery eligibility; never persisted as executable code. */
  idempotencyKey?: (input: JsonValue) => string | Promise<string>
  inputSchema: Record<string, JsonValue>
  executionMode?: ToolExecutionMode
  /** Compatibility normalization applied before validation and approval. */
  prepareArguments?: (input: JsonValue) => JsonValue
  requiresApproval?: boolean
  /** bash 分级提示（镜像 Rust CommandTier），供审批 UI 分流；非安全边界。 */
  resolveTier?: (input: JsonValue) => CommandTier
  approvalPresentation?: (input: JsonValue) => ToolApprovalPresentation
  auditArguments?: (input: JsonValue) => JsonValue
  validate(input: JsonValue): ToolValidationResult<JsonValue>
  execute(input: JsonValue, context: AgentToolExecutionContext): Promise<AgentToolResult>
}

export interface AgentContext {
  sessionId: string
  systemPrompt: string
  model: ModelRef
  reasoning?: ModelReasoning
  messages: AgentMessage[]
  /** Complete executable registry, including tools that are not active yet. */
  tools: AgentTool[]
  /** Active registry names. Omitted for legacy contexts where every tool is active. */
  activeToolNames?: string[]
}

export interface BeforeAgentStartContext {
  sessionId: string
  runId: string
  prompts: AgentMessage[]
  systemPrompt: string
  /** Isolated Runtime snapshot. Mutations are ignored without an explicit result. */
  context: AgentContext
  signal: AbortSignal
}

export interface BeforeAgentStartResult {
  /** Explicit replacement for the prompts passed to this run. */
  prompts?: AgentMessage[]
  /** Messages appended after the selected prompts. */
  appendMessages?: AgentMessage[]
  /** Temporary prompt override scoped to this run only. */
  systemPrompt?: string
}

export type BeforeAgentStart = (
  context: BeforeAgentStartContext,
) => BeforeAgentStartResult | undefined | Promise<BeforeAgentStartResult | undefined>

export interface ContextHookContext {
  sessionId: string
  runId: string
  messages: AgentMessage[]
  /** Isolated Runtime snapshot; model identity and Session state are read-only. */
  context: AgentContext
  signal: AbortSignal
}

export interface ContextHookResult {
  messages: AgentMessage[]
}

export type TransformContext = (
  messages: AgentMessage[],
  signal: AbortSignal,
  context?: AgentContext,
  runId?: string,
) => AgentMessage[] | Promise<AgentMessage[]>

export type ConvertToModelMessages = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => ModelMessage[] | Promise<ModelMessage[]>

export type ResolveModelAuth = (
  model: ModelRef,
  signal: AbortSignal,
) => ModelRequestAuth | undefined | Promise<ModelRequestAuth | undefined>

export interface AgentLimits {
  maxTurns: number
  maxToolCalls: number
  maxDurationMs: number
  maxMessageBytes: number
  maxInlineToolResultBytes: number
  /**
   * 单次 run 的计费 token 预算（软限制，按阈值注入提醒，不做硬停）：
   * 计费口径为 output + 非缓存 input（对齐 codex rollout budget 的加权思路），
   * 缓存命中的重复输入不计入。缺省 undefined = 不限制（不累计提醒）。
   */
  maxTotalTokens?: number
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxTurns: 48,
  maxToolCalls: 144,
  maxDurationMs: 15 * 60 * 1000,
  maxMessageBytes: 1024 * 1024,
  maxInlineToolResultBytes: 256 * 1024,
  // 计费 token 软预算默认开启（2M billable）。量级依据：输出 + 非缓存输入口径下，
  // 走缓存的正常长会话整轮 run 难以触及；只有无缓存的重复大上下文循环（跑偏/
  // 失败重试的典型形态）会在 run 中后段触发 75%/90% 提醒，推动模型收口。仅注入
  // 提醒不硬停——硬边界仍由轮次/工具/时长兜底。
  maxTotalTokens: 2_000_000,
}

/**
 * 运行时预算提醒阈值。由 {@link computeBudgetThresholds} 按 {@link AgentLimits}
 * 自适应推导,替代历史上为 maxTurns=32 硬编码的绝对阈值(16/3/20),保证任意
 * 限制值下提醒比例一致。
 */
export interface BudgetThresholds {
  /** 剩余轮次 ≤ 此值 → 软提醒(并行探索/规划收口)。约 50%。 */
  turnSoftNotice: number
  /** 剩余轮次 ≤ 此值 → 硬约束(停止扩展/基于证据交付)。约 10%。 */
  turnHardNotice: number
  /** 剩余工具调用 ≤ 此值 → 工具预算提醒(合并检索)。约 25%。 */
  toolCallNotice: number
  /** 计费 token 累计 ≥ maxTotalTokens × 此值 → token 软提醒。约 75%。 */
  tokenSoftNotice: number
  /** 计费 token 累计 ≥ maxTotalTokens × 此值 → token 硬提醒。约 90%。 */
  tokenHardNotice: number
}

/**
 * 按给定限制推导预算提醒阈值。全部使用比例 + 下限,语义在任意 maxTurns/
 * maxToolCalls 下稳定:
 * - turnSoftNotice = max(4, ceil(maxTurns * 0.5))  —— 32→16 / 48→24 / 64→32 / 10→5
 * - turnHardNotice = max(3, ceil(maxTurns * 0.1))  —— 32→4  / 48→5  / 64→7  / 10→3
 * - toolCallNotice = max(20, ceil(maxToolCalls*0.25)) —— 96→24 / 144→36 / 192→48
 */
export const computeBudgetThresholds = (limits: AgentLimits): BudgetThresholds => ({
  turnSoftNotice: Math.max(4, Math.ceil(limits.maxTurns * 0.5)),
  turnHardNotice: Math.max(3, Math.ceil(limits.maxTurns * 0.1)),
  toolCallNotice: Math.max(20, Math.ceil(limits.maxToolCalls * 0.25)),
  tokenSoftNotice: Math.round(limits.maxTotalTokens !== undefined ? limits.maxTotalTokens * 0.75 : Number.POSITIVE_INFINITY),
  tokenHardNotice: Math.round(limits.maxTotalTokens !== undefined ? limits.maxTotalTokens * 0.9 : Number.POSITIVE_INFINITY),
})

export type AgentRunEndReason =
  | 'completed'
  | 'aborted'
  | 'error'
  | 'turn_limit'
  | 'tool_limit'
  | 'time_limit'
  | 'stopped'

/** SubAgent 委派种类：探索（explore）+ 三种只读审查（inspect/examine/review）。 */
export type SubAgentKind = 'explore' | 'inspect' | 'examine' | 'review'

/** 探索广度档位：模型按任务复杂度选择搜索深度，映射到不同 child 预算。 */
export type ExploreBreadth = 'light' | 'standard' | 'thorough'

export interface AgentDelegationRequest {
  kind: SubAgentKind
  task: string
  scope?: string[]
  /** 审查/探索广度（默认 standard）；映射到不同 child 预算，父 run 累计预算不变。 */
  breadth?: ExploreBreadth
}

/**
 * 子会话收口端因：在 AgentRunEndReason 基础上扩展 fail-closed（context_limit）
 * 与父 run 预算（parent_run_budget）两个子会话专属端因。
 */
export type SubAgentEndReason =
  | AgentRunEndReason
  | 'context_limit'
  | 'parent_run_budget'

export interface AgentDelegationResult {
  status: 'completed' | 'partial'
  summary: string
  turns: number
  toolCalls: number
  modelRequests: number
  endReason: SubAgentEndReason
  durationMs: number
  /**
   * 父 run 累计计费/回流快照（内存累计，不持久化）；由 SubAgentRuntime 从
   * parentLedger 填充，供父工具向模型暴露累计成本与父上下文占用。
   */
  parentRunUsage?: {
    calls: number
    modelRequests: number
    inputTokens: number
    outputTokens: number
    costTotal: number
    /** 子结果回流父上下文的累计字节数。 */
    returnedBytes: number
    /** 子会话累计的诊断 type 标签（去重，content-free；内存累计，不持久化）。 */
    diagnosticTypes?: string[]
  }
}

/**
 * 工具执行层注入的委托上下文：parentRunId/parentToolCallId/signal 由
 * executeToolCalls 层在每个工具调用现场注入，供 AgentSession 构造
 * SubAgentRuntimeBinding 时消费。
 */
export interface SubAgentDelegationContext {
  parentRunId: string
  parentToolCallId: string
  signal: AbortSignal
  /** 父工具调用硬性截止时间（epoch ms）；子会话按它 clamp 绝对 deadline 并预留清理时间。 */
  deadlineMs?: number
  /** 子会话进度回传（父工具 result 之外的轻量 progress），由工具执行层注入。 */
  reportProgress?: (content: string, details?: JsonValue) => Promise<void>
}

/**
 * Immutable, content-free boundary produced after the transcript and all run
 * events have been applied. Callers can use it as a safe persistence/branching
 * barrier without retaining message bodies.
 */
export interface AgentSavePoint {
  sessionId: string
  runId: string
  messageCount: number
  lastMessageId?: string
  checkpointId?: string
  createdAt: number
}

/**
 * Per-turn durable boundary emitted only after all mutations scheduled from
 * `turn_end` have been committed. Unlike AgentSavePoint, this does not mark the
 * whole run idle.
 */
export interface AgentTurnSavePoint {
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

export type RuntimeUpdateSource = 'set' | 'scheduled' | 'prepare_next_turn' | 'restore'

export interface RuntimeToolsSnapshot {
  toolNames: string[]
  activeToolNames: string[]
}

/**
 * `runtime_dependencies_update` 的原子载荷快照：systemPrompt + activeToolNames
 * + runtimeManifest 三者作为一个单元提交。core 层不反向 import runtime 模块，
 * `runtimeManifest` 在 core 层声明为 `unknown`，进入 Runtime/repository 边界后
 * 立即经 `decodeRuntimeDependencyManifest` 还原为强类型。
 */
export interface RuntimeDependenciesSnapshot {
  systemPrompt: string
  activeToolNames: string[]
  runtimeManifest: unknown
}

export type AgentMutationEvent =
  | {
      type: 'session_message_append'
      sessionId: string
      message: AgentMessage
    }
  | {
      type: 'runtime_system_prompt_update'
      previous: string
      current: string
      source: RuntimeUpdateSource
    }
  | {
      type: 'runtime_model_update'
      previous: ModelRef
      current: ModelRef
      source: RuntimeUpdateSource
    }
  | {
      type: 'runtime_reasoning_update'
      previous: ModelReasoning | null
      current: ModelReasoning | null
      source: RuntimeUpdateSource
    }
  | {
      type: 'runtime_tools_update'
      previous: RuntimeToolsSnapshot
      current: RuntimeToolsSnapshot
      source: RuntimeUpdateSource
    }
  | {
      type: 'runtime_dependencies_update'
      previous: RuntimeDependenciesSnapshot
      current: RuntimeDependenciesSnapshot
      source: 'set'
      /** 该事件使当前 context checkpoint 失效（随 batch 原子持久化删除）。 */
      invalidateCheckpoint: true
    }

/** Atomic persistence unit for appendMessage and Runtime state changes. */
export interface AgentMutationBatch {
  id: string
  sessionId: string
  runId?: string
  turn?: number
  /** Durable journal entries atomically acknowledged by this batch. */
  journalEntryIds?: string[]
  events: AgentMutationEvent[]
  createdAt: number
}

/** Durable identity returned by the mutation writer for new commits and replays. */
export interface AgentMutationReceipt {
  batchId: string
  sessionId: string
  runId?: string
  turn?: number
  committedAt: number
  replayed: boolean
}

export type AgentEvent =
  | { type: 'agent_start'; sessionId: string; runId: string }
  | {
      type: 'auto_retry_start'
      attempt: number
      maxAttempts: number
      delayMs: number
      errorMessage: string
      failedMessageId: string
    }
  | {
      type: 'auto_retry_end'
      success: boolean
      attempt: number
      finalError?: string
    }
  | { type: 'compaction_start'; compactionId: string; reason: CompactionReason }
  | {
      type: 'compaction_end'
      compactionId: string
      reason: CompactionReason
      checkpoint?: ContextCheckpoint
      usage?: ContextBudgetUsage
      aborted: boolean
      errorMessage?: string
    }
  | { type: 'context_usage'; usage: ContextBudgetUsage; checkpointId?: string }
  | { type: 'turn_start'; runId: string; turn: number }
  | {
      type: 'provider_request_start'
      requestId: string
      runId: string
      assistantMessageId: string
      modelProvider: string
      modelId: string
      messageCount: number
      toolCount: number
    }
  | {
      type: 'provider_response_received'
      requestId: string
      runId: string
      assistantMessageId: string
      message: AssistantMessage
    }
  | { type: 'message_start'; runId: string; message: AgentMessage }
  | {
      type: 'message_update'
      runId: string
      messageId: string
      update: 'text' | 'thinking' | 'tool_call'
      delta?: string
      assistantMessageEvent: AssistantMessageEvent
    }
  | {
      type: 'message_end'
      runId: string
      message: AgentMessage
      consumedJournalEntryId?: string
    }
  | {
      type: 'tool_execution_start'
      runId: string
      toolCallId: string
      toolName: string
      arguments: JsonValue
      approvalState: Extract<ToolApprovalState, 'not_required' | 'pending'>
      recoveryPolicy: ToolRecoveryPolicy
      idempotencyKey?: string
    }
  | {
      type: 'tool_execution_update'
      runId: string
      toolCallId: string
      toolName: string
      content: string
      details?: JsonValue
    }
  | {
      type: 'tool_execution_end'
      runId: string
      toolCallId: string
      toolName: string
      result: AgentToolResult
      isError: boolean
      approvalState: Exclude<ToolApprovalState, 'pending'>
    }
  | {
      type: 'turn_end'
      runId: string
      turn: number
      message: AssistantMessage
      toolResults: ToolResultMessage[]
    }
  | AgentMutationEvent
  | { type: 'turn_save_point'; savePoint: AgentTurnSavePoint }
  | {
      type: 'agent_end'
      sessionId: string
      runId: string
      reason: AgentRunEndReason
      messages: AgentMessage[]
      errorMessage?: string
    }
  | { type: 'agent_settled'; savePoint: AgentSavePoint }

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>

/** run 级累计 token 用量（对齐 codex rollout budget 的计费口径：output + 非缓存 input）。 */
export interface AgentRunTokenUsage {
  inputTokens: number
  outputTokens: number
  /** output + (input − cacheRead)：缓存命中的重复输入不计费。 */
  billableTokens: number
  /** 各次响应 totalTokens 的朴素和（仅作参考总量，不用于预算判定）。 */
  totalTokens: number
}

export interface AgentLoopResult {
  runId: string
  reason: AgentRunEndReason
  messages: AgentMessage[]
  newMessages: AgentMessage[]
  unconsumedMessages: AgentMessage[]
  turns: number
  toolCalls: number
  /** 本次 run 的累计 token 用量（仅统计带 usage 的 assistant 响应）。 */
  tokenUsage: AgentRunTokenUsage
  errorMessage?: string
  context: AgentContext
  transport: ModelTransport
}
