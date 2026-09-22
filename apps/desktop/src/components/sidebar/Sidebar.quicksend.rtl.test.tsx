// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import type { StoredAgentSession } from '@/persistence/types'

const mocks = vi.hoisted(() => ({
  sessions: [] as StoredAgentSession[],
  activeSessionId: null as string | null,
  authorizedWorkspaces: [] as Array<{ path: string; name: string; gitBranch?: string | null }>,
  sendToSession: vi.fn(async () => true),
  releaseQueuedForSession: vi.fn(async () => true),
  sessionQueueCounts: {} as Record<string, number>,
}))

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T => selector({
      ...original.useAgentStore.getState(),
      sessions: mocks.sessions,
      activeSessionId: mocks.activeSessionId,
      authorizedWorkspaces: mocks.authorizedWorkspaces,
      sendToSession: mocks.sendToSession,
      releaseQueuedForSession: mocks.releaseQueuedForSession,
      sessionQueueCounts: mocks.sessionQueueCounts,
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
    } as ConnectState),
  }
})

const stubSession = (overrides: Partial<StoredAgentSession> = {}): StoredAgentSession => ({
  id: 'background-session',
  title: '后台任务',
  systemPrompt: '',
  modelProvider: 'generic-anthropic-compatible',
  modelId: 'claude-test',
  reasoning: null,
  activeToolNames: [],
  providerConfig: null,
  runtimeManifest: null,
  status: 'idle',
  createdAt: 0,
  updatedAt: Date.now(),
  messageCount: 0,
  parentSessionId: null,
  forkedFromMessageId: null,
  branchKind: null,
  retriedMessageId: null,
  workspace: { path: '/repo', name: 'repo' },
  ...overrides,
})

describe('Sidebar 后台快捷发送 (RTL)', () => {
  afterEach(() => {
    mocks.sessions = []
    mocks.activeSessionId = null
    mocks.authorizedWorkspaces = []
    mocks.sendToSession.mockClear()
    mocks.sendToSession.mockResolvedValue(true)
    mocks.releaseQueuedForSession.mockClear()
    mocks.releaseQueuedForSession.mockResolvedValue(true)
    mocks.sessionQueueCounts = {}
  })

  it('不切换会话：行内输入发送消息到后台会话', async () => {
    const user = userEvent.setup()
    mocks.authorizedWorkspaces = [{ path: '/repo', name: 'repo' }]
    mocks.sessions = [stubSession()]

    render(createElement(Sidebar))
    await user.click(screen.getByRole('button', { name: '向会话 后台任务 发送消息' }))

    const input = screen.getByLabelText('发送消息到会话 后台任务')
    await user.type(input, '继续重构登录模块')
    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(mocks.sendToSession).toHaveBeenCalledWith('background-session', '继续重构登录模块')
    // 发起成功后输入收起。
    expect(screen.queryByLabelText('发送消息到会话 后台任务')).not.toBeInTheDocument()
  })

  it('Enter 提交与 Escape 收起', async () => {
    const user = userEvent.setup()
    mocks.authorizedWorkspaces = [{ path: '/repo', name: 'repo' }]
    mocks.sessions = [stubSession()]

    render(createElement(Sidebar))
    await user.click(screen.getByRole('button', { name: '向会话 后台任务 发送消息' }))
    const input = screen.getByLabelText('发送消息到会话 后台任务')
    await user.type(input, '跑一下测试{escape}')
    expect(mocks.sendToSession).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('发送消息到会话 后台任务')).not.toBeInTheDocument()

    // 重新展开再走 Enter 提交路径。
    await user.click(screen.getByRole('button', { name: '向会话 后台任务 发送消息' }))
    await user.type(screen.getByLabelText('发送消息到会话 后台任务'), '跑一下测试{enter}')
    expect(mocks.sendToSession).toHaveBeenCalledWith('background-session', '跑一下测试')
  })

  it('发起失败时保留输入与草稿，便于重试', async () => {
    const user = userEvent.setup()
    mocks.authorizedWorkspaces = [{ path: '/repo', name: 'repo' }]
    mocks.sessions = [stubSession()]
    mocks.sendToSession.mockResolvedValue(false)

    render(createElement(Sidebar))
    await user.click(screen.getByRole('button', { name: '向会话 后台任务 发送消息' }))
    await user.type(screen.getByLabelText('发送消息到会话 后台任务'), '重试这条')
    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(mocks.sendToSession).toHaveBeenCalledWith('background-session', '重试这条')
    expect(screen.getByLabelText('发送消息到会话 后台任务')).toBeInTheDocument()
    expect(screen.getByLabelText('发送消息到会话 后台任务')).toHaveValue('重试这条')
  })

  it('有待发送队列的后台会话显示放行按钮，点击走 releaseQueuedForSession', async () => {
    const user = userEvent.setup()
    mocks.authorizedWorkspaces = [{ path: '/repo', name: 'repo' }]
    mocks.sessions = [stubSession()]
    mocks.sessionQueueCounts = { 'background-session': 2 }

    render(createElement(Sidebar))
    const releaseButton = screen.getByRole('button', { name: '放行会话 后台任务 的队首待发送消息' })
    await user.click(releaseButton)
    expect(mocks.releaseQueuedForSession).toHaveBeenCalledWith('background-session')
  })

  it('无待发送队列时不显示放行按钮', () => {
    mocks.authorizedWorkspaces = [{ path: '/repo', name: 'repo' }]
    mocks.sessions = [stubSession()]
    mocks.sessionQueueCounts = {}

    render(createElement(Sidebar))
    expect(screen.queryByRole('button', { name: '放行会话 后台任务 的队首待发送消息' }))
      .not.toBeInTheDocument()
  })
})
