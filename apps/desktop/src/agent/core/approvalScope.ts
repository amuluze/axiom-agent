import type { AgentToolExecutionContext } from './types'

export interface ToolApprovalScope {
  sessionId: string
  runId: string
  toolCallId: string
}

export const toolApprovalScope = (
  context: Pick<AgentToolExecutionContext, 'sessionId' | 'runId' | 'toolCallId'>,
): ToolApprovalScope => ({
  sessionId: context.sessionId,
  runId: context.runId,
  toolCallId: context.toolCallId,
})
