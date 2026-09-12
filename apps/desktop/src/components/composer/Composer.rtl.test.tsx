// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer'

const mocks = vi.hoisted(() => ({
  authorizedWorkspace: null as { path: string; name: string; gitBranch?: string | null } | null,
  authorizedWorkspaces: [] as Array<{ path: string; name: string; gitBranch?: string | null }>,
  recentWorkspacePaths: [] as string[],
  addWorkspace: vi.fn(async () => true),
  activateWorkspace: vi.fn(async () => true),
  running: false,
  sessionBusy: false,
  providerReady: true,
  providerSetupRequired: false,
  compactionRunning: false,
  branchSummaryRunning: false,
  accessMode: 'standard' as 'standard' | 'no-approval',
  setAccessMode: vi.fn(),
  messages: [] as unknown[],
  contextUsage: null as { tokenPercent: number; bytePercent: number; estimatedTokens: number; contextWindow: number; requestBytes: number; needsCompaction: boolean } | null,
  contextCheckpoint: null as { summary: string } | null,
  setSummaryRequest: vi.fn(),
}))

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T => selector({
      ...original.useAgentStore.getState(),
      provider: {
        ...original.useAgentStore.getState().provider,
        providerId: 'demo',
      },
      providerReady: mocks.providerReady,
      providerSetupRequired: mocks.providerSetupRequired,
      running: mocks.running,
      sessionBusy: mocks.sessionBusy,
      compactionRunning: mocks.compactionRunning,
      branchSummaryRunning: mocks.branchSummaryRunning,
      authorizedWorkspace: mocks.authorizedWorkspace,
      authorizedWorkspaces: mocks.authorizedWorkspaces,
      addWorkspace: mocks.addWorkspace,
      activateWorkspace: mocks.activateWorkspace,
      send: vi.fn(async () => undefined),
      messages: mocks.messages,
      contextUsage: mocks.contextUsage,
      contextCheckpoint: mocks.contextCheckpoint,
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
      accessMode: mocks.accessMode,
      setAccessMode: mocks.setAccessMode,
      recentWorkspacePaths: mocks.recentWorkspacePaths,
      setSummaryRequest: mocks.setSummaryRequest,
    } as UiState),
  }
})

