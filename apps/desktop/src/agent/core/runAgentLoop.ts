import { createId } from './id'
import {
  activateToolResults,
  activeToolsForContext,
  normalizeAgentContextTools,
} from './deferredTools'
import {
  snapshotAgentContext,
  snapshotAgentEvent,
  snapshotAgentMessage,
  snapshotAgentMessages,
  snapshotAgentTools,
} from './snapshots'
import {
  appendBudgetNoticesToSystemPrompt,
  buildBudgetNotices,
  buildTurnSavePoint,
  buildTurnSnapshot,
} from './turnHelpers'
import { errorText } from './abort'
import { createOrchestrationFailureMessage } from './diagnostics'
import {
  runtimeToolsSnapshot,
  sameRuntimeValue,
  validatedMessages,
} from './messageValidation'
import { streamAssistantMessage } from './streamAssistantMessage'
import { createAssistantContinueMessage } from './messages'
import { executeToolCalls, failToolCalls, type ToolBatchResult } from './toolExecution'
import type {
  AgentContext,
  AgentDelegationRequest,
  AgentDelegationResult,
  AgentEventSink,
  AgentLimits,
  AgentLoopResult,
  AgentMessage,
  AgentMutationBatch,
  AgentMutationEvent,
  AgentMutationReceipt,
  AgentRunEndReason,
  AgentTool,
  AgentTurnSavePoint,
  AfterToolCall,
  AssistantMessage,
  BeforeAgentStart,
  BeforeToolCall,
  ConvertToModelMessages,
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
  ToolResultMessage,
  TransformContext,
} from './types'
import { computeBudgetThresholds, DEFAULT_AGENT_LIMITS } from './types'

export interface AgentTurnSnapshot {
  message: AssistantMessage
  toolResults: ToolResultMessage[]
  context: AgentContext
  newMessages: AgentMessage[]
  /** Compatibility projection of context.messages. */
  messages: AgentMessage[]
  turn: number
  toolCalls: number
  /**
   * 当前轮是否存在临时的系统提示词覆盖（如 before_agent_start.systemPrompt）。
   * 为 true 时，下游钩子（prepareNextTurn）应跳过基于静态 base 重建提示词，
   * 以免覆盖用户主动接管的内容。临时覆盖不写入 context.systemPrompt，故需单独暴露。
   */
  hasTemporarySystemPrompt?: boolean
}

export interface AgentLoopTurnUpdate {
  context?: AgentContext
  systemPrompt?: string
  model?: ModelRef
  reasoning?: ModelReasoning | null
  tools?: AgentTool[]
  activeToolNames?: string[]
  transport?: ModelTransport
  appendMessages?: AgentMessage[]
  source?: RuntimeUpdateSource
  runtimeUpdates?: AgentLoopTurnUpdate[]
}

export interface PendingAgentLoopMutationBatch {
  id: string
  update: AgentLoopTurnUpdate
  journalEntryIds?: string[]
}

export interface RunAgentLoopOptions {
  context: AgentContext
  prompts: AgentMessage[]
  transport: ModelTransport
  emit?: AgentEventSink
  signal?: AbortSignal
  limits?: Partial<AgentLimits>
  toolExecution?: ToolExecutionMode
  getInitialMessages?: (runId: string) => Promise<AgentMessage[]>
  getSteeringMessages?: (runId: string) => Promise<AgentMessage[]>
  getFollowUpMessages?: (runId: string) => Promise<AgentMessage[]>
  onUnconsumedMessages?: (messages: AgentMessage[]) => void | Promise<void>
  shouldStopAfterTurn?: (snapshot: AgentTurnSnapshot) => boolean | Promise<boolean>
  beforeToolCall?: BeforeToolCall
  afterToolCall?: AfterToolCall
  transformContext?: TransformContext
  convertToModelMessages?: ConvertToModelMessages
  resolveModelAuth?: ResolveModelAuth
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
  peekPendingMutations?: () =>
    PendingAgentLoopMutationBatch | undefined | Promise<PendingAgentLoopMutationBatch | undefined>
  acknowledgePendingMutations?: (batchId: string) => void | Promise<void>
  commitMutationBatch?: (
    batch: AgentMutationBatch,
  ) => AgentMutationReceipt | void | Promise<AgentMutationReceipt | void>
  historyMessageCount?: number
  historyLastMessageId?: string
  getCheckpointId?: () => string | undefined
  prepareModelRequest?: (
    request: ModelRequest,
    signal: AbortSignal,
    transport: ModelTransport,
  ) => Promise<ModelRequest>
  beforeAgentEnd?: (
    context: AgentContext,
    transport: ModelTransport,
    signal: AbortSignal,
  ) => void | Promise<void>
  externalizeToolResult?: ToolResultExternalizer
  /**
   * SubAgent 委派端口：由父 AgentSession 提供，toolExecution 层在每个工具调用
   * 现场注入 parentToolCallId/signal/deadlineMs/reportProgress 后包装成
   * AgentToolExecutionContext.delegateAgent。
   */
  runDelegate?: (
    request: AgentDelegationRequest,
    ctx: SubAgentDelegationContext,
  ) => Promise<AgentDelegationResult>
}

