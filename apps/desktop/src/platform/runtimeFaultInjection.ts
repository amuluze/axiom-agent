import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './environment'
import type { AuthorizedWorkspace } from './workspace'
import type { RuntimeFaultCheckpoint } from '@/agent/runtime/AgentSession'

declare global {
  interface Window {
    __AXIOM_E2E_FAULT_CHECKPOINT__?: string
  }
}

/** E2E-only process checkpoint. Production builds return before invoking native code. */
export const runtimeFaultCheckpoint = async (checkpoint: RuntimeFaultCheckpoint): Promise<void> => {
  if (!isTauriRuntime() || window.__AXIOM_E2E_FAULT_CHECKPOINT__ !== checkpoint) return
  await invoke('e2e_runtime_fault_checkpoint', { checkpoint })
  throw new Error(`E2E runtime fault checkpoint did not terminate the process: ${checkpoint}`)
}

/** E2E 构建专属：登记并授权一个确实存在的目录（authorize_workspace 是恢复
 * 专用、只认注册表既有路径；自动化需要无人值守地为会话绑定工作区）。
 * 返回 canonical 化后的工作区摘要——调用方必须以它（而非原始入参路径）做
 * 后续匹配：macOS 的 /var → /private/var 符号链接会让裸路径对不上。 */
export const e2eRegisterWorkspace = async (path: string): Promise<AuthorizedWorkspace> => {
  return invoke<AuthorizedWorkspace>('e2e_register_workspace', { path })
}
