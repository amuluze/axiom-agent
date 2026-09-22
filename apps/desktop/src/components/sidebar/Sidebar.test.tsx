import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import type { SidebarProps } from './Sidebar'
import type { ConnectConfigSummary } from '@/platform/connect'
import type { StoredAgentSession } from '@/persistence/types'

const mocks = vi.hoisted(() => ({
  sessions: [] as StoredAgentSession[],
  awaitingApprovalSessionIds: [] as string[],
  sessionQueueCounts: {} as Record<string, number>,
  authorizedWorkspace: null as {
    path: string
    name: string
    gitBranch?: string | null
  } | null,
  authorizedWorkspaces: [] as Array<{
    path: string
    name: string
    gitBranch?: string | null
  }>,
  view: 'new-task',
  availableUpdate: null as { version: string; notes: string | null; pubDate: string | null } | null,
  createNewSession: vi.fn(async () => true),
  addWorkspace: vi.fn(async () => true),
  revokeWorkspace: vi.fn(async () => true),
  setView: vi.fn(),
  closeSidebarOverlay: vi.fn(),
  connectConfig: {
    workspacePath: null,
    bindings: [],
    platforms: [],
  } as ConnectConfigSummary,
}))

const stubSession = (overrides: Partial<StoredAgentSession> = {}): StoredAgentSession => ({
  id: 's1',
  title: 'Sprint planning',
  systemPrompt: '',
  modelProvider: 'generic-anthropic-compatible',
  modelId: 'claude-test',
  reasoning: null,
  activeToolNames: [],
  providerConfig: null,
  runtimeManifest: null,
  status: 'idle',
  createdAt: 0,
  updatedAt: Date.now() - 86_400_000 * 3,
  messageCount: 8,
  parentSessionId: null,
  forkedFromMessageId: null,
  branchKind: null,
  retriedMessageId: null,
  ...overrides,
})

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T => selector({
      ...original.useAgentStore.getState(),
      sessions: mocks.sessions,
      awaitingApprovalSessionIds: mocks.awaitingApprovalSessionIds,
      sessionQueueCounts: mocks.sessionQueueCounts,
      authorizedWorkspace: mocks.authorizedWorkspace,
      authorizedWorkspaces: mocks.authorizedWorkspaces,
      createNewSession: mocks.createNewSession,
      addWorkspace: mocks.addWorkspace,
      revokeWorkspace: mocks.revokeWorkspace,
    } as StoreState),
  }
})

vi.mock('@/stores/uiStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/uiStore')>()
  type UiState = ReturnType<typeof original.useUiStore.getState>
  return {
    ...original,
    useUiStore: <T,>(selector: (state: UiState) => T): T => selector({
      ...original.useUiStore.getState(),
      view: mocks.view,
      availableUpdate: mocks.availableUpdate,
      setView: mocks.setView,
      closeSidebarOverlay: mocks.closeSidebarOverlay,
    } as UiState),
  }
})

vi.mock('@/stores/connectStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/connectStore')>()
  type ConnectState = ReturnType<typeof original.useConnectStore.getState>
  return {
    ...original,
    useConnectStore: <T,>(selector: (state: ConnectState) => T): T => selector({
      ...original.useConnectStore.getState(),
      config: mocks.connectConfig,
    } as ConnectState),
  }
})

afterEach(() => {
  mocks.sessions = []
  mocks.awaitingApprovalSessionIds = []
  mocks.authorizedWorkspace = null
  mocks.authorizedWorkspaces = []
  mocks.view = 'new-task'
  mocks.availableUpdate = null
  mocks.connectConfig = { workspacePath: null, bindings: [], platforms: [] }
  mocks.createNewSession.mockClear()
  mocks.addWorkspace.mockClear()
  mocks.revokeWorkspace.mockClear()
  mocks.setView.mockClear()
  mocks.closeSidebarOverlay.mockClear()
})

