// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalCard } from './ApprovalCard'

const mocks = vi.hoisted(() => ({
  pendingApproval: null as {
    toolCallId: string
    toolName: string
    sessionId: string
    presentation: {
      title: string
      description: string
      category?: 'workspace-write' | 'workspace-command'
      path?: string
      preview?: string
      changes?: Array<{ path: string; preview: string }>
      danger?: boolean
    }
  } | null,
  approveToolCall: vi.fn<(toolCallId: string) => Promise<void>>(),
  denyToolCall: vi.fn<(toolCallId: string) => Promise<void>>(),
  accessMode: 'standard' as 'standard' | 'no-approval',
  accessModeChanging: false,
  setAccessMode: vi.fn<(mode: 'standard' | 'no-approval') => Promise<string | null>>(),
}))

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T =>
      selector({
        ...original.useAgentStore.getState(),
        pendingApproval: mocks.pendingApproval,
        approveToolCall: mocks.approveToolCall,
        denyToolCall: mocks.denyToolCall,
        accessMode: mocks.accessMode,
        accessModeChanging: mocks.accessModeChanging,
        setAccessMode: mocks.setAccessMode,
      } as StoreState),
  }
})

afterEach(() => {
  mocks.pendingApproval = null
  mocks.approveToolCall.mockClear()
  mocks.denyToolCall.mockClear()
  mocks.accessMode = 'standard'
  mocks.accessModeChanging = false
  mocks.setAccessMode.mockReset()
  mocks.setAccessMode.mockResolvedValue(null)
})

const pending = {
  toolCallId: 'tc-1',
  toolName: 'write',
  sessionId: 's-1',
  presentation: {
    title: 'Write one file?',
    description: 'Axiom 将写入 src/a.ts。',
  },
}

describe('ApprovalCard (RTL)', () => {
  it('点击允许一次时调用 approveToolCall', async () => {
    const user = userEvent.setup()
    mocks.pendingApproval = pending
    render(<ApprovalCard />)
    await user.click(screen.getByRole('button', { name: '允许一次' }))
    expect(mocks.approveToolCall).toHaveBeenCalledTimes(1)
    expect(mocks.approveToolCall).toHaveBeenCalledWith('tc-1')
  })

  it('点击拒绝时调用 denyToolCall', async () => {
    const user = userEvent.setup()
    mocks.pendingApproval = pending
    render(<ApprovalCard />)
    await user.click(screen.getByRole('button', { name: '拒绝' }))
    expect(mocks.denyToolCall).toHaveBeenCalledTimes(1)
    expect(mocks.denyToolCall).toHaveBeenCalledWith('tc-1')
  })

  it('命令类审批显示工作目录标签与命令预览', async () => {
    mocks.pendingApproval = {
      ...pending,
      toolName: 'bash',
      presentation: {
        ...pending.presentation,
        title: 'Run tests?',
        description: '执行项目代码。',
        category: 'workspace-command',
        path: '.',
        preview: 'npm test',
      },
    }
    render(<ApprovalCard />)
    expect(screen.getByText('工作目录')).toBeInTheDocument()
    expect(screen.getByText('npm test')).toBeInTheDocument()
  })

  it('高危命令必须勾选确认后才允许放行', async () => {
    const user = userEvent.setup()
    mocks.pendingApproval = {
      ...pending,
      toolName: 'bash',
      presentation: {
        ...pending.presentation,
        title: 'Run rm?',
        description: '执行高风险命令。',
        category: 'workspace-command',
        preview: 'rm -rf node_modules',
        danger: true,
      },
    }
    render(<ApprovalCard />)
    const allowButton = screen.getByRole('button', { name: '允许一次' })
    expect(allowButton).toBeDisabled()
    await user.click(allowButton)
    expect(mocks.approveToolCall).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: /仍允许执行一次/ }))
    expect(allowButton).toBeEnabled()
    await user.click(allowButton)
    expect(mocks.approveToolCall).toHaveBeenCalledTimes(1)
    expect(mocks.approveToolCall).toHaveBeenCalledWith('tc-1')
  })

  it('切换审批后重置高危确认勾选', async () => {
    const user = userEvent.setup()
    mocks.pendingApproval = {
      ...pending,
      presentation: { ...pending.presentation, danger: true },
    }
    const { rerender } = render(<ApprovalCard />)
    await user.click(screen.getByRole('checkbox', { name: /仍允许执行一次/ }))
    expect(screen.getByRole('button', { name: '允许一次' })).toBeEnabled()
    // store mock 无订阅通知，改 mock 后需显式 rerender 触发新审批的渲染。
    mocks.pendingApproval = {
      ...pending,
      toolCallId: 'tc-2',
      presentation: { ...pending.presentation, danger: true },
    }
    rerender(<ApprovalCard />)
    expect(screen.getByRole('button', { name: '允许一次' })).toBeDisabled()
  })

  it('点击完全访问把当前会话切到 no-approval，且不代替用户放行本次调用', async () => {
    const user = userEvent.setup()
    mocks.pendingApproval = pending
    render(<ApprovalCard />)

    await user.click(screen.getByRole('button', { name: '完全访问' }))

    expect(mocks.setAccessMode).toHaveBeenCalledTimes(1)
    expect(mocks.setAccessMode).toHaveBeenCalledWith('no-approval')
    // 模式切换只改档位：本次调用仍由用户点「允许一次」放行（原生警告确认在 Rust 侧）。
    expect(mocks.approveToolCall).not.toHaveBeenCalled()
  })

  it('模式切换被取消时在卡片内提示原因', async () => {
    const user = userEvent.setup()
    mocks.setAccessMode.mockResolvedValue('切换访问模式失败：用户取消启用完全访问')
    mocks.pendingApproval = pending
    render(<ApprovalCard />)

    await user.click(screen.getByRole('button', { name: '完全访问' }))

    // 卡片本身是 role="alert"，这里按文案定位切换失败提示。
    expect(await screen.findByText(/用户取消启用完全访问/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '完全访问' })).toBeEnabled()
  })

  it('已是完全访问时不重复提供切换按钮', () => {
    mocks.accessMode = 'no-approval'
    mocks.pendingApproval = pending
    render(<ApprovalCard />)
    expect(screen.queryByRole('button', { name: '完全访问' })).toBeNull()
    expect(screen.getByRole('button', { name: '允许一次' })).toBeInTheDocument()
  })
})
