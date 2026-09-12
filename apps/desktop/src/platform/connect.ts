import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauriRuntime } from './environment'

/**
 * 「连接」远程操控通道的前端契约层。
 *
 * Rust `connect` 模块是唯一权威：持有各聊天平台（飞书 / 钉钉 / 微信个人号）
 * 的长连接、配对绑定与凭证（凭证只进 Keychain），WebView 经这里固定的
 * command 集读写配置、启停连接、回发消息。聊天入站消息经
 * `axiom:connect-event` 事件推送，由 connectService 路由到 agentStore。
 */

export type ConnectPlatform = 'feishu' | 'dingtalk' | 'weixin'

export type ConnectStatus =
  | 'unconfigured'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'

export interface ConnectPlatformStatus {
  platform: ConnectPlatform
  status: ConnectStatus
  message: string | null
  configured: boolean
  /** 凭证可见性提示（如 App ID 前缀），不含任何密钥明文。 */
  credentialHint: string | null
}

export interface ConnectBinding {
  platform: ConnectPlatform
  chatId: string
  chatType: 'p2p' | 'group'
  userId: string
  userName: string
  pairedAt: number
}

export interface ConnectConfigSummary {
  workspacePath: string | null
  bindings: ConnectBinding[]
  platforms: ConnectPlatformStatus[]
}

export interface ConnectPairingCode {
  code: string
  expiresAt: number
}

export interface ConnectWechatQr {
  loginId: string
  /** QR 点阵：每行一个字符串，'1' 为暗模块。前端渲染为 SVG，不引入二维码依赖。 */
  rows: string[]
}

export type ConnectWechatLoginStatus =
  | { status: 'starting' }
  | { status: 'waiting'; rows?: string[] }
  | { status: 'scanned' }
  | { status: 'confirmed' }
  | { status: 'expired' }
  | { status: 'failed'; message: string }

export type ConnectEvent =
  | {
      kind: 'status'
      platform: ConnectPlatform
      status: ConnectStatus
      message: string | null
    }
  | {
      kind: 'message'
      platform: ConnectPlatform
      chatId: string
      chatType: 'p2p' | 'group'
      userId: string
      userName: string
      messageId: string
      text: string
    }
  | {
      kind: 'paired'
      platform: ConnectPlatform
      chatId: string
      chatType: 'p2p' | 'group'
      userId: string
      userName: string
    }

export interface ConnectPlatformCredentialDraft {
  /** 飞书：App ID（cli_ 开头）。 */
  appId?: string
  /** 飞书：App Secret。 */
  appSecret?: string
  /** 钉钉：Client ID（AppKey）。 */
  clientId?: string
  /** 钉钉：Client Secret。 */
  clientSecret?: string
  /** 微信个人号：手动绑定的 ilink token（扫码登录亦可，见 startWechatLogin）。 */
  token?: string
}

export const getConnectConfig = async (): Promise<ConnectConfigSummary> => {
  if (!isTauriRuntime()) return { workspacePath: null, bindings: [], platforms: [] }
  return invoke<ConnectConfigSummary>('get_connect_config')
}

export const saveConnectPlatformConfig = async (
  platform: ConnectPlatform,
  credential: ConnectPlatformCredentialDraft,
): Promise<void> => {
  if (!isTauriRuntime()) throw new Error('连接配置仅在 Axiom 桌面应用中可用')
  await invoke('save_connect_platform_config', { request: { platform, credential } })
}

export const clearConnectPlatformConfig = async (platform: ConnectPlatform): Promise<void> => {
  if (!isTauriRuntime()) throw new Error('连接配置仅在 Axiom 桌面应用中可用')
  await invoke('clear_connect_platform_config', { request: { platform } })
}

export const connectPlatform = async (platform: ConnectPlatform): Promise<void> => {
  if (!isTauriRuntime()) throw new Error('连接仅在 Axiom 桌面应用中可用')
  await invoke('connect_platform', { request: { platform } })
}

export const disconnectPlatform = async (platform: ConnectPlatform): Promise<void> => {
  if (!isTauriRuntime()) throw new Error('连接仅在 Axiom 桌面应用中可用')
  await invoke('disconnect_platform', { request: { platform } })
}

export const setConnectWorkspace = async (workspacePath: string | null): Promise<void> => {
  if (!isTauriRuntime()) throw new Error('连接配置仅在 Axiom 桌面应用中可用')
  await invoke('set_connect_workspace', { request: { workspacePath } })
}

export const createConnectPairingCode = async (): Promise<ConnectPairingCode> => {
  if (!isTauriRuntime()) throw new Error('配对仅在 Axiom 桌面应用中可用')
  return invoke<ConnectPairingCode>('create_connect_pairing_code')
}

export const unpairConnectBinding = async (
  platform: ConnectPlatform,
  chatId: string,
  userId: string,
): Promise<void> => {
  if (!isTauriRuntime()) throw new Error('配对管理仅在 Axiom 桌面应用中可用')
  await invoke('unpair_connect_binding', { request: { platform, chatId, userId } })
}

export const connectReplyMessage = async (
  platform: ConnectPlatform,
  chatId: string,
  userId: string,
  text: string,
): Promise<void> => {
  if (!isTauriRuntime()) return
  await invoke('connect_reply_message', { request: { platform, chatId, userId, text } })
}

export const startWechatLogin = async (): Promise<ConnectWechatQr> => {
  if (!isTauriRuntime()) throw new Error('微信登录仅在 Axiom 桌面应用中可用')
  return invoke<ConnectWechatQr>('start_wechat_login')
}

export const pollWechatLogin = async (loginId: string): Promise<ConnectWechatLoginStatus> => {
  if (!isTauriRuntime()) return { status: 'failed', message: '微信登录仅在 Axiom 桌面应用中可用' }
  return invoke<ConnectWechatLoginStatus>('poll_wechat_login', { request: { loginId } })
}

export const listenConnectEvents = async (
  handler: (event: ConnectEvent) => void,
): Promise<UnlistenFn> => listen<ConnectEvent>('axiom:connect-event', (event) => {
  handler(event.payload)
})
