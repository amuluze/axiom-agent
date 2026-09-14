// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Composer,
  deliverQueuedContent,
  isComposerAvailable,
  isComposerHistoryKey,
  isComposerSendKey,
  recentWorkspaceEntries,
} from './Composer'

const COMPOSER_HISTORY_KEY = 'axiom.composer.history.v1'

const persistedHistory = (): string[] => {
  const raw = window.localStorage.getItem(COMPOSER_HISTORY_KEY)
  if (!raw) return []
  const parsed: unknown = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
}

const seedHistory = (entries: string[]) => {
  window.localStorage.setItem(COMPOSER_HISTORY_KEY, JSON.stringify(entries))
}

const mocks = vi.hoisted(() => ({
  authorizedWorkspace: null as { path: string; name: string; gitBranch?: string | null } | null,
  authorizedWorkspaces: [] as Array<{
    path: string
    name: string
    gitBranch?: string | null
  }>,
  authorizedFiles: [] as Array<{ path: string; name: string; sizeBytes: number; isDirectory: boolean }>,
  recentWorkspacePaths: [] as string[],
  send: vi.fn(async () => undefined),
  editUserMessage: vi.fn(async () => true),
  activeSessionId: 'session-1' as string | null,
  messageEditRequest: null as { sessionId: string; messageId: string; content: string; images?: Array<{ type: 'image'; source: { type: 'base64'; mediaType: string; data: string } }> } | null,
  setMessageEditRequest: vi.fn(),
  queueSteering: vi.fn(async () => true),
  queueFollowUp: vi.fn(async () => true),
  authorizeFile: vi.fn(async () => true),
  authorizeDirectory: vi.fn(async () => true),
  providerReady: true,
  providerSetupRequired: false,
  running: false,
  sessionBusy: false,
  compactionRunning: false,
  branchSummaryRunning: false,
  providerId: 'demo',
  modelName: undefined as string | undefined,
  accessMode: 'standard',
  setAccessMode: vi.fn(),
  contextUsage: null as { tokenPercent: number; bytePercent: number; estimatedTokens: number; contextWindow: number; requestBytes: number; needsCompaction: boolean } | null,
  contextCheckpoint: null as { summary: string } | null,
}))

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  const stateWithMocks = (): StoreState => ({
    ...original.useAgentStore.getState(),
    provider: {
      ...original.useAgentStore.getState().provider,
      providerId: mocks.providerId,
      ...(mocks.modelName !== undefined ? { modelName: mocks.modelName } : {}),
    },
    providerReady: mocks.providerReady,
    providerSetupRequired: mocks.providerSetupRequired,
    running: mocks.running,
    sessionBusy: mocks.sessionBusy,
    compactionRunning: mocks.compactionRunning,
    branchSummaryRunning: mocks.branchSummaryRunning,
    authorizedWorkspace: mocks.authorizedWorkspace,
    authorizedWorkspaces: mocks.authorizedWorkspaces,
    authorizedFiles: mocks.authorizedFiles,
    send: mocks.send,
    editUserMessage: mocks.editUserMessage,
    activeSessionId: mocks.activeSessionId,
    queueSteering: mocks.queueSteering,
    queueFollowUp: mocks.queueFollowUp,
    authorizeFile: mocks.authorizeFile,
    authorizeDirectory: mocks.authorizeDirectory,
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
      messageEditRequest: mocks.messageEditRequest,
      setMessageEditRequest: mocks.setMessageEditRequest,
    } as UiState),
  }
})

beforeEach(() => {
  mocks.authorizedWorkspace = { path: '/repo', name: 'repo', gitBranch: 'main' }
  mocks.authorizedWorkspaces = [mocks.authorizedWorkspace]
  mocks.authorizedFiles = []
  mocks.recentWorkspacePaths = ['/repo']
  mocks.send.mockClear()
  mocks.editUserMessage.mockClear()
  mocks.editUserMessage.mockResolvedValue(true)
  mocks.setMessageEditRequest.mockClear()
  mocks.activeSessionId = 'session-1'
  mocks.messageEditRequest = null
  mocks.queueSteering.mockClear()
  mocks.queueFollowUp.mockClear()
  window.localStorage.clear()
  mocks.providerReady = true
  mocks.providerSetupRequired = false
  mocks.running = false
  mocks.sessionBusy = false
  mocks.compactionRunning = false
  mocks.branchSummaryRunning = false
  mocks.accessMode = 'standard'
  mocks.providerId = 'demo'
  mocks.modelName = undefined
  mocks.setAccessMode.mockClear()
  mocks.contextUsage = null
  mocks.contextCheckpoint = null
})

