import { create } from 'zustand'
import {
  clearConnectPlatformConfig,
  connectPlatform,
  createConnectPairingCode,
  disconnectPlatform,
  getConnectConfig,
  saveConnectPlatformConfig,
  setConnectWorkspace,
  startWechatLogin,
  unpairConnectBinding,
  type ConnectConfigSummary,
  type ConnectPairingCode,
  type ConnectPlatform,
  type ConnectPlatformStatus,
  type ConnectWechatQr,
} from '@/platform/connect'

/**
 * 连接面板的投影状态：配置摘要 / 各平台连接状态 / 配对码 / 微信扫码会话。
 * 聊天消息不入 store —— 入站消息由 connectService 直接路由到 agentStore，
 * 避免把外部不可信文本塞进 React 状态树。
 */

const EMPTY_PLATFORMS: ConnectPlatformStatus[] = [
  { platform: 'feishu', status: 'unconfigured', message: null, configured: false, credentialHint: null },
  { platform: 'dingtalk', status: 'unconfigured', message: null, configured: false, credentialHint: null },
  { platform: 'weixin', status: 'unconfigured', message: null, configured: false, credentialHint: null },
]

/** 最近一次出站回发失败（桌面侧可见的排查入口；聊天侧此时无法自述）。 */
export interface ConnectReplyError {
  platform: ConnectPlatform
  message: string
  at: number
}

interface ConnectState {
  loaded: boolean
  config: ConnectConfigSummary
  /** 面板操作进行中标记（连接/断开/保存），防止重复触发。 */
  actionBusy: boolean
  /**
   * 面板动作失败原因（连接/断开、切换远程目录、扫码登录、生成配对码、解除配对）。
   * 这些失败此前一律被静默吞掉——用户只看到「点了没反应」，无从判断是没生效还是出错。
   */
  actionError: string | null
  pairing: ConnectPairingCode | null
  wechatLogin: ConnectWechatQr | null
  wechatLoginMessage: string | null
  replyError: ConnectReplyError | null
  refresh: () => Promise<void>
  applyStatus: (status: ConnectPlatformStatus) => void
  applyPaired: () => Promise<void>
  savePlatformConfig: (
    platform: ConnectPlatform,
    credential: { appId?: string; appSecret?: string; clientId?: string; clientSecret?: string; token?: string },
  ) => Promise<string | null>
  clearPlatformConfig: (platform: ConnectPlatform) => Promise<string | null>
  connect: (platform: ConnectPlatform) => Promise<string | null>
  disconnect: (platform: ConnectPlatform) => Promise<string | null>
  changeWorkspace: (workspacePath: string | null) => Promise<void>
  newPairingCode: () => Promise<void>
  unpair: (platform: ConnectPlatform, chatId: string, userId: string) => Promise<void>
  beginWechatLogin: () => Promise<void>
  setWechatLoginMessage: (message: string | null) => void
  clearWechatLogin: () => void
  setReplyError: (error: ConnectReplyError) => void
  clearReplyError: () => void
  setActionError: (message: string | null) => void
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const useConnectStore = create<ConnectState>((set, get) => ({
  loaded: false,
  config: { workspacePath: null, bindings: [], platforms: EMPTY_PLATFORMS },
  actionBusy: false,
  actionError: null,
  pairing: null,
  wechatLogin: null,
  wechatLoginMessage: null,
  replyError: null,

  refresh: async () => {
    try {
      const config = await getConnectConfig()
      set({ config, loaded: true })
    } catch (error) {
      set({ loaded: true })
      throw error
    }
  },

  applyStatus: (status) => {
    set((state) => ({
      config: {
        ...state.config,
        platforms: state.config.platforms.map((platform) => (
          platform.platform === status.platform ? status : platform
        )),
      },
    }))
  },

  applyPaired: async () => {
    await get().refresh()
  },

  savePlatformConfig: async (platform, credential) => {
    set({ actionBusy: true })
    try {
      await saveConnectPlatformConfig(platform, credential)
      await get().refresh()
      return null
    } catch (error) {
      return errorMessage(error)
    } finally {
      set({ actionBusy: false })
    }
  },

  clearPlatformConfig: async (platform) => {
    set({ actionBusy: true })
    try {
      await clearConnectPlatformConfig(platform)
      await get().refresh()
      return null
    } catch (error) {
      return errorMessage(error)
    } finally {
      set({ actionBusy: false })
    }
  },

  connect: async (platform) => {
    set({ actionBusy: true })
    try {
      await connectPlatform(platform)
      await get().refresh()
      set({ actionError: null })
      return null
    } catch (error) {
      const message = errorMessage(error)
      set({ actionError: message })
      return message
    } finally {
      set({ actionBusy: false })
    }
  },

  disconnect: async (platform) => {
    set({ actionBusy: true })
    try {
      await disconnectPlatform(platform)
      await get().refresh()
      set({ actionError: null })
      return null
    } catch (error) {
      const message = errorMessage(error)
      set({ actionError: message })
      return message
    } finally {
      set({ actionBusy: false })
    }
  },

  changeWorkspace: async (workspacePath) => {
    try {
      await setConnectWorkspace(workspacePath)
      // 写入成功即就地回填：config 的权威读取走 refresh()（含密钥元数据检查），
      // 它失败时旧实现会把刚写入的目录选择一并丢弃——表现正是「选了又弹回去」。
      // 归一化与 Rust set_connect_workspace 一致（trim、空串→null），避免读回失败时
      // 乐观态与权威态长期不一致。
      const normalized = workspacePath?.trim() ? workspacePath.trim() : null
      set((state) => ({ config: { ...state.config, workspacePath: normalized }, actionError: null }))
      try {
        await get().refresh()
      } catch {
        // 读回失败不回退已落盘的写入。
      }
    } catch (error) {
      set({ actionError: errorMessage(error) })
    }
  },

  newPairingCode: async () => {
    try {
      const pairing = await createConnectPairingCode()
      set({ pairing, actionError: null })
    } catch (error) {
      set({ actionError: errorMessage(error) })
    }
  },

  unpair: async (platform, chatId, userId) => {
    try {
      await unpairConnectBinding(platform, chatId, userId)
      await get().refresh()
      set({ actionError: null })
    } catch (error) {
      set({ actionError: errorMessage(error) })
    }
  },

  beginWechatLogin: async () => {
    try {
      const wechatLogin = await startWechatLogin()
      set({ wechatLogin, wechatLoginMessage: null, actionError: null })
    } catch (error) {
      set({ wechatLogin: null, actionError: errorMessage(error) })
    }
  },

  setWechatLoginMessage: (wechatLoginMessage) => set({ wechatLoginMessage }),
  clearWechatLogin: () => set({ wechatLogin: null, wechatLoginMessage: null }),
  setReplyError: (replyError) => set({ replyError }),
  clearReplyError: () => set({ replyError: null }),
  setActionError: (actionError) => set({ actionError }),
}))
