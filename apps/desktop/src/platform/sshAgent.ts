import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type { UnlistenFn } from '@tauri-apps/api/event'

/**
 * Agent 侧 SSH 远程执行通道（P0：读取 SSH 配置 + 远程 exec）。
 *
 * 契约与 `src-tauri/src/ssh_agent.rs` 的 `SshAgentCommandRequest` /
 * `SshAgentCommandResponse` 逐字镜像（serde tag=action/type + camelCase 字段），
 * 改任一侧必须同步。安全边界全部由 Rust 权威强制：主机门禁（只接受 config
 * 别名/注册表 hostId）、lease 消费绑定 {host, command}、首连原生三选一审批与
 * 会话授权表（本层持有的授权镜像仅用于免卡片，签发时 Rust 仍校验权威表）。
 */

/** 可连接主机条目（config 别名或 Axiom 主机注册表条目）。 */
export interface SshAgentHost {
  /** exec 的 `host` 入参：config 别名或注册表 hostId。 */
  host: string
  source: 'config' | 'registry'
  name?: string | null
  hostname?: string | null
  username?: string | null
  port?: number | null
}

export type SshAgentCommandRequest =
  | { action: 'listHosts' }
  | {
      action: 'exec'
      sessionId: string
      host: string
      command: string
      timeoutMs?: number
    }
  | { action: 'sessionGrants'; sessionId: string }
  | { action: 'revokeSessionGrants'; sessionId: string }

export interface SshAgentExecResult {
  exitCode?: number | null
  stdout: string
  stderr: string
  truncated: boolean
  durationMs: number
  timedOut: boolean
}

export type SshAgentCommandResponse =
  | { type: 'hosts'; hosts: SshAgentHost[] }
  | ({ type: 'exec' } & SshAgentExecResult)
  | { type: 'grants'; hosts: string[] }
  | { type: 'ack' }

/** 会话授权事件（Rust → 前端，`axiom:ssh-agent-grant`）：原生对话框「本会话内
 * 允许该主机」点击后广播，前端据此更新免卡片镜像。 */
export interface SshAgentGrantEvent {
  sessionId: string
  host: string
}

export const SSH_AGENT_GRANT_EVENT = 'axiom:ssh-agent-grant'

export const sshAgentCommand = async (
  request: SshAgentCommandRequest,
  options?: { approvalLease?: string; workspacePath?: string },
): Promise<SshAgentCommandResponse> => {
  return invoke<SshAgentCommandResponse>('ssh_agent_command', {
    request,
    approvalLease: options?.approvalLease,
    workspacePath: options?.workspacePath,
  })
}

/** 订阅会话授权事件（免卡片镜像的更新源），返回取消订阅函数。 */
export const onSshAgentGrantEvent = async (
  handler: (event: SshAgentGrantEvent) => void,
): Promise<UnlistenFn> => {
  return listen<SshAgentGrantEvent>(SSH_AGENT_GRANT_EVENT, (event) => handler(event.payload))
}
