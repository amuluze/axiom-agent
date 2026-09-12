import { describe, expect, it, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import {
  connectServiceInternals,
  resetConnectServiceForTests,
} from './connectService'
import { useConnectStore } from '../connectStore'
import { useAgentStore } from '../agentStore'
import { connectReplyMessage } from '@/platform/connect'

/**
 * connectService 纯逻辑单测：绑定键、审批应答解析、帮助文本与 /status 渲染。
 * 消息路由依赖 agentStore / connectStore 的副作用，由真实 store 的默认态覆盖。
 * 环境按 node 测试约定模拟非 Tauri 运行时（isTauriRuntime=false），
 * 因此 platform/connect 的 invoke 路径全部由 mock 顶替。
 */

vi.mock('@/platform/connect', () => ({
  connectReplyMessage: vi.fn(async () => undefined),
  listenConnectEvents: vi.fn(async () => () => undefined),
}))

vi.mock('@/platform/environment', () => ({
  isTauriRuntime: () => false,
}))

describe('connectServiceInternals', () => {
  beforeEach(() => {
    resetConnectServiceForTests()
    useAgentStore.setState({ providerReady: true, providerSetupRequired: false })
    useConnectStore.setState({
      loaded: true,
      config: { workspacePath: null, bindings: [], platforms: [] },
    })
  })

  afterEach(() => {
    resetConnectServiceForTests()
    vi.restoreAllMocks()
  })

  it('binding keys are stable and namespaced', () => {
    const key = connectServiceInternals.bindingKey('feishu', 'oc_1', 'ou_1')
    expect(key).toBe('feishu:oc_1:ou_1')
    expect(connectServiceInternals.bindingKey('weixin', 'u', 'u')).toBe('weixin:u:u')
  })

  it('parses approval verdicts from short Chinese/English replies', () => {
    const parse = connectServiceInternals.parseApprovalVerdict
    expect(parse('y')).toBe('approved')
    expect(parse('Y')).toBe('approved')
    expect(parse('yes')).toBe('approved')
    expect(parse('好')).toBe('approved')
    expect(parse('允许')).toBe('approved')
    expect(parse('n')).toBe('denied')
    expect(parse('no')).toBe('denied')
    expect(parse('拒绝')).toBe('denied')
    // 长文本或普通消息不算审批应答
    expect(parse('')).toBeNull()
    expect(parse('帮我看看这个 y 什么意思')).toBeNull()
    expect(parse('y'.repeat(13))).toBeNull()
  })

  it('status text reflects provider readiness', () => {
    useAgentStore.setState({ providerReady: true })
    expect(connectServiceInternals.statusText()).toContain('就绪')
    useAgentStore.setState({ providerReady: false })
    expect(connectServiceInternals.statusText()).toContain('未配置')
  })

  it('session map round-trips through localStorage', () => {
    // node 环境默认无 window/localStorage：注入最小 stub 使守卫生效。
    const store = new Map<string, string>()
    const storageStub = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    }
    vi.stubGlobal('window', { localStorage: storageStub })
    const map = new Map([
      ['feishu:oc_1:ou_1', 'session-1'],
    ])
    connectServiceInternals.persistSessionMap(map)
    const restored = connectServiceInternals.loadSessionMap()
    expect(restored.get('feishu:oc_1:ou_1')).toBe('session-1')
    vi.unstubAllGlobals()
  })

  it('loadSessionMap 过滤历史 undefined 脏 key（事件字段名不匹配时期的遗留）', () => {
    const store = new Map<string, string>([
      ['axiom.connect.session-map.v1', JSON.stringify({
        'weixin:undefined:undefined': 'session-legacy',
        'weixin:wx-1:wx-1': 'session-valid',
      })],
    ])
    const storageStub = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    }
    vi.stubGlobal('window', { localStorage: storageStub })
    const restored = connectServiceInternals.loadSessionMap()
    expect(restored.get('weixin:undefined:undefined')).toBeUndefined()
    expect(restored.get('weixin:wx-1:wx-1')).toBe('session-valid')
    vi.unstubAllGlobals()
  })

  it('unbound bindings do not dispatch and require a workspace for tasks', async () => {
    // 未配对 + 未选工作目录：直接回复指引而不驱动会话。
    const replies: string[] = []
    vi.mocked(connectReplyMessage).mockImplementation(async (_platform, _chatId, _userId, text) => {
      replies.push(text)
    })
    const sendSpy = vi.spyOn(useAgentStore.getState(), 'send').mockResolvedValue(undefined)
    const createSpy = vi.spyOn(useAgentStore.getState(), 'createNewSession').mockResolvedValue(false)
    await connectServiceInternals.handleInboundMessage({
      platform: 'feishu',
      chatId: 'oc_1',
      userId: 'ou_1',
      userName: '张三',
      messageId: 'om_1',
      text: '帮我写个 demo',
    })
    expect(replies.some((text) => text.includes('工作目录'))).toBe(true)
    expect(sendSpy).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
  })
})

/**
 * 执行结果回传集成测试：真实 agentStore（demo transport）+ 真实 send()，
 * 验证「入站消息 → 驱动会话 → 执行结束 → 最终 assistant 输出回发聊天平台」
 * 的完整闭环。若此路径断裂（如 send 未结算就读取投影），聊天侧会静默无反馈。
 */
