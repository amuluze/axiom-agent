import { isTauriRuntime } from '@/platform/environment'
import { onSshAgentGrantEvent, sshAgentCommand } from '@/platform/sshAgent'

/**
 * SSH 远程执行的「会话内允许主机」TS 镜像（Rust `SshAgentState` 权威授权表的
 * 前端投影）：仅用于 before-tool-call 预检免弹审批卡。lease 签发时 Rust 仍校验
 * 自己的授权表——镜像被伪造/丢失时最多多弹一次卡（Rust 对已授权主机的
 * Interactive 签发会静默放行），不构成安全边界。授权随进程存亡：Rust 侧为
 * 内存表、重启清空，本镜像不做跨重启补水。
 */

const sessionGrants = new Map<string, Set<string>>()
let subscribed = false

/** 订阅 Rust 授权事件（应用装配时调用一次；订阅失败下次调用重试）。 */
export const ensureSshApprovalGrantMirror = (): void => {
  if (subscribed || !isTauriRuntime()) return
  void onSshAgentGrantEvent((event) => {
    const hosts = sessionGrants.get(event.sessionId) ?? new Set<string>()
    hosts.add(event.host)
    sessionGrants.set(event.sessionId, hosts)
  }).then(() => {
    subscribed = true
  }).catch(() => {
    // 非 Tauri 环境订阅失败：保持未订阅，下次调用重试。
  })
}

/** 预检：该会话是否已在原生对话框授权过该主机。 */
export const sshHostGrantedForSession = (sessionId: string, host: string): boolean =>
  sessionGrants.get(sessionId)?.has(host) ?? false

/** 会话删除时回收：清本地镜像并通知 Rust 清权威表（best-effort，不阻断删除）。 */
export const forgetSshApprovalGrants = (sessionId: string): void => {
  sessionGrants.delete(sessionId)
  if (!isTauriRuntime()) return
  void sshAgentCommand({ action: 'revokeSessionGrants', sessionId }).catch(() => undefined)
}
