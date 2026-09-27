// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DesignAssistantPanel from './DesignAssistantPanel'
import { useUiStore } from '@/stores/uiStore'

const mocks = vi.hoisted(() => ({
  activeSessionId: null as string | null,
  messages: [] as unknown[],
  createNewSession: vi.fn(async () => true),
}))

vi.mock('@/stores/agentStore', () => ({
  useAgentStore: Object.assign(
    (selector: (state: typeof mocks) => unknown) => selector(mocks),
    { getState: () => mocks },
  ),
}))

// 消息流与 Composer 各自有独立测试：这里只验证面板的装配（分支与出口），
// 用桩替换避免拉起真实运行时。
vi.mock('@/components/session/SessionMessageStream', () => ({
  SessionMessageStream: () => <div data-testid="stream-mock" />,
}))
vi.mock('@/components/composer/Composer', () => ({
  Composer: ({ variant, showAccessPicker }: { variant?: string; showAccessPicker?: boolean }) => (
    <div
      data-testid="composer-mock"
      data-variant={variant}
      data-show-access-picker={String(showAccessPicker !== false)}
    />
  ),
}))

describe('DesignAssistantPanel 设计助手侧栏', () => {
  beforeEach(() => {
    mocks.activeSessionId = null
    mocks.messages = []
    mocks.createNewSession.mockClear()
    useUiStore.setState({ view: 'design' })
  })

  it('无会话：展示设计助手引导（标题/说明/三条清单）与开始入口', () => {
    render(<DesignAssistantPanel />)
    expect(screen.getByText('设计助手')).toBeTruthy()
    expect(screen.getByText('通过与模型对话，实时更新右侧设计稿')).toBeTruthy()
    expect(screen.getByText('描述设计意图，模型解析并修改')).toBeTruthy()
    expect(screen.getByText('多轮对话逐步调整布局与样式')).toBeTruthy()
    expect(screen.getByText('确认后一键落实到右侧设计稿')).toBeTruthy()
    expect(screen.getByText('开始设计会话')).toBeTruthy()
    expect(screen.queryByTestId('composer-mock')).toBeNull()
    expect(screen.queryByTestId('stream-mock')).toBeNull()
  })

  it('无会话：开始按钮建会话（不自动建，避免切进来就多一份空会话）', async () => {
    render(<DesignAssistantPanel />)
    fireEvent.click(screen.getByText('开始设计会话'))
    await waitFor(() => expect(mocks.createNewSession).toHaveBeenCalledTimes(1))
  })

  it('有会话但无消息：保留引导 + 真实 Composer（session 变体，不劫持视图；隐藏审批下拉）', () => {
    mocks.activeSessionId = 's1'
    render(<DesignAssistantPanel />)
    expect(screen.getByText('设计助手')).toBeTruthy()
    expect(screen.getByTestId('composer-mock').getAttribute('data-variant')).toBe('session')
    expect(screen.getByTestId('composer-mock').getAttribute('data-show-access-picker')).toBe('false')
    expect(screen.queryByText('开始设计会话')).toBeNull()
    expect(screen.queryByTestId('stream-mock')).toBeNull()
  })

  it('有消息：渲染消息流并保留 Composer', () => {
    mocks.activeSessionId = 's1'
    mocks.messages = [{ id: 'm1', role: 'user', content: '把按钮改主色' }]
    render(<DesignAssistantPanel />)
    expect(screen.getByTestId('stream-mock')).toBeTruthy()
    expect(screen.getByTestId('composer-mock')).toBeTruthy()
    expect(screen.queryByText('设计助手')).toBeNull()
  })

  it('返回：有会话回会话页，无会话回新任务页', () => {
    mocks.activeSessionId = 's1'
    const { unmount } = render(<DesignAssistantPanel />)
    fireEvent.click(screen.getByText('返回'))
    expect(useUiStore.getState().view).toBe('session')
    unmount()

    mocks.activeSessionId = null
    useUiStore.setState({ view: 'design' })
    render(<DesignAssistantPanel />)
    fireEvent.click(screen.getByText('返回'))
    expect(useUiStore.getState().view).toBe('new-task')
  })

  it('橡皮擦：新建设计会话（开一份干净对话）', async () => {
    mocks.activeSessionId = 's1'
    mocks.messages = [{ id: 'm1', role: 'user', content: '旧对话' }]
    render(<DesignAssistantPanel />)
    fireEvent.click(screen.getByLabelText('新建设计会话'))
    await waitFor(() => expect(mocks.createNewSession).toHaveBeenCalledTimes(1))
  })
})
