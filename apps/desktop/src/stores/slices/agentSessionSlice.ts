import type {
  AgentMessage,
  AgentRunEndReason,
  AssistantMessage,
  ImageContentBlock,
} from '@/agent/core/types'
import type { PendingToolApproval } from '@/agent/approval/ApprovalCoordinator'
import type { ContextBudgetUsage, ContextCheckpoint } from '@/agent/context/types'
import type { SummaryInstructionOptions } from '@/agent/context/summaryInstructions'
import type { QueuedMessageSnapshot } from '@/agent/runtime/AgentSession'
import type {
  QueueAcceptance,
  QueueMoveTarget,
  QueueMutationResult,
} from '@/agent/runtime/queueContracts'
import type { ActiveToolInfo } from '../runtimeCaches'
import {
  clear as clearAction,
  clearQueuedMessages as clearQueuedMessagesAction,
  compactContext as compactContextAction,
  continueConversation as continueConversationAction,
  deleteQueuedMessage as deleteQueuedMessageAction,
  discardRecoveredMessage as discardRecoveredMessageAction,
  editQueuedMessage as editQueuedMessageAction,
  editUserMessage as editUserMessageAction,
  moveQueuedMessage as moveQueuedMessageAction,
  promoteQueuedMessage as promoteQueuedMessageAction,
  queueFollowUp as queueFollowUpAction,
  queueNextTurn as queueNextTurnAction,
  queueSteering as queueSteeringAction,
  restoreQueuedMessage as restoreQueuedMessageAction,
  retryAssistant as retryAssistantAction,
  retryFailedAssistant as retryFailedAssistantAction,
  send as sendAction,
  sendQueuedNow as sendQueuedNowAction,
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
  /** sendQueuedNow 已接受、等待 turn 边界注入的队列项 id（运行中武装，消费/作废即清）。 */
  armedQueueMessageId: string | null
  /** 每个会话的待发送条数（含后台会话，随事件与后台投递更新）：侧栏排队徽标。 */
  sessionQueueCounts: Record<string, number>
  compactionRunning: boolean
  sessionBusy: boolean
  branchSummaryRunning: boolean
  contextUsage: ContextBudgetUsage | null
  contextCheckpoint: ContextCheckpoint | null
  send: (content: string, images?: ImageContentBlock[]) => Promise<void>
  queueSteering: (content: string, images?: ImageContentBlock[]) => Promise<QueueAcceptance>
  queueFollowUp: (content: string, images?: ImageContentBlock[]) => Promise<QueueAcceptance>
  queueNextTurn: (content: string, images?: ImageContentBlock[]) => Promise<QueueAcceptance>
  /** 原位改写队列项（保留图片与队列位置）。 */
  editQueuedMessage: (
    messageId: string,
    content: string,
    images?: ImageContentBlock[],
  ) => Promise<QueueMutationResult>
  /** 队列内重排或跨队列提升（placement 相对显示序）。 */
  moveQueuedMessage: (messageId: string, target: QueueMoveTarget) => Promise<QueueMutationResult>
  /** 提升为引导：移到 steering 队首，下一个 turn 边界注入。 */
  promoteQueuedMessage: (messageId: string) => Promise<QueueMutationResult>
  deleteQueuedMessage: (messageId: string) => Promise<QueueMutationResult>
  /** 立即发送一条队列项：运行中注入当前 run，空闲时取出该条走完整发送链路。 */
  sendQueuedNow: (messageId?: string) => Promise<QueueAcceptance>
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
  /** 编辑已发送的用户消息并重发（从该消息之前的分支边界重新开始）。
   *  images 是原消息的图片块，重发时原样保留。 */
  editUserMessage: (messageId: string, content: string, images?: ImageContentBlock[]) => Promise<boolean>
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
  armedQueueMessageId: null,
  sessionQueueCounts: {},
  compactionRunning: false,
  sessionBusy: false,
  branchSummaryRunning: false,
  contextUsage: null,
  contextCheckpoint: null,
  send: (content, images) => sendAction(set, get, deps, content, images),
  queueSteering: (content, images) => queueSteeringAction(set, get, deps.getSession(), content, images),
  queueFollowUp: (content, images) => queueFollowUpAction(set, get, deps.getSession(), content, images),
  queueNextTurn: (content, images) => queueNextTurnAction(set, get, deps.getSession(), content, images),
  editQueuedMessage: (messageId, content, images) =>
    editQueuedMessageAction(set, get, deps, messageId, content, images),
  moveQueuedMessage: (messageId, target) => moveQueuedMessageAction(set, get, deps, messageId, target),
  promoteQueuedMessage: (messageId) => promoteQueuedMessageAction(set, get, deps, messageId),
  deleteQueuedMessage: (messageId) => deleteQueuedMessageAction(set, get, deps, messageId),
  sendQueuedNow: (messageId) => sendQueuedNowAction(set, get, deps, messageId),
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
  editUserMessage: (messageId, content, images) => editUserMessageAction(set, get, deps, messageId, content, images),
  compactContext: (summaryInstructions) => compactContextAction(set, get, deps, summaryInstructions),
})
