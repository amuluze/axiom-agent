// @vitest-environment jsdom
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptedQueueMessage } from '@/agent/runtime/queueContracts'
import { Composer } from './Composer'
import { MAX_PASTE_IMAGES, bytesToBase64 } from './imagePaste'

const mocks = vi.hoisted(() => ({
  authorizedWorkspace: null as { path: string; name: string; gitBranch?: string | null } | null,
  authorizedWorkspaces: [] as Array<{ path: string; name: string; gitBranch?: string | null }>,
  recentWorkspacePaths: [] as string[],
  addWorkspace: vi.fn(async () => true),
  activateWorkspace: vi.fn(async () => true),
  send: vi.fn(async (_content: string, _images?: unknown) => undefined),
  queueSteering: vi.fn(async (_content: string, _images?: unknown) => acceptedQueueMessage('queued-1')),
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
  // 队列面板状态与操作：默认空队列，各用例按需注入。
  queuedMessages: [] as Array<{
    id: string
    kind: 'steering' | 'follow-up' | 'next-turn'
    content: string
    images: unknown[]
    createdAt: number
  }>,
  recoveredQueuedMessages: [] as Array<{
    id: string
    kind: 'steering' | 'follow-up' | 'next-turn'
    content: string
    images: unknown[]
    createdAt: number
  }>,
  pendingSteeringCount: 0,
  pendingFollowUpCount: 0,
  pendingNextTurnCount: 0,
  // sendQueuedNow 已接受、等待 turn 边界注入的队列项（运行中武装）。
  armedQueueMessageId: null as string | null,
  queuedMutation: { updated: true, messageId: 'q1', kind: 'steering' } as
    { updated: true; messageId: string; kind: string } | { updated: false; reason: string },
  editQueuedMessage: vi.fn(async () => mocks.queuedMutation),
  moveQueuedMessage: vi.fn(async () => mocks.queuedMutation),
  deleteQueuedMessage: vi.fn(async () => mocks.queuedMutation),
  restoreQueuedMessage: vi.fn(async () => null as unknown),
  clearQueuedMessages: vi.fn(async () => undefined),
  discardRecoveredMessage: vi.fn(async () => undefined),
  sendQueuedNow: vi.fn(async (_messageId?: string) => acceptedQueueMessage('queued-1')),
  saveQueueAutoDrain: vi.fn((_enabled: boolean) => true),
  queueAutoDrain: true,
  messages: [] as unknown[],
  contextUsage: null as { tokenPercent: number; bytePercent: number; estimatedTokens: number; contextWindow: number; requestBytes: number; needsCompaction: boolean } | null,
  contextCheckpoint: null as { summary: string } | null,
  setSummaryRequest: vi.fn(),
}))

const findWorkspaceFiles = vi.hoisted(() => vi.fn(async () => ({
  matches: [
    { path: 'src/main.ts', name: 'main.ts', kind: 'file', sizeBytes: 1 },
  ],
  truncated: false,
})))

