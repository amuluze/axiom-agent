import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionView, shouldStickToOutput } from './SessionView'

const mocks = vi.hoisted(() => ({
  messages: [] as Array<{ role: string; id: string; content: string; createdAt: number }>,
  endReason: null as string | null,
  pendingApproval: null as unknown,
  error: null as string | null,
  running: false,
  sessionBusy: false,
  provider: { modelId: 'claude-test', providerId: 'generic-anthropic-compatible' },
}))

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T => selector({
      ...original.useAgentStore.getState(),
      messages: mocks.messages as StoreState['messages'],
      endReason: mocks.endReason,
      pendingApproval: mocks.pendingApproval,
      error: mocks.error,
      running: mocks.running,
      sessionBusy: mocks.sessionBusy,
      provider: { ...original.useAgentStore.getState().provider, modelId: mocks.provider.modelId, providerId: mocks.provider.providerId },
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

afterEach(() => {
  mocks.messages = []
  mocks.endReason = null
  mocks.pendingApproval = null
  mocks.error = null
  mocks.running = false
  mocks.sessionBusy = false
  mocks.provider = { modelId: 'claude-test', providerId: 'generic-anthropic-compatible' }
})

describe('SessionView', () => {
  it('renders the session container with the header and composer', () => {
    const html = renderToStaticMarkup(createElement(SessionView))
    expect(html).toContain('session')
    expect(html).toContain('session__content')
    expect(html).toContain('session__header')
    expect(html).toContain('composer')
    expect(html).toContain('aria-live="polite"')
  })

  it('renders user messages as bubbles in the message column', () => {
    mocks.messages = [
      { role: 'user', id: 'u1', content: 'hello', createdAt: 0 },
      { role: 'assistant', id: 'a1', content: 'hi there', toolCalls: [], stopReason: 'stop', createdAt: 1 },
    ] as unknown as typeof mocks.messages
    const html = renderToStaticMarkup(createElement(SessionView))
    expect(html).toContain('hello')
    expect(html).toContain('hi there')
  })

  it('offers a copy action for both the user bubble and the assistant text', () => {
    mocks.messages = [
      { role: 'user', id: 'u1', content: '帮我看看这段日志', createdAt: 0 },
      { role: 'assistant', id: 'a1', content: '好的，日志显示……', toolCalls: [], stopReason: 'stop', createdAt: 1 },
    ] as unknown as typeof mocks.messages
    const html = renderToStaticMarkup(createElement(SessionView))
    expect(html.match(/aria-label="复制消息"/gu)).toHaveLength(2)
  })

  it('offers copy/edit on user messages and branch actions on agent replies', () => {
    mocks.messages = [
      { role: 'user', id: 'u1', content: '改一下需求', createdAt: 0 },
      { role: 'assistant', id: 'a1', content: '好的', toolCalls: [], stopReason: 'stop', createdAt: 1 },
      { role: 'user', id: 'u2', content: '再改一下', createdAt: 2 },
      { role: 'assistant', id: 'a2', content: '收到', toolCalls: [], stopReason: 'stop', createdAt: 3 },
    ] as unknown as typeof mocks.messages

    const html = renderToStaticMarkup(createElement(SessionView))

    expect(html.match(/aria-label="复制消息"/gu)).toHaveLength(4)
    // u1 是首条消息，之前没有分支边界 → 编辑按钮禁用；u2 可编辑。
    expect(html).toContain('aria-label="这条用户消息之前没有安全的分支边界，无法编辑"')
    expect(html).toContain('aria-label="编辑这条用户消息并重发"')
    // 只有非末条的 Agent 回答能「总结后分支」。
    expect(html.match(/aria-label="总结后从这条回答消息创建分支"/gu)).toHaveLength(1)
    expect(html.match(/aria-label="从这条回答消息创建分支"/gu)).toHaveLength(2)
  })

  it('renders no action row under tool call cards', () => {
    mocks.messages = [
      {
        role: 'assistant',
        id: 'a1',
        content: '准备读取文件',
        createdAt: 0,
        stopReason: 'tool_use',
        toolCalls: [{ id: 'tc1', name: 'read', arguments: { path: 'notes.txt' } }],
      },
      { role: 'tool', id: 't1', toolCallId: 'tc1', toolName: 'read', content: 'ok', isError: false, createdAt: 1 },
    ] as unknown as typeof mocks.messages

    const html = renderToStaticMarkup(createElement(SessionView))

    // 工具调用卡本身不带操作行：整棵树里只有 a1 那条 assistant-text 的复制按钮。
    expect(html.match(/aria-label="复制消息"/gu)).toHaveLength(1)
  })

  it('omits the copy action for a tool-call-only assistant message', () => {
    mocks.messages = [
      {
        role: 'assistant',
        id: 'a1',
        content: '',
        createdAt: 0,
        stopReason: 'tool_use',
        toolCalls: [{ id: 'tc1', name: 'read', arguments: { path: 'a.txt' } }],
      },
    ] as unknown as typeof mocks.messages
    const html = renderToStaticMarkup(createElement(SessionView))
    expect(html).not.toContain('aria-label="复制消息"')
  })

  it('restores artifact inspection for completed tool results', () => {
    mocks.messages = [
      {
        role: 'assistant',
        id: 'a1',
        content: '',
        createdAt: 0,
        stopReason: 'tool_use',
        toolCalls: [{ id: 'tc1', name: 'read', arguments: { path: 'notes.txt' } }],
      },
      {
        role: 'tool',
        id: 't1',
        toolCallId: 'tc1',
        toolName: 'read',
        content: 'externalized',
        isError: false,
        createdAt: 1,
        artifact: {
          id: 'sha256:abc',
          kind: 'text',
          mediaType: 'text/plain',
          relativePath: 'artifacts/abc',
          contentHash: 'abcdef1234567890',
          sizeBytes: 64,
          createdAt: 1,
        },
      },
    ] as unknown as typeof mocks.messages

    const html = renderToStaticMarkup(createElement(SessionView))
    expect(html).toContain('aria-label="完整工具结果 Artifact"')
    expect(html).toContain('校验并查看完整内容')
  })

  it('renders tool calls once through the dedicated tool card', () => {
    mocks.messages = [
      {
        role: 'assistant',
        id: 'a1',
        content: '准备读取文件',
        contentBlocks: [
          { type: 'text', text: '准备读取文件' },
          {
            type: 'tool_call',
            id: 'tc1',
            name: 'read',
            arguments: { path: 'notes.txt' },
            rawArguments: '{"path":"notes.txt"}',
          },
        ],
        createdAt: 0,
        stopReason: 'tool_use',
        toolCalls: [{
          id: 'tc1',
          name: 'read',
          arguments: { path: 'notes.txt' },
          rawArguments: '{"path":"notes.txt"}',
        }],
      },
    ] as unknown as typeof mocks.messages

    const html = renderToStaticMarkup(createElement(SessionView))
    expect(html).toContain('准备读取文件')
    expect(html).toContain('Tool call read')
    expect(html).not.toContain('调用工具')
  })

  it('shows artifact persistence failures even when no artifact reference exists', () => {
    mocks.messages = [
      {
        role: 'assistant',
        id: 'a1',
        content: '',
        createdAt: 0,
        stopReason: 'tool_use',
        toolCalls: [{ id: 'tc1', name: 'read', arguments: { path: 'notes.txt' } }],
      },
      {
        role: 'tool',
        id: 't1',
        toolCallId: 'tc1',
        toolName: 'read',
        content: 'truncated',
        isError: false,
        createdAt: 1,
        artifactError: '完整工具结果未能写入 Artifact 存储',
      },
    ] as unknown as typeof mocks.messages

    const html = renderToStaticMarkup(createElement(SessionView))
    expect(html).toContain('完整工具结果未能写入 Artifact 存储')
    expect(html).toContain('role="alert"')
  })

  it('shows the paused banner when the session was stopped', () => {
    mocks.endReason = 'stopped'
    mocks.messages = [
      { role: 'user', id: 'u1', content: 'hi', createdAt: 0 },
    ] as unknown as typeof mocks.messages
    const html = renderToStaticMarkup(createElement(SessionView))
    expect(html).toContain('已暂停')
    expect(html).toContain('继续')
  })

  it('shows runtime operation errors instead of only changing the header status', () => {
    mocks.error = '分支边界消息不存在于当前会话'
    const html = renderToStaticMarkup(createElement(SessionView))
    expect(html).toContain('session__runtime-error')
    expect(html).toContain('分支边界消息不存在于当前会话')
    expect(html).toContain('查看日志')
  })

  it('offers only the same-session retry action for a failed assistant response', () => {
    mocks.messages = [
      { role: 'user', id: 'u1', content: 'retry this', createdAt: 0 },
      {
        role: 'assistant',
        id: 'a1',
        content: '',
        createdAt: 1,
        toolCalls: [],
        stopReason: 'error',
        errorMessage: 'error decoding response body',
      },
    ] as unknown as typeof mocks.messages

    const html = renderToStaticMarkup(createElement(SessionView))

    expect(html).toContain('error decoding response body')
    expect(html).toContain('>重试</button>')
    expect(html).not.toContain('在新分支重试这条回答')
    expect(html).not.toContain('重试回答')
  })

  it('keeps following streamed output only while the reader is near the bottom', () => {
    expect(shouldStickToOutput({ scrollHeight: 1_000, scrollTop: 620, clientHeight: 300 })).toBe(true)
    expect(shouldStickToOutput({ scrollHeight: 1_000, scrollTop: 400, clientHeight: 300 })).toBe(false)
  })
})
