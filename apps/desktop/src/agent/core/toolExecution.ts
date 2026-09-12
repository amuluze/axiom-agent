import { byteLength } from './bytes'
import { isAbortError } from './abort'
import {
  activeToolsForContext,
  validateAddedToolNames,
} from './deferredTools'
import {
  cloneJsonValue,
  snapshotAgentContext,
  snapshotAgentTool,
  snapshotApprovalPresentation,
  snapshotAssistantMessage,
  snapshotToolCall,
  snapshotToolResult,
} from './snapshots'
import type {
  AfterToolCall,
  AgentContext,
  AgentDelegationRequest,
  AgentDelegationResult,
  AgentEventSink,
  AgentTool,
  AgentToolExecutionContext,
  BeforeToolCall,
  JsonValue,
  SubAgentDelegationContext,
  ToolCall,
  ToolExecutionMode,
  ToolResultExternalizer,
  ToolResultMessage,
  ToolApprovalPresentation,
} from './types'
import type { AssistantMessage } from './types'

/** SubAgent 委派端口：由 runAgentLoop 透传，executePreparedToolCall 在每个工具调用现场注入身份。 */
export type RunDelegatePort = (
  request: AgentDelegationRequest,
  ctx: SubAgentDelegationContext,
) => Promise<AgentDelegationResult>
import {
  createToolError,
  emitToolResultMessages,
  failToolCalls,
  type ToolBatchResult,
  type ToolCallOutcome,
} from './toolResults'

// runAgentLoop 主循环从本模块统一取得工具执行链入口与结果类型，这里转发 toolResults 的导出。
export { failToolCalls, type ToolBatchResult }

/**
 * 工具执行硬超时错误。非 AbortError：工具忽略 signal 时，执行层在 deadline 到达后
 * 以本错误切断该调用，生成工具失败结果（模型可见并可自行恢复），不取消整个 run。
 */
export class ToolExecutionTimeoutError extends Error {
  readonly toolName: string

  constructor(toolName: string) {
    super(`工具 ${toolName} 执行超过时限`)
    this.name = 'ToolExecutionTimeoutError'
    this.toolName = toolName
  }
}

/** 给 Promise 加硬超时：先到者胜，超时 reject 专属错误；胜者清理 timer 防泄漏。 */
const withHardTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(timeoutError()), timeoutMs)
  promise.then(
    (value) => { clearTimeout(timer); resolve(value) },
    (error) => { clearTimeout(timer); reject(error) },
  )
})

/** 已通过校验与审批、准备就绪的工具调用。 */
export interface PreparedToolCall {
  call: ToolCall
  tool: AgentTool
  input: JsonValue
  approvalState: 'approved' | 'not_required'
  approvalLease?: string
}

/**
 * 等待用户审批（或对无需审批的工具直接放行）。
 * 审批等待期间响应 abort：把 signal 转成 reject，避免无限挂起。
 */