describe('Composer', () => {
  it('renders an empty composer with the standard placeholder on desktop', () => {
    const html = renderToStaticMarkup(createElement(Composer))
    expect(html).toContain('composer')
    expect(html).toContain('给 Axiom 一项任务')
  })

  it('falls back to the new-task placeholder on the new-task variant', () => {
    const html = renderToStaticMarkup(createElement(Composer, { variant: 'new-task' }))
    expect(html).toContain('@ 添加文件或目录、/ 使用技能、# 关联会话')
  })

  it('reflects the no-approval access mode in the access-mode label colour', () => {
    mocks.accessMode = 'no-approval'
    const html = renderToStaticMarkup(createElement(Composer))
    expect(html).toContain('data-mode="no-approval"')
  })

  it('renders the active model as a dynamic model switcher', () => {
    const html = renderToStaticMarkup(createElement(Composer))
    expect(html).toContain('aria-label="切换模型"')
    expect(html).toContain('demo-v1')
  })

  it('shows only the model name when a model name is configured', () => {
    mocks.modelName = 'Claude 测试助手'
    const html = renderToStaticMarkup(createElement(Composer))
    expect(html).toContain('Claude 测试助手')
    expect(html).not.toContain('Claude 测试助手 · demo-v1')
  })

  it('falls back to the model id when no model name is configured', () => {
    mocks.providerId = 'generic-anthropic-compatible'
    const html = renderToStaticMarkup(createElement(Composer))
    expect(html).toContain('demo-v1')
    expect(html).not.toContain('Anthropic-compatible · demo-v1')
  })

  it('keeps the composer available for steering while a run is active', () => {
    mocks.running = true
    const html = renderToStaticMarkup(createElement(Composer))
    expect(html).toContain('Enter 发送；⌥↵ 换行')
    expect(html).toContain('aria-label="停止运行"')
    expect(html).not.toMatch(/<textarea[^>]*disabled/)
  })

  it('keeps the workspace switcher available while another session runs', () => {
    mocks.running = true
    const html = renderToStaticMarkup(createElement(Composer))
    expect(html).not.toMatch(/<button[^>]*aria-label="选择项目"[^>]*disabled/gu)
  })

  it('offers cancellation while a branch summary is running', () => {
    mocks.sessionBusy = true
    mocks.branchSummaryRunning = true
    const html = renderToStaticMarkup(createElement(Composer))
    expect(html).toContain('aria-label="取消分支摘要"')
  })

  it('locks the composer during structural session work', () => {
    expect(isComposerAvailable({
      providerReady: true,
      providerSetupRequired: false,
      workspaceReady: true,
      sessionBusy: true,
      compactionRunning: false,
    })).toBe(false)
  })

  it('requires a work directory before accepting a new task', () => {
    mocks.authorizedWorkspace = null
    mocks.authorizedWorkspaces = []
    const html = renderToStaticMarkup(createElement(Composer, { variant: 'new-task' }))
    expect(html).toContain('请先选择一个工作目录')
    expect(html).toMatch(/<textarea[^>]*disabled/gu)
  })

  it('only clears queued input after the runtime accepts the action', async () => {
    const clear = vi.fn()
    await expect(deliverQueuedContent(vi.fn(async () => false), 'keep me', clear)).resolves.toBe(false)
    expect(clear).not.toHaveBeenCalled()
    await expect(deliverQueuedContent(vi.fn(async () => true), 'send me', clear)).resolves.toBe(true)
    expect(clear).toHaveBeenCalledOnce()
  })

  it('uses Enter to send, Alt+Enter to insert a newline, and ignores IME composition', () => {
    const key = (overrides: Partial<Parameters<typeof isComposerSendKey>[0]> = {}) => ({
      key: 'Enter',
      altKey: false,
      nativeEvent: {},
      ...overrides,
    })
    expect(isComposerSendKey(key())).toBe(true)
    expect(isComposerSendKey(key({ altKey: true }))).toBe(false)
    expect(isComposerSendKey(key({ nativeEvent: { isComposing: true } }))).toBe(false)
    expect(isComposerSendKey(key({ nativeEvent: { keyCode: 229 } }))).toBe(false)
    expect(isComposerSendKey(key(), true)).toBe(false)
  })

  it('shows the current Git branch beside the authorized directory', () => {
    mocks.authorizedWorkspace = {
      path: '/Users/me/axiom',
      name: 'axiom',
      gitBranch: 'feat-new-ui',
    }
    const html = renderToStaticMarkup(createElement(Composer))
    expect(html).toContain('axiom')
    expect(html).toContain('feat-new-ui')
  })

  it('renders the context budget trigger in the session variant when usage exists', () => {
    mocks.contextUsage = {
      tokenPercent: 45,
      bytePercent: 30,
      estimatedTokens: 90_000,
      contextWindow: 200_000,
      requestBytes: 1024 * 500,
      needsCompaction: false,
    }
    const html = renderToStaticMarkup(createElement(Composer))
    expect(html).toContain('aria-label="上下文预算"')
    expect(html).toContain('45%')
  })

  it('omits the context budget trigger on the new-task variant', () => {
    mocks.contextUsage = {
      tokenPercent: 45,
      bytePercent: 30,
      estimatedTokens: 90_000,
      contextWindow: 200_000,
      requestBytes: 1024 * 500,
      needsCompaction: false,
    }
    const html = renderToStaticMarkup(createElement(Composer, { variant: 'new-task' }))
    expect(html).not.toContain('aria-label="上下文预算"')
  })

  it('omits the context budget trigger without a session context usage', () => {
    const html = renderToStaticMarkup(createElement(Composer))
    expect(html).not.toContain('aria-label="上下文预算"')
  })

  describe('输入历史（↑/↓ 回溯）', () => {
    const renderComposer = () => {
      render(createElement(Composer))
      return screen.getByRole('textbox') as HTMLTextAreaElement
    }

    it('recalls the newest entry on ArrowUp and walks back further', () => {
      seedHistory(['新任务', '旧任务一', '旧任务二'])
      const textarea = renderComposer()
      fireEvent.keyDown(textarea, { key: 'ArrowUp' })
      expect(textarea.value).toBe('新任务')
      fireEvent.keyDown(textarea, { key: 'ArrowUp' })
      expect(textarea.value).toBe('旧任务一')
      fireEvent.keyDown(textarea, { key: 'ArrowUp' })
      expect(textarea.value).toBe('旧任务二')
      fireEvent.keyDown(textarea, { key: 'ArrowUp' })
      expect(textarea.value).toBe('旧任务二')
    })

    it('restores the draft after stepping past the newest entry with ArrowDown', () => {
      seedHistory(['新任务', '旧任务'])
      const textarea = renderComposer()
      fireEvent.change(textarea, { target: { value: '未发送草稿' } })
      fireEvent.keyDown(textarea, { key: 'ArrowUp' })
      expect(textarea.value).toBe('新任务')
      fireEvent.keyDown(textarea, { key: 'ArrowUp' })
      expect(textarea.value).toBe('旧任务')
      fireEvent.keyDown(textarea, { key: 'ArrowDown' })
      expect(textarea.value).toBe('新任务')
      fireEvent.keyDown(textarea, { key: 'ArrowDown' })
      expect(textarea.value).toBe('未发送草稿')
      fireEvent.keyDown(textarea, { key: 'ArrowDown' })
      expect(textarea.value).toBe('未发送草稿')
    })

    it('leaves ArrowUp to native caret movement without history', () => {
      const textarea = renderComposer()
      fireEvent.change(textarea, { target: { value: '当前草稿' } })
      fireEvent.keyDown(textarea, { key: 'ArrowUp' })
      expect(textarea.value).toBe('当前草稿')
    })

    it('keeps native caret movement for mid-line carets in multiline drafts', () => {
      seedHistory(['历史任务'])
      const textarea = renderComposer()
      fireEvent.change(textarea, { target: { value: '第一行\n第二行\n第三行' } })
      textarea.setSelectionRange(4, 4)
      fireEvent.keyDown(textarea, { key: 'ArrowUp' })
      expect(textarea.value).toBe('第一行\n第二行\n第三行')
      expect(textarea.selectionStart).toBe(4)
      textarea.setSelectionRange(4, 4)
      fireEvent.keyDown(textarea, { key: 'ArrowDown' })
      expect(textarea.value).toBe('第一行\n第二行\n第三行')
    })

    it('ignores history keys combined with modifiers', () => {
      seedHistory(['历史任务'])
      const textarea = renderComposer()
      for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
        fireEvent.keyDown(textarea, { key: 'ArrowUp', ...mods })
        expect(textarea.value).toBe('')
        fireEvent.keyDown(textarea, { key: 'ArrowDown', ...mods })
        expect(textarea.value).toBe('')
      }
    })

    it('yields ArrowUp to the mention popover while it is open', () => {
      seedHistory(['历史任务'])
      const textarea = renderComposer()
      fireEvent.change(textarea, { target: { value: '@' } })
      expect(screen.getByRole('listbox')).toBeTruthy()
      fireEvent.keyDown(textarea, { key: 'ArrowUp' })
      expect(textarea.value).toBe('@')
    })

    it('moves through history regardless of caret position while browsing', () => {
      seedHistory(['第一条历史', '更早的历史'])
      const textarea = renderComposer()
      fireEvent.keyDown(textarea, { key: 'ArrowUp' })
      expect(textarea.value).toBe('第一条历史')
      // 浏览态下光标已在条目末尾（最后一行），↓ 仍应前进而不是停留在原地。
      fireEvent.keyDown(textarea, { key: 'ArrowDown' })
      fireEvent.keyDown(textarea, { key: 'ArrowUp' })
      expect(textarea.value).toBe('第一条历史')
      fireEvent.keyDown(textarea, { key: 'ArrowUp' })
      expect(textarea.value).toBe('更早的历史')
    })

    it('records accepted submissions and recalls them with ArrowUp', () => {
      const textarea = renderComposer()
      fireEvent.change(textarea, { target: { value: '帮我写个脚本' } })
      fireEvent.keyDown(textarea, { key: 'Enter' })
      expect(mocks.send).toHaveBeenCalledWith('帮我写个脚本', undefined)
      expect(textarea.value).toBe('')
      expect(persistedHistory()).toEqual(['帮我写个脚本'])
      fireEvent.keyDown(textarea, { key: 'ArrowUp' })
      expect(textarea.value).toBe('帮我写个脚本')
    })

    it('records queued steering submissions once the queue accepts them', async () => {
      mocks.running = true
      const textarea = renderComposer()
      fireEvent.change(textarea, { target: { value: '排队消息' } })
      fireEvent.keyDown(textarea, { key: 'Enter' })
      await waitFor(() => expect(textarea.value).toBe(''))
      expect(mocks.queueSteering).toHaveBeenCalledWith('排队消息', undefined)
      expect(persistedHistory()).toEqual(['排队消息'])
    })
  })
})

