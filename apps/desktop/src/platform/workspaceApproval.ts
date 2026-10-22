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

/** 与 Rust `WorkspaceApprovalConfirmationMode` 对齐：原生确认退役后只剩两档
 * （标准模式单层卡片 / 完全访问自动签发）。 */
export type WorkspaceApprovalConfirmationMode = 'interactive' | 'automatic'

const NATIVE_WORKSPACE_APPROVAL_TOOL_NAMES: Record<string, string> = {
  write: 'create_workspace_file',
  edit: 'edit_workspace_file',
  apply_changes: 'apply_workspace_changes',
  restore_trash: 'restore_workspace_trash',
  bash: 'run_workspace_command',
  ssh: 'run_ssh_command',
  // design_import 经 create_workspace_file 落盘（已存在目标一律拒绝），租约必须按
  // 该原生命令口径绑定：与模型输入 { source, target } 不同，实际字节由编译产物
  // 决定（见该工具的 approvalLeaseInput）。
  design_import: 'create_workspace_file',
}

export const nativeWorkspaceApprovalToolName = (toolName: string): string =>
  NATIVE_WORKSPACE_APPROVAL_TOOL_NAMES[toolName] ?? toolName

export const setWorkspaceApprovalMode = async (
  sessionId: string,
  mode: WorkspaceApprovalConfirmationMode,
): Promise<void> => {
  if (!isTauriRuntime()) return
  await invoke('set_workspace_approval_mode', { sessionId, mode })
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
    // 绑定的是真实落盘口径的输入（不是模型输入）：工具声明了 approvalLeaseInput
    // 时用它，否则两者一致。写通道消费侧按同一口径重算 digest。
    input: structuredClone(context.approvalLeaseInput ?? context.input),
    confirmationMode,
    ...(workspacePath ? { workspacePath } : {}),
  }
  return invoke<string>('request_workspace_approval_lease', { request })
}
