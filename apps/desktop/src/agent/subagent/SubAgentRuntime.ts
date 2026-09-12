import { createId } from '@/agent/core/id'
import { isAbortError } from '@/agent/core/abort'
import { runAgentLoop } from '@/agent/core/runAgentLoop'
import { createUserMessage } from '@/agent/core/messages'
import type {
  AgentContext,
  AgentDelegationRequest,
  AgentLoopResult,
  AgentTool,
  ModelRef,
  SubAgentKind,
} from '@/agent/core/types'
import { createScopedReadEnvironment } from './scopedReadEnvironment'
import { SUBAGENT_READ_MAX_LINES, createSubAgentReadonlyTools } from './readonlyTools'
import { buildBudgetStatusMessage, computeEffectiveMessageBytes } from './budgetStatus'
import {
  estimateModelMessagesBytes,
  SubAgentBudgetLedger,
  type SubAgentBudgetExhaustion,
} from './SubAgentBudgetLedger'
import {
  SUBAGENT_BREADTH_BUDGETS,
  SubAgentExecutionError,
  type AgentDelegationResult,
  type SubAgentChildBudget,
  type SubAgentObservationContext,
  type SubAgentRuntime,
  type SubAgentRuntimeBinding,
} from './contracts'
import type { ProviderErrorKind } from '@/agent/core/types'
import { buildExploreSystemPrompt, type ExplorePromptOptions } from './explore/buildExplorePrompt'
import { buildInspectSystemPrompt } from './reviewers/buildInspectPrompt'
import { buildExamineSystemPrompt } from './reviewers/buildExaminePrompt'
import { buildReviewSystemPrompt } from './reviewers/buildReviewPrompt'
import { probeScopeEntries } from './scopeProbe'

/** 父工具 deadline 前预留清理时间，避免后台 API 消耗。 */
const PARENT_DEADLINE_BUFFER_MS = 500
/** 剩余时间不足时不启动子请求。 */
const MIN_START_REMAINING_MS = 1000
/** 子 tool_execution_end 聚合 progress 的限频。 */
const PROGRESS_INTERVAL_MS = 500

/**
 * 预算耗尽错误（带稳定 code）。在子循环的请求发送前 / 工具执行前抛出，
 * runAgentLoop 会把它转成 error 消息；SubAgentRuntime 据 ledger.exhaustion
 * 事后判定 fail-closed 收口，不进入任何压缩/recovery 路径。
 */
export class SubAgentContextLimitError extends Error {
  constructor(public readonly exhaustion: SubAgentBudgetExhaustion) {
    super(`子任务预算耗尽：${exhaustion}`)
    this.name = 'SubAgentContextLimitError'
  }
}

/**
 * 独立、非持久化的子会话运行时（首版为 Explore，现扩展到四类委派）。
 *
 * 结构隔离（§4.3）：不 import stores/platform/components；不调用产品
 * createRuntimeSession；不创建 AgentHarness；不注入 ContextWindowManager 的
 * 压缩能力（prepareModelRequest/requestOverflowRecovery 入口不在构造路径上，
 * 子循环直接调用 runAgentLoop——runAgentLoop 本身不发起摘要请求）。
 * 中间 ToolResult 不传 externalizer；child 事件不落 repository。
 */
export interface SubAgentRuntimeOptions {
  /** 单次 child 预算覆盖（优先于 breadth 参数；不传时按 request.breadth 选 SUBAGENT_BREADTH_BUDGETS 档位）。 */
  childBudget?: SubAgentChildBudget
}

/**
 * 按委派种类分发 system prompt builder。四类共享同一组通用选项（scope/workspaceRoot/
 * budget/contextWindow），差异只在 builder 内部渲染的角色与审查要点。
 */
const buildSubAgentSystemPrompt = (kind: SubAgentKind, opts: ExplorePromptOptions): string => {
  switch (kind) {
    case 'explore': return buildExploreSystemPrompt(opts)
    case 'inspect': return buildInspectSystemPrompt(opts)
    case 'examine': return buildExamineSystemPrompt(opts)
    case 'review': return buildReviewSystemPrompt(opts)
    default: throw new SubAgentExecutionError(`不支持的 SubAgent 种类：${String(kind)}`)
  }
}

