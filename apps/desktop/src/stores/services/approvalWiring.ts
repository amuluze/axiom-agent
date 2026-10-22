import {
  ApprovalCoordinator,
  buildAccessModeBeforeToolCall,
  evaluateAccessModeToolCall,
  type AccessMode,
} from '@/agent/approval/ApprovalCoordinator'
import type { BeforeToolCall } from '@/agent/core/types'
import { requestWorkspaceApprovalLease } from '@/platform/workspaceApproval'

/**
 * 审批装配（自 agentStore 抽出的 B2 切片）。
 *
 * store 只提供当前会话/工作区的读取原语；协调器、标准模式租约与完全访问自动
 * 租约的裁决顺序保持原样：标准模式一律交互式卡片，Automatic 先由 Rust 签发
 * Unrestricted，被拒后安全回落卡片。
 */

export interface ApprovalWiringDependencies {
  workspacePathOf: (sessionId: string) => string | undefined
  isWorkspaceAuthorized: (workspacePath: string) => boolean
  approvalTimeoutMs: () => number
  accessModeOf: (sessionId: string) => AccessMode
  onAutomaticFallback: (reason: string) => void
}

export interface ApprovalWiring {
  coordinator: ApprovalCoordinator
  createBeforeToolCall: () => BeforeToolCall
}

export const createApprovalWiring = (deps: ApprovalWiringDependencies): ApprovalWiring => {
  const coordinator = new ApprovalCoordinator((context) => {
    const workspacePath = deps.workspacePathOf(context.sessionId)
    // 绑定的工作区不在本进程授权集内时提前给出友好提示，避免落到 Rust 侧
    // 「was not previously authorized」类通用错误（审批失败语义模糊）。
    if (workspacePath && !deps.isWorkspaceAuthorized(workspacePath)) {
      throw new Error(`会话绑定的工作区「${workspacePath}」已撤销或未授权，无法执行需要审批的操作`)
    }
    return requestWorkspaceApprovalLease(context, 'interactive', workspacePath)
  }, () => deps.approvalTimeoutMs())

  return {
    coordinator,
    createBeforeToolCall: () => buildAccessModeBeforeToolCall(
      coordinator,
      (context) => evaluateAccessModeToolCall(
        context,
        deps.accessModeOf(context.sessionId),
        (automaticContext) => requestWorkspaceApprovalLease(
          automaticContext,
          'automatic',
          deps.workspacePathOf(automaticContext.sessionId),
        ),
      ),
      undefined,
      deps.onAutomaticFallback,
    ),
  }
}
