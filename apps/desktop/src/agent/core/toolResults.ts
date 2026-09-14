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
 * 单条工具结果消息的整体字节预算。message_end 是持久化屏障，Rust 侧
 * persist_session_message 对整个请求体有 2 MiB 硬上限——超限时写库失败会让 run
 * 失败关闭，而 assistant(tool_calls) 已先行落库，持久历史从此缺少对应 tool 消息，
 * 后续所有模型请求都会被 Provider 以 400（insufficient tool messages）拒绝。
 * contentBlocks 的图片（browser/computer 截图的 base64）不受 256 KiB 文本内联上限
 * 约束，是唯一能把单条消息顶破持久化上限的载荷，必须在此收口。取 1.5 MiB，
 * 为 Rust DTO 信封与 JSON 编码差异留足余量。
 */
const MAX_TOOL_RESULT_MESSAGE_BYTES = 1536 * 1024

const messageByteLength = (message: ToolResultMessage): number =>
  byteLength(JSON.stringify(message))

/**
 * 把消息压回整体预算内：从尾部丢弃图片 contentBlocks（保留靠前的），必要时兜底
 * 截断文本 content。返回被丢弃的图片数与估算字节数，供调用方追加省略说明。
 */
const shrinkToMessageBudget = (
  message: ToolResultMessage,
): { omittedImages: number; omittedBytes: number } => {
  let omittedImages = 0
  let omittedBytes = 0
  while (message.contentBlocks?.length && messageByteLength(message) > MAX_TOOL_RESULT_MESSAGE_BYTES) {
    const dropped = message.contentBlocks[message.contentBlocks.length - 1]
    if (!dropped) break
    message.contentBlocks = message.contentBlocks.slice(0, -1)
    if (message.contentBlocks.length === 0) delete message.contentBlocks
    omittedImages += 1
    omittedBytes += byteLength(JSON.stringify(dropped))
  }
  if (messageByteLength(message) > MAX_TOOL_RESULT_MESSAGE_BYTES) {
    message.content = truncateToBytes(message.content, MAX_TOOL_RESULT_MESSAGE_BYTES - 64 * 1024)
  }
  return { omittedImages, omittedBytes }
}

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

  const message: ToolResultMessage = {
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

  const { omittedImages, omittedBytes } = shrinkToMessageBudget(message)
  if (omittedImages > 0) {
    message.content = `${message.content}\n\n[单条消息超出字节预算，已省略尾部 ${omittedImages} 张图片（约 ${Math.ceil(omittedBytes / 1024)} KiB 的 base64 数据）；如需查看请让工具重新截图或缩小截图范围。]`
  }
  return message
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