describe('Sidebar', () => {
  it('renders the sidebar nav with 新任务、技能 and SSH items', () => {
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('sidebar')
    expect(html).toContain('新任务')
    expect(html).toContain('技能')
    // SSH 是独立全窗口视图（设计稿「Axiom — SSH」）的侧栏入口。
    expect(html).toContain('SSH')
  })

  it('marks 新任务 as active when the current view is new-task', () => {
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('sidebar__nav-item--active')
    expect(html).toMatch(/active.*新任务|新任务.*active/u)
  })

  it('renders one icon-only add-directory action inside the workspace header', () => {
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('工作区')
    expect(html).not.toContain('aria-label="筛选"')
    expect(html).not.toContain('aria-label="搜索"')
    expect(html).not.toContain('aria-label="归档"')
    expect(html.match(/aria-label="添加工作目录"/gu)).toHaveLength(1)
    expect(html).toMatch(/sidebar__workspace-header[\s\S]*sidebar__workspace-add/u)
    expect(html).not.toContain('<span>添加工作目录</span>')
  })

  it('shows the authorised workspace name or an empty-workspace prompt', () => {
    const noWorkspace = renderToStaticMarkup(createElement(Sidebar))
    expect(noWorkspace).toContain('尚未添加工作目录')

    mocks.authorizedWorkspace = { path: '/repo', name: 'my-project' }
    mocks.authorizedWorkspaces = [{ path: '/repo', name: 'my-project' }]
    const withWorkspace = renderToStaticMarkup(createElement(Sidebar))
    expect(withWorkspace).toContain('my-project')
  })

  it('lists up to 5 most recent sessions with relative timestamps', () => {
    const day = 86_400_000
    mocks.authorizedWorkspaces = [{ path: '/repo', name: 'repo' }]
    mocks.sessions = [
      stubSession({
        id: 'a',
        title: 'alpha',
        workspace: { path: '/repo', name: 'repo' },
        updatedAt: Date.now() - day,
      }),
      stubSession({
        id: 'b',
        title: 'beta',
        workspace: { path: '/repo', name: 'repo' },
        updatedAt: Date.now() - 5 * day,
      }),
    ]
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('alpha')
    expect(html).toContain('beta')
  })

  it('marks only sessions awaiting approval with the 待审批 badge', () => {
    mocks.authorizedWorkspaces = [{ path: '/repo', name: 'repo' }]
    mocks.sessions = [
      stubSession({
        id: 'awaiting',
        title: 'awaiting task',
        workspace: { path: '/repo', name: 'repo' },
      }),
      stubSession({
        id: 'plain',
        title: 'plain task',
        workspace: { path: '/repo', name: 'repo' },
      }),
    ]
    mocks.awaitingApprovalSessionIds = ['awaiting']

    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html.match(/待审批/gu)).toHaveLength(1)
    expect(html).toContain('title="该会话正在等待用户审批"')
  })

  it('moves archive action onto each session row without a delete button', () => {
    mocks.authorizedWorkspaces = [{ path: '/repo', name: 'repo' }]
    mocks.sessions = [stubSession({
      title: 'alpha',
      workspace: { path: '/repo', name: 'repo' },
    })]
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('aria-label="归档会话 alpha"')
    expect(html).not.toContain('aria-label="删除会话 alpha"')
  })

  it('offers background quick-send for running and idle sessions bound to an authorized workspace', () => {
    mocks.authorizedWorkspaces = [{ path: '/repo', name: 'repo' }]
    mocks.sessions = [
      stubSession({
        id: 'idle',
        title: 'idle task',
        workspace: { path: '/repo', name: 'repo' },
      }),
      stubSession({
        id: 'busy',
        title: 'busy task',
        status: 'running',
        workspace: { path: '/repo', name: 'repo' },
      }),
      stubSession({
        id: 'unbound',
        title: 'unbound task',
        workspace: { path: '/revoked', name: 'revoked' },
      }),
    ]
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('aria-label="向会话 idle task 发送消息"')
    // 运行中的后台会话可排队引导消息（不再只能停止），文案切换为排队语义。
    expect(html).toContain('aria-label="向会话 busy task 发送消息"')
    expect(html).toContain('该会话正在运行：消息作为引导排队')
    // 工作区已撤销的会话仍不可发。
    expect(html).not.toContain('aria-label="向会话 unbound task 发送消息"')
  })

  it('shows the pending queue badge for a session with queued messages', () => {
    mocks.authorizedWorkspaces = [{ path: '/repo', name: 'repo' }]
    mocks.sessionQueueCounts = { busy: 3 }
    mocks.sessions = [
      stubSession({
        id: 'busy',
        title: 'busy task',
        status: 'running',
        workspace: { path: '/repo', name: 'repo' },
      }),
    ]
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('待发送 3 条')
    expect(html).toContain('sidebar__task-queued')
  })

  it('groups sessions by workspace and shows each repository branch', () => {
    mocks.authorizedWorkspaces = [
      { path: '/repo/alpha', name: 'alpha', gitBranch: 'main' },
      { path: '/repo/beta', name: 'beta', gitBranch: 'feat-parallel' },
    ]
    mocks.sessions = [
      stubSession({
        id: 'alpha-session',
        title: 'alpha task',
        workspace: { path: '/repo/alpha', name: 'alpha', gitBranch: 'main' },
      }),
      stubSession({
        id: 'beta-session',
        title: 'beta task',
        workspace: { path: '/repo/beta', name: 'beta', gitBranch: 'feat-parallel' },
      }),
    ]

    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('alpha task')
    expect(html).toContain('beta task')
    expect(html).toContain('main')
    expect(html).toContain('feat-parallel')
  })

  it('shows the workspace state dot only while one of its sessions is running', () => {
    mocks.authorizedWorkspaces = [
      { path: '/repo/busy', name: 'busy' },
      { path: '/repo/idle', name: 'idle' },
    ]
    mocks.sessions = [
      stubSession({
        id: 'running',
        title: 'running task',
        status: 'running',
        workspace: { path: '/repo/busy', name: 'busy' },
      }),
      stubSession({
        id: 'idle',
        title: 'idle task',
        workspace: { path: '/repo/idle', name: 'idle' },
      }),
    ]
    const html = renderToStaticMarkup(createElement(Sidebar))
    // 仅 busy 工作区亮运行点；旧的授权常亮绿点不再渲染
    expect(html.match(/title="该工作目录下有会话正在运行"/gu)).toHaveLength(1)
    expect(html).not.toContain('sidebar__workspace-state--authorized')
  })

  it('hides the workspace state dot when no session under it is running', () => {
    mocks.authorizedWorkspaces = [{ path: '/repo', name: 'repo' }]
    mocks.sessions = [stubSession({
      id: 'idle',
      title: 'idle task',
      workspace: { path: '/repo', name: 'repo' },
    })]
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).not.toContain('sidebar__workspace-state')
  })

  it('shows 显示更多 when sessions exceed 5', () => {
    const day = 86_400_000
    mocks.authorizedWorkspaces = [{ path: '/repo', name: 'repo' }]
    mocks.sessions = Array.from({ length: 6 }, (_, i) =>
      stubSession({
        id: `s-${i}`,
        title: `session ${i}`,
        workspace: { path: '/repo', name: 'repo' },
        updatedAt: Date.now() - i * day,
      }),
    )
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('显示更多')
  })

  it('renders the bottom bar with 连接 and settings button', () => {
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('连接')
    expect(html).toContain('aria-label="设置"')
  })

  it('keeps the default avatar without a status dot when nothing is connected', () => {
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('sidebar__connect-avatar')
    expect(html).not.toContain('sidebar__connect-dot')
    expect(html).not.toContain('sidebar__connect-avatar-icon')
    expect(html).not.toContain('sidebar__connect-badge')
    expect(html).toContain('title="连接聊天工具，远程操控 Axiom"')
  })

  it('shows connected platform brand icons with a green status dot', () => {
    mocks.connectConfig = {
      workspacePath: null,
      bindings: [],
      platforms: [
        { platform: 'feishu', status: 'connected', message: null, configured: true, credentialHint: 'cli_x' },
        { platform: 'dingtalk', status: 'disconnected', message: null, configured: true, credentialHint: null },
        { platform: 'weixin', status: 'unconfigured', message: null, configured: false, credentialHint: null },
      ],
    }
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('sidebar__connect-dot--connected')
    expect(html).toContain('sidebar__connect-avatar-icon')
    expect(html).toContain('title="已连接 飞书"')
    // 未连接的钉钉不占头像位置；无配对时不显示计数徽标
    expect(html.match(/sidebar__connect-avatar-icon/gu)).toHaveLength(1)
    expect(html).not.toContain('sidebar__connect-badge')
  })

  it('shows a paired-chat count badge and error state in the title', () => {
    mocks.connectConfig = {
      workspacePath: null,
      bindings: [
        {
          platform: 'feishu', chatId: 'chat-1', chatType: 'p2p',
          userId: 'u-1', userName: '张三', pairedAt: 0,
        },
        {
          platform: 'weixin', chatId: 'chat-2', chatType: 'group',
          userId: 'u-2', userName: '群聊', pairedAt: 0,
        },
      ],
      platforms: [
        { platform: 'feishu', status: 'connected', message: null, configured: true, credentialHint: 'cli_x' },
        { platform: 'dingtalk', status: 'error', message: '连接失败', configured: true, credentialHint: null },
        { platform: 'weixin', status: 'connected', message: null, configured: true, credentialHint: null },
      ],
    }
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('sidebar__connect-badge')
    expect(html).toContain('>2</span>')
    expect(html).toContain('title="已连接 飞书、微信个人号，2 个配对聊天（部分平台异常）"')
  })

  it('shows an amber dot while connecting and a red dot on error', () => {
    mocks.connectConfig = {
      workspacePath: null,
      bindings: [],
      platforms: [
        { platform: 'feishu', status: 'unconfigured', message: null, configured: false, credentialHint: null },
        { platform: 'dingtalk', status: 'connecting', message: null, configured: true, credentialHint: null },
        { platform: 'weixin', status: 'unconfigured', message: null, configured: false, credentialHint: null },
      ],
    }
    expect(renderToStaticMarkup(createElement(Sidebar))).toContain('sidebar__connect-dot--connecting')

    mocks.connectConfig = {
      workspacePath: null,
      bindings: [],
      platforms: [
        { platform: 'feishu', status: 'error', message: '鉴权失败', configured: true, credentialHint: null },
        { platform: 'dingtalk', status: 'unconfigured', message: null, configured: false, credentialHint: null },
        { platform: 'weixin', status: 'unconfigured', message: null, configured: false, credentialHint: null },
      ],
    }
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('sidebar__connect-dot--error')
    expect(html).toContain('title="连接异常，点击查看"')
  })

  it('renders only the sidebar collapse control in the draggable titlebar', () => {
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('data-tauri-drag-region')
    expect(html).toContain('aria-label="折叠侧边栏"')
    expect(html).not.toContain('aria-label="后退"')
    expect(html).not.toContain('aria-label="前进"')
  })

  it('hides the update entry when no update is available', () => {
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).not.toContain('sidebar__icon-button--update')
    expect(html).not.toContain('有可用更新')
  })

  it('shows the update entry left of the collapse button when an update is available', () => {
    mocks.availableUpdate = { version: '0.2.7', notes: null, pubDate: null }
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('sidebar__icon-button--update')
    expect(html).toContain('aria-label="有可用更新 v0.2.7，点击前往更新"')
    // 更新按钮位于折叠按钮左侧（DOM 先序）
    expect(html).toMatch(
      /sidebar__icon-button--update[\s\S]*aria-label="折叠侧边栏"/u,
    )
  })

  it('wraps in overlay when variant is overlay', () => {
    const html = renderToStaticMarkup(createElement<SidebarProps>(Sidebar, { variant: 'overlay' }))
    expect(html).toContain('sidebar__overlay')
  })

  it('does not wrap in overlay when variant is default', () => {
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).not.toContain('sidebar__overlay')
  })

  it('renders a remove button on each authorised workspace row', () => {
    mocks.authorizedWorkspaces = [
      { path: '/repo/alpha', name: 'alpha' },
      { path: '/repo/beta', name: 'beta' },
    ]
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('aria-label="移除工作目录 alpha"')
    expect(html).toContain('aria-label="移除工作目录 beta"')
    // 仍未绑定的孤儿组（__unbound__）不应有移除按钮
    expect(html).not.toContain('aria-label="移除工作目录 尚未添加工作目录"')
  })

  it('renders a new-session button before the remove button on each authorised workspace row', () => {
    mocks.authorizedWorkspaces = [
      { path: '/repo/alpha', name: 'alpha' },
      { path: '/repo/beta', name: 'beta' },
    ]
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('aria-label="在 alpha 中新建会话"')
    expect(html).toContain('aria-label="在 beta 中新建会话"')
    expect(html).toContain('title="新建会话"')
    // 新建会话按钮应位于同工作区移除按钮之前
    expect(html).toMatch(/aria-label="在 alpha 中新建会话"[\s\S]*aria-label="移除工作目录 alpha"/u)
    // 未授权工作区不显示新建会话按钮
    expect(html).not.toContain('aria-label="在 尚未添加工作目录 中新建会话"')
  })

  it('does not render a new-session button for unauthorised workspace groups', () => {
    // 模拟只存在于历史 session 里的旧工作区（不在 authorizedWorkspaces 列表中）
    mocks.authorizedWorkspaces = []
    mocks.sessions = [stubSession({
      id: 'orphan',
      title: 'orphan task',
      workspace: { path: '/repo/legacy', name: 'legacy' },
    })]
    const html = renderToStaticMarkup(createElement(Sidebar))
    // 该 group 整体被过滤，因此既没有移除按钮也没有新建会话按钮。
    expect(html).not.toContain('legacy')
    expect(html).not.toContain('orphan task')
    expect(html).not.toContain('aria-label="在 legacy 中新建会话"')
  })

  it('does not render a remove button for unauthorised workspace groups', () => {
    // 模拟只存在于历史 session 里的旧工作区（不在 authorizedWorkspaces 列表中）
    mocks.authorizedWorkspaces = []
    mocks.sessions = [stubSession({
      id: 'orphan',
      title: 'orphan task',
      workspace: { path: '/repo/legacy', name: 'legacy' },
    })]
    const html = renderToStaticMarkup(createElement(Sidebar))
    // 该 group 整体被过滤（path 不在 authorizedWorkspaces），
    // 包括其下 session 一并从工作区列表消失，避免与"已移除但数据库未清"
    // 的中间态出现视觉错位。
    expect(html).not.toContain('legacy')
    expect(html).not.toContain('orphan task')
    expect(html).not.toContain('aria-label="移除工作目录 legacy"')
  })

  it('does not render sessions without a workspace in the workspace list', () => {
    mocks.authorizedWorkspaces = [{ path: '/repo/alpha', name: 'alpha' }]
    mocks.sessions = [
      stubSession({
        id: 'bound',
        title: 'bound task',
        workspace: { path: '/repo/alpha', name: 'alpha' },
      }),
      stubSession({
        id: 'unbound',
        title: 'unbound task',
        workspace: null,
      }),
    ]
    const html = renderToStaticMarkup(createElement(Sidebar))
    expect(html).toContain('bound task')
    expect(html).not.toContain('unbound task')
    expect(html).not.toContain('未绑定工作目录')
  })

  it('keeps the add-workspace button in the workspace header unchanged', () => {
    mocks.authorizedWorkspaces = [{ path: '/repo/alpha', name: 'alpha' }]
    const html = renderToStaticMarkup(createElement(Sidebar))
    // header 内的"添加工作目录"按钮仍然只渲染一次（不被新的移除按钮同名干扰）
    expect(html.match(/aria-label="添加工作目录"/gu)).toHaveLength(1)
    // 移除按钮命名空间独立
    expect(html.match(/aria-label="移除工作目录 alpha"/gu)).toHaveLength(1)
  })
})