describe('connectService 执行结果回传', () => {
  beforeAll(async () => {
    resetConnectServiceForTests()
    await useAgentStore.getState().initialize()
  })

  beforeEach(() => {
    resetConnectServiceForTests()
    useAgentStore.setState({
      providerReady: true,
      providerSetupRequired: false,
      authorizedWorkspace: { path: '/repo/axiom', name: 'axiom', gitBranch: null },
      authorizedWorkspaces: [{ path: '/repo/axiom', name: 'axiom', gitBranch: null }],
    })
    useConnectStore.setState({
      loaded: true,
      config: { workspacePath: '/repo/axiom', bindings: [], platforms: [] },
    })
  })

  it('运行结束后把最终 assistant 输出回发到发起消息的聊天会话', async () => {
    const replies: Array<{ platform: string; chatId: string; userId: string; text: string }> = []
    vi.mocked(connectReplyMessage).mockClear()
    vi.mocked(connectReplyMessage).mockImplementation(async (platform, chatId, userId, text) => {
      replies.push({ platform, chatId, userId, text })
    })
    await connectServiceInternals.handleInboundMessage({
      platform: 'feishu',
      chatId: 'oc_reply_flow',
      userId: 'ou_reply_flow',
      userName: '张三',
      messageId: 'om_reply_flow',
      text: '帮我写个 demo',
    })
    expect(replies.length).toBeGreaterThan(0)
    const result = replies[replies.length - 1]
    expect(result.platform).toBe('feishu')
    expect(result.chatId).toBe('oc_reply_flow')
    expect(result.userId).toBe('ou_reply_flow')
    // demo transport 固定输出会回显用户消息；断言回发的是运行结果而非指引文案
    expect(result.text).toContain('本地演示响应')
    expect(result.text).toContain('帮我写个 demo')
  })

  it('运行报错时把错误信息回发到聊天平台', async () => {
    const replies: Array<{ platform: string; chatId: string; userId: string; text: string }> = []
    vi.mocked(connectReplyMessage).mockClear()
    vi.mocked(connectReplyMessage).mockImplementation(async (platform, chatId, userId, text) => {
      replies.push({ platform, chatId, userId, text })
    })
    // 未授权工作目录 → send() 设置 error 后早退，回发应为错误信息而非结果
    useAgentStore.setState({ authorizedWorkspaces: [] })
    await connectServiceInternals.handleInboundMessage({
      platform: 'dingtalk',
      chatId: 'dc_reply_flow',
      userId: 'du_reply_flow',
      userName: '李四',
      messageId: 'dm_reply_flow',
      text: '写个失败用例',
    })
    expect(replies.length).toBeGreaterThan(0)
    const result = replies[replies.length - 1]
    expect(result.text).toContain('工作目录')
  })

  it('回发失败时把错误投影到 connectStore（桌面侧可见，不再静默吞掉）', async () => {
    vi.mocked(connectReplyMessage).mockClear()
    vi.mocked(connectReplyMessage).mockRejectedValue(new Error('回复通道不可用'))
    await connectServiceInternals.handleInboundMessage({
      platform: 'feishu',
      chatId: 'oc_reply_error',
      userId: 'ou_reply_error',
      userName: '王五',
      messageId: 'om_reply_error',
      text: '测试回发失败',
    })
    const state = useConnectStore.getState()
    expect(state.replyError).not.toBeNull()
    expect(state.replyError?.platform).toBe('feishu')
    expect(state.replyError?.message).toContain('回复通道不可用')
    // 失败后投影可清除，供面板关闭提示条
    useConnectStore.getState().clearReplyError()
    expect(useConnectStore.getState().replyError).toBeNull()
  })

  it('审批应答绕过串行队列立即执行（队列头挂起等审批时 y/n 不死锁）', async () => {
    const replies: string[] = []
    vi.mocked(connectReplyMessage).mockClear()
    vi.mocked(connectReplyMessage).mockImplementation(async (_p, _c, _u, text) => {
      replies.push(text)
    })
    // 建立绑定 → 会话映射（审批应答按 sessionMap 判定归属）。
    await connectServiceInternals.handleInboundMessage({
      platform: 'weixin',
      chatId: 'wx_approval',
      userId: 'wx_approval',
      userName: '测试',
      messageId: 'om_setup',
      text: '建个会话',
    })
    const sessionId = useAgentStore.getState().activeSessionId
    expect(sessionId).toBeTruthy()
    const approveSpy = vi.fn(async () => undefined)
    useAgentStore.setState({
      approveToolCall: approveSpy,
      pendingApproval: {
        sessionId: sessionId!,
        toolCallId: 'tc-1',
        toolLabel: 'bash: npm test',
      } as never,
    })
    // 直连事件处理器（与 handleConnectEvent 同一入口行为）：y 应立即放行，
    // 不因串行队列中可能挂起的 run 而被阻塞。
    await connectServiceInternals.applyApprovalVerdict(
      {
        platform: 'weixin',
        chatId: 'wx_approval',
        userId: 'wx_approval',
        userName: '测试',
        messageId: 'om_y',
        text: 'y',
      },
      useAgentStore.getState().pendingApproval!,
      'approved',
    )
    expect(approveSpy).toHaveBeenCalledWith('tc-1')
    expect(replies.some((text) => text.includes('已允许该操作'))).toBe(true)
  })
})
