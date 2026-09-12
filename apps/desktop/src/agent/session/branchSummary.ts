import { createId } from '@/agent/core/id'
import { BRANCH_SUMMARY_CUSTOM_TYPE, defaultConvertToModelMessages } from '@/agent/core/messages'
import type {
  AgentMessage,
  JsonValue,
  ModelMessage,
  ModelRef,
  ModelRequest,
  ModelTransport,
} from '@/agent/core/types'
import {
  modelRequestByteLength,
  utf8ByteLength,
} from '@/agent/context/budget'
import { serializeConversationForCompaction, CHECKPOINT_HEADINGS, CHECKPOINT_RULES } from '@/agent/context/compaction'
import {
  resolveSummaryInstructions,
  type SummaryInstructionOptions,
} from '@/agent/context/summaryInstructions'
import {
  summaryHookCancelled,
  type SummaryRuntimeHooks,
} from '@/agent/runtime/summaryHooks'
import type { BranchSummarySource } from './branch'

const MAX_SUMMARY_OUTPUT_BYTES = 128 * 1024
const HARD_REQUEST_BYTES = 2 * 1024 * 1024

const BRANCH_SUMMARY_SYSTEM_PROMPT = `你是 Axiom 的分支摘要器。只总结已离开的会话分支，不要继续对话，不要调用工具。
必须使用以下结构：
${CHECKPOINT_HEADINGS}
${CHECKPOINT_RULES}
不得在摘要中包含 API Key、令牌、文件正文或其他秘密；只保留完成工作必需的路径与符号引用。`

const branchModelMessages = (messages: AgentMessage[]): ModelMessage[] => messages.flatMap((message) => {
  if (message.role !== 'custom' || message.customType === BRANCH_SUMMARY_CUSTOM_TYPE) {
    return defaultConvertToModelMessages([message])
  }
  return []
})

const branchFacts = (messages: AgentMessage[]): Pick<BranchSummarySource, 'readFiles' | 'modifiedFiles'> => {
  const readFiles = new Set<string>()
  const modifiedFiles = new Set<string>()
  for (const message of messages) {
    if (message.role === 'custom' && message.customType === BRANCH_SUMMARY_CUSTOM_TYPE
      && typeof message.data === 'object' && message.data && !Array.isArray(message.data)) {
      const data = message.data as Record<string, JsonValue>
      if (Array.isArray(data.readFiles)) {
        for (const path of data.readFiles) if (typeof path === 'string') readFiles.add(path)
      }
      if (Array.isArray(data.modifiedFiles)) {
        for (const path of data.modifiedFiles) if (typeof path === 'string') modifiedFiles.add(path)
      }
    }
    if (message.role !== 'tool' || message.isError || typeof message.details !== 'object'
      || !message.details || Array.isArray(message.details)) continue
    const details = message.details as Record<string, JsonValue>
    const path = typeof details.path === 'string' ? details.path : undefined
    if (!path) continue
    if (details.operation === 'created' || details.operation === 'edited') modifiedFiles.add(path)
    else if (message.toolName.includes('read')) readFiles.add(path)
  }
  for (const path of modifiedFiles) readFiles.delete(path)
  return {
    readFiles: Array.from(readFiles).sort(),
    modifiedFiles: Array.from(modifiedFiles).sort(),
  }
}

export interface GenerateBranchSummaryOptions extends SummaryInstructionOptions {
  sessionId: string
  messages: AgentMessage[]
  model: ModelRef
  transport: ModelTransport
  signal: AbortSignal
  hooks?: Pick<SummaryRuntimeHooks, 'beforeBranchSummary' | 'afterBranchSummary'>
}

export const generateBranchSummary = async ({
  sessionId,
  messages,
  model,
  transport,
  signal,
  customInstructions,
  replaceInstructions,
  hooks,
}: GenerateBranchSummaryOptions): Promise<BranchSummarySource> => {
  if (messages.length === 0) throw new Error('没有需要总结的已离开分支内容')
  const modelMessages = branchModelMessages(messages)
  if (modelMessages.length === 0) throw new Error('已离开分支中没有可供模型总结的内容')
  const beforeContext = {
    sessionId,
    messages: structuredClone(messages),
    model: structuredClone(model),
    summaryInstructions: { customInstructions, replaceInstructions },
    signal,
  }
  const hookResult = await hooks?.beforeBranchSummary?.(beforeContext)
  if (hookResult?.cancel) throw summaryHookCancelled('branch-summary')
  const effectiveInstructions: SummaryInstructionOptions = {
    customInstructions: hookResult?.customInstructions !== undefined
      ? hookResult.customInstructions
      : customInstructions,
    replaceInstructions: hookResult?.replaceInstructions !== undefined
      ? hookResult.replaceInstructions
      : replaceInstructions,
  }
  const replacement = hookResult?.replacement?.content.trim()
  if (hookResult?.replacement && !replacement) throw new Error('Branch Summary 替代摘要不能为空')
  if (replacement && utf8ByteLength(replacement) > MAX_SUMMARY_OUTPUT_BYTES) {
    throw new Error('Branch Summary 替代摘要超过 128 KiB 安全上限')
  }

  let summary = replacement ?? ''
  if (!replacement) {
    const conversation = serializeConversationForCompaction(modelMessages)
    const content = [
      '<abandoned-branch>',
      conversation,
      '</abandoned-branch>',
      resolveSummaryInstructions(
        '请生成结构化分支摘要，使 Agent 在新的分支上保留已离开探索中的有效结论。',
        effectiveInstructions,
        true,
      ),
    ].join('\n\n')
    const request: ModelRequest = {
      sessionId,
      runId: createId('branch-summary'),
      systemPrompt: BRANCH_SUMMARY_SYSTEM_PROMPT,
      model,
      messages: [{
        id: createId('message'),
        role: 'user',
        content,
        createdAt: Date.now(),
      }],
      tools: [],
      maxOutputTokens: Math.min(2_048, model.maxOutputTokens ?? 2_048),
    }
    if (modelRequestByteLength(request, transport) > HARD_REQUEST_BYTES) {
      throw new Error('分支摘要请求超过 Rust 2 MiB 硬上限')
    }

    let output = ''
    let done = false
    for await (const event of transport.stream(request, signal)) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      if (event.type === 'text_delta') {
        output += event.delta
        if (utf8ByteLength(output) > MAX_SUMMARY_OUTPUT_BYTES) {
          throw new Error('分支摘要输出超过 128 KiB 安全上限')
        }
      } else if (event.type === 'tool_call_start') {
        throw new Error('分支摘要模型尝试调用工具')
      } else if (event.type === 'error') {
        throw new Error(`分支摘要失败：${event.message}`)
      } else if (event.type === 'done') {
        done = true
      }
    }
    if (!done) throw new Error('分支摘要模型流未正常结束')
    summary = output.trim()
    if (!summary) throw new Error('分支摘要为空')
  }
  const facts = branchFacts(messages)
  const result = {
    content: summary,
    sourceFromMessageId: messages[0].id,
    sourceThroughMessageId: messages[messages.length - 1].id,
    ...facts,
  }
  await hooks?.afterBranchSummary?.({
    ...beforeContext,
    summaryInstructions: effectiveInstructions,
    result: structuredClone(result),
    replaced: Boolean(replacement),
  })
  return result
}