export const waitForApproval = async (
  prepared: Pick<PreparedToolCall, 'call' | 'tool' | 'input'>,
  assistantMessage: AssistantMessage,
  context: AgentContext,
  runId: string,
  signal: AbortSignal,
  beforeToolCall: BeforeToolCall | undefined,
): Promise<{ approved: boolean; reason?: string; approvalLease?: string }> => {
  if (!beforeToolCall) {
    return prepared.tool.requiresApproval
      ? { approved: false, reason: '没有可用的用户审批处理器' }
      : { approved: true }
  }
  if (signal.aborted) return { approved: false, reason: 'Agent 运行已取消' }

  let presentation: ToolApprovalPresentation | undefined
  try {
    presentation = prepared.tool.approvalPresentation?.(cloneJsonValue(prepared.input)) ?? {
      title: `允许工具 ${prepared.tool.label} 执行？`,
      description: '此工具需要逐次用户审批。',
    }
  } catch (error) {
    return {
      approved: false,
      reason: `无法生成安全审批预览：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  let removeAbortListener = (): void => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'))
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })

  try {
    const result = await Promise.race([
      Promise.resolve(beforeToolCall({
        sessionId: context.sessionId,
        runId,
        assistantMessage: snapshotAssistantMessage(assistantMessage),
        toolCall: snapshotToolCall(prepared.call),
        toolCallId: prepared.call.id,
        toolName: prepared.tool.name,
        toolLabel: prepared.tool.label,
        requiresApproval: prepared.tool.requiresApproval === true,
        tier: prepared.tool.resolveTier?.(cloneJsonValue(prepared.input)),
        input: cloneJsonValue(prepared.input),
        context: snapshotAgentContext(context),
        presentation: snapshotApprovalPresentation(presentation),
        signal,
      })),
      aborted,
    ])
    return result.decision === 'approved'
      ? { approved: true, ...(result.approvalLease ? { approvalLease: result.approvalLease } : {}) }
      : { approved: false, reason: result.reason ?? '用户拒绝了本次工具调用' }
  } catch (error) {
    return {
      approved: false,
      reason: signal.aborted || isAbortError(error)
        ? 'Agent 运行已取消'
        : `审批处理失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    removeAbortListener()
  }
}

/** 执行工具的后置 Hook；Hook 失败时把结果降级为错误结果而非中断。 */
export const applyAfterToolCall = async (
  prepared: PreparedToolCall,
  assistantMessage: AssistantMessage,
  context: AgentContext,
  runId: string,
  signal: AbortSignal,
  outcome: ToolCallOutcome,
  afterToolCall: AfterToolCall | undefined,
): Promise<ToolCallOutcome> => {
  if (!afterToolCall) return outcome
  try {
    const override = await afterToolCall({
      sessionId: context.sessionId,
      runId,
      assistantMessage: snapshotAssistantMessage(assistantMessage),
      toolCall: snapshotToolCall(prepared.call),
      tool: snapshotAgentTool(prepared.tool),
      input: cloneJsonValue(prepared.input),
      result: snapshotToolResult(outcome.result),
      isError: outcome.isError,
      context: snapshotAgentContext(context),
      signal,
    })
    return {
      ...outcome,
      result: override?.result ? snapshotToolResult(override.result) : outcome.result,
      isError: override?.isError ?? outcome.isError,
    }
  } catch (error) {
    return {
      ...outcome,
      result: createToolError(
        `工具 ${prepared.call.name} 已执行，但后置处理失败：${error instanceof Error ? error.message : String(error)}`,
      ),
      isError: true,
    }
  }
}

/** 执行一个已准备就绪的工具调用，捕获进度事件、处理 abort、应用硬超时与 afterToolCall。 */
export const executePreparedToolCall = async (
  prepared: PreparedToolCall,
  assistantMessage: AssistantMessage,
  context: AgentContext,
  runId: string,
  signal: AbortSignal,
  emit: AgentEventSink,
  afterToolCall: AfterToolCall | undefined,
  timeoutMs?: number,
  runDelegate?: RunDelegatePort,
): Promise<ToolCallOutcome> => {
  const progressEvents: Promise<void>[] = []
  let acceptingProgress = true
  let outcome: ToolCallOutcome
  try {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const deadlineMs = timeoutMs !== undefined && timeoutMs > 0
      ? Date.now() + timeoutMs
      : undefined
    const reportProgress: AgentToolExecutionContext['reportProgress'] = (content, details) => {
      if (!acceptingProgress) return Promise.resolve()
      const progress = Promise.resolve(emit({
        type: 'tool_execution_update',
        runId,
        toolCallId: prepared.call.id,
        toolName: prepared.call.name,
        content,
        details,
      }))
      progressEvents.push(progress)
      return progress
    }
    const executePromise = prepared.tool.execute(prepared.input, {
      sessionId: context.sessionId,
      runId,
      toolCallId: prepared.call.id,
      ...(prepared.approvalLease ? { approvalLease: prepared.approvalLease } : {}),
      signal,
      modelAcceptsImage: context.model.input?.includes('image') ?? false,
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
      reportProgress,
      ...(runDelegate
        ? {
            delegateAgent: (request: AgentDelegationRequest) =>
              runDelegate(request, {
                parentRunId: runId,
                parentToolCallId: prepared.call.id,
                signal,
                ...(deadlineMs !== undefined ? { deadlineMs } : {}),
                reportProgress,
              }),
          }
        : {}),
    })
    // 硬超时：工具忽略 signal 时由 deadline 切断，避免挂起整个 run / abort / dispose。
    // 超时错误非 AbortError，只让该工具调用失败（模型可见），不取消整轮。
    const result = timeoutMs !== undefined && timeoutMs > 0
      ? await withHardTimeout(
          executePromise,
          timeoutMs,
          () => new ToolExecutionTimeoutError(prepared.call.name),
        )
      : await executePromise
    acceptingProgress = false
    // 进度事件失败不翻转已成功执行的工具结果：工具副作用已落地，进度 emit
    // （store 写）失败只说明观测通道出问题，模型不应据此收到"工具执行失败"。
    await Promise.allSettled(progressEvents)
    outcome = { call: prepared.call, result, isError: false }
  } catch (error) {
    acceptingProgress = false
    await Promise.allSettled(progressEvents)
    const result = createToolError(
      signal.aborted || isAbortError(error)
        ? `工具 ${prepared.call.name} 已取消`
        : error instanceof ToolExecutionTimeoutError
          ? error.message
          : `工具 ${prepared.call.name} 执行失败：${error instanceof Error ? error.message : String(error)}`,
    )
    outcome = { call: prepared.call, result, isError: true }
  }

  outcome = await applyAfterToolCall(
    prepared,
    assistantMessage,
    context,
    runId,
    signal,
    outcome,
    afterToolCall,
  )
  try {
    validateAddedToolNames(outcome.result.addedToolNames, context.tools)
    if (outcome.isError && outcome.result.addedToolNames?.length) {
      throw new Error('失败的工具结果不能激活新工具')
    }
  } catch (error) {
    outcome = {
      ...outcome,
      result: createToolError(
        `工具 ${prepared.call.name} 返回的新增工具无效：${error instanceof Error ? error.message : String(error)}`,
      ),
      isError: true,
    }
  }
  await emit({
    type: 'tool_execution_end',
    runId,
    toolCallId: prepared.call.id,
    toolName: prepared.call.name,
    result: outcome.result,
    isError: outcome.isError,
    approvalState: prepared.approvalState,
  })
  return outcome
}

/** 校验参数、激活状态、审批等待，产出 PreparedToolCall 或直接给出失败结果。 */
export const prepareToolCall = async (
  call: ToolCall,
  assistantMessage: AssistantMessage,
  context: AgentContext,
  runId: string,
  signal: AbortSignal,
  emit: AgentEventSink,
  beforeToolCall: BeforeToolCall | undefined,
): Promise<PreparedToolCall | ToolCallOutcome> => {
  const tool = activeToolsForContext(context).find((candidate) => candidate.name === call.name)
  let errorMessage: string | undefined
  let validatedInput: JsonValue = call.arguments

  if (call.argumentError) {
    errorMessage = `工具参数不是有效 JSON：${call.argumentError}`
  } else if (!tool) {
    errorMessage = context.tools.some((candidate) => candidate.name === call.name)
      ? `工具尚未激活：${call.name}`
      : `未注册工具：${call.name}`
  } else {
    try {
      const preparedInput = tool.prepareArguments?.(call.arguments) ?? call.arguments
      const validation = tool.validate(preparedInput)
      if (validation.ok) {
        validatedInput = validation.value
      } else {
        errorMessage = `工具参数校验失败：${validation.error}`
      }
    } catch (error) {
      errorMessage = `工具参数预处理失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (errorMessage || !tool) {
    await emit({
      type: 'tool_execution_start',
      runId,
      toolCallId: call.id,
      toolName: call.name,
      arguments: call.arguments,
      approvalState: 'not_required',
      recoveryPolicy: 'never',
    })
    const result = createToolError(errorMessage ?? `未注册工具：${call.name}`)
    await emit({
      type: 'tool_execution_end',
      runId,
      toolCallId: call.id,
      toolName: call.name,
      result,
      isError: true,
      approvalState: 'not_required',
    })
    return { call, result, isError: true }
  }

  let auditArguments = validatedInput
  if (tool.auditArguments) {
    try {
      auditArguments = tool.auditArguments(cloneJsonValue(validatedInput))
    } catch {
      auditArguments = { redacted: true }
    }
  }
  let recoveryPolicy = tool.recoveryPolicy ?? 'never'
  let idempotencyKey: string | undefined
  if (recoveryPolicy === 'idempotent') {
    try {
      const rawKey = await tool.idempotencyKey?.(cloneJsonValue(validatedInput))
      idempotencyKey = rawKey?.trim()
      if (!idempotencyKey || byteLength(idempotencyKey) > 512) {
        throw new Error('idempotencyKey 必须是 1–512 bytes')
      }
    } catch (error) {
      errorMessage = `工具幂等键生成失败：${error instanceof Error ? error.message : String(error)}`
      recoveryPolicy = 'never'
      idempotencyKey = undefined
    }
  }
  if (errorMessage) {
    await emit({
      type: 'tool_execution_start',
      runId,
      toolCallId: call.id,
      toolName: call.name,
      arguments: auditArguments,
      approvalState: 'not_required',
      recoveryPolicy: 'never',
    })
    const result = createToolError(errorMessage)
    await emit({
      type: 'tool_execution_end',
      runId,
      toolCallId: call.id,
      toolName: call.name,
      result,
      isError: true,
      approvalState: 'not_required',
    })
    return { call, result, isError: true }
  }
  await emit({
    type: 'tool_execution_start',
    runId,
    toolCallId: call.id,
    toolName: call.name,
    arguments: auditArguments,
    approvalState: tool.requiresApproval ? 'pending' : 'not_required',
    recoveryPolicy,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  })
  const prepared = { call, tool, input: validatedInput } satisfies Omit<PreparedToolCall, 'approvalState'>
  const approval = await waitForApproval(
    prepared,
    assistantMessage,
    context,
    runId,
    signal,
    beforeToolCall,
  )
  if (!approval.approved) {
    const result = createToolError(
      signal.aborted
        ? `工具 ${call.name} 审批等待已取消`
        : `工具 ${call.name} 未获批准：${approval.reason ?? '用户拒绝了本次工具调用'}`,
    )
    await emit({
      type: 'tool_execution_end',
      runId,
      toolCallId: call.id,
      toolName: call.name,
      result,
      isError: true,
      approvalState: tool.requiresApproval ? 'denied' : 'not_required',
    })
    return { call, result, isError: true }
  }
  return {
    ...prepared,
    approvalState: tool.requiresApproval ? 'approved' : 'not_required',
    ...(approval.approvalLease ? { approvalLease: approval.approvalLease } : {}),
  }
}

/**
 * 执行一轮工具调用。按 executionMode 与工具自身模式决定串行或并行；
 * 被中断时未开始的调用也会被 failToolCalls 生成结果，维护上下文不变量。
 */
export const executeToolCalls = async (
  assistantMessage: AssistantMessage,
  context: AgentContext,
  runId: string,
  signal: AbortSignal,
  emit: AgentEventSink,
  executionMode: ToolExecutionMode,
  maxInlineToolResultBytes: number,
  beforeToolCall: BeforeToolCall | undefined,
  afterToolCall: AfterToolCall | undefined,
  externalizeToolResult?: ToolResultExternalizer,
  timeoutMs?: number,
  runDelegate?: RunDelegatePort,
): Promise<ToolBatchResult> => {
  const calls = assistantMessage.toolCalls
  const resultSlots = new Map<string, ToolCallOutcome>()
  const forceSequential =
    executionMode === 'sequential'
    || calls.some((call) =>
      activeToolsForContext(context).find((tool) => tool.name === call.name)?.executionMode === 'sequential')

  if (forceSequential) {
    for (const call of calls) {
      const prepared = await prepareToolCall(
        call,
        assistantMessage,
        context,
        runId,
        signal,
        emit,
        beforeToolCall,
      )
      if (!('tool' in prepared)) {
        resultSlots.set(call.id, prepared)
        if (signal.aborted) break
        continue
      }
      const outcome = await executePreparedToolCall(
        prepared,
        assistantMessage,
        context,
        runId,
        signal,
        emit,
        afterToolCall,
        timeoutMs,
        runDelegate,
      )
      resultSlots.set(prepared.call.id, outcome)
      if (signal.aborted) break
    }
  } else {
    const preparedCalls: PreparedToolCall[] = []
    for (const call of calls) {
      const prepared = await prepareToolCall(
        call,
        assistantMessage,
        context,
        runId,
        signal,
        emit,
        beforeToolCall,
      )
      if ('tool' in prepared) preparedCalls.push(prepared)
      else resultSlots.set(call.id, prepared)
      if (signal.aborted) break
    }
    const outcomes = await Promise.all(
      preparedCalls.map((prepared) => executePreparedToolCall(
        prepared,
        assistantMessage,
        context,
        runId,
        signal,
        emit,
        afterToolCall,
        timeoutMs,
        runDelegate,
      )),
    )
    for (const outcome of outcomes) resultSlots.set(outcome.call.id, outcome)
  }

  const executed = calls
    .map((call) => resultSlots.get(call.id))
    .filter((outcome): outcome is ToolCallOutcome => Boolean(outcome))
  const skippedCalls = calls.filter((call) => !resultSlots.has(call.id))
  const activeNames = new Set(activeToolsForContext(context).map((tool) => tool.name))
  // 中断时尚未开始执行的调用也必须生成结果，否则 assistant 消息会带着
  // "有 tool_call 无 tool_result"的悬空调用进入后续模型上下文（与
  // streamAssistantMessage 的剥离策略维护同一不变量）。
  const skipped = skippedCalls.length > 0
    ? await failToolCalls(
        skippedCalls,
        '未执行工具：Agent 运行已取消或中断',
        runId,
        emit,
        maxInlineToolResultBytes,
        externalizeToolResult,
        activeNames,
      )
    : { messages: [] as ToolResultMessage[] }
  const messages = [
    ...await emitToolResultMessages(
      runId,
      executed,
      emit,
      maxInlineToolResultBytes,
      externalizeToolResult,
      activeNames,
    ),
    ...skipped.messages,
  ]
  return {
    messages,
    allTerminate: executed.length > 0 && executed.every((outcome) => outcome.result.terminate === true),
  }
}
