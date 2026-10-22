import { invoke } from '@tauri-apps/api/core'
import type { AgentCapability } from '@/config/runtimePolicy'

/**
 * 会话授权快照：只剩代际与能力位。
 *
 * 历史：这里曾有会话级资源授权（web 读取 / 浏览器 / SSH 主机与命令 / 电脑窗口 /
 * VCS 凭据）的清单与定向撤销。那些资源先后随 C1 会话能力预设与原生确认退役，
 * Rust 侧 `SessionResource` 已整体删除，故这里同步收窄——不再有定向撤销，
 * `revoke` 只递增会话代际使该会话既有的审批租约失效。
 */
export interface SessionAuthorizationSnapshot {
  sessionId: string
  generation: number
  capabilities: AgentCapability[]
}

export type SessionAuthorizationRequest =
  | { action: 'snapshot'; sessionId: string }
  | { action: 'revoke'; sessionId: string }

export const sessionAuthorizationCommand = (
  request: SessionAuthorizationRequest,
): Promise<SessionAuthorizationSnapshot> => invoke('session_authorization_command', { request })

export const getSessionAuthorization = (sessionId: string): Promise<SessionAuthorizationSnapshot> =>
  sessionAuthorizationCommand({ action: 'snapshot', sessionId })

export const revokeSessionAuthorization = (
  sessionId: string,
): Promise<SessionAuthorizationSnapshot> => sessionAuthorizationCommand({ action: 'revoke', sessionId })

/**
 * 会话权限收口：held Automatic 模式与会话撤销代际在同一次 Rust 调用内落定。
 *
 * 停止会话是权限**降级**动作——降级失败若保留更高权限即 fail-open。把「撤销
 * 代际」与「降级模式」合成一条命令（而非两段 IPC），窗口从结构上消失。
 * 与归档/清空/删除共用同一个 Rust `retire_session_authority`。
 */
export const retireSessionAuthority = (sessionId: string): Promise<void> =>
  invoke('retire_session_authority_command', { sessionId })
