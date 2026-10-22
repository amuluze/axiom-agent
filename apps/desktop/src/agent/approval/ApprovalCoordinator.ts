import type {
  BeforeToolCall,
  BeforeToolCallContext,
  BeforeToolCallResult,
  ToolApprovalPresentation,
} from '@/agent/core/types'

export type AccessMode = 'standard' | 'no-approval'

/**
 * 审批确认模式：标准模式一律只走审批卡片（单层），完全访问走自动签发。
 *
 * 历史上这里按风险分档决定是否需要第二次（macOS 原生对话框）确认；原生确认已
 * 整体退役（2026-10-08 决策：标准模式全档单层），沙箱档位改由 Rust 侧
 * `validate_command_confirmation` 权威分类（Automatic 恒为无沙箱档）。渲染进程
 * 只需区分「是否请求自动签发」，不再参与层数与档位判定。
 *
 * 因此不再导出 `confirmationDepthFor`：调用方直接传字面量 `'interactive'`。
 */

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
  fallbackReason?: string
}

export type AccessModeEvaluator = (context: BeforeToolCallContext) => Promise<AccessModeDecision>

export type AutomaticApprovalLeaseIssuer = (context: BeforeToolCallContext) => Promise<string>

type ApprovalListener = (pending: PendingToolApproval | null) => void

export type ApprovalLeaseIssuer = (context: BeforeToolCallContext) => Promise<string>

/// 审批等待超时：默认 2 分钟、可经「运行预算」配置（30 秒 ~ 15 分钟，上限对齐
/// run 级默认 maxDurationMs）。保证即使某会话的审批卡片被忽略且 run 未设时限，
/// 审批也会自动拒绝，不会无限阻塞其他会话（ApprovalCoordinator 为全局单例、
/// 队列跨会话共享）。
export const DEFAULT_APPROVAL_TIMEOUT_MS = 2 * 60 * 1000
export const MIN_APPROVAL_TIMEOUT_MS = 30 * 1000
export const MAX_APPROVAL_TIMEOUT_MS = 15 * 60 * 1000

/// 超时来源：常量或取值函数（取值函数让运行中修改设置对下一个审批立即生效）。
export type ApprovalTimeoutSource = number | (() => number)

export class ApprovalCoordinator {
  private readonly pending: PendingRequest[] = []
  private readonly listeners = new Set<ApprovalListener>()

  constructor(
    private readonly issueLease?: ApprovalLeaseIssuer,
    private readonly approvalTimeoutMs: ApprovalTimeoutSource = DEFAULT_APPROVAL_TIMEOUT_MS,
  ) {}

  private resolveApprovalTimeoutMs(): number {
    const value = typeof this.approvalTimeoutMs === 'function'
      ? this.approvalTimeoutMs()
      : this.approvalTimeoutMs
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_APPROVAL_TIMEOUT_MS
  }

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
      autoDenyTimer = setTimeout(autoDeny, this.resolveApprovalTimeoutMs())
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
      this.settleRequest(pending, {
        decision,
        approvalSource: 'interactive',
        ...(approvalLease ? { approvalLease } : {}),
      })
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

  /**
   * 撤回指定会话的全部待决审批。
   *
   * 权限降级时必须调用：已入队的卡片是按降级**前**的权限状态排队的，用户点
   * 「允许一次」会走 interactive 签发路径——若 native 侧此刻仍是 Automatic，
   * 该卡片将被授予 `Unrestricted` 租约（撤销工作区后放行工作区外写入即由此而来）。
   * 按会话撤回而非全局 cancel：多会话并行时不得连带拒绝其它会话的合法审批。
   */
  cancelForSession(sessionId: string, reason: string): number {
    const targets = this.pending.filter((request) => request.view.sessionId === sessionId)
    for (const pending of targets) {
      this.settleRequest(pending, { decision: 'denied', reason })
    }
    return targets.length
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

/**
 * 完全访问（no-approval）评估：尝试直接签发自动租约；被 Rust 拒绝（held 模式
 * 未开启或生命周期已撤销）时回落逐次卡片。Automatic 租约同时授予写工具的
 * unrestricted scope 与 bash 的无沙箱执行档，拒绝权始终在 Rust 签发侧。
 */
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
  } catch (error) {
    return {
      decision: 'pending',
      fallbackReason: error instanceof Error ? error.message : String(error),
    }
  }
}

export const buildAccessModeBeforeToolCall = (
  coordinator: ApprovalCoordinator,
  evaluator: AccessModeEvaluator,
  onAuditNote?: (note: string) => void,
  onAutomaticFallback?: (reason: string) => void,
): BeforeToolCall => async (context) => {
  if (!context.requiresApproval) return { decision: 'approved' }
  const evaluation = await evaluator(context)
  if (evaluation.decision === 'approved') {
    if (evaluation.auditNote) onAuditNote?.(evaluation.auditNote)
    const result: BeforeToolCallResult = { decision: 'approved' }
    result.approvalSource = 'automatic'
    if (evaluation.approvalLease) result.approvalLease = evaluation.approvalLease
    return result
  }
  if (evaluation.fallbackReason) onAutomaticFallback?.(evaluation.fallbackReason)
  return await coordinator.request(context)
}
