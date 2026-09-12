import { createId } from './id'
import type { AgentContext, AssistantMessage, AssistantMessageDiagnostic } from './types'
import { errorText } from './abort'

/**
 * 把运行时错误归一化为 AssistantMessageDiagnostic，便于挂在 assistant 消息上。
 * 仅提取 code（当其为字符串/数字时），其余字段按 Error 形态记录。
 */
export const diagnosticForError = (
  type: string,
  error: unknown,
): AssistantMessageDiagnostic => {
  const value = error instanceof Error ? error : undefined
  const code =
    value && 'code' in value
      ? (value as Error & { code?: unknown }).code
      : undefined
  return {
    type,
    timestamp: Date.now(),
    error: {
      name: value?.name,
      message: value?.message ?? String(error),
      stack: value?.stack,
      code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    },
  }
}

/** Agent 编排层失败时构造的 assistant 终态消息（无文本、无工具调用）。 */
export const createOrchestrationFailureMessage = (
  context: AgentContext,
  error: unknown,
  aborted: boolean,
): AssistantMessage => ({
  id: createId('message'),
  role: 'assistant',
  content: '',
  toolCalls: [],
  stopReason: aborted ? 'aborted' : 'error',
  provider: context.model.provider,
  model: context.model.model,
  createdAt: Date.now(),
  errorMessage: aborted ? 'Agent 运行已取消' : errorText(error),
  diagnostics: [diagnosticForError('agent-orchestration-error', error)],
})
