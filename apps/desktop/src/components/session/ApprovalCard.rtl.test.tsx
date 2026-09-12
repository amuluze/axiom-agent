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
      } as StoreState),
  }
})

afterEach(() => {
  mocks.pendingApproval = null
  mocks.approveToolCall.mockClear()
  mocks.denyToolCall.mockClear()
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
})
