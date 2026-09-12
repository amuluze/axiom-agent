// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import type { StoredAgentSession } from '@/persistence/types'

const mocks = vi.hoisted(() => ({
  sessions: [] as StoredAgentSession[],
  authorizedWorkspaces: [] as Array<{ path: string; name: string; gitBranch?: string | null }>,
  setSettingsSection: vi.fn(),
  setView: vi.fn(),
  closeSidebarOverlay: vi.fn(),
  activateWorkspace: vi.fn(async () => true),
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
      authorizedWorkspace: null,
      authorizedWorkspaces: mocks.authorizedWorkspaces,
      selectSession: vi.fn(),
      createNewSession: vi.fn(async () => true),
      addWorkspace: vi.fn(async () => true),
      activateWorkspace: mocks.activateWorkspace,
      revokeWorkspace: vi.fn(async () => true),
      archiveSession: vi.fn(async () => true),
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
      view: 'new-task',
      setView: mocks.setView,
      setSettingsSection: mocks.setSettingsSection,
      closeSidebarOverlay: mocks.closeSidebarOverlay,
    } as UiState),
  }
})

afterEach(() => {
  mocks.sessions = []
  mocks.authorizedWorkspaces = []
  mocks.setSettingsSection.mockClear()
  mocks.setView.mockClear()
  mocks.closeSidebarOverlay.mockClear()
  mocks.activateWorkspace.mockClear()
})

describe('Sidebar 技能菜单（RTL）', () => {
  it('技能按钮可点击，点击后跳转到设置-技能页', () => {
    render(<Sidebar />)
    const button = screen.getByRole('button', { name: '技能' })
    expect(button).not.toBeDisabled()

    fireEvent.click(button)

    expect(mocks.setSettingsSection).toHaveBeenCalledWith('skills')
    expect(mocks.setView).toHaveBeenCalledWith('settings')
    expect(mocks.closeSidebarOverlay).toHaveBeenCalledTimes(1)
  })

  it('SSH 导航项点击后打开 SSH 全窗口视图', () => {
    render(<Sidebar />)
    const button = screen.getByRole('button', { name: 'SSH' })
    expect(button).not.toBeDisabled()

    fireEvent.click(button)

    expect(mocks.setView).toHaveBeenCalledWith('ssh')
    expect(mocks.closeSidebarOverlay).toHaveBeenCalledTimes(1)
  })

  it('工作目录默认展开，点击折叠后隐藏会话并以不同图标区分', () => {
    mocks.authorizedWorkspaces = [{ path: '/repo', name: 'repo' }]
    mocks.sessions = [stubSession({
      id: 's1',
      title: 'task-1',
      workspace: { path: '/repo', name: 'repo' },
    })]

    render(<Sidebar />)

    // 展开态：显示收起按钮与下方会话
    const collapseButton = screen.getByRole('button', { name: '收起工作目录 repo' })
    expect(screen.getByText('task-1')).toBeInTheDocument()

    fireEvent.click(collapseButton)

    // 折叠态：按钮变为展开图标，会话列表隐藏
    expect(screen.getByRole('button', { name: '展开工作目录 repo' })).toBeInTheDocument()
    expect(screen.queryByText('task-1')).not.toBeInTheDocument()
  })

  it('点击整行（非图标区域）也会切换展开/收起并激活工作目录', () => {
    mocks.authorizedWorkspaces = [{ path: '/repo', name: 'repo' }]
    mocks.sessions = [stubSession({
      id: 's1',
      title: 'task-1',
      workspace: { path: '/repo', name: 'repo' },
    })]

    render(<Sidebar />)

    expect(screen.getByText('task-1')).toBeInTheDocument()

    // 点击项目名称（行的主体区域，而非折叠图标）
    fireEvent.click(screen.getByText('repo'))

    // 折叠：会话列表隐藏，图标切换为展开
    expect(screen.getByRole('button', { name: '展开工作目录 repo' })).toBeInTheDocument()
    expect(screen.queryByText('task-1')).not.toBeInTheDocument()
    // 原有的激活工作目录行为保留
    expect(mocks.activateWorkspace).toHaveBeenCalledWith('/repo')

    // 再次点击整行可展开恢复会话列表
    fireEvent.click(screen.getByText('repo'))
    expect(screen.getByText('task-1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '收起工作目录 repo' })).toBeInTheDocument()
  })

  it('未授权工作目录的空占位不渲染折叠按钮', () => {
    render(<Sidebar />)
    expect(screen.queryByRole('button', { name: /收起工作目录|展开工作目录/u })).not.toBeInTheDocument()
  })
})
