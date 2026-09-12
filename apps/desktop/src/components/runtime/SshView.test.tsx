// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUiStore } from '@/stores/uiStore'

const mocks = vi.hoisted(() => ({
  activeSessionId: 'sess-1' as string | null,
}))

vi.mock('./SshHostsPanel', () => ({
  SshHostsPanel: ({ onBack }: { onBack?: () => void }) => (
    <div data-testid="ssh-hosts-panel-mock">
      <button data-testid="trigger-back" onClick={onBack}>返回</button>
    </div>
  ),
}))

vi.mock('./SshTerminalPanel', () => ({
  SshTerminalPanel: () => <div data-testid="ssh-terminal-panel-mock" />,
}))

vi.mock('@/stores/agentStore', () => ({
  useAgentStore: {
    getState: () => ({ activeSessionId: mocks.activeSessionId }),
  },
}))

const { SshView } = await import('./SshView')

beforeEach(() => {
  mocks.activeSessionId = 'sess-1'
  // 每次用例从可复现的初始态出发（view/终端面板开关）。
  useUiStore.setState({ view: 'ssh', terminalPanelOpen: false })
})

describe('SshView', () => {
  it('renders the window bar (traffic-light drag region) and both panes', () => {
    render(<SshView />)
    // 严格对齐设计稿：窗口栏仅可拖拽区（macOS 交通灯由系统绘制），无标题/按钮；
    // 返回键在左栏主机管理上方（SshHostsPanel 的 onBack），不在窗口栏。
    expect(document.querySelector('.sshview__windowbar')).toBeTruthy()
    expect(screen.queryByText('运行时面板')).toBeNull()
    expect(screen.queryByLabelText('关闭 SSH 视图')).toBeNull()
    expect(screen.queryByLabelText('切换本地终端面板')).toBeNull()
    expect(screen.getByTestId('ssh-hosts-panel-mock')).toBeTruthy()
    expect(screen.getByTestId('ssh-terminal-panel-mock')).toBeTruthy()
    // 左右分栏（主机管理 340px + 分隔线 + 终端列）。
    expect(document.querySelector('.sshview__body')).toBeTruthy()
    expect(document.querySelector('.sshview__divider')).toBeTruthy()
  })

  it('returns to the session view on back when a session is active', () => {
    render(<SshView />)
    fireEvent.click(screen.getByTestId('trigger-back'))
    expect(useUiStore.getState().view).toBe('session')
  })

  it('returns to the new-task view on back when no session is active', () => {
    mocks.activeSessionId = null
    render(<SshView />)
    fireEvent.click(screen.getByTestId('trigger-back'))
    expect(useUiStore.getState().view).toBe('new-task')
  })

  it('renders the default window chrome in SSR', () => {
    const html = renderToStaticMarkup(<SshView />)
    expect(html).toContain('sshview__windowbar')
    expect(html).not.toContain('运行时面板')
  })
})
