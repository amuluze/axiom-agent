import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import type {
  AgentDelegationRequest,
  AgentDelegationResult,
  ExploreBreadth,
  SubAgentKind,
  AssistantMessage,
  JsonValue,
  ModelRef,
  ModelRequest,
  ModelTransport,
  ModelTransportLifecycle,
  ProviderErrorKind,
  ResolveModelAuth,
} from '@/agent/core/types'

export type {
  AgentDelegationRequest,
  AgentDelegationResult,
  ExploreBreadth,
  SubAgentKind,
} from '@/agent/core/types'

/**
 * 子会话观察身份 envelope：保留真实 childSessionId，聚合键固定使用
 * parentSessionId/parentRunId/parentToolCallId（不修改 ModelRequest.sessionId，
 * 不落 repository、不写父 mutation journal）。
 */
export interface SubAgentObservationContext {
  kind: SubAgentKind
  childSessionId: string
  parentSessionId: string
  parentRunId: string
  parentToolCallId: string
}

export interface SubAgentObservationSink {
  onModelRequest?: (
    request: ModelRequest,
    context: SubAgentObservationContext,
    signal: AbortSignal,
  ) => void | Promise<void>
  onModelResponse?: (
    message: AssistantMessage,
    request: ModelRequest,
    context: SubAgentObservationContext,
    signal: AbortSignal,
  ) => void | Promise<void>
}

/**
 * 单次 child 探索的预算上限。各档位值见 SUBAGENT_BREADTH_BUDGETS——模型经
 * breadth 参数选择档位（默认 standard），产品测试可经 childBudget 覆盖。
 */
export interface SubAgentChildBudget {
  maxTurns: number
  maxToolCalls: number
  /** 所有尝试共享同一绝对 deadline，同时受父 deadline 约束。 */
  maxDurationMs: number
  maxOutputTokens: number
  /** 子会话累计输出 token 上限（跨轮累加，超限下轮 fail-closed）。区别于 maxOutputTokens（per-request cap）。 */
  maxOutputTokensPerRun: number
  /** 按现有流式口径累计 text/thinking/tool name/arguments。 */
  maxMessageBytes: number
  /** 超出后确定性截断，防止 read 堆积（无 child Artifact）。 */
  maxInlineToolResultBytes: number
}

/**
 * 单轮输出 token 余量口径：6144/轮（light 8 轮 × 6144 = 49152，standard 16 轮 = 98304，
 * thorough 24 轮 = 147456）。thinking 默认开启的推理模型单轮 thinking + 文本 + 工具参数
 * 常超 4096 tokens——旧 4096/轮口径下审查子 Agent 普遍在中段即触 child_output_tokens
 * 中止（partial 无结论），是「审查因配额中止」的高频根因。总量仍有双上界兜底：
 * 单请求 16384（maxOutputTokens）+ 父 run 120 次模型请求，不因本维度放宽而失控。
 */
export const DEFAULT_SUBAGENT_CHILD_BUDGET: SubAgentChildBudget = {
  maxTurns: 16,
  maxToolCalls: 48,
  maxDurationMs: 240_000,
  maxOutputTokens: 16_384,
  maxOutputTokensPerRun: 98_304,
  maxMessageBytes: 512 * 1024,
  maxInlineToolResultBytes: 64 * 1024,
}

/**
 * 广度 → child 预算映射。模型经 breadth 参数选择档位，standard 为默认。
 * thorough 档放宽单次预算，但父 run 累计预算（调用次数/请求/时长）不变，
 * 因此 thorough 会更快消耗父配额（正确的成本权衡）。
 */
export const SUBAGENT_BREADTH_BUDGETS: Record<ExploreBreadth, SubAgentChildBudget> = {
  light: {
    maxTurns: 8,
    maxToolCalls: 20,
    maxDurationMs: 120_000,
    maxOutputTokens: 16_384,
    maxOutputTokensPerRun: 49_152,
    maxMessageBytes: 256 * 1024,
    maxInlineToolResultBytes: 64 * 1024,
  },
  standard: DEFAULT_SUBAGENT_CHILD_BUDGET,
  thorough: {
    maxTurns: 24,
    maxToolCalls: 72,
    maxDurationMs: 360_000,
    maxOutputTokens: 16_384,
    maxOutputTokensPerRun: 147_456,
    maxMessageBytes: 512 * 1024,
    maxInlineToolResultBytes: 64 * 1024,
  },
}