beforeEach(() => {
  mocks.authorizedWorkspace = { path: '/repo', name: 'repo', gitBranch: 'main' }
  mocks.authorizedWorkspaces = [
    { path: '/repo', name: 'repo', gitBranch: 'main' },
    { path: '/other', name: 'other', gitBranch: null },
  ]
  mocks.recentWorkspacePaths = ['/other', '/repo']
  mocks.addWorkspace.mockClear()
  mocks.activateWorkspace.mockClear()
  mocks.setAccessMode.mockClear()
  mocks.setSummaryRequest.mockClear()
  mocks.running = false
  mocks.sessionBusy = false
  mocks.messages = []
  mocks.contextUsage = null
  mocks.contextCheckpoint = null
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('Composer project picker', () => {
  it('renders the current project name on the trigger', () => {
    render(<Composer variant="new-task" />)
    expect(screen.getByRole('button', { name: '选择项目' })).toBeInTheDocument()
    expect(screen.getByText('repo')).toBeInTheDocument()
  })

  it('renders the git branch on the trigger when the workspace is a git repo', () => {
    render(<Composer variant="new-task" />)
    expect(screen.getByText('main')).toBeInTheDocument()
  })

  it('hides the git branch on the trigger when the workspace is not a git repo', () => {
    mocks.authorizedWorkspace = { path: '/plain', name: 'plain', gitBranch: null }
    render(<Composer variant="new-task" />)
    expect(screen.getByText('plain')).toBeInTheDocument()
    expect(screen.queryByText('main')).not.toBeInTheDocument()
  })

  it('opens a menu with recent workspaces and an open-new-directory action', async () => {
    const user = userEvent.setup()
    render(<Composer variant="new-task" />)
    await user.click(screen.getByRole('button', { name: '选择项目' }))
    expect(screen.getByText('最近打开')).toBeInTheDocument()
    expect(screen.getByText('打开新目录')).toBeInTheDocument()
    expect(screen.getByText('other')).toBeInTheDocument()
  })

  it('orders recent workspaces most-recent-first', async () => {
    const user = userEvent.setup()
    render(<Composer variant="new-task" />)
    await user.click(screen.getByRole('button', { name: '选择项目' }))
    const items = screen.getAllByRole('menuitem')
    const labels = items.map((item) => item.textContent ?? '')
    expect(labels).toEqual(['other', 'repo · main', '打开新目录'])
  })

  it('does not render legacy authorization-management items', async () => {
    const user = userEvent.setup()
    render(<Composer variant="new-task" />)
    await user.click(screen.getByRole('button', { name: '选择项目' }))
    expect(screen.queryByText('为当前会话更换目录')).not.toBeInTheDocument()
    expect(screen.queryByText('添加单文件读取授权')).not.toBeInTheDocument()
    expect(screen.queryByText('撤销工作目录授权')).not.toBeInTheDocument()
    expect(screen.queryByText('已授权工作目录')).not.toBeInTheDocument()
    expect(screen.queryByText('单文件授权')).not.toBeInTheDocument()
  })

  it('activates a workspace when a recent item is clicked', async () => {
    const user = userEvent.setup()
    render(<Composer variant="new-task" />)
    await user.click(screen.getByRole('button', { name: '选择项目' }))
    await user.click(screen.getByText('other'))
    expect(mocks.activateWorkspace).toHaveBeenCalledWith('/other')
  })

  it('calls addWorkspace when open-new-directory is clicked', async () => {
    const user = userEvent.setup()
    render(<Composer variant="new-task" />)
    await user.click(screen.getByRole('button', { name: '选择项目' }))
    await user.click(screen.getByText('打开新目录'))
    expect(mocks.addWorkspace).toHaveBeenCalledOnce()
  })

  it('shows an empty state when there are no recent workspaces', async () => {
    mocks.recentWorkspacePaths = []
    const user = userEvent.setup()
    render(<Composer variant="new-task" />)
    await user.click(screen.getByRole('button', { name: '选择项目' }))
    expect(screen.getByText('暂无最近打开的项目')).toBeInTheDocument()
  })
})

describe('Composer menu dismissal', () => {
  it('closes the project menu when clicking outside the picker', async () => {
    const user = userEvent.setup()
    render(<Composer variant="new-task" />)
    await user.click(screen.getByRole('button', { name: '选择项目' }))
    expect(screen.getByText('最近打开')).toBeInTheDocument()
    // 点击 Composer 输入框（菜单外）→ 菜单收起
    await user.click(screen.getByLabelText('发送给 Axiom'))
    expect(screen.queryByText('最近打开')).not.toBeInTheDocument()
  })

  it('closes the access menu when clicking outside', async () => {
    const user = userEvent.setup()
    render(<Composer variant="new-task" />)
    await user.click(screen.getByRole('button', { name: '访问模式' }))
    expect(screen.getByText('选择访问模式')).toBeInTheDocument()
    await user.click(screen.getByLabelText('发送给 Axiom'))
    expect(screen.queryByText('选择访问模式')).not.toBeInTheDocument()
  })

  it('closes the model menu when clicking outside', async () => {
    const user = userEvent.setup()
    render(<Composer variant="new-task" />)
    await user.click(screen.getByRole('button', { name: '切换模型' }))
    expect(screen.getByText('当前会话模型')).toBeInTheDocument()
    await user.click(screen.getByLabelText('发送给 Axiom'))
    expect(screen.queryByText('当前会话模型')).not.toBeInTheDocument()
  })

  it('closes one menu when another selector is opened (mutually exclusive)', async () => {
    const user = userEvent.setup()
    render(<Composer variant="new-task" />)
    await user.click(screen.getByRole('button', { name: '选择项目' }))
    expect(screen.getByText('最近打开')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '访问模式' }))
    expect(screen.queryByText('最近打开')).not.toBeInTheDocument()
    expect(screen.getByText('选择访问模式')).toBeInTheDocument()
  })

  it('closes the project menu on Escape', async () => {
    const user = userEvent.setup()
    render(<Composer variant="new-task" />)
    await user.click(screen.getByRole('button', { name: '选择项目' }))
    expect(screen.getByText('最近打开')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByText('最近打开')).not.toBeInTheDocument()
  })
})