const noOpSink: AgentEventSink = () => undefined

/** snapshotAgentContext 的本地别名，主循环中多处使用，保留以减少改动面。 */
const snapshotContext = snapshotAgentContext

const mergeLimits = (limits: Partial<AgentLimits> | undefined): AgentLimits => ({
  ...DEFAULT_AGENT_LIMITS,
  ...limits,
})

export const runAgentLoop = async (options: RunAgentLoopOptions): Promise<AgentLoopResult> => {
  const rawEmit = options.emit ?? noOpSink
  const emit: AgentEventSink = (event) => {
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      // message_end 是持久化屏障：store 监听器在此落库。把 assistant 消息登记进 runtime
      // history 放在转发给监听器之前，消除"store 已写而 history 缺"的非原子窗口——即使
      // 监听器抛错让 run 走失败路径，context.messages 与 agent_end 事件也保持一致。
      // 仅处理 assistant：user/custom（appendMessage）与 tool（emitToolResults）消息
      // 由各自的显式 push 路径登记，避免重复。
      if (!context.messages.some((message) => message.id === event.message.id)) {
        context.messages.push(event.message)
        newMessages.push(event.message)
      }
    }
    return rawEmit(snapshotAgentEvent(event))
  }
  const limits = mergeLimits(options.limits)
  const budgetThresholds = computeBudgetThresholds(limits)
  const runId = createId('run')
  const controller = new AbortController()
  const runStartedAt = Date.now()
  let timeLimitReached = false
  // 结束原因归因：外部用户取消优先于超时。timer 在用户取消后仍可能触发置
  // timeLimitReached，若不先看外部 signal，会误报 time_limit。
  const endReason = (): AgentRunEndReason =>
    timeLimitReached && !options.signal?.aborted ? 'time_limit' : 'aborted'
  const forwardAbort = (): void => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  if (options.signal?.aborted) forwardAbort()
  const timeout = setTimeout(() => {
    timeLimitReached = true
    controller.abort(new DOMException('Agent time limit reached', 'AbortError'))
  }, limits.maxDurationMs)

  let context: AgentContext = normalizeAgentContextTools(snapshotContext(options.context))
  let transport = options.transport
  const newMessages: AgentMessage[] = []
  let turns = 0
  let toolCalls = 0
  let reason: AgentRunEndReason = 'completed'
  let errorMessage: string | undefined
  let pendingMessages: AgentMessage[] = []
  let temporarySystemPrompt: string | undefined
  const pendingSavePointBatchIds: string[] = []
  let pendingTurnSavePoint: AgentTurnSavePoint | undefined
  let turnOpen = false
  let pendingMutationFlushFailed = false

  const appendMessage = async (message: AgentMessage): Promise<void> => {
    const appended = snapshotAgentMessage(message)
    await emit({ type: 'message_start', runId, message: appended })
    context.messages.push(appended)
    newMessages.push(appended)
    await emit({ type: 'message_end', runId, message: appended })
  }

  const applyTurnUpdate = async (
    update: AgentLoopTurnUpdate,
    mutationId = createId('mutation'),
    onCommitted?: () => void | Promise<void>,
    journalEntryIds?: string[],
    targetTurn = turns,
  ): Promise<string | undefined> => {
    let candidateContext = snapshotContext(context)
    let candidateTransport = transport
    let candidateTemporarySystemPrompt = temporarySystemPrompt
    const appendedMessages: AgentMessage[] = []
    const mutationEvents: AgentMutationEvent[] = []
    const messageIds = new Set(candidateContext.messages.map((message) => message.id))

    const collect = (candidate: AgentLoopTurnUpdate): void => {
      if (candidate.appendMessages?.length) {
        const appended = validatedMessages(
          candidate.appendMessages,
          'Save Point appendMessage()',
          messageIds,
        )
        for (const message of appended) {
          if (message.role !== 'user' && message.role !== 'custom') {
            throw new Error('Save Point mutation 只允许追加 User 或 Custom 消息')
          }
          messageIds.add(message.id)
          candidateContext.messages.push(message)
          appendedMessages.push(message)
          mutationEvents.push({
            type: 'session_message_append',
            sessionId: candidateContext.sessionId,
            message,
          })
        }
      }

      const hasRuntimeUpdate = candidate.context !== undefined
        || candidate.systemPrompt !== undefined
        || candidate.model !== undefined
        || candidate.reasoning !== undefined
        || candidate.tools !== undefined
        || candidate.activeToolNames !== undefined
        || candidate.transport !== undefined
      if (hasRuntimeUpdate) {
        const previous = snapshotContext(candidateContext)
        const source = candidate.source ?? 'prepare_next_turn'
        if (candidate.context) {
          candidateContext = normalizeAgentContextTools({
            ...snapshotContext(candidate.context),
            sessionId: candidateContext.sessionId,
            messages: candidateContext.messages,
          })
          candidateTemporarySystemPrompt = undefined
        } else {
          candidateContext = normalizeAgentContextTools({
            ...candidateContext,
            systemPrompt: candidate.systemPrompt ?? candidateContext.systemPrompt,
            model: candidate.model ? structuredClone(candidate.model) : candidateContext.model,
            reasoning: candidate.reasoning === null
              ? undefined
              : candidate.reasoning
                ? structuredClone(candidate.reasoning)
                : candidateContext.reasoning,
            tools: candidate.tools ? snapshotAgentTools(candidate.tools) : candidateContext.tools,
            activeToolNames: candidate.activeToolNames?.slice()
              ?? (candidate.tools ? candidate.tools.map((tool) => tool.name) : candidateContext.activeToolNames),
          })
          if (candidate.systemPrompt !== undefined) candidateTemporarySystemPrompt = undefined
        }
        candidateTransport = candidate.transport ?? candidateTransport

        if (previous.systemPrompt !== candidateContext.systemPrompt) {
          mutationEvents.push({
            type: 'runtime_system_prompt_update',
            previous: previous.systemPrompt,
            current: candidateContext.systemPrompt,
            source,
          })
        }
        if (!sameRuntimeValue(previous.model, candidateContext.model)) {
          mutationEvents.push({
            type: 'runtime_model_update',
            previous: previous.model,
            current: candidateContext.model,
            source,
          })
        }
        if (!sameRuntimeValue(previous.reasoning ?? null, candidateContext.reasoning ?? null)) {
          mutationEvents.push({
            type: 'runtime_reasoning_update',
            previous: previous.reasoning ?? null,
            current: candidateContext.reasoning ?? null,
            source,
          })
        }
        const previousTools = runtimeToolsSnapshot(previous)
        const currentTools = runtimeToolsSnapshot(candidateContext)
        if (!sameRuntimeValue(previousTools, currentTools)) {
          mutationEvents.push({
            type: 'runtime_tools_update',
            previous: previousTools,
            current: currentTools,
            source,
          })
        }
      }
      for (const nested of candidate.runtimeUpdates ?? []) collect(nested)
    }

    collect(update)
    const batch: AgentMutationBatch = {
      id: mutationId,
      sessionId: candidateContext.sessionId,
      runId,
      ...(targetTurn > 0 ? { turn: targetTurn } : {}),
      ...(journalEntryIds?.length ? { journalEntryIds: journalEntryIds.slice() } : {}),
      events: structuredClone(mutationEvents),
      createdAt: Date.now(),
    }
    let receipt: AgentMutationReceipt | void = undefined
    if (batch.events.length > 0 && options.commitMutationBatch) {
      // at-least-once 提交 + 单次重试：首次失败可能实际已提交（响应丢失），重试时
      // store 按 batchId 幂等去重（receipt.replayed），两端收敛到同一状态，不会产生
      // 重复消息/状态——该不变量由 store 的 journal dedup 保证，这里不做二次重放。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          receipt = await options.commitMutationBatch(batch)
          break
        } catch (error) {
          if (attempt > 0) throw error
        }
      }
    }
    if (receipt && (
      receipt.batchId !== batch.id
      || receipt.sessionId !== batch.sessionId
      || receipt.runId !== batch.runId
      || receipt.turn !== batch.turn
    )) {
      throw new Error('Runtime mutation receipt 与提交 batch ownership 不一致')
    }

    context = candidateContext
    transport = candidateTransport
    temporarySystemPrompt = candidateTemporarySystemPrompt
    newMessages.push(...snapshotAgentMessages(appendedMessages))
    await onCommitted?.()
    for (const event of mutationEvents) await emit(event)
    if (batch.events.length === 0) return undefined
    return mutationId
  }

  const flushPendingMutations = async (): Promise<string[]> => {
    const committedBatchIds: string[] = []
    for (let flushes = 0; flushes < 100; flushes += 1) {
      const pending = await options.peekPendingMutations?.()
      if (!pending) return committedBatchIds
      let committedBatchId: string | undefined
      try {
        committedBatchId = await applyTurnUpdate(
          pending.update,
          pending.id,
          async () => options.acknowledgePendingMutations?.(pending.id),
          pending.journalEntryIds,
        )
      } catch (error) {
        pendingMutationFlushFailed = true
        throw error
      }
      if (committedBatchId) committedBatchIds.push(committedBatchId)
    }
    throw new Error('Save Point pending mutation 未能在 100 次冲刷内收敛')
  }

  const emitTurnSavePoint = async (flushMutations = true): Promise<void> => {
    if (!pendingTurnSavePoint) {
      if (flushMutations) pendingSavePointBatchIds.push(...await flushPendingMutations())
      const lastDurableMessage = newMessages[newMessages.length - 1]
      const checkpointId = options.getCheckpointId?.()
      pendingTurnSavePoint = buildTurnSavePoint({
        sessionId: context.sessionId,
        runId,
        turn: turns,
        mutationBatchIds: pendingSavePointBatchIds.slice(),
        historyMessageCount: options.historyMessageCount ?? 0,
        newMessageCount: newMessages.length,
        ...(lastDurableMessage ? { lastDurableMessageId: lastDurableMessage.id } : {}),
        ...(options.historyLastMessageId ? { historyLastMessageId: options.historyLastMessageId } : {}),
        ...(checkpointId ? { checkpointId } : {}),
        createdAt: Date.now(),
      })
    }
    const confirmed = pendingTurnSavePoint
    await emit({ type: 'turn_save_point', savePoint: confirmed })
    pendingSavePointBatchIds.splice(0, confirmed.mutationBatchIds.length)
    pendingTurnSavePoint = undefined
  }

  let runPrompts: AgentMessage[]
  try {
    const beforeStart = await options.beforeAgentStart?.({
      sessionId: context.sessionId,
      runId,
      prompts: snapshotAgentMessages(options.prompts),
      systemPrompt: context.systemPrompt,
      context: snapshotContext(context),
      signal: controller.signal,
    })
    runPrompts = snapshotAgentMessages(options.prompts)
    if (beforeStart?.prompts) runPrompts = validatedMessages(beforeStart.prompts, 'before_agent_start prompts')
    if (beforeStart?.appendMessages?.length) {
      runPrompts.push(...validatedMessages(
        beforeStart.appendMessages,
        'before_agent_start appendMessages',
        new Set(runPrompts.map((message) => message.id)),
      ))
    }
    if (beforeStart?.systemPrompt !== undefined) {
      if (typeof beforeStart.systemPrompt !== 'string') {
        throw new Error('before_agent_start systemPrompt 必须是字符串')
      }
      temporarySystemPrompt = beforeStart.systemPrompt
    }
  } catch (error) {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', forwardAbort)
    throw error
  }

  try {
    await emit({ type: 'agent_start', sessionId: context.sessionId, runId })
    const initialMessages = validatedMessages(
      (await options.getInitialMessages?.(runId)) ?? [],
      'getInitialMessages messages',
      new Set(runPrompts.map((message) => message.id)),
    )
    if (initialMessages.length > 0) runPrompts = [...initialMessages, ...runPrompts]
    turns = 1
    turnOpen = true
    await emit({ type: 'turn_start', runId, turn: turns })
    for (const prompt of runPrompts) await appendMessage(prompt)
    pendingSavePointBatchIds.push(...await flushPendingMutations())
    pendingMessages = snapshotAgentMessages((await options.getSteeringMessages?.(runId)) ?? [])
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new DOMException('Agent 运行已取消', 'AbortError')
    }

    while (true) {
      for (const pending of pendingMessages) await appendMessage(pending)
      pendingMessages = []

      // 预算提示注入（纯函数，见 turnHelpers.ts）：按轮次/工具调用剩余量生成软/硬提醒。
      const budgetNotices = buildBudgetNotices(turns, toolCalls, limits, budgetThresholds)
      const budgetAwareSystemPrompt = appendBudgetNoticesToSystemPrompt(
        temporarySystemPrompt ?? context.systemPrompt,
        budgetNotices,
      )
      const assistant = await streamAssistantMessage(
        context,
        runId,
        transport,
        controller.signal,
        emit,
        limits.maxMessageBytes,
        options.transformContext,
        options.convertToModelMessages,
        options.resolveModelAuth,
        options.prepareModelRequest,
        options.onModelRequest,
        options.onModelResponse,
        options.providerLifecycle,
        budgetAwareSystemPrompt,
      )
      // assistant 已由 emit 拦截在 message_end 时登记进 context/newMessages。

      let toolResults: ToolResultMessage[] = []
      let allToolsTerminate = false
      const calls = assistant.toolCalls

      if (assistant.stopReason !== 'error' && assistant.stopReason !== 'aborted' && calls.length > 0) {
        let batch: ToolBatchResult
        const activeNames = new Set(activeToolsForContext(context).map((tool) => tool.name))
        if (toolCalls + calls.length > limits.maxToolCalls) {
          batch = await failToolCalls(
            calls,
            `未执行工具：达到最大工具调用数 ${limits.maxToolCalls}`,
            runId,
            emit,
            limits.maxInlineToolResultBytes,
            options.externalizeToolResult,
            activeNames,
          )
          reason = 'tool_limit'
          errorMessage = `达到最大工具调用数 ${limits.maxToolCalls}`
        } else if (assistant.stopReason === 'length') {
          batch = await failToolCalls(
            calls,
            '未执行工具：模型响应达到长度上限，工具参数可能不完整',
            runId,
            emit,
            limits.maxInlineToolResultBytes,
            options.externalizeToolResult,
            activeNames,
          )
          toolCalls += calls.length
        } else {
          toolCalls += calls.length
          batch = await executeToolCalls(
            assistant,
            context,
            runId,
            controller.signal,
            emit,
            options.toolExecution ?? 'parallel',
            limits.maxInlineToolResultBytes,
            options.beforeToolCall,
            options.afterToolCall,
            options.externalizeToolResult,
            // 工具硬超时：整轮剩余时间。忽略 signal 的工具在此被切断为失败结果，
            // 不会无限挂起 run/abort/dispose（超时不置 controller.aborted，不误报 time_limit）。
            Math.max(0, limits.maxDurationMs - (Date.now() - runStartedAt)),
            options.runDelegate,
          )
        }
        toolResults = batch.messages
        allToolsTerminate = batch.allTerminate
        for (const result of toolResults) {
          context.messages.push(result)
          newMessages.push(result)
        }
        context = activateToolResults(context, toolResults)
      }

      await emit({ type: 'turn_end', runId, turn: turns, message: assistant, toolResults })
      turnOpen = false
      await emitTurnSavePoint()

      if (assistant.stopReason === 'error') {
        reason = 'error'
        errorMessage = assistant.errorMessage
        break
      }
      if (assistant.stopReason === 'aborted' || controller.signal.aborted) {
        reason = endReason()
        errorMessage = assistant.errorMessage
        break
      }
      if (reason === 'tool_limit') break

      const snapshot: AgentTurnSnapshot = buildTurnSnapshot(
        assistant,
        toolResults,
        context,
        newMessages,
        turns,
        toolCalls,
        temporarySystemPrompt !== undefined,
      )
      const nextTurn = await options.prepareNextTurn?.(snapshot, controller.signal)
      if (nextTurn) {
        const mutationBatchId = await applyTurnUpdate(
          nextTurn,
          createId('mutation'),
          undefined,
          undefined,
          turns + 1,
        )
        if (mutationBatchId) pendingSavePointBatchIds.push(mutationBatchId)
      }
      pendingSavePointBatchIds.push(...await flushPendingMutations())

      const stopSnapshot: AgentTurnSnapshot = buildTurnSnapshot(
        assistant,
        toolResults,
        context,
        newMessages,
        turns,
        toolCalls,
        temporarySystemPrompt !== undefined,
      )
      if (await options.shouldStopAfterTurn?.(stopSnapshot)) {
        reason = 'stopped'
        break
      }

      pendingMessages = snapshotAgentMessages((await options.getSteeringMessages?.(runId)) ?? [])
      // max_tokens 截断且本轮无工具调用：模型输出被 Provider 硬截断（长任务中常见），
      // 不能静默结束——需自动追加续写消息推进下一轮，避免用户手动输入"继续"。
      // 用户主动排队的 steering/follow-up 始终优先于自动续写。
      const truncatedWithoutTools = assistant.stopReason === 'length' && calls.length === 0
      let shouldContinue = (calls.length > 0 && !allToolsTerminate) || pendingMessages.length > 0

      if (!shouldContinue) {
        const followUpMessages = (await options.getFollowUpMessages?.(runId)) ?? []
        if (followUpMessages.length > 0) {
          pendingMessages = snapshotAgentMessages(followUpMessages)
          shouldContinue = true
        }
      }
      if (!shouldContinue && truncatedWithoutTools) {
        if (assistant.excludeFromModelContext === true) {
          // thinking-only 空响应：同 run 请求路径不过滤 excludeFromModelContext，
          // 续写前从 context 移除，避免下一轮向 Provider 发送空 assistant 触发 HTTP 400。
          context.messages = context.messages.filter((message) => message.id !== assistant.id)
        }
        pendingMessages = [createAssistantContinueMessage(assistant.id)]
        shouldContinue = true
      }
      if (!shouldContinue) break
      if (controller.signal.aborted) {
        reason = endReason()
        break
      }
      if (turns >= limits.maxTurns) {
        reason = 'turn_limit'
        errorMessage = `达到最大模型轮数 ${limits.maxTurns}`
        break
      }
      turns += 1
      turnOpen = true
      await emit({ type: 'turn_start', runId, turn: turns })
    }
    await flushPendingMutations()
    if (options.beforeAgentEnd) {
      try {
        await options.beforeAgentEnd(snapshotContext(context), transport, controller.signal)
      } catch (error) {
        // 收尾遥测（context_usage 等 observer 事件）失败不得毒化一个已经完成的 run：
        // 此刻所有消息/工具结果均已落库，run 已进入终止态；失败只应在 run 本就
        // 是错误态时作为补充细节记录，绝不清空既定的结束原因或追加失败消息。
        if (reason === 'error') {
          errorMessage = `${errorMessage ?? 'Agent 运行失败'}；收尾遥测失败：${errorText(error)}`
        }
      }
    }
    await flushPendingMutations()
  } catch (error) {
    reason = controller.signal.aborted ? endReason() : 'error'
    errorMessage = errorText(error)
    const failureMessage = createOrchestrationFailureMessage(context, error, controller.signal.aborted)
    // failureMessage 的登记由下方 message_end 的 emit 拦截完成（见 emit 定义），不重复 push。

    const reportingErrors: unknown[] = []
    const attemptReport = async (operation: () => void | Promise<void>): Promise<boolean> => {
      try {
        await operation()
        return true
      } catch (reportingError) {
        reportingErrors.push(reportingError)
        return false
      }
    }
    if (!turnOpen) {
      turns += 1
      turnOpen = true
      await attemptReport(() => emit({ type: 'turn_start', runId, turn: turns }))
    }
    await attemptReport(() => emit({ type: 'message_start', runId, message: failureMessage }))
    await attemptReport(() => emit({ type: 'message_end', runId, message: failureMessage }))
    if (await attemptReport(() => emit({
      type: 'turn_end',
      runId,
      turn: turns,
      message: failureMessage,
      toolResults: [],
    }))) {
      turnOpen = false
    }
    await attemptReport(() => emitTurnSavePoint(!pendingMutationFlushFailed))
    if (reportingErrors.length > 0) {
      errorMessage = `${errorMessage}；生命周期补偿失败：${reportingErrors.map(errorText).join('；')}`
    }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', forwardAbort)
  }

  const result: AgentLoopResult = {
    runId,
    reason,
    messages: snapshotAgentMessages(context.messages),
    newMessages: snapshotAgentMessages(newMessages),
    unconsumedMessages: snapshotAgentMessages(pendingMessages),
    turns,
    toolCalls,
    errorMessage,
    context: snapshotContext(context),
    transport,
  }
  await options.onUnconsumedMessages?.(snapshotAgentMessages(pendingMessages))
  await emit({
    type: 'agent_end',
    sessionId: context.sessionId,
    runId,
    reason,
    messages: context.messages.slice(),
    errorMessage,
  })
  return result
}
