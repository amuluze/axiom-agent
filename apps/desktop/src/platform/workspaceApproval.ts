import type { BeforeToolCallContext, JsonValue } from '@/agent/core/types'
import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './environment'

interface WorkspaceApprovalLeaseRequest {
  sessionId: string
  runId: string
  toolCallId: string
  toolName: string
  input: JsonValue
  confirmationMode: WorkspaceApprovalConfirmationMode
  workspacePath?: string
}

export type WorkspaceApprovalConfirmationMode =
  | 'interactive'
  | 'automatic'
  | 'sandboxSafe'
  /** SSH 远程执行的「会话内已授权主机」签发模式（Rust 校验权威授权表）。 */
  | 'sshSessionGranted'

const NATIVE_WORKSPACE_APPROVAL_TOOL_NAMES: Record<string, string> = {
  write: 'create_workspace_file',
  edit: 'edit_workspace_file',
  apply_changes: 'apply_workspace_changes',
  restore_trash: 'restore_workspace_trash',
  bash: 'run_workspace_command',
  ssh: 'run_ssh_command',
}

export const nativeWorkspaceApprovalToolName = (toolName: string): string =>
  NATIVE_WORKSPACE_APPROVAL_TOOL_NAMES[toolName] ?? toolName

/**
 * 把用户选择的 access-mode 同步到 Rust 权威状态。Rust 仅在模式为 automatic 时
 * 接受 automatic 租约（fail-closed）；浏览器开发模式静默降级。
 */
export const setWorkspaceApprovalMode = async (
  mode: WorkspaceApprovalConfirmationMode,
): Promise<void> => {
  if (!isTauriRuntime()) return
  await invoke('set_workspace_approval_mode', { mode })
}

export const requestWorkspaceApprovalLease = async (
  context: BeforeToolCallContext,
  confirmationMode: WorkspaceApprovalConfirmationMode,
  workspacePath?: string,
): Promise<string> => {
  if (!isTauriRuntime()) throw new Error('原生工作区审批仅在 Axiom 桌面应用中可用')
  const request: WorkspaceApprovalLeaseRequest = {
    sessionId: context.sessionId,
    runId: context.runId,
    toolCallId: context.toolCallId,
    toolName: nativeWorkspaceApprovalToolName(context.toolName),
    input: structuredClone(context.input),
    confirmationMode,
    ...(workspacePath ? { workspacePath } : {}),
  }
  return invoke<string>('request_workspace_approval_lease', { request })
}
