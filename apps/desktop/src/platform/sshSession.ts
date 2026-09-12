//! SSH 主机管理与远程终端命令通道（P0 主机 CRUD + P1 会话引擎 + P2 文件上传）。
//!
//! 契约与 `src-tauri/src/ssh.rs` 的 `SshCommandRequest` / `SshCommandResponse`
//! 及 `src-tauri/src/ssh_session.rs` 的 `SshSessionEvent` / `SshUploadEvent`
//! 逐字镜像（serde tag=action/type/phase + rename_all_fields），改任一侧必须
//! 同步。主机配置由 Rust 独占持久化（~/.axiom/ssh/hosts.json），本层只传结构
//! 化条目、不接触文件路径与凭据；上传本地路径由 Rust 原生选择器决定，stdin
//! 写入经 Rust 原生 keyDown 手势门校验。

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { decodeBase64ToBytes } from './base64'

export type { UnlistenFn } from '@tauri-apps/api/event'

/** SSH 主机条目（与 Rust `SshHostEntry` 逐字镜像）。 */
export interface SshHostEntry {
  id: string
  name: string
  hostname: string
  port: number
  username: string
  createdAt: number
  /** 已托管密码的 secret 引用（WebView 只见引用不见明文）；旧条目缺省。 */
  secretId?: string
  /** 本地私钥文件绝对路径（可选，非密）；连接时经 ssh `-i` 显式优先。旧条目缺省。 */
  privateKeyPath?: string
}

/** 保存主机的字段输入；`id` 缺省表示新增，命中既有条目则为更新。
 * `password` 缺省 = 不改动已托管密码；'' = 清除；非空 = 保存/替换。
 * `privateKeyPath` 缺省 = 不改动；'' = 清除；非空 = 设置（Rust 侧校验绝对路径）。 */
export interface SshHostDraft {
  name: string
  hostname: string
  port: number
  username: string
  password?: string
  privateKeyPath?: string
}

export type SshCommandRequest =
  | { action: 'listHosts' }
  | { action: 'saveHost'; id?: string | null; name: string; hostname: string; port: number; username: string; password?: string; privateKeyPath?: string }
  | { action: 'deleteHost'; id: string }
  | { action: 'openSession'; hostId: string; cols: number; rows: number }
  | { action: 'writeSession'; hostId: string; data: string }
  | { action: 'resizeSession'; hostId: string; cols: number; rows: number }
  | { action: 'closeSession'; hostId: string }
  | { action: 'uploadFile'; hostId: string; remoteDir: string }
  | { action: 'resumeUpload'; hostId: string }
  | { action: 'cancelUpload'; hostId: string }
  | { action: 'listFiles'; hostId: string; path: string }
  | { action: 'makeDir'; hostId: string; path: string }
  | { action: 'uploadFolder'; hostId: string; remoteDir: string }
  | { action: 'listSessions' }

export type SshCommandResponse =
  | { type: 'hosts'; hosts: SshHostEntry[] }
  | { type: 'ack' }
  | { type: 'sessions'; sessions: SshSessionInfo[] }
  | { type: 'files'; hostId: string; path: string; entries: RemoteDirEntry[]; truncated: boolean }

/** 活跃会话条目（与 Rust `SshSessionInfo` 逐字镜像）。 */
export interface SshSessionInfo {
  hostId: string
}

/** 远程目录条目（SFTP 文件浏览器；与 Rust `RemoteDirEntry` 逐字镜像）。 */
export interface RemoteDirEntry {
  name: string
  sizeBytes: number
  isDir: boolean
  /** 符号权限模式（`drwxr-xr-x`）。 */
  perms: string
  /** 修改时间可读串（远端 `stat` 原样，未换算时区）。 */
  modifiedAt: string
}

/** 会话事件（Rust → 前端，`axiom:ssh-event`；与 Rust `SshSessionEvent` 逐字镜像）。
 * `data` 是 PTY 输出字节的 base64 编码（与本地终端 TerminalEvent 同款）。 */
export interface SshSessionEvent {
  hostId: string
  data?: string | null
  done?: boolean
  exitCode?: number | null
  error?: string | null
}

export const SSH_SESSION_EVENT = 'axiom:ssh-event'

/** 上传事件（Rust → 前端，`axiom:ssh-upload-event`；与 Rust `SshUploadEvent` 逐字镜像）。 */
export type SshUploadEvent =
  | { phase: 'start'; hostId: string; name: string; totalBytes: number }
  | { phase: 'progress'; hostId: string; name: string; transferredBytes: number; totalBytes: number }
  | { phase: 'done'; hostId: string; name: string }
  | { phase: 'cancelled'; hostId: string; name: string }
  | { phase: 'failed'; hostId: string; name: string; error: string }

export const SSH_UPLOAD_EVENT = 'axiom:ssh-upload-event'

export const sshCommand = async (request: SshCommandRequest): Promise<SshCommandResponse> => {
  return invoke<SshCommandResponse>('ssh_command', { request })
}

/** 订阅 SSH 会话事件（数据字节流与会话结束），返回取消订阅函数。 */
export const onSshSessionEvent = async (
  handler: (event: SshSessionEvent) => void,
): Promise<UnlistenFn> => {
  return listen<SshSessionEvent>(SSH_SESSION_EVENT, (event) => handler(event.payload))
}

/** 订阅 SSH 上传事件（生命周期与进度），返回取消订阅函数。 */
export const onSshUploadEvent = async (
  handler: (event: SshUploadEvent) => void,
): Promise<UnlistenFn> => {
  return listen<SshUploadEvent>(SSH_UPLOAD_EVENT, (event) => handler(event.payload))
}

/**
 * 订阅指定主机的会话输出：字节流经流式 UTF-8 解码为字符串（跨 chunk 的
 * 多字节字符不丢），done 以 exitCode 回调。返回取消订阅函数。
 */
export const subscribeSshSessionOutput = async (
  hostId: string,
  onData: (data: string) => void,
  onDone: (exitCode: number | null) => void,
): Promise<UnlistenFn> => {
  const decoder = new TextDecoder()
  return onSshSessionEvent((event) => {
    if (event.hostId !== hostId) return
    if (event.data) {
      onData(decoder.decode(decodeBase64ToBytes(event.data), { stream: true }))
    }
    if (event.done) onDone(event.exitCode ?? null)
  })
}