vi.mock('@/platform/workspace', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/platform/workspace')>()
  return {
    ...original,
    findWorkspaceFiles,
  }
})

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
    queuedMessages: mocks.queuedMessages,
    recoveredQueuedMessages: mocks.recoveredQueuedMessages,
    pendingSteeringCount: mocks.pendingSteeringCount,
    pendingFollowUpCount: mocks.pendingFollowUpCount,
    pendingNextTurnCount: mocks.pendingNextTurnCount,
    armedQueueMessageId: mocks.armedQueueMessageId,
    editQueuedMessage: mocks.editQueuedMessage,
    moveQueuedMessage: mocks.moveQueuedMessage,
    deleteQueuedMessage: mocks.deleteQueuedMessage,
    restoreQueuedMessage: mocks.restoreQueuedMessage,
    clearQueuedMessages: mocks.clearQueuedMessages,
    discardRecoveredMessage: mocks.discardRecoveredMessage,
    sendQueuedNow: mocks.sendQueuedNow,
    saveQueueAutoDrain: mocks.saveQueueAutoDrain,
    queueModeSettings: {
      ...original.useAgentStore.getState().queueModeSettings,
      autoDrain: mocks.queueAutoDrain,
    },
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
  mocks.queuedMessages = []
  mocks.recoveredQueuedMessages = []
  mocks.pendingSteeringCount = 0
  mocks.pendingFollowUpCount = 0
  mocks.pendingNextTurnCount = 0
  mocks.armedQueueMessageId = null
  mocks.queuedMutation = { updated: true, messageId: 'q1', kind: 'steering' }
  mocks.editQueuedMessage.mockClear()
  mocks.moveQueuedMessage.mockClear()
  mocks.deleteQueuedMessage.mockClear()
  mocks.restoreQueuedMessage.mockClear()
  findWorkspaceFiles.mockClear()
  mocks.restoreQueuedMessage.mockImplementation(async () => null)
  mocks.clearQueuedMessages.mockClear()
  mocks.discardRecoveredMessage.mockClear()
  mocks.sendQueuedNow.mockClear()
  mocks.saveQueueAutoDrain.mockClear()
  mocks.queueAutoDrain = true
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
    await user.click(screen.getByRole('button', { name: /^访问模式/ }))
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
    await user.click(screen.getByRole('button', { name: /^访问模式/ }))
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
    await user.click(screen.getByRole('button', { name: /^上下文预算/ }))
    expect(screen.getByRole('dialog', { name: '上下文预算' })).toBeInTheDocument()
    expect(screen.getByText('90.0K / 200K tokens')).toBeInTheDocument()
    await user.click(screen.getByLabelText('发送给 Axiom'))
    expect(screen.queryByRole('dialog', { name: '上下文预算' })).not.toBeInTheDocument()
  })

  it('closes the budget panel on Escape', async () => {
    enableBudget()
    const user = userEvent.setup()
    render(<Composer />)
    await user.click(screen.getByRole('button', { name: /^上下文预算/ }))
    expect(screen.getByRole('dialog', { name: '上下文预算' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '上下文预算' })).not.toBeInTheDocument()
  })

  it('closes the budget panel when another selector is opened', async () => {
    enableBudget()
    const user = userEvent.setup()
    render(<Composer />)
    await user.click(screen.getByRole('button', { name: /^上下文预算/ }))
    expect(screen.getByRole('dialog', { name: '上下文预算' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^访问模式/ }))
    expect(screen.queryByRole('dialog', { name: '上下文预算' })).not.toBeInTheDocument()
    expect(screen.getByText('选择访问模式')).toBeInTheDocument()
  })

  it('triggers manual compaction and closes the panel', async () => {
    enableBudget()
    const user = userEvent.setup()
    render(<Composer />)
    await user.click(screen.getByRole('button', { name: /^上下文预算/ }))
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

  it('@ 提及弹窗按实测空间钳高（间距 8px），关闭后清理', async () => {
    const rectSpy = mockTriggerRect(300)
    const user = userEvent.setup()
    render(<Composer variant="new-task" />)
    const textarea = screen.getByRole('textbox')
    await user.type(textarea, '@')
    const wrap = textarea.closest('.composer__input-wrap') as HTMLElement
    // 300 - 弹层间距 8（--space-2，与标准菜单的 6px 不同）- 顶部余量 8
    expect(wrap.style.getPropertyValue('--composer-menu-available')).toBe('284px')
    await user.keyboard('{Escape}')
    expect(wrap.style.getPropertyValue('--composer-menu-available')).toBe('')
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

describe('Composer 用量环', () => {
  const usageMessage = {
    id: 'assistant-1',
    createdAt: 1,
    role: 'assistant',
    content: 'done',
    toolCalls: [],
    stopReason: 'stop',
    usage: {
      inputTokens: 64_000,
      outputTokens: 1_800,
      totalTokens: 65_800,
      cacheReadTokens: 63_700,
    },
  }

  it('悬浮时展开命中率明细，离开后收起', async () => {
    mocks.messages = [usageMessage]
    render(<Composer />)
    const ring = screen.getByRole('button', { name: /缓存命中率 99\.5%/ })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.mouseEnter(ring)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('缓存读 63.7K / 输入 64.0K')

    fireEvent.mouseLeave(ring)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('有水位时合并为一个入口：悬浮同时给出预算与用量，降级环不再出现', async () => {
    mocks.contextUsage = {
      tokenPercent: 47,
      bytePercent: 20,
      estimatedTokens: 94_000,
      contextWindow: 200_000,
      requestBytes: 1024 * 300,
      needsCompaction: false,
    }
    mocks.messages = [usageMessage]
    render(<Composer />)

    expect(screen.queryByRole('button', { name: /^最近一次响应用量/ })).not.toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: /上下文预算水位 47%/ })
    fireEvent.mouseEnter(trigger)
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('94.0K / 200K tokens')
    expect(tip).toHaveTextContent('缓存命中率 99.5%')
  })
})

describe('Composer 队列面板操作', () => {
  const image = {
    type: 'image' as const,
    source: { type: 'base64' as const, mediaType: 'image/png', data: 'cG5n' },
  }
  const queued = (
    id: string,
    kind: 'steering' | 'follow-up',
    content: string,
    images: unknown[] = [],
  ) => ({ id, kind, content, images, createdAt: 1 })

  it('队列项可拖拽重排与删除，落点相对显示序表达', async () => {
    mocks.running = true
    mocks.queuedMessages = [
      queued('q1', 'steering', 'first'),
      queued('q2', 'follow-up', 'second'),
    ]
    mocks.pendingSteeringCount = 1
    mocks.pendingFollowUpCount = 1
    render(<Composer />)

    // 拖拽第一项到第二项下半 → 排到其后（kind 保留来源项）。
    const items = screen.getAllByRole('listitem')
    fireEvent.dragStart(items[0]!)
    fireEvent.dragOver(items[1]!)
    fireEvent.drop(items[1]!)
    fireEvent.dragEnd(items[0]!)
    await waitFor(() => {
      expect(mocks.moveQueuedMessage).toHaveBeenLastCalledWith('q1', {
        kind: 'steering',
        placement: { position: 'below', anchorId: 'q2' },
      })
    })

    // 落在目标行上半 → 插到其上方。jsdom 无几何信息，用 createEvent 注入 clientY
    // （fireEvent 的 init 属性在 Event 构造器路径会被丢弃，坐标传不进 handler）。
    fireEvent.dragStart(items[1]!)
    const dragOverAbove = createEvent.dragOver(items[0]!)
    Object.defineProperty(dragOverAbove, 'clientY', { value: -5 })
    fireEvent(items[0]!, dragOverAbove)
    const dropAbove = createEvent.drop(items[0]!)
    Object.defineProperty(dropAbove, 'clientY', { value: -5 })
    fireEvent(items[0]!, dropAbove)
    fireEvent.dragEnd(items[1]!)
    await waitFor(() => {
      expect(mocks.moveQueuedMessage).toHaveBeenLastCalledWith('q2', {
        kind: 'follow-up',
        placement: { position: 'above', anchorId: 'q1' },
      })
    })

    await userEvent.click(screen.getAllByRole('button', { name: '删除这条' })[0]!)
    expect(mocks.deleteQueuedMessage).toHaveBeenCalledWith('q1')
    mocks.running = false
  })

  it('队列行支持 ⌥↑/⌥↓ 键盘重排，与拖拽等价；纯方向键不触发', async () => {
    mocks.running = true
    mocks.queuedMessages = [
      queued('q1', 'steering', 'first'),
      queued('q2', 'follow-up', 'second'),
    ]
    mocks.pendingSteeringCount = 1
    mocks.pendingFollowUpCount = 1
    render(<Composer />)

    const items = screen.getAllByRole('listitem')
    fireEvent.keyDown(items[1]!, { key: 'ArrowUp', altKey: true })
    await waitFor(() => {
      expect(mocks.moveQueuedMessage).toHaveBeenLastCalledWith('q2', {
        kind: 'follow-up',
        placement: { position: 'above', anchorId: 'q1' },
      })
    })
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown', altKey: true })
    await waitFor(() => {
      expect(mocks.moveQueuedMessage).toHaveBeenLastCalledWith('q1', {
        kind: 'steering',
        placement: { position: 'below', anchorId: 'q2' },
      })
    })

    // 无 ⌥ 修饰的方向键保持默认语义，不触发重排。
    mocks.moveQueuedMessage.mockClear()
    fireEvent.keyDown(items[0]!, { key: 'ArrowUp' })
    expect(mocks.moveQueuedMessage).not.toHaveBeenCalled()
    mocks.running = false
  })

  it('立即发送按钮：运行中队首引导禁用（会被自动消费），其余项可点且送 sendQueuedNow', async () => {
    mocks.running = true
    mocks.queueAutoDrain = true
    mocks.queuedMessages = [
      queued('q1', 'steering', 'first'),
      queued('q2', 'follow-up', 'second'),
    ]
    mocks.pendingSteeringCount = 1
    mocks.pendingFollowUpCount = 1
    const user = userEvent.setup()
    render(<Composer />)

    const sendButtons = screen.getAllByRole('button', { name: '立即发送（下一个 turn 边界注入）' })
    expect(sendButtons[0]).toBeDisabled()
    expect(sendButtons[1]).toBeEnabled()
    await user.click(sendButtons[1]!)
    expect(mocks.sendQueuedNow).toHaveBeenCalledWith('q2')
    mocks.running = false
  })

  it('立即发送按钮：暂停自动发送时队首引导可手动放行', async () => {
    mocks.running = true
    mocks.queueAutoDrain = false
    mocks.queuedMessages = [queued('q1', 'steering', 'first')]
    mocks.pendingSteeringCount = 1
    const user = userEvent.setup()
    render(<Composer />)

    const sendButton = screen.getByRole('button', { name: '立即发送（下一个 turn 边界注入）' })
    expect(sendButton).toBeEnabled()
    await user.click(sendButton)
    expect(mocks.sendQueuedNow).toHaveBeenCalledWith('q1')
    mocks.running = false
  })

  it('已放行的队列项发送 chip 切换为「已放行」语义并高亮，未放行项不受影响', async () => {
    // 回归：点击「立即发送」被接受后（武装等待 turn 边界注入），接受到注入
    // 之间的窗口没有任何可见反馈，用户只能得出「点了没反应」的结论。
    mocks.running = true
    mocks.queueAutoDrain = false
    mocks.queuedMessages = [
      queued('q1', 'steering', 'first'),
      queued('q2', 'follow-up', 'second'),
    ]
    mocks.pendingSteeringCount = 1
    mocks.pendingFollowUpCount = 1
    mocks.armedQueueMessageId = 'q1'
    render(<Composer />)

    // 武装项的 chip 可访问名切换为「已放行」语义（accent 软底高亮），未武装项保持原名。
    expect(screen.getByRole('button', { name: '已放行：等待当前任务到 turn 边界注入' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '立即发送（下一个 turn 边界注入）' })).toBeInTheDocument()
    // 武装项的发送按钮保持可用（重复点击幂等重武装）。
    expect(screen.getByRole('button', { name: '已放行：等待当前任务到 turn 边界注入' })).toBeEnabled()
    mocks.running = false
    mocks.armedQueueMessageId = null
  })

  it('立即发送按钮：空闲时队首引导不禁用，语义切换为开始新任务发送', async () => {
    // 回归：禁用条件曾漏掉 running——空闲时（崩溃恢复/暂停期残留）队首引导
    // 不会被自动消费，禁用会让唯一发送入口失效。
    mocks.running = false
    mocks.queueAutoDrain = true
    mocks.queuedMessages = [queued('q1', 'steering', 'first')]
    mocks.pendingSteeringCount = 1
    const user = userEvent.setup()
    render(<Composer />)

    const sendButton = screen.getByRole('button', { name: '立即发送（开始新任务发送）' })
    expect(sendButton).toBeEnabled()
    await user.click(sendButton)
    expect(mocks.sendQueuedNow).toHaveBeenCalledWith('q1')
  })

  it('暂停队列展示中断通知，「继续」恢复自动发送，「清除未发送」清空队列', async () => {
    mocks.running = false
    mocks.queueAutoDrain = false
    mocks.queuedMessages = [queued('q1', 'steering', 'first')]
    mocks.pendingSteeringCount = 1
    const user = userEvent.setup()
    render(<Composer />)

    expect(screen.getByText('由于你中断了当前响应，队列已暂停')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '继续' }))
    expect(mocks.saveQueueAutoDrain).toHaveBeenCalledWith(true)
    await user.click(screen.getByRole('button', { name: '清除未发送' }))
    expect(mocks.clearQueuedMessages).toHaveBeenCalledTimes(1)
  })

  it('行内编辑保存走 editQueuedMessage，被拒时给出原因', async () => {
    mocks.running = true
    mocks.queuedMessages = [queued('q1', 'steering', 'first')]
    mocks.pendingSteeringCount = 1
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByRole('button', { name: '编辑这条' }))
    const editor = screen.getByLabelText('编辑待发送消息')
    await user.clear(editor)
    await user.type(editor, 'edited')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(mocks.editQueuedMessage).toHaveBeenCalledWith('q1', 'edited')

    // 拒绝：消息已被注入/删除时不再静默失败。
    mocks.queuedMutation = { updated: false, reason: 'unknown-message' }
    await user.click(screen.getByRole('button', { name: '编辑这条' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(screen.getByText('该待发送消息已不存在（可能已被注入或删除）')).toBeInTheDocument()
    })
    mocks.running = false
  })

  it('编辑态 Esc 取消且不改动队列项', async () => {
    mocks.running = true
    mocks.queuedMessages = [queued('q1', 'steering', 'first')]
    mocks.pendingSteeringCount = 1
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByRole('button', { name: '编辑这条' }))
    fireEvent.keyDown(screen.getByLabelText('编辑待发送消息'), { key: 'Escape' })
    expect(screen.queryByLabelText('编辑待发送消息')).not.toBeInTheDocument()
    expect(mocks.editQueuedMessage).not.toHaveBeenCalled()
    mocks.running = false
  })

  it('恢复草稿的「恢复编辑」把图片块回填为附件，不再静默丢图', async () => {
    mocks.running = true
    mocks.recoveredQueuedMessages = [queued('q1', 'steering', '', [image])]
    mocks.restoreQueuedMessage.mockImplementation(async () => ({
      id: 'q1',
      kind: 'steering',
      content: '',
      images: [image],
      createdAt: 1,
    }))
    const user = userEvent.setup()
    render(<Composer />)

    expect(screen.getByText('已从停止的运行恢复 1 条草稿')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '恢复编辑' }))
    await waitFor(() => {
      expect(screen.getByLabelText('已附加的截图')).toBeInTheDocument()
    })
    expect(screen.getAllByRole('button', { name: '移除这张截图' })).toHaveLength(1)
    mocks.running = false
  })

  it('恢复草稿行「丢弃」走 discardRecoveredMessage', async () => {
    mocks.running = false
    mocks.recoveredQueuedMessages = [queued('q1', 'steering', 'draft', [])]
    const user = userEvent.setup()
    render(<Composer />)

    await user.click(screen.getByRole('button', { name: '丢弃' }))
    expect(mocks.discardRecoveredMessage).toHaveBeenCalledWith('q1')
  })

  it('队列项预览标注图片数量', () => {
    mocks.running = true
    mocks.queuedMessages = [queued('q1', 'steering', 'with image', [image])]
    mocks.pendingSteeringCount = 1
    render(<Composer />)
    expect(screen.getByText('含 1 张图片')).toBeInTheDocument()
    mocks.running = false
  })
})