/**
 * 父 run 累计子 Agent 预算；按 (parentSessionId, parentRunId) 建立，
 * run settled 后释放。retry/失败同样计费；所有尝试共享绝对 deadline。
 *
 * 配额按「全链路 SDD + 返工循环」定容：8 次委派 = inspect/examine/review 3 次 +
 * explore 1 次 + 最多 3 轮审查返工重审 + 1 次余量；时长按实际墙钟累计（child 通常
 * 远低于名义单次上限），900s 覆盖 thorough 档返工场景。更早的 5 次/480s 在两轮
 * 返工后即触顶，与「审查不通过回上一阶段」的工作流常态不匹配。
 */
export interface SubAgentParentRunBudget {
  maxCallsPerParentRun: number
  maxModelRequestsPerParentRun: number
  maxDurationMsPerParentRun: number
}

export const DEFAULT_SUBAGENT_PARENT_RUN_BUDGET: SubAgentParentRunBudget = {
  maxCallsPerParentRun: 8,
  maxModelRequestsPerParentRun: 120,
  maxDurationMsPerParentRun: 900_000,
}

/**
 * 父 run 累计 ledger 运行状态（可变）。delegate 入口先计数；校验失败、
 * 启动失败和 child error 也占一次配额。
 */
export interface SubAgentParentRunLedger {
  budget: SubAgentParentRunBudget
  callCount: number
  modelRequestCount: number
  spentDurationMs: number
  /** 子结果回流父上下文的累计字节数（diagnostic 观察项，无硬上限）。 */
  returnedBytes: number
  /** 子响应累计 token/cost（内存累加，会话关闭或重启后丢失；首版不持久化 child 计费）。 */
  inputTokens: number
  outputTokens: number
  costTotal: number
  /** 子会话累计的诊断 type 标签（去重；content-free，不保留诊断正文）。 */
  diagnosticTypes: string[]
}

export const createParentRunLedger = (
  budget: SubAgentParentRunBudget = DEFAULT_SUBAGENT_PARENT_RUN_BUDGET,
): SubAgentParentRunLedger => ({
  budget,
  callCount: 0,
  modelRequestCount: 0,
  spentDurationMs: 0,
  returnedBytes: 0,
  inputTokens: 0,
  outputTokens: 0,
  costTotal: 0,
  diagnosticTypes: [],
})

/**
 * 父 AgentSession 以当前权威状态构造的运行时绑定，由 SubAgentRuntime 内部消费，
 * 不暴露给 AgentTool。这样运行中的 Provider 更新、模型切换和 endpoint 解析
 * 都沿用父会话的当前状态。
 */
export interface SubAgentRuntimeBinding {
  parentSessionId: string
  parentRunId: string
  parentToolCallId: string
  model: ModelRef
  transport: ModelTransport
  providerLifecycle?: ModelTransportLifecycle
  /** child 请求的 auth 解析；产品 transport 自持有 key 时可省略。 */
  resolveModelAuth?: ResolveModelAuth
  /** 父工作区 environment：SubAgentRuntime 基于它构造 scope 收窄的只读环境。 */
  environment: AgentEnvironment
  /** 父授权工作区根目录绝对路径（相对路径的解析根）；用于注入子 prompt 与 scope 快速校验诊断。 */
  workspacePath?: string
  observation?: SubAgentObservationSink
  parentRunLedger: SubAgentParentRunLedger
  /** 子模型上下文窗口（tokens）：SubAgentBudgetLedger 按它折算 token 预算，>0 时启用。 */
  contextWindow: number
  /** 父工具调用硬性截止时间（epoch ms）；child deadline clamp 时预留清理时间。 */
  deadlineMs?: number
  /** 子会话进度回传（父工具 result 之外的轻量 progress），由工具执行层注入。 */
  reportProgress?: (content: string, details?: JsonValue) => Promise<void>
}

/**
 * SubAgent 运行时委派端口。父 AgentSession 实现 delegate 窄化后的能力，
 * 工具只看到 AgentToolExecutionContext.delegateAgent。
 */
export interface SubAgentRuntime {
  delegate(
    request: AgentDelegationRequest,
    binding: SubAgentRuntimeBinding,
    signal: AbortSignal,
  ): Promise<AgentDelegationResult>
}

/**
 * 子会话执行错误。携带 Provider 错误分类，子 Agent 工具映射为面向模型的
 * 父工具结果提示；只透传分类，不透传 Provider 原始 body 或敏感请求字段。
 */
export class SubAgentExecutionError extends Error {
  readonly providerErrorKind?: ProviderErrorKind

  constructor(message: string, providerErrorKind?: ProviderErrorKind) {
    super(message)
    this.name = 'SubAgentExecutionError'
    this.providerErrorKind = providerErrorKind
  }
}
