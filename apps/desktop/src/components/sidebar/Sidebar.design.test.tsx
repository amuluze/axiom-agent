// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import type { ConnectConfigSummary } from '@/platform/connect'

const mocks = vi.hoisted(() => ({
  view: 'new-task',
  sessions: [] as unknown[],
  authorizedWorkspace: null as { path: string; name: string; gitBranch?: string | null } | null,
  authorizedWorkspaces: [] as Array<{ path: string; name: string; gitBranch?: string | null }>,
  awaitingApprovalSessionIds: [] as string[],
  sessionQueueCounts: {} as Record<string, number>,
  availableUpdate: null as { version: string; notes: string | null; pubDate: string | null } | null,
  createNewSession: vi.fn(async () => true),
  addWorkspace: vi.fn(async () => true),
  revokeWorkspace: vi.fn(async () => true),
  connectConfig: { workspacePath: null, bindings: [], platforms: [] } as ConnectConfigSummary,
}))

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T => selector({
      ...original.useAgentStore.getState(),
      sessions: mocks.sessions,
      authorizedWorkspace: mocks.authorizedWorkspace,
      authorizedWorkspaces: mocks.authorizedWorkspaces,
      awaitingApprovalSessionIds: mocks.awaitingApprovalSessionIds,
      sessionQueueCounts: mocks.sessionQueueCounts,
      availableUpdate: mocks.availableUpdate,
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
    } as UiState),
  }
})

vi.mock('@/stores/connectStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/connectStore')>()
  return {
    ...original,
    useConnectStore: <T,>(selector: (state: { config: ConnectConfigSummary }) => T): T =>
      selector({ config: mocks.connectConfig }),
  }
})

// 设计助手面板懒加载：桩掉以断言装配与「侧栏其余区段让位」这一结构事实。
vi.mock('@/components/design/DesignAssistantPanel', () => ({
  default: () => <div data-testid="design-assistant-mock" />,
}))

describe('Sidebar 设计视图分支', () => {
  it('设计视图：侧栏只剩 Title Bar + 设计助手，Nav/工作区/任务列表/底栏全部让位', async () => {
    mocks.view = 'design'
    const { container } = render(<Sidebar />)
    // 懒加载 chunk 解析后出现（Suspense 初帧为 null）。
    await waitFor(() => expect(screen.getByTestId('design-assistant-mock')).toBeTruthy())
    expect(container.querySelector('.sidebar__titlebar')).not.toBeNull()
    expect(container.querySelector('.sidebar__nav')).toBeNull()
    expect(container.querySelector('.sidebar__workspace-header')).toBeNull()
    expect(container.querySelector('.sidebar__workspace-list')).toBeNull()
    expect(container.querySelector('.sidebar__bottom-bar')).toBeNull()
  })

  it('非设计视图：侧栏维持原结构（Nav/工作区/底栏在位，无设计助手）', () => {
    mocks.view = 'new-task'
    const { container } = render(<Sidebar />)
    expect(container.querySelector('.sidebar__nav')).not.toBeNull()
    expect(container.querySelector('.sidebar__workspace-header')).not.toBeNull()
    expect(container.querySelector('.sidebar__bottom-bar')).not.toBeNull()
    expect(screen.queryByTestId('design-assistant-mock')).toBeNull()
  })
})