describe('Composer @ 工作区文件候选', () => {
  it('输入 @ 自动弹出弹层并展示工作区检索结果，选择后回填结构化 token', async () => {
    // @ 候选 = 手动引用 + 工作区防抖检索（mock platform 返回 src/main.ts）。
    const user = userEvent.setup()
    render(<Composer />)

    const textarea = screen.getByLabelText('发送给 Axiom')
    await user.click(textarea)
    await user.type(textarea, '@')

    // 防抖检索完成后弹层出现工作区候选（相对路径为展示标签）。
    const candidate = await screen.findByText('src/main.ts', {}, { timeout: 3000 })
    expect(candidate).toBeInTheDocument()

    // 选择候选 → 结构化 token（绝对路径 id）回填输入框。
    await user.click(candidate)
    expect((textarea as HTMLTextAreaElement).value).toBe('@src/main.ts  ')
  })

  it('删除中间的引用后，两侧引用之间仍保持双空格', async () => {
    const user = userEvent.setup()
    render(<Composer />)

    const textarea = screen.getByLabelText('发送给 Axiom')
    fireEvent.change(textarea, {
      target: { value: '@src/a.ts  @src/b.ts  @src/c.ts  ' },
    })
    const removeButtons = await screen.findAllByRole('button', { name: '移除这个引用' })
    expect(removeButtons).toHaveLength(3)

    await user.click(removeButtons[1]!)
    // 合并空白也用双空格：否则剩下的两颗胶囊会塔回单空格、重新粘在一起。
    expect((textarea as HTMLTextAreaElement).value).toBe('@src/a.ts  @src/c.ts  ')
  })
})