export const createSubAgentRuntime = (options: SubAgentRuntimeOptions = {}): SubAgentRuntime => {
  const overrideBudget = options.childBudget
  return {
  async delegate(
    request: AgentDelegationRequest,
    binding: SubAgentRuntimeBinding,
    signal: AbortSignal,
  ): Promise<AgentDelegationResult> {
    const startedAt = Date.now()
    // 按 breadth 选预算（childBudget 覆盖优先，用于产品测试全档位覆盖）。
    const budget = overrideBudget ?? SUBAGENT_BREADTH_BUDGETS[request.breadth ?? 'standard']
    const ledger = new SubAgentBudgetLedger(binding.parentRunLedger, budget, binding.contextWindow)
    // 有效单次请求字节上限：名义上限与上下文窗口折算（窗口 × 3 bytes/token）取小。
    // 运行时 fail-closed 边界始终按窗口折算（debitModelRequest 的 child_context_window）；
    // 这里产出同一数值供提示词渲染与预算状态注入使用，模型不再按幻影额度规划。
    const effectiveMaxMessageBytes = computeEffectiveMessageBytes(
      budget.maxMessageBytes,
      binding.contextWindow,
    )

    // 父 run 次数在 delegate 入口立即计入（校验失败、启动失败和 child error 也占一次）。
    // 拒绝文案内嵌对症恢复配方而非依赖工具层通用配方：通用配方引导「收窄 scope 重新
    // 委派」，而委派配额尽时重委派必然再被拒——正确动作是父 Agent 亲自收口/自查。
    const callExhaustion = ledger.beginParentCall()
    if (callExhaustion) {
      throw new SubAgentExecutionError(
        `同一父 run 的子 Agent 委派次数已达上限（${binding.parentRunLedger.budget.maxCallsPerParentRun} 次）。`
        + '父 run 内不能再委派：基于已收集的审查/探索结果直接收口，或由主 Agent 亲自完成剩余只读复核；继续委派只会被再次拒绝。',
      )
    }

    // scope 存在性快速校验（fail-closed）：scope 引用的路径必须位于授权工作区内，
    // 否则子 agent 会按任务目录（而非授权工作区根）猜结构，空转多轮后才失败。
    if (request.scope && request.scope.length > 0) {
      const { invalid } = await probeScopeEntries(binding.environment, request.scope)
      if (invalid.length > 0) {
        throw new SubAgentExecutionError(
          `scope 包含不在授权工作区内的路径，已拒绝执行：${invalid.join(', ')}。`
            + `授权工作区根：${binding.workspacePath ?? '未知'}。`
            + 'scope 必须是授权工作区内的相对路径；若任务目标在工作区之外，请先切换/授权对应工作区。',
        )
      }
    }

    const childSessionId = createId('sub-session')
    const observationContext: SubAgentObservationContext = {
      kind: request.kind,
      childSessionId,
      parentSessionId: binding.parentSessionId,
      parentRunId: binding.parentRunId,
      parentToolCallId: binding.parentToolCallId,
    }

    // 绝对 deadline：child 上限 + 父工具 deadline + 父 run 累计时长上限，取最小值。
    const parentRemainingMs = Math.max(
      0,
      binding.parentRunLedger.budget.maxDurationMsPerParentRun
        - binding.parentRunLedger.spentDurationMs,
    )
    let childDeadline = startedAt + Math.min(budget.maxDurationMs, parentRemainingMs)
    if (binding.deadlineMs !== undefined && binding.deadlineMs > 0) {
      // 下界保护：deadline 预留清理时间不得把 childDeadline 回溯到 startedAt 之前，
      // 后续 MIN_START_REMAINING_MS 检查会以"剩余时间不足"明确收口。
      childDeadline = Math.min(
        childDeadline,
        Math.max(startedAt, binding.deadlineMs - PARENT_DEADLINE_BUFFER_MS),
      )
    }
    if (childDeadline - startedAt < MIN_START_REMAINING_MS) {
      throw new SubAgentExecutionError(
        '子任务剩余时间不足，不启动：父 run 时长配额已尽或父工具 deadline 已到。'
        + '基于已收集的结果直接收口，或由主 Agent 亲自完成剩余只读复核。',
      )
    }
    if (signal.aborted) {
      throw new SubAgentExecutionError('子任务已取消')
    }

    // linked controller：父 signal abort 与内部 deadline 都传播到子循环。
    const controller = new AbortController()
    const onParentAbort = (): void => controller.abort()
    signal.addEventListener('abort', onParentAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), Math.max(0, childDeadline - Date.now()))

    let summaryCandidate: string | undefined
    let toolExecutions = 0
    let lastProgressAt = 0
    /** 最近一次 tool_execution_start 的探索目标描述（tool_execution_end 后清除）。 */
    let lastTarget: string | undefined
    let errors = 0

    try {
      const result = await runAgentLoop({
        context: buildChildContext(request, binding, childSessionId, budget, effectiveMaxMessageBytes),
        prompts: [createUserMessage(request.task)],
        transport: binding.transport,
        signal: controller.signal,
        limits: {
          maxTurns: budget.maxTurns,
          maxToolCalls: budget.maxToolCalls,
          maxDurationMs: Math.max(0, childDeadline - Date.now()),
          maxMessageBytes: budget.maxMessageBytes,
          maxInlineToolResultBytes: budget.maxInlineToolResultBytes,
        },
        toolExecution: 'sequential',
        providerLifecycle: binding.providerLifecycle,
        resolveModelAuth: binding.resolveModelAuth,
        prepareModelRequest: async (request) => {
          // 预算状态注入：只在任一维度接近上限（≥75%）时把状态消息附加到
          // 本次请求。原地 push 保持引用不变，不触发 context.messages 同步——
          // 消息只进本次请求、不进子历史，不参与后续字节累计。
          const status = buildBudgetStatusMessage(ledger, effectiveMaxMessageBytes)
          if (status && request.messages.length > 0) {
            request.messages.push(createUserMessage(status))
          }
          return request
        },
        onModelRequest: async (modelRequest, requestSignal) => {
          const bytes = estimateModelMessagesBytes(modelRequest.messages)
          const exhaustion = ledger.debitModelRequest(bytes)
          if (exhaustion) throw new SubAgentContextLimitError(exhaustion)
          await binding.observation?.onModelRequest?.(modelRequest, observationContext, requestSignal)
        },
        onModelResponse: async (message, modelRequest, requestSignal) => {
          if (message.content?.trim()) summaryCandidate = message.content
          if (message.usage) {
            ledger.parentLedger.inputTokens += message.usage.inputTokens ?? 0
            ledger.parentLedger.outputTokens += message.usage.outputTokens ?? 0
            ledger.parentLedger.costTotal += message.usage.cost?.total ?? 0
            // 累计子会话 output token 到预算 ledger（下轮 debitModelRequest 拦截）。
            ledger.debitOutputTokens(message.usage.outputTokens ?? 0)
          }
          // 收集子消息诊断 type 标签（content-free），归并到父 run ledger。
          // 不落库——遵守 child 无持久化禁区。
          if (message.diagnostics) {
            for (const diagnostic of message.diagnostics) {
              if (!ledger.parentLedger.diagnosticTypes.includes(diagnostic.type)) {
                ledger.parentLedger.diagnosticTypes.push(diagnostic.type)
              }
            }
          }
          await binding.observation?.onModelResponse?.(
            message,
            modelRequest,
            observationContext,
            requestSignal,
          )
        },
        beforeToolCall: async () => {
          const exhaustion = ledger.debitToolCall()
          if (exhaustion) throw new SubAgentContextLimitError(exhaustion)
          return { decision: 'approved' }
        },
        emit: (event) => {
          if (event.type === 'tool_execution_start') {
            lastTarget = describeToolTarget(event.toolName, event.arguments)
          } else if (event.type === 'tool_execution_end') {
            toolExecutions += 1
            if (event.isError) errors += 1
            const now = Date.now()
            if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
              lastProgressAt = now
              const action = lastTarget
                ? `${lastTarget} · 已完成 ${toolExecutions} 次只读调用`
                : `已完成 ${toolExecutions} 次只读调用`
              const progress = binding.reportProgress?.(`${request.kind}: ${action}`, {
                toolCalls: toolExecutions,
                ...(lastTarget ? { current: { target: lastTarget } } : {}),
                ...(errors > 0 ? { errors } : {}),
              })
              if (progress) void progress.catch(() => undefined)
            }
            lastTarget = undefined
          }
        },
      })
      // 双 deadline timer（本 runtime 的 controller timer 与 runAgentLoop 的
      // limits.maxDurationMs timer）几乎同刻触发、外层先注册先到，runAgentLoop 多以
      // reason 'aborted' 结束。父 signal 未中止而 controller 已中止只可能是内部
      // deadline（child 上限 / 父 run 累计时长 / 父工具 deadline clamp）——重映射为
      // time_limit 语义，否则 settleResult 会把已有 summary 的时长中止当作取消丢弃收口。
      const internalDeadlineAborted = result.reason === 'aborted'
        && controller.signal.aborted
        && !signal.aborted
      const delegationResult = settleResult(
        result,
        ledger,
        summaryCandidate,
        startedAt,
        internalDeadlineAborted,
      )
      // 回流字节累计（仅成功/partial 路径；抛错路径无 summary 回流，不累计）。
      binding.parentRunLedger.returnedBytes += byteLength(delegationResult.summary)
      return {
        ...delegationResult,
        parentRunUsage: {
          calls: ledger.parentLedger.callCount,
          modelRequests: ledger.parentLedger.modelRequestCount,
          inputTokens: ledger.parentLedger.inputTokens,
          outputTokens: ledger.parentLedger.outputTokens,
          costTotal: ledger.parentLedger.costTotal,
          returnedBytes: binding.parentRunLedger.returnedBytes,
          ...(ledger.parentLedger.diagnosticTypes.length > 0
            ? { diagnosticTypes: [...ledger.parentLedger.diagnosticTypes] }
            : {}),
        },
      }
    } catch (error) {
      if (error instanceof SubAgentContextLimitError) {
        throw new SubAgentExecutionError(`子任务预算耗尽：${error.exhaustion}`)
      }
      if (error instanceof SubAgentExecutionError) throw error
      if (signal.aborted || controller.signal.aborted || isAbortError(error)) {
        throw new SubAgentExecutionError('子任务已取消')
      }
      throw new SubAgentExecutionError(
        `子任务执行失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onParentAbort)
      ledger.settleDuration()
    }
  },
  }
}

const buildChildContext = (
  request: AgentDelegationRequest,
  binding: SubAgentRuntimeBinding,
  childSessionId: string,
  budget: SubAgentChildBudget,
  effectiveMaxMessageBytes: number,
): AgentContext => {
  // child ModelRef：maxOutputTokens 收窄到产品上限，不继承父 reasoning budget。
  const childModel: ModelRef = {
    ...binding.model,
    maxOutputTokens: Math.min(
      binding.model.maxOutputTokens ?? budget.maxOutputTokens,
      budget.maxOutputTokens,
    ),
  }
  const scopedEnvironment = createScopedReadEnvironment(binding.environment, request.scope ?? [])
  const tools: AgentTool[] = createSubAgentReadonlyTools(scopedEnvironment, {
    // 子 Agent read 默认行数收窄：保证结果（含分页提示与 SHA）落在内联上限内，
    // 不被截断后丢失 offset 续读信息。
    read: { maxLines: SUBAGENT_READ_MAX_LINES },
  })
  return {
    sessionId: childSessionId,
    systemPrompt: buildSubAgentSystemPrompt(request.kind, {
      scope: request.scope,
      workspaceRoot: binding.workspacePath,
      contextWindow: binding.contextWindow,
      budget: {
        maxTurns: budget.maxTurns,
        maxToolCalls: budget.maxToolCalls,
        maxMessageBytes: effectiveMaxMessageBytes,
        maxInlineToolResultBytes: budget.maxInlineToolResultBytes,
      },
    }),
    model: childModel,
    messages: [],
    tools,
    activeToolNames: tools.map((tool) => tool.name),
  }
}

const settleResult = (
  result: AgentLoopResult,
  ledger: SubAgentBudgetLedger,
  summaryCandidate: string | undefined,
  startedAt: number,
  /** 内部 deadline 触发（非父取消）：'aborted' 按 time_limit 语义收口。 */
  internalDeadlineAborted = false,
): AgentDelegationResult => {
  const durationMs = Date.now() - startedAt
  const modelRequests = ledger.parentLedger.modelRequestCount
  const reason: AgentLoopResult['reason'] = internalDeadlineAborted && result.reason === 'aborted'
    ? 'time_limit'
    : result.reason

  // 预算耗尽（fail-closed）：onModelRequest/beforeToolCall 抛 SubAgentContextLimitError
  // 被 runAgentLoop 转成 error 消息，这里据 ledger.exhaustion 事后判定。
  if (ledger.exhaustion) {
    const exhausted = ledger.exhaustion
    const endReason = exhausted === 'parent_run_request_limit' || exhausted === 'parent_run_call_limit'
      ? 'parent_run_budget'
      : 'context_limit'
    if (summaryCandidate?.trim()) {
      return {
        status: 'partial',
        summary: summaryCandidate,
        turns: result.turns,
        toolCalls: result.toolCalls,
        modelRequests,
        endReason,
        durationMs,
      }
    }
    throw new SubAgentExecutionError(`子任务因预算耗尽中止（${exhausted}）`)
  }

  const lastAssistant = [...result.newMessages]
    .reverse()
    .find((message) => message.role === 'assistant')
  const finalText = lastAssistant?.role === 'assistant' && lastAssistant.content.trim()
    ? lastAssistant.content
    : undefined
  const summary = summaryCandidate ?? finalText

  switch (reason) {
    case 'completed':
      if (summary) {
        return {
          status: 'completed',
          summary,
          turns: result.turns,
          toolCalls: result.toolCalls,
          modelRequests,
          endReason: 'completed',
          durationMs,
        }
      }
      throw new SubAgentExecutionError('子任务完成但没有可用的总结文本')
    case 'turn_limit':
    case 'tool_limit':
    case 'time_limit':
      if (summary) {
        return {
          status: 'partial',
          summary,
          turns: result.turns,
          toolCalls: result.toolCalls,
          modelRequests,
          endReason: reason,
          durationMs,
        }
      }
      throw new SubAgentExecutionError(`子任务因 ${reason} 中止且没有总结`)
    case 'aborted':
    case 'stopped':
      // 到达此分支的只可能是父 run 取消（内部 deadline 已在上游重映射为 time_limit）。
      throw new SubAgentExecutionError('子任务已取消')
    case 'error': {
      const kind = providerErrorKindOf(result)
      // Provider context overflow 且已有有效总结 → partial（设计 §4.3.3）。
      // 子会话无 overflow recovery，此处直接收口，不重新进入 runAgentLoop。
      // 其余 Provider 错误仍 fail-closed 抛错，携带分类让父工具给出重试建议。
      if (kind === 'context_overflow' && summaryCandidate?.trim()) {
        return {
          status: 'partial',
          summary: summaryCandidate,
          turns: result.turns,
          toolCalls: result.toolCalls,
          modelRequests,
          endReason: 'context_limit',
          durationMs,
        }
      }
      throw new SubAgentExecutionError(
        result.errorMessage ?? '子任务因 Provider 错误中止',
        kind,
      )
    }
    default:
      throw new SubAgentExecutionError(`子任务异常结束：${reason}`)
  }
}

const providerErrorKindOf = (result: AgentLoopResult): ProviderErrorKind | undefined => {
  for (let i = result.newMessages.length - 1; i >= 0; i -= 1) {
    const message = result.newMessages[i]
    if (message.role === 'assistant' && message.providerError) return message.providerError.kind
  }
  return undefined
}

/** UTF-8 字节长度：用于回流字节累计，与 SubAgentBudgetLedger 的字节口径一致。 */
const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

/**
 * 从工具调用参数提取探索目标的人类可读描述，用于进度回传。
 * 防御性提取：不信任字段名，按 toolName 分别取 path/pattern/glob。
 */
export const describeToolTarget = (toolName: string, args: unknown): string | undefined => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const a = args as Record<string, unknown>
  const path = typeof a.path === 'string' ? a.path : undefined
  switch (toolName) {
    case 'read':
      return path ? `读取 ${path}` : undefined
    case 'ls':
      return path ? `列出 ${path}` : undefined
    case 'grep': {
      const pattern = typeof a.pattern === 'string' ? a.pattern : undefined
      if (!pattern) return undefined
      return path ? `搜索 '${pattern}' in ${path}` : `搜索 '${pattern}'`
    }
    case 'find': {
      const glob =
        typeof a.glob === 'string' ? a.glob : typeof a.pattern === 'string' ? a.pattern : undefined
      if (glob) return path ? `查找 ${glob} in ${path}` : `查找 ${glob}`
      return path ? `查找 in ${path}` : undefined
    }
    default:
      return undefined
  }
}