describe('Composer context budget popover', () => {
  const enableBudget = () => {
    mocks.messages = [{}, {}]
    mocks.contextUsage = {
      tokenPercent: 45,
      bytePercent: 30,
      estimatedTokens: 90_000,
      contextWindow: 200_000,
      requestBytes: 1024 * 500,
      needsCompaction: false,
    }
  }

  it('opens the budget panel from the trigger and closes on outside click', async () => {
    enableBudget()
    const user = userEvent.setup()
    render(<Composer />)
    await user.click(screen.getByRole('button', { name: '上下文预算' }))
    expect(screen.getByRole('dialog', { name: '上下文预算' })).toBeInTheDocument()
    expect(screen.getByText('90.0K / 200K tokens')).toBeInTheDocument()
    await user.click(screen.getByLabelText('发送给 Axiom'))
    expect(screen.queryByRole('dialog', { name: '上下文预算' })).not.toBeInTheDocument()
  })

  it('closes the budget panel on Escape', async () => {
    enableBudget()
    const user = userEvent.setup()
    render(<Composer />)
    await user.click(screen.getByRole('button', { name: '上下文预算' }))
    expect(screen.getByRole('dialog', { name: '上下文预算' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '上下文预算' })).not.toBeInTheDocument()
  })

  it('closes the budget panel when another selector is opened', async () => {
    enableBudget()
    const user = userEvent.setup()
    render(<Composer />)
    await user.click(screen.getByRole('button', { name: '上下文预算' }))
    expect(screen.getByRole('dialog', { name: '上下文预算' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '访问模式' }))
    expect(screen.queryByRole('dialog', { name: '上下文预算' })).not.toBeInTheDocument()
    expect(screen.getByText('选择访问模式')).toBeInTheDocument()
  })

  it('triggers manual compaction and closes the panel', async () => {
    enableBudget()
    const user = userEvent.setup()
    render(<Composer />)
    await user.click(screen.getByRole('button', { name: '上下文预算' }))
    await user.click(screen.getByRole('button', { name: '手动压缩' }))
    expect(mocks.setSummaryRequest).toHaveBeenCalledWith({ mode: 'compaction' })
    expect(screen.queryByRole('dialog', { name: '上下文预算' })).not.toBeInTheDocument()
  })
})

describe('Composer upward menu viewport clamp', () => {
  const mockTriggerRect = (top: number) => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top,
      bottom: top + 30,
      height: 30,
      width: 220,
      left: 0,
      right: 220,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect)
    return rectSpy
  }

  it('打开菜单时把实测可用空间写入容器变量，关闭后清理', async () => {
    const rectSpy = mockTriggerRect(500)
    const user = userEvent.setup()
    render(<Composer variant="new-task" />)
    await user.click(screen.getByRole('button', { name: '选择项目' }))
    const picker = screen.getByRole('menu').parentElement as HTMLElement
    // 500 - 弹层间距 6 - 顶部余量 8
    expect(picker.style.getPropertyValue('--composer-menu-available')).toBe('486px')
    await user.click(screen.getByLabelText('发送给 Axiom'))
    expect(picker.style.getPropertyValue('--composer-menu-available')).toBe('')
    rectSpy.mockRestore()
  })

  it('空间超出首选上限时按上限钳制', async () => {
    const rectSpy = mockTriggerRect(4000)
    const user = userEvent.setup()
    render(<Composer variant="new-task" />)
    await user.click(screen.getByRole('button', { name: '切换模型' }))
    const picker = screen.getByRole('menu').parentElement as HTMLElement
    expect(picker.style.getPropertyValue('--composer-menu-available')).toBe('560px')
    await user.keyboard('{Escape}')
    expect(picker.style.getPropertyValue('--composer-menu-available')).toBe('')
    rectSpy.mockRestore()
  })
})
