import { createId } from './id'
import { byteLength, truncateToBytes } from './bytes'
import type {
  AgentEventSink,
  AgentToolResult,
  ToolCall,
  ToolResultExternalizer,
  ToolResultMessage,
} from './types'

/** 单个工具调用的执行结果（含是否出错）。 */
export interface ToolCallOutcome {
  call: ToolCall
  result: AgentToolResult
  isError: boolean
}

/** 一轮工具批量执行的结果：回灌消息 + 是否全部终止。 */
export interface ToolBatchResult {
  messages: ToolResultMessage[]
  allTerminate: boolean
}

/** 构造一个纯文本错误结果。 */
export const createToolError = (message: string): AgentToolResult => ({ content: message })

/**
 * 把工具调用结果构造成可回灌的 ToolResultMessage。
 * 超出内联上限或携带 artifactContent 时，尝试外置到 Artifact 存储，
 * 并在尾部追加截断提示或失败说明。
 */
export const createToolResultMessage = async (
  runId: string,
  outcome: ToolCallOutcome,
  maxInlineToolResultBytes: number,
  externalizeToolResult?: ToolResultExternalizer,
): Promise<ToolResultMessage> => {
  const artifactContent = outcome.result.artifactContent ?? outcome.result.content
  const exceedsInlineLimit = byteLength(outcome.result.content) > maxInlineToolResultBytes
  const requiresArtifact = outcome.result.artifactContent !== undefined || exceedsInlineLimit
  let artifact = outcome.result.artifact
  let artifactError: string | undefined
  if (!artifact && requiresArtifact && externalizeToolResult) {
    try {
      artifact = await externalizeToolResult({
        runId,
        toolCallId: outcome.call.id,
        toolName: outcome.call.name,
        content: artifactContent,
      })
    } catch {
      artifactError = '完整工具结果未能写入 Artifact 存储'
    }
  }

  const suffix = exceedsInlineLimit && artifact
    ? `\n\n[完整工具结果已安全保存为 Artifact · ${artifact.sizeBytes} bytes]`
    : exceedsInlineLimit && artifactError
      ? '\n\n[Artifact 保存失败；内容仅保留到 Axiom 内联上限]'
      : undefined

  const inlineContent = truncateToBytes(outcome.result.content, maxInlineToolResultBytes, suffix)
  const contentBlocks = outcome.result.contentBlocks
    ? [
        ...(inlineContent ? [{ type: 'text' as const, text: inlineContent }] : []),
        ...outcome.result.contentBlocks
          .filter((block) => block.type === 'image')
          .map((block) => ({ ...block, source: { ...block.source } })),
      ]
    : undefined

  return {
    id: createId('message'),
    role: 'tool',
    toolCallId: outcome.call.id,
    toolName: outcome.call.name,
    content: inlineContent,
    ...(contentBlocks ? { contentBlocks } : {}),
    details: outcome.result.details,
    artifact,
    artifactError,
    ...(outcome.result.addedToolNames?.length
      ? { addedToolNames: outcome.result.addedToolNames.slice() }
      : {}),
    isError: outcome.isError,
    createdAt: Date.now(),
  }
}

/**
 * 把一批工具结果构造成 ToolResultMessage 并以 message_start/message_end 事件发出。
 * addedToolNames 会被规范化为"相对当前激活集合的真实增量"（去重、丢弃未知名）。
 */
export const emitToolResultMessages = async (
  runId: string,
  outcomes: ToolCallOutcome[],
  emit: AgentEventSink,
  maxInlineToolResultBytes: number,
  externalizeToolResult?: ToolResultExternalizer,
  activeNames?: ReadonlySet<string>,
): Promise<ToolResultMessage[]> => {
  const messages: ToolResultMessage[] = []
  for (let outcome of outcomes) {
    // Normalize addedToolNames into a true delta: drop names already active,
    // drop unknown names, drop duplicates. The discover tool already filters
    // by active set on its own; this is defense in depth for any tool that
    // returns addedToolNames (including future ones).
    const rawAdded = outcome.result.addedToolNames
    if (rawAdded && rawAdded.length > 0 && activeNames) {
      const seen = new Set<string>()
      const normalized: string[] = []
      for (const name of rawAdded) {
        if (activeNames.has(name)) continue
        if (seen.has(name)) continue
        seen.add(name)
        normalized.push(name)
      }
      if (normalized.length !== rawAdded.length) {
        outcome = {
          ...outcome,
          result: {
            ...outcome.result,
            addedToolNames: normalized.length > 0 ? normalized : undefined,
          },
        }
      }
    }
    const message = await createToolResultMessage(
      runId,
      outcome,
      maxInlineToolResultBytes,
      externalizeToolResult,
    )
    await emit({ type: 'message_start', runId, message })
    await emit({ type: 'message_end', runId, message })
    messages.push(message)
  }
  return messages
}

/**
 * 为"未执行/已跳过"的工具调用批量生成失败结果消息，
 * 维护"每个 tool_call 必须有对应 tool_result"的 Provider 上下文不变量。
 */
export const failToolCalls = async (
  calls: ToolCall[],
  reason: string,
  runId: string,
  emit: AgentEventSink,
  maxInlineToolResultBytes: number,
  externalizeToolResult: ToolResultExternalizer | undefined,
  activeNames: ReadonlySet<string>,
): Promise<ToolBatchResult> => {
  const outcomes: ToolCallOutcome[] = []
  for (const call of calls) {
    await emit({
      type: 'tool_execution_start',
      runId,
      toolCallId: call.id,
      toolName: call.name,
      arguments: call.arguments,
      approvalState: 'not_required',
      recoveryPolicy: 'never',
    })
    const result = createToolError(reason)
    await emit({
      type: 'tool_execution_end',
      runId,
      toolCallId: call.id,
      toolName: call.name,
      result,
      isError: true,
      approvalState: 'not_required',
    })
    outcomes.push({ call, result, isError: true })
  }
  return {
    messages: await emitToolResultMessages(
      runId,
      outcomes,
      emit,
      maxInlineToolResultBytes,
      externalizeToolResult,
      activeNames,
    ),
    allTerminate: false,
  }
}
