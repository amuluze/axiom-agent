// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer'
import { MAX_PASTE_IMAGES, bytesToBase64 } from './imagePaste'

const mocks = vi.hoisted(() => ({
  authorizedWorkspace: null as { path: string; name: string; gitBranch?: string | null } | null,
  authorizedWorkspaces: [] as Array<{ path: string; name: string; gitBranch?: string | null }>,
  recentWorkspacePaths: [] as string[],
  addWorkspace: vi.fn(async () => true),
  activateWorkspace: vi.fn(async () => true),
  send: vi.fn(async (_content: string, _images?: unknown) => undefined),
  queueSteering: vi.fn(async (_content: string, _images?: unknown) => true),
  // 粘贴测试可覆盖为视觉模型 provider；默认沿用 store 原始 provider
  providerOverride: null as Record<string, unknown> | null,
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
  const stateWithMocks = () => ({
    ...original.useAgentStore.getState(),
    provider: (mocks.providerOverride ?? {
      ...original.useAgentStore.getState().provider,
      providerId: 'demo',
    }) as unknown as ReturnType<typeof original.useAgentStore.getState>['provider'],
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
    send: mocks.send,
    queueSteering: mocks.queueSteering,
    messages: mocks.messages,
    contextUsage: mocks.contextUsage,
    contextCheckpoint: mocks.contextCheckpoint,
  } as StoreState)
  // deliverInput 的发送分支经 getState() 复核可用性，mock 必须同形提供。
  const useAgentStore = ((selector: (state: StoreState) => unknown): unknown =>
    selector(stateWithMocks())) as unknown as typeof original.useAgentStore
  useAgentStore.getState = () => stateWithMocks()
  return {
    ...original,
    useAgentStore,
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
  mocks.send.mockClear()
  mocks.queueSteering.mockClear()
  mocks.providerOverride = null
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

describe('Composer 粘贴截图', () => {
  beforeEach(() => {
    // 视觉模型 provider：绕开 demo 的纯文本目录声明，走完整粘贴链路
    mocks.providerOverride = {
      schemaVersion: 3,
      profileId: 'builtin.ollama',
      providerId: 'ollama',
      apiFormat: 'openai-compatible',
      modelId: 'gemma3',
      timeoutMs: 60_000,
      maxOutputTokens: 8_192,
      contextWindow: 128_000,
    } as never
  })

  const pasteImage = (element: Element, files: File[]) => {
    fireEvent.paste(element, {
      clipboardData: {
        items: files.map((file) => ({ type: file.type, getAsFile: () => file })),
        files,
      },
    })
  }

  const makeShot = (bytes: number[] = [137, 80, 78, 71], name = 'shot.png') =>
    new File([new Uint8Array(bytes)], name, { type: 'image/png' })

  it('粘贴截图后出现附件缩略图，可移除', async () => {
    render(<Composer />)
    pasteImage(screen.getByLabelText('发送给 Axiom'), [makeShot()])
    await waitFor(() => {
      expect(screen.getByLabelText('已附加的截图')).toBeInTheDocument()
    })
    await userEvent.setup().click(screen.getByRole('button', { name: '移除这张截图' }))
    expect(screen.queryByLabelText('已附加的截图')).not.toBeInTheDocument()
  })

  it('纯文本粘贴不进入附件链路', () => {
    render(<Composer />)
    const textarea = screen.getByLabelText('发送给 Axiom')
    fireEvent.paste(textarea, {
      clipboardData: { items: [{ type: 'text/plain', getAsFile: () => null }], files: [] },
    })
    fireEvent.change(textarea, { target: { value: '普通文本' } })
    expect(screen.queryByLabelText('已附加的截图')).not.toBeInTheDocument()
  })

  it('文本 + 截图一起发送：send 收到图像内容块', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const textarea = screen.getByLabelText('发送给 Axiom')
    await user.type(textarea, '看这张截图')
    pasteImage(textarea, [makeShot()])
    await waitFor(() => {
      expect(screen.getByLabelText('已附加的截图')).toBeInTheDocument()
    })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(mocks.send).toHaveBeenCalledWith('看这张截图', [
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: bytesToBase64(new Uint8Array([137, 80, 78, 71])) },
      },
    ])
  })

  it('仅截图（无文本）也能发送，输入框置空且附件清空', async () => {
    render(<Composer />)
    const textarea = screen.getByLabelText('发送给 Axiom')
    pasteImage(textarea, [makeShot()])
    await waitFor(() => {
      expect(screen.getByLabelText('已附加的截图')).toBeInTheDocument()
    })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
    expect(mocks.send.mock.calls[0]?.[0]).toBe('') // type-safe: mock has typed params
    expect(screen.queryByLabelText('已附加的截图')).not.toBeInTheDocument()
  })

  it('超出单条上限时提示且只保留前 4 张', async () => {
    render(<Composer />)
    const files = Array.from({ length: MAX_PASTE_IMAGES + 1 }, (_, i) => makeShot([i], `shot-${i}.png`))
    pasteImage(screen.getByLabelText('发送给 Axiom'), files)
    await waitFor(() => {
      expect(screen.getByText('一次最多附加 4 张截图')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '移除这张截图' }).length).toBe(MAX_PASTE_IMAGES)
    })
  })

  it('运行中发送带图消息走引导队列：queueSteering 收到图像块', async () => {
    mocks.running = true
    const user = userEvent.setup()
    render(<Composer />)
    const textarea = screen.getByLabelText('发送给 Axiom')
    await user.type(textarea, '补个图')
    pasteImage(textarea, [makeShot()])
    await waitFor(() => {
      expect(screen.getByLabelText('已附加的截图')).toBeInTheDocument()
    })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(mocks.queueSteering).toHaveBeenCalledTimes(1)
    expect((mocks.queueSteering.mock.calls[0]?.[1] as unknown[] | undefined)?.length).toBe(1)
    mocks.running = false
  })
})

describe('Composer 粘贴截图 · 模型能力防线', () => {
  const makeShot = () => new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
  const pasteImage = (element: Element, files: File[]) => {
    fireEvent.paste(element, {
      clipboardData: {
        items: files.map((file) => ({ type: file.type, getAsFile: () => file })),
        files,
      },
    })
  }

  it('非视觉模型（目录声明仅文本）粘贴截图时提示且不附加', async () => {
    // 默认 mock 的 demo provider：demo-v1 在目录中 input=['text']
    render(<Composer />)
    pasteImage(screen.getByLabelText('发送给 Axiom'), [makeShot()])
    await waitFor(() => {
      expect(screen.getByText(/当前模型不支持图片输入/)).toBeInTheDocument()
    })
    expect(screen.queryByLabelText('已附加的截图')).not.toBeInTheDocument()
  })
})
