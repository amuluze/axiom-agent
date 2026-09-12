// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PendingToolApproval } from '@/agent/approval/ApprovalCoordinator'
import type { StoredAgentSession } from '@/persistence/types'
import { useAgentStore } from '@/stores/agentStore'
import { BackgroundApprovals } from './BackgroundApprovals'

const storedSession = (overrides: Partial<StoredAgentSession> = {}): StoredAgentSession => ({
  id: 'session-bg',
  title: '后台任务',
  systemPrompt: '',
  modelProvider: 'demo',
  modelId: 'demo-model',
  reasoning: null,
  activeToolNames: [],
  providerConfig: null,
  runtimeManifest: null,
  status: 'running',
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  parentSessionId: null,
  forkedFromMessageId: null,
  branchKind: null,
  retriedMessageId: null,
  ...overrides,
})

const approval = (overrides: Partial<PendingToolApproval> = {}): PendingToolApproval => ({
  sessionId: 'session-bg',
  runId: 'run-1',
  toolCallId: 'call-bg',
  toolName: 'create_workspace_file',
  toolLabel: '创建工作区文件',
  presentation: {
    title: '创建 notes.txt？',
    description: '将创建新文件',
    path: 'notes.txt',
    preview: '+ content',
  },
  ...overrides,
})

describe('BackgroundApprovals (RTL)', () => {
  afterEach(() => {
    // 还原为空审批态，避免污染其他用例读取的 store 切片。
    useAgentStore.setState({ backgroundApprovals: [], sessions: [] })
  })

  it('无后台审批时不渲染', () => {
    useAgentStore.setState({ backgroundApprovals: [] })
    const { container } = render(<BackgroundApprovals />)
    expect(container).toBeEmptyDOMElement()
  })

  it('列出后台审批并直接放行/拒绝（不切换会话）', async () => {
    const approveToolCall = vi.fn().mockResolvedValue(undefined)
    const denyToolCall = vi.fn().mockResolvedValue(undefined)
    useAgentStore.setState({
      backgroundApprovals: [approval()],
      sessions: [storedSession()],
      approveToolCall,
      denyToolCall,
    })
    render(<BackgroundApprovals />)

    expect(screen.getByText('后台任务')).toBeInTheDocument()
    screen.getByRole('button', { name: '允许一次' }).click()
    await Promise.resolve()
    expect(approveToolCall).toHaveBeenCalledWith('call-bg')

    screen.getByRole('button', { name: '拒绝' }).click()
    await Promise.resolve()
    expect(denyToolCall).toHaveBeenCalledWith('call-bg')
  })

  it('高危审批禁用一键放行，要求切换会话确认', () => {
    useAgentStore.setState({
      backgroundApprovals: [approval({
        presentation: {
          title: '执行 rm -rf？',
          description: '高危命令',
          path: '.',
          preview: 'rm -rf build',
          danger: true,
        },
      })],
      sessions: [],
    })
    render(<BackgroundApprovals />)

    const approve = screen.getByRole('button', { name: '需切换会话确认' })
    expect(approve).toBeDisabled()
    // 会话已不在列表中（被归档等）：标题回退为「未命名会话」。
    expect(screen.getByText('未命名会话')).toBeInTheDocument()
  })
})
