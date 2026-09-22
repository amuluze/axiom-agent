import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConnectStore } from './connectStore'

/**
 * 连接面板的动作失败可见性契约：这些动作（切换远程目录、扫码登录、连接/断开…）
 * 此前一律静默吞掉失败，用户只看到「点了没反应」，无从判断是没生效还是报错。
 */
const mocks = vi.hoisted(() => ({
  setConnectWorkspace: vi.fn(),
  startWechatLogin: vi.fn(),
  getConnectConfig: vi.fn(),
  connectPlatform: vi.fn(),
}))

vi.mock('@/platform/connect', () => ({
  setConnectWorkspace: mocks.setConnectWorkspace,
  startWechatLogin: mocks.startWechatLogin,
  getConnectConfig: mocks.getConnectConfig,
  connectPlatform: mocks.connectPlatform,
  disconnectPlatform: vi.fn(),
  clearConnectPlatformConfig: vi.fn(),
  unpairConnectBinding: vi.fn(),
}))

const initialConfig = useConnectStore.getState().config

beforeEach(() => {
  vi.clearAllMocks()
  useConnectStore.setState({
    config: initialConfig,
    actionError: null,
    actionBusy: false,
    wechatLogin: null,
  })
})

describe('connectStore 动作失败可见性', () => {
  it('切换远程目录写入失败：保留原值并投影错误', async () => {
    mocks.setConnectWorkspace.mockRejectedValue(new Error('无法写入连接配置'))
    await useConnectStore.getState().changeWorkspace('/ws/a')
    const state = useConnectStore.getState()
    expect(state.config.workspacePath).toBeNull()
    expect(state.actionError).toBe('无法写入连接配置')
    expect(mocks.getConnectConfig).not.toHaveBeenCalled()
  })

  it('切换远程目录写入成功但读回失败：已落盘的选择不被丢弃', async () => {
    mocks.setConnectWorkspace.mockResolvedValue(undefined)
    mocks.getConnectConfig.mockRejectedValue(new Error('读取连接配置失败'))
    await useConnectStore.getState().changeWorkspace('/ws/a')
    const state = useConnectStore.getState()
    expect(state.config.workspacePath).toBe('/ws/a')
    expect(state.actionError).toBeNull()
  })

  it('扫码登录启动失败：给出可见错误且不进入扫码态', async () => {
    mocks.startWechatLogin.mockRejectedValue(new Error('微信登录仅在 Axiom 桌面应用中可用'))
    await useConnectStore.getState().beginWechatLogin()
    expect(useConnectStore.getState().wechatLogin).toBeNull()
    expect(useConnectStore.getState().actionError).toBe('微信登录仅在 Axiom 桌面应用中可用')
  })

  it('扫码登录成功：清空错误并进入扫码态', async () => {
    mocks.startWechatLogin.mockResolvedValue({ loginId: 'wxlogin-1', rows: [] })
    useConnectStore.setState({ actionError: '旧错误' })
    await useConnectStore.getState().beginWechatLogin()
    expect(useConnectStore.getState().wechatLogin).toEqual({ loginId: 'wxlogin-1', rows: [] })
    expect(useConnectStore.getState().actionError).toBeNull()
  })

  it('连接平台失败：错误同时回传调用方并投影到面板', async () => {
    mocks.connectPlatform.mockRejectedValue(new Error('飞书 App Secret 未配置'))
    const message = await useConnectStore.getState().connect('feishu')
    expect(message).toBe('飞书 App Secret 未配置')
    expect(useConnectStore.getState().actionError).toBe('飞书 App Secret 未配置')
  })
})
