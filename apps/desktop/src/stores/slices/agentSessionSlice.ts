import type {
  AgentMessage,
  AgentRunEndReason,
  AssistantMessage,
} from '@/agent/core/types'
import type { PendingToolApproval } from '@/agent/approval/ApprovalCoordinator'
import type { ContextBudgetUsage, ContextCheckpoint } from '@/agent/context/types'
import type { SummaryInstructionOptions } from '@/agent/context/summaryInstructions'
import type { QueuedMessageSnapshot } from '@/agent/runtime/AgentSession'
import type { ActiveToolInfo } from '../runtimeCaches'
import {
  clear as clearAction,
  clearQueuedMessages as clearQueuedMessagesAction,
  compactContext as compactContextAction,
  continueConversation as continueConversationAction,
  discardRecoveredMessage as discardRecoveredMessageAction,
  editUserMessage as editUserMessageAction,
  queueFollowUp as queueFollowUpAction,
  queueNextTurn as queueNextTurnAction,
  queueSteering as queueSteeringAction,
  restoreQueuedMessage as restoreQueuedMessageAction,
  retryAssistant as retryAssistantAction,
  retryFailedAssistant as retryFailedAssistantAction,
  send as sendAction,
  type AgentGet,
  type AgentSet,
  type StoreRuntimeDeps,
} from '../sessionActions'
import {
  branchFromMessage as branchFromMessageAction,
  cancelBranchSummary as cancelBranchSummaryAction,
} from '../sessionManagementActions'

/**
 * 会话运行时切片：消息流、运行状态、审批挂起、队列与压缩状态。
 * 方法全部转发到 sessionActions / sessionManagementActions 的显式 action
 * 函数，经 StoreRuntimeDeps 取用模块级单例（session / repository 等）。
 */
export interface AgentSessionSlice {
  messages: AgentMessage[]
  running: boolean
  activeTools: Record<string, ActiveToolInfo>
  pendingApproval: PendingToolApproval | null
  /** 有审批待决的会话 id 列表（含激活会话）：侧栏据此标记「等待审批」。 */
  awaitingApprovalSessionIds: string[]
  /** 后台（非激活）会话的待决审批，按入队顺序：多会话并行时在收件箱直接
   *  放行/拒绝，不必切换会话（respond 按 toolCallId 全局定位）。 */
  backgroundApprovals: PendingToolApproval[]
  endReason: AgentRunEndReason | null
  error: string | null
  streamingDraft: AssistantMessage | null
  queuedMessages: QueuedMessageSnapshot[]
  recoveredQueuedMessages: QueuedMessageSnapshot[]
  pendingSteeringCount: number
  pendingFollowUpCount: number
  pendingNextTurnCount: number
  compactionRunning: boolean
  sessionBusy: boolean
  branchSummaryRunning: boolean
  contextUsage: ContextBudgetUsage | null
  contextCheckpoint: ContextCheckpoint | null
  send: (content: string) => Promise<void>
  queueSteering: (content: string) => Promise<boolean>
  queueFollowUp: (content: string) => Promise<boolean>
  queueNextTurn: (content: string) => Promise<boolean>
  clearQueuedMessages: () => Promise<void>
  restoreQueuedMessage: (messageId: string) => Promise<QueuedMessageSnapshot | null>
  discardRecoveredMessage: (messageId: string) => Promise<void>
  continueConversation: () => Promise<void>
  clear: () => Promise<void>
  branchFromMessage: (
    messageId: string,
    summarize?: boolean,
    summaryInstructions?: SummaryInstructionOptions,
  ) => Promise<boolean>
  cancelBranchSummary: () => void
  retryFailedAssistant: (messageId: string) => Promise<boolean>
  retryAssistant: (messageId: string) => Promise<boolean>
  /** 编辑已发送的用户消息并重发（从该消息之前的分支边界重新开始）。 */
  editUserMessage: (messageId: string, content: string) => Promise<boolean>
  compactContext: (summaryInstructions?: SummaryInstructionOptions) => Promise<boolean>
}

export const createAgentSessionSlice = (
  set: AgentSet,
  get: AgentGet,
  deps: StoreRuntimeDeps,
): AgentSessionSlice => ({
  messages: [],
  running: false,
  activeTools: {},
  pendingApproval: null,
  awaitingApprovalSessionIds: [],
  backgroundApprovals: [],
  endReason: null,
  error: null,
  streamingDraft: null,
  queuedMessages: [],
  recoveredQueuedMessages: [],
  pendingSteeringCount: 0,
  pendingFollowUpCount: 0,
  pendingNextTurnCount: 0,
  compactionRunning: false,
  sessionBusy: false,
  branchSummaryRunning: false,
  contextUsage: null,
  contextCheckpoint: null,
  send: (content) => sendAction(set, get, deps, content),
  queueSteering: (content) => queueSteeringAction(set, get, deps.getSession(), content),
  queueFollowUp: (content) => queueFollowUpAction(set, get, deps.getSession(), content),
  queueNextTurn: (content) => queueNextTurnAction(set, get, deps.getSession(), content),
  clearQueuedMessages: () => clearQueuedMessagesAction(set, get, deps),
  restoreQueuedMessage: (messageId) => restoreQueuedMessageAction(set, get, deps, messageId),
  discardRecoveredMessage: (messageId) => discardRecoveredMessageAction(set, get, deps, messageId),
  continueConversation: () => continueConversationAction(set, get, deps),
  clear: () => clearAction(set, get, deps),
  branchFromMessage: (messageId, summarize = false, summaryInstructions) =>
    branchFromMessageAction(set, get, deps, messageId, summarize, summaryInstructions),
  cancelBranchSummary: () => cancelBranchSummaryAction(set, get, deps),
  retryFailedAssistant: (messageId) => retryFailedAssistantAction(set, get, deps, messageId),
  retryAssistant: (messageId) => retryAssistantAction(set, get, deps, messageId),
  editUserMessage: (messageId, content) => editUserMessageAction(set, get, deps, messageId, content),
  compactContext: (summaryInstructions) => compactContextAction(set, get, deps, summaryInstructions),
})