describe('Composer message editing', () => {
  const renderComposer = () => {
    render(createElement(Composer))
    return screen.getByRole('textbox') as HTMLTextAreaElement
  }

  it('prefills the edited message and shows the edit banner', async () => {
    mocks.messageEditRequest = { sessionId: 'session-1', messageId: 'u1', content: '改一下需求' }
    const textarea = renderComposer()

    await waitFor(() => expect(textarea.value).toBe('改一下需求'))
    expect(screen.getByText('正在编辑已发送的消息')).toBeTruthy()
  })

  it('branches and resends the edited content on submit', async () => {
    mocks.messageEditRequest = { sessionId: 'session-1', messageId: 'u1', content: '旧内容' }
    const textarea = renderComposer()
    await waitFor(() => expect(textarea.value).toBe('旧内容'))

    fireEvent.change(textarea, { target: { value: '新内容' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => expect(mocks.editUserMessage).toHaveBeenCalledWith('u1', '新内容', undefined))
    await waitFor(() => expect(textarea.value).toBe(''))
    expect(mocks.setMessageEditRequest).toHaveBeenCalledWith(null)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('keeps the edited text when the store rejects the edit', async () => {
    mocks.editUserMessage.mockResolvedValue(false)
    mocks.messageEditRequest = { sessionId: 'session-1', messageId: 'u1', content: '旧内容' }
    const textarea = renderComposer()
    await waitFor(() => expect(textarea.value).toBe('旧内容'))

    fireEvent.change(textarea, { target: { value: '新内容' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => expect(mocks.editUserMessage).toHaveBeenCalledWith('u1', '新内容', undefined))
    expect(textarea.value).toBe('新内容')
    expect(mocks.setMessageEditRequest).not.toHaveBeenCalled()
  })

  it('forwards the original message images on edit submit', async () => {
    const images = [{
      type: 'image' as const,
      source: { type: 'base64' as const, mediaType: 'image/png', data: 'cG5n' },
    }]
    mocks.messageEditRequest = { sessionId: 'session-1', messageId: 'u1', content: '旧内容', images }
    const textarea = renderComposer()
    await waitFor(() => expect(textarea.value).toBe('旧内容'))

    fireEvent.change(textarea, { target: { value: '新内容' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => expect(mocks.editUserMessage).toHaveBeenCalledWith('u1', '新内容', images))
  })

  it('discards the edit and clears the input on cancel', async () => {
    mocks.messageEditRequest = { sessionId: 'session-1', messageId: 'u1', content: '旧内容' }
    const textarea = renderComposer()
    await waitFor(() => expect(textarea.value).toBe('旧内容'))

    fireEvent.click(screen.getByLabelText('放弃编辑'))

    expect(textarea.value).toBe('')
    expect(mocks.setMessageEditRequest).toHaveBeenCalledWith(null)
  })

  it('ignores an edit request that belongs to another session', () => {
    mocks.messageEditRequest = { sessionId: 'other-session', messageId: 'u1', content: '别人的消息' }
    const textarea = renderComposer()

    expect(textarea.value).toBe('')
    expect(screen.queryByText('正在编辑已发送的消息')).toBeNull()
  })
})

describe('isComposerHistoryKey', () => {
  const key = (overrides: Partial<Parameters<typeof isComposerHistoryKey>[0]> = {}) => ({
    key: 'ArrowUp',
    nativeEvent: {},
    ...overrides,
  })

  it('accepts bare ArrowUp/ArrowDown outside IME composition', () => {
    expect(isComposerHistoryKey(key())).toBe(true)
    expect(isComposerHistoryKey({ key: 'ArrowDown', nativeEvent: {} })).toBe(true)
    expect(isComposerHistoryKey(key({ nativeEvent: { isComposing: true } }))).toBe(false)
    expect(isComposerHistoryKey(key({ nativeEvent: { keyCode: 229 } }))).toBe(false)
    expect(isComposerHistoryKey(key(), true)).toBe(false)
  })

  it('rejects modifier combos and non-arrow keys', () => {
    expect(isComposerHistoryKey(key({ metaKey: true }))).toBe(false)
    expect(isComposerHistoryKey(key({ ctrlKey: true }))).toBe(false)
    expect(isComposerHistoryKey(key({ altKey: true }))).toBe(false)
    expect(isComposerHistoryKey(key({ shiftKey: true }))).toBe(false)
    expect(isComposerHistoryKey({ key: 'Enter', nativeEvent: {} })).toBe(false)
  })
})

describe('recentWorkspaceEntries', () => {
  const workspaces = [
    { path: '/a', name: 'a', gitBranch: null },
    { path: '/b', name: 'b', gitBranch: 'main' },
    { path: '/c', name: 'c', gitBranch: null },
  ]

  it('orders entries by recent workspace paths', () => {
    const paths = recentWorkspaceEntries(workspaces, ['/b', '/c', '/a']).map((ws) => ws.path)
    expect(paths).toEqual(['/b', '/c', '/a'])
  })

  it('drops recent paths that are no longer authorized', () => {
    const paths = recentWorkspaceEntries(workspaces, ['/gone', '/a']).map((ws) => ws.path)
    expect(paths).toEqual(['/a'])
  })

  it('returns an empty list when there are no recent paths', () => {
    expect(recentWorkspaceEntries(workspaces, [])).toEqual([])
  })
})
