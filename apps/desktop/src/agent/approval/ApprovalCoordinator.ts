import type {
  BeforeToolCall,
  BeforeToolCallContext,
  BeforeToolCallResult,
  ToolApprovalPresentation,
} from '@/agent/core/types'

export type AccessMode = 'standard' | 'no-approval'

export interface PendingToolApproval {
  sessionId: string
  runId: string
  toolCallId: string
  toolName: string
  toolLabel: string
  presentation: ToolApprovalPresentation
}

interface PendingRequest {
  view: PendingToolApproval
  context: BeforeToolCallContext
  resolve: (result: BeforeToolCallResult) => void
  removeAbortListener: () => void
  settling: boolean
}

export interface AccessModeDecision {
  decision: 'approved' | 'pending'
  approvalLease?: string
  auditNote?: string
}

export type AccessModeEvaluator = (context: BeforeToolCallContext) => Promise<AccessModeDecision>

export type AutomaticApprovalLeaseIssuer = (context: BeforeToolCallContext) => Promise<string>

type ApprovalListener = (pending: PendingToolApproval | null) => void

export type ApprovalLeaseIssuer = (context: BeforeToolCallContext) => Promise<string>

/// 审批等待超时上界：对齐 run 级默认 maxDurationMs（15 分钟），
/// 保证即使某会话的审批卡片被忽略且 run 未设时限，审批也会自动拒绝，
/// 不会无限阻塞其他会话（ApprovalCoordinator 为全局单例、队列跨会话共享）。
const DEFAULT_APPROVAL_TIMEOUT_MS = 15 * 60 * 1000

export class ApprovalCoordinator {
  private readonly pending: PendingRequest[] = []
  private readonly listeners = new Set<ApprovalListener>()

  constructor(
    private readonly issueLease?: ApprovalLeaseIssuer,
    private readonly approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
  ) {}

  readonly request: BeforeToolCall = (context) => {
    if (!context.requiresApproval) return { decision: 'approved' }
    return new Promise<BeforeToolCallResult>((resolve) => {
      let request: PendingRequest
      let autoDenyTimer: ReturnType<typeof setTimeout> | undefined
      const abort = () => {
        this.settleRequest(request, { decision: 'denied', reason: 'Agent 运行已取消' })
      }
      const autoDeny = () => {
        this.settleRequest(request, { decision: 'denied', reason: '审批等待超时，已自动拒绝' })
      }
      context.signal.addEventListener('abort', abort, { once: true })
      autoDenyTimer = setTimeout(autoDeny, this.approvalTimeoutMs)
      request = {
        view: this.toPendingView(context),
        context,
        resolve,
        removeAbortListener: () => {
          context.signal.removeEventListener('abort', abort)
          if (autoDenyTimer) clearTimeout(autoDenyTimer)
        },
        settling: false,
      }
      this.pending.push(request)
      // 每次入队都通知：消费者按会话分组重查自己的队首（getPendingForSession），
      // 即使全局队首未变，激活会话的 pending 集也可能从无到有——只在队首变化时
      // 通知会让激活会话的审批卡片不出现，run 静默阻塞到超时自动拒绝。
      this.notify()
      if (context.signal.aborted) abort()
    })
  }

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener)
    listener(this.pending[0]?.view ?? null)
    return () => this.listeners.delete(listener)
  }

  /**
   * 当前会话的队首审批视图（无则 null）。多会话并行时 UI 按激活会话分组展示，
   * 避免后台会话的审批抢占前台卡片；respond 仍按 toolCallId 全局定位，跨会话安全。
   */
  getPendingForSession(sessionId: string): PendingToolApproval | null {
    return this.pending.find((request) => request.view.sessionId === sessionId)?.view ?? null
  }

  /** 有审批待决的会话 id 列表（按当前队列顺序去重），供侧栏标记「等待审批」。 */
  pendingApprovalSessionIds(): string[] {
    const ids: string[] = []
    for (const request of this.pending) {
      const sessionId = request.view.sessionId
      if (!ids.includes(sessionId)) ids.push(sessionId)
    }
    return ids
  }

  /** 全部待决审批视图（按入队顺序）。多会话并行时供收件箱展示非激活会话
   *  的审批——store 过滤掉激活会话后即为「后台会话审批」列表。 */
  pendingViews(): PendingToolApproval[] {
    return this.pending.map((request) => request.view)
  }

  async respond(toolCallId: string, decision: 'approved' | 'denied'): Promise<boolean> {
    const pending = this.pending.find((request) => request.view.toolCallId === toolCallId)
    if (!pending || pending.view.toolCallId !== toolCallId || pending.settling) return false
    if (decision === 'denied') {
      this.settleRequest(pending, { decision, reason: '用户拒绝了本次工具调用' })
      return true
    }
    pending.settling = true
    try {
      const approvalLease = this.issueLease ? await this.issueLease(pending.context) : undefined
      if (!this.pending.includes(pending)) return false
      this.settleRequest(pending, { decision, ...(approvalLease ? { approvalLease } : {}) })
      return true
    } catch (error) {
      if (!this.pending.includes(pending)) return false
      this.settleRequest(pending, {
        decision: 'denied',
        reason: `原生审批失败：${error instanceof Error ? error.message : String(error)}`,
      })
      return false
    }
  }

  cancel(reason: string): void {
    for (const pending of [...this.pending]) {
      this.settleRequest(pending, { decision: 'denied', reason })
    }
  }

  private toPendingView(context: BeforeToolCallContext): PendingToolApproval {
    return {
      sessionId: context.sessionId,
      runId: context.runId,
      toolCallId: context.toolCallId,
      toolName: context.toolName,
      toolLabel: context.toolLabel,
      presentation: context.presentation,
    }
  }

  private settleRequest(pending: PendingRequest, result: BeforeToolCallResult): void {
    const index = this.pending.indexOf(pending)
    if (index < 0) return
    this.pending.splice(index, 1)
    pending.removeAbortListener()
    pending.resolve(result)
    // 同上：非队首结算也要通知，否则已展示的审批卡片会残留已结算的 stale 视图。
    this.notify()
  }

  private notify(): void {
    const view = this.pending[0]?.view ?? null
    for (const listener of this.listeners) listener(view)
  }
}

export const evaluateAccessModeToolCall = async (
  context: BeforeToolCallContext,
  mode: AccessMode,
  issueAutomaticLease: AutomaticApprovalLeaseIssuer,
): Promise<AccessModeDecision> => {
  if (mode === 'standard') return { decision: 'pending' }
  try {
    const approvalLease = await issueAutomaticLease(context)
    return {
      decision: 'approved',
      approvalLease,
      auditNote: `免审批放行 ${context.toolName}`,
    }
  } catch {
    return { decision: 'pending' }
  }
}

export const buildAccessModeBeforeToolCall = (
  coordinator: ApprovalCoordinator,
  evaluator: AccessModeEvaluator,
  onAuditNote?: (note: string) => void,
): BeforeToolCall => async (context) => {
  if (!context.requiresApproval) return { decision: 'approved' }
  const evaluation = await evaluator(context)
  if (evaluation.decision === 'approved') {
    if (evaluation.auditNote) onAuditNote?.(evaluation.auditNote)
    const result: BeforeToolCallResult = { decision: 'approved' }
    if (evaluation.approvalLease) result.approvalLease = evaluation.approvalLease
    return result
  }
  return await coordinator.request(context)
}
