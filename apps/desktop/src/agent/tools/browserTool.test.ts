import { describe, expect, it, vi } from 'vitest'
import type { AgentToolExecutionContext } from '@/agent/core/types'
import type {
  BrowserCommandRequest,
  BrowserCommandResponse,
} from '@/agent/environment/AgentEnvironment'
import { createFakeAgentEnvironment } from './__fixtures__/fakeAgentEnvironment'
import { createBrowserTool, BROWSER_MAX_URL_CHARS } from './browserTool'

const baseContext = (overrides: Partial<AgentToolExecutionContext> = {}): AgentToolExecutionContext => ({
  sessionId: 'session-1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  signal: new AbortController().signal,
  reportProgress: async () => undefined,
  modelAcceptsImage: true,
  ...overrides,
})

const respondsWith =
  (response: BrowserCommandResponse) =>
  async (request: BrowserCommandRequest): Promise<BrowserCommandResponse> => {
    void request
    return response
  }

describe('browserTool validate', () => {
  const tool = createBrowserTool(createFakeAgentEnvironment())

  it('accepts each action with its required arguments', () => {
    expect(tool.validate({ action: 'tabs' }).ok).toBe(true)
    expect(tool.validate({ action: 'new_tab' }).ok).toBe(true)
    expect(tool.validate({ action: 'new_tab', url: 'http://localhost:5173/' }).ok).toBe(true)
    expect(tool.validate({ action: 'navigate', tabId: 't1', url: 'https://example.com' }).ok).toBe(true)
    expect(tool.validate({ action: 'snapshot', tabId: 't1' }).ok).toBe(true)
    expect(tool.validate({ action: 'click', tabId: 't1', ref: 42 }).ok).toBe(true)
    expect(tool.validate({ action: 'fill', tabId: 't1', ref: 42, text: 'hello' }).ok).toBe(true)
    expect(tool.validate({ action: 'type_text', tabId: 't1', text: 'hi', ref: 7 }).ok).toBe(true)
    expect(tool.validate({ action: 'press', tabId: 't1', key: 'Enter' }).ok).toBe(true)
    expect(tool.validate({ action: 'scroll', tabId: 't1', deltaY: -300 }).ok).toBe(true)
    expect(tool.validate({ action: 'screenshot', tabId: 't1' }).ok).toBe(true)
    expect(tool.validate({ action: 'respond_dialog', tabId: 't1', accept: false }).ok).toBe(true)
    expect(tool.validate({ action: 'console', tabId: 't1' }).ok).toBe(true)
    expect(tool.validate({ action: 'console', tabId: 't1', limit: 30 }).ok).toBe(true)
  })

  it('rejects unknown actions and misplaced arguments', () => {
    expect(tool.validate({ action: 'ensure_running' }).ok).toBe(false)
    expect(tool.validate({ action: 'tabs', tabId: 't1' }).ok).toBe(false)
    expect(tool.validate({ action: 'navigate', url: 'https://example.com' }).ok).toBe(false)
    expect(tool.validate({ action: 'click', tabId: 't1', text: 'nope' }).ok).toBe(false)
    expect(tool.validate({}).ok).toBe(false)
    expect(tool.validate('tabs').ok).toBe(false)
  })

  it('enforces url scheme/length, positive ref, and text bounds', () => {
    expect(tool.validate({ action: 'navigate', tabId: 't1', url: 'ftp://example.com' }).ok).toBe(false)
    expect(tool.validate({ action: 'navigate', tabId: 't1', url: 'file:///etc/passwd' }).ok).toBe(false)
    expect(
      tool.validate({ action: 'navigate', tabId: 't1', url: `https://example.com/${'a'.repeat(BROWSER_MAX_URL_CHARS)}` }).ok,
    ).toBe(false)
    expect(tool.validate({ action: 'click', tabId: 't1', ref: 0 }).ok).toBe(false)
    expect(tool.validate({ action: 'click', tabId: 't1', ref: 1.5 }).ok).toBe(false)
    expect(tool.validate({ action: 'click', tabId: '', ref: 3 }).ok).toBe(false)
    expect(tool.validate({ action: 'fill', tabId: 't1', ref: 1, text: 123 }).ok).toBe(false)
    expect(tool.validate({ action: 'respond_dialog', tabId: 't1', accept: 'yes' }).ok).toBe(false)
    expect(tool.validate({ action: 'scroll', tabId: 't1', deltaX: 'down' }).ok).toBe(false)
    expect(tool.validate({ action: 'console', tabId: 't1', limit: 0 }).ok).toBe(false)
    expect(tool.validate({ action: 'console', tabId: 't1', limit: 201 }).ok).toBe(false)
    expect(tool.validate({ action: 'console', tabId: 't1', limit: 1.5 }).ok).toBe(false)
    expect(tool.validate({ action: 'console' }).ok).toBe(false)
  })
})

describe('browserTool execute', () => {
  it('forwards navigate as the camelCase request and formats the result', async () => {
    const environment = createFakeAgentEnvironment({
      browserCommand: respondsWith({ type: 'navigated', url: 'http://localhost:5173/', title: 'Vite App' }),
    })
    const tool = createBrowserTool(environment)
    const result = await tool.execute({ action: 'navigate', tabId: 't1', url: 'http://localhost:5173/' }, baseContext())
    expect(environment.browser.command).toHaveBeenCalledWith({
      action: 'navigate',
      tabId: 't1',
      url: 'http://localhost:5173/',
    })
    expect(result.content).toContain('Vite App')
    expect(result.details).toMatchObject({ action: 'navigate', url: 'http://localhost:5173/' })
  })

  it('formats tab lists with tabId anchors and empty-state guidance', async () => {
    const empty = createBrowserTool(
      createFakeAgentEnvironment({ browserCommand: respondsWith({ type: 'tabs', tabs: [] }) }),
    )
    const emptyResult = await empty.execute({ action: 'tabs' }, baseContext())
    expect(emptyResult.content).toContain('没有打开的 tab')

    const populated = createBrowserTool(
      createFakeAgentEnvironment({
        browserCommand: respondsWith({
          type: 'tabs',
          tabs: [
            { tabId: 'ABC123', url: 'http://localhost:5173/', title: 'Dev', active: true, hasDialog: false },
            { tabId: 'DEF456', url: 'https://example.com/', title: '', active: false, hasDialog: true },
          ],
        }),
      }),
    )
    const result = await populated.execute({ action: 'tabs' }, baseContext())
    expect(result.content).toContain('tabId=ABC123')
    expect(result.content).toContain('（当前活跃）')
    expect(result.content).toContain('⚠有对话框待处理')
  })

  it('returns the snapshot text with dialog warning when present', async () => {
    const tool = createBrowserTool(
      createFakeAgentEnvironment({
        browserCommand: respondsWith({
          type: 'snapshot',
          url: 'https://example.com/',
          title: 'Example',
          text: '- [ref=1] heading "Title"',
          truncated: false,
          dialog: { kind: 'confirm', message: '离开页面？' },
        }),
      }),
    )
    const result = await tool.execute({ action: 'snapshot', tabId: 't1' }, baseContext())
    expect(result.content).toContain('[ref=1] heading "Title"')
    expect(result.content).toContain('confirm')
    expect(result.content).toContain('离开页面？')
    expect(result.details).toMatchObject({ truncated: false, hasDialog: true })
  })

  it('emits an image content block for screenshots on vision models', async () => {
    const tool = createBrowserTool(
      createFakeAgentEnvironment({
        browserCommand: respondsWith({
          type: 'screenshot',
          imageBase64: 'aGVsbG8=',
          mimeType: 'image/png',
          width: 1280,
          height: 800,
          resized: false,
        }),
      }),
    )
    const result = await tool.execute({ action: 'screenshot', tabId: 't1' }, baseContext())
    expect(result.contentBlocks).toEqual([
      { type: 'text', text: expect.stringContaining('1280x800') },
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: 'aGVsbG8=' },
      },
    ])
  })

  it('degrades screenshots to a text note for non-vision models', async () => {
    const tool = createBrowserTool(
      createFakeAgentEnvironment({
        browserCommand: respondsWith({
          type: 'screenshot',
          imageBase64: 'aGVsbG8=',
          mimeType: 'image/png',
          width: 1280,
          height: 800,
          resized: true,
        }),
      }),
    )
    const result = await tool.execute(
      { action: 'screenshot', tabId: 't1' },
      baseContext({ modelAcceptsImage: false }),
    )
    expect(result.contentBlocks).toBeUndefined()
    expect(result.content).toContain('不支持图片')
  })

  it('surfaces dialog state and forwards respondDialog', async () => {
    const dialogTool = createBrowserTool(
      createFakeAgentEnvironment({
        browserCommand: respondsWith({ type: 'dialogState', dialog: { kind: 'prompt', message: '名字？' } }),
      }),
    )
    const dialogResult = await dialogTool.execute({ action: 'dialog', tabId: 't1' }, baseContext())
    expect(dialogResult.content).toContain('prompt')
    expect(dialogResult.content).toContain('名字？')

    const environment = createFakeAgentEnvironment({
      browserCommand: respondsWith({ type: 'done' }),
    })
    const tool = createBrowserTool(environment)
    await tool.execute(
      { action: 'respond_dialog', tabId: 't1', accept: true, promptText: 'Axiom' },
      baseContext(),
    )
    expect(environment.browser.command).toHaveBeenCalledWith({
      action: 'respondDialog',
      tabId: 't1',
      accept: true,
      promptText: 'Axiom',
    })
  })

  it('forwards console requests and formats entries with a level summary', async () => {
    const environment = createFakeAgentEnvironment({
      browserCommand: respondsWith({
        type: 'consoleLog',
        entries: [
          { level: 'info', text: 'vite ready', source: 'console', timestamp: 1700000000000 },
          { level: 'error', text: 'Failed to load resource: 404', source: 'network', timestamp: 1700000001000 },
          { level: 'error', text: 'Uncaught TypeError: x is not a function', source: 'exception', timestamp: 1700000002000 },
        ],
      }),
    })
    const tool = createBrowserTool(environment)
    const result = await tool.execute({ action: 'console', tabId: 't1', limit: 30 }, baseContext())
    expect(environment.browser.command).toHaveBeenCalledWith({
      action: 'console',
      tabId: 't1',
      limit: 30,
    })
    expect(result.content).toContain('最近 3 条')
    expect(result.content).toContain('2 error')
    expect(result.content).toContain('[error][network] Failed to load resource: 404')
    expect(result.content).toContain('[error][exception] Uncaught TypeError')
    // 时间正序：网络错误在前、异常在后。
    expect(result.content.indexOf('404')).toBeLessThan(result.content.indexOf('TypeError'))
    expect(result.details).toMatchObject({ action: 'console', count: 3, errorCount: 2 })
  })

  it('formats empty console output with guidance', async () => {
    const tool = createBrowserTool(
      createFakeAgentEnvironment({ browserCommand: respondsWith({ type: 'consoleLog', entries: [] }) }),
    )
    const result = await tool.execute({ action: 'console', tabId: 't1' }, baseContext())
    expect(result.content).toContain('暂无 console 输出')
    expect(result.details).toMatchObject({ count: 0, errorCount: 0 })
  })

  it('re-throws environment errors verbatim so the runtime marks isError', async () => {
    const environment = createFakeAgentEnvironment({
      browserCommand: async () => {
        throw new Error('浏览器能力未启用：请在 设置 → 浏览器 打开开关并保存')
      },
    })
    const tool = createBrowserTool(environment)
    await expect(tool.execute({ action: 'tabs' }, baseContext())).rejects.toThrow('浏览器能力未启用')
  })

  it('aborts before dispatching when the signal is already aborted', async () => {
    const environment = createFakeAgentEnvironment()
    const tool = createBrowserTool(environment)
    const controller = new AbortController()
    controller.abort()
    await expect(tool.execute({ action: 'tabs' }, baseContext({ signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(environment.browser.command).not.toHaveBeenCalled()
  })
})

describe('browserTool contract metadata', () => {
  it('declares never-recovery and serialized execution for stateful browser actions', () => {
    const tool = createBrowserTool(createFakeAgentEnvironment())
    expect(tool.name).toBe('browser')
    expect(tool.runtimeVersion).toBe('2')
    expect(tool.recoveryPolicy).toBe('never')
    expect(tool.requiresApproval).toBe(false)
    expect(tool.executionMode).toBe('sequential')
    expect(tool.idempotencyKey).toBeUndefined()
    expect(tool.promptSnippet).toBeTruthy()
    expect(tool.promptGuidelines?.length).toBeGreaterThan(0)
  })

  it('keeps discoverability keywords in the description surface', () => {
    const tool = createBrowserTool(createFakeAgentEnvironment())
    const haystack = `${tool.name} ${tool.label} ${tool.description} ${tool.promptSnippet ?? ''}`.toLowerCase()
    for (const keyword of ['browser', 'navigate', 'click', 'screenshot', 'snapshot', 'localhost']) {
      expect(haystack).toContain(keyword)
    }
  })

  it('does not call the environment from validate', () => {
    const environment = createFakeAgentEnvironment()
    const tool = createBrowserTool(environment)
    expect(tool.validate({ action: 'tabs' }).ok).toBe(true)
    expect(environment.browser.command).not.toHaveBeenCalled()
    expect(vi.mocked(environment.browser.command).mock.calls.length).toBe(0)
  })
})
