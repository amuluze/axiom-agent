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
    expect(tool.validate({ action: 'screenshot', tabId: 't1', ref: 12 }).ok).toBe(true)
    expect(tool.validate({ action: 'hover', tabId: 't1', ref: 42 }).ok).toBe(true)
    expect(tool.validate({ action: 'select_tab', tabId: 't1' }).ok).toBe(true)
    expect(tool.validate({ action: 'select_option', tabId: 't1', ref: 31, text: '北京' }).ok).toBe(true)
    expect(tool.validate({ action: 'upload_file', tabId: 't1', ref: 88, path: '/repo/fixtures/a.png' }).ok).toBe(true)
    expect(tool.validate({ action: 'wait', tabId: 't1', text: '登录成功' }).ok).toBe(true)
    expect(tool.validate({ action: 'wait', tabId: 't1', durationMs: 1500 }).ok).toBe(true)
    expect(tool.validate({ action: 'wait', tabId: 't1', text: 'ok', durationMs: 3000 }).ok).toBe(true)
    expect(tool.validate({ action: 'find', tabId: 't1', text: '提交', limit: 5 }).ok).toBe(true)
    expect(tool.validate({ action: 'respond_dialog', tabId: 't1', accept: false }).ok).toBe(true)
    expect(tool.validate({ action: 'console', tabId: 't1' }).ok).toBe(true)
    expect(tool.validate({ action: 'console', tabId: 't1', limit: 30 }).ok).toBe(true)
    expect(tool.validate({ action: 'dblclick', tabId: 't1', ref: 42 }).ok).toBe(true)
    expect(tool.validate({ action: 'set_viewport', tabId: 't1', width: 375, height: 667 }).ok).toBe(true)
    expect(tool.validate({ action: 'set_viewport', tabId: 't1' }).ok).toBe(true)
    expect(tool.validate({ action: 'downloads' }).ok).toBe(true)
    expect(tool.validate({ action: 'downloads', limit: 5 }).ok).toBe(true)
    expect(tool.validate({ action: 'read_download', name: 'report.json' }).ok).toBe(true)
  })

  it('rejects invalid select_tab/select_option/upload_file arguments', () => {
    expect(tool.validate({ action: 'select_tab' }).ok).toBe(false)
    expect(tool.validate({ action: 'select_option', tabId: 't1', ref: 31 }).ok).toBe(false)
    expect(tool.validate({ action: 'select_option', tabId: 't1', ref: 31, text: '  ' }).ok).toBe(false)
    expect(tool.validate({ action: 'select_option', tabId: 't1', text: '北京' }).ok).toBe(false)
    expect(tool.validate({ action: 'upload_file', tabId: 't1', ref: 88 }).ok).toBe(false)
    expect(tool.validate({ action: 'upload_file', tabId: 't1', ref: 88, path: '' }).ok).toBe(false)
    expect(tool.validate({ action: 'upload_file', tabId: 't1', ref: 88, path: 'fixtures/a.png' }).ok).toBe(false)
    expect(tool.validate({ action: 'upload_file', tabId: 't1', path: '/repo/a.png' }).ok).toBe(false)
  })

  it('rejects invalid hover/wait/find arguments', () => {
    expect(tool.validate({ action: 'hover', tabId: 't1' }).ok).toBe(false)
    expect(tool.validate({ action: 'hover', tabId: 't1', ref: 0 }).ok).toBe(false)
    expect(tool.validate({ action: 'wait', tabId: 't1' }).ok).toBe(false)
    expect(tool.validate({ action: 'wait', tabId: 't1', text: '' }).ok).toBe(false)
    expect(tool.validate({ action: 'wait', tabId: 't1', durationMs: 0 }).ok).toBe(false)
    expect(tool.validate({ action: 'wait', tabId: 't1', durationMs: 15001 }).ok).toBe(false)
    expect(tool.validate({ action: 'find', tabId: 't1' }).ok).toBe(false)
    expect(tool.validate({ action: 'find', tabId: 't1', text: '  ' }).ok).toBe(false)
    expect(tool.validate({ action: 'find', tabId: 't1', text: '提交', limit: 51 }).ok).toBe(false)
    expect(tool.validate({ action: 'find', tabId: 't1', text: '提交', limit: 1.5 }).ok).toBe(false)
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

  it('rejects invalid dblclick/set_viewport/downloads/read_download arguments', () => {
    expect(tool.validate({ action: 'dblclick', tabId: 't1' }).ok).toBe(false)
    expect(tool.validate({ action: 'dblclick', tabId: 't1', ref: 0 }).ok).toBe(false)
    expect(tool.validate({ action: 'set_viewport', tabId: 't1', width: 375 }).ok).toBe(false)
    expect(tool.validate({ action: 'set_viewport', tabId: 't1', height: 667 }).ok).toBe(false)
    expect(tool.validate({ action: 'set_viewport', tabId: 't1', width: 0, height: 667 }).ok).toBe(false)
    expect(tool.validate({ action: 'set_viewport', tabId: 't1', width: 10001, height: 667 }).ok).toBe(false)
    expect(tool.validate({ action: 'set_viewport', tabId: 't1', width: 1.5, height: 667 }).ok).toBe(false)
    expect(tool.validate({ action: 'downloads', limit: 0 }).ok).toBe(false)
    expect(tool.validate({ action: 'downloads', limit: 51 }).ok).toBe(false)
    expect(tool.validate({ action: 'read_download' }).ok).toBe(false)
    expect(tool.validate({ action: 'read_download', name: '  ' }).ok).toBe(false)
    expect(tool.validate({ action: 'read_download', name: '../escape.txt' }).ok).toBe(false)
    expect(tool.validate({ action: 'read_download', name: 'a/b.txt' }).ok).toBe(false)
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

  it('renders wait outcomes and tells the model to observe after waiting', async () => {
    const matched = createBrowserTool(
      createFakeAgentEnvironment({ browserCommand: respondsWith({ type: 'waited', textMatched: true, waitedMs: 900 }) }),
    )
    const matchedResult = await matched.execute({ action: 'wait', tabId: 't1', text: '登录成功' }, baseContext())
    expect(matchedResult.content).toContain('目标文本已出现')

    const timedOut = createBrowserTool(
      createFakeAgentEnvironment({ browserCommand: respondsWith({ type: 'waited', textMatched: false, waitedMs: 15000 }) }),
    )
    const timedOutResult = await timedOut.execute({ action: 'wait', tabId: 't1', durationMs: 15000 }, baseContext())
    expect(timedOutResult.content).toContain('未出现')
  })

  it('forwards hover and renders find matches with ref anchors', async () => {
    const hover = createFakeAgentEnvironment({
      browserCommand: respondsWith({ type: 'done' }),
    })
    const hoverTool = createBrowserTool(hover)
    await hoverTool.execute({ action: 'hover', tabId: 't1', ref: 42 }, baseContext())
    expect(hover.browser.command).toHaveBeenCalledWith({ action: 'hover', tabId: 't1', ref: 42 })

    const selectTab = createFakeAgentEnvironment({
      browserCommand: respondsWith({ type: 'done' }),
    })
    const selectTabTool = createBrowserTool(selectTab)
    await selectTabTool.execute({ action: 'select_tab', tabId: 't9' }, baseContext())
    expect(selectTab.browser.command).toHaveBeenCalledWith({ action: 'activateTab', tabId: 't9' })

    const upload = createFakeAgentEnvironment({
      browserCommand: respondsWith({ type: 'done' }),
    })
    const uploadTool = createBrowserTool(upload)
    await uploadTool.execute(
      { action: 'upload_file', tabId: 't1', ref: 88, path: '/repo/fixtures/a.png' },
      baseContext(),
    )
    expect(upload.browser.command).toHaveBeenCalledWith({
      action: 'uploadFile',
      tabId: 't1',
      ref: 88,
      path: '/repo/fixtures/a.png',
    })

    const selectOption = createFakeAgentEnvironment({
      browserCommand: respondsWith({ type: 'done' }),
    })
    const selectOptionTool = createBrowserTool(selectOption)
    await selectOptionTool.execute(
      { action: 'select_option', tabId: 't1', ref: 31, text: '北京' },
      baseContext(),
    )
    expect(selectOption.browser.command).toHaveBeenCalledWith({
      action: 'selectOption',
      tabId: 't1',
      ref: 31,
      text: '北京',
    })

    const found = createBrowserTool(
      createFakeAgentEnvironment({
        browserCommand: respondsWith({
          type: 'found',
          url: 'http://localhost:5173/',
          title: 'Vite App',
          matches: ['[ref=12] button "提交"', '[ref=13] textbox "搜索"'],
          total: 5,
          truncated: true,
        }),
      }),
    )
    const foundResult = await found.execute({ action: 'find', tabId: 't1', text: '提交' }, baseContext())
    expect(foundResult.content).toContain('[ref=12] button "提交"')
    expect(foundResult.content).toContain('共 5 条命中')
    expect(foundResult.content).toContain('仅返回前 2 条')
    expect(foundResult.details).toMatchObject({ action: 'find', total: 5, truncated: true })

    const none = createBrowserTool(
      createFakeAgentEnvironment({
        browserCommand: respondsWith({
          type: 'found',
          url: 'http://localhost:5173/',
          title: 'Vite App',
          matches: [],
          total: 0,
          truncated: false,
        }),
      }),
    )
    const noneResult = await none.execute({ action: 'find', tabId: 't1', text: '不存在' }, baseContext())
    expect(noneResult.content).toContain('没有找到匹配「不存在」')
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

  it('forwards dblclick and set_viewport as camelCase requests and renders viewport outcomes', async () => {
    const dbl = createFakeAgentEnvironment({ browserCommand: respondsWith({ type: 'done' }) })
    const dblTool = createBrowserTool(dbl)
    await dblTool.execute({ action: 'dblclick', tabId: 't1', ref: 42 }, baseContext())
    expect(dbl.browser.command).toHaveBeenCalledWith({ action: 'dblClick', tabId: 't1', ref: 42 })

    const viewport = createFakeAgentEnvironment({
      browserCommand: respondsWith({ type: 'viewportApplied', width: 375, height: 667 }),
    })
    const viewportTool = createBrowserTool(viewport)
    const result = await viewportTool.execute(
      { action: 'set_viewport', tabId: 't1', width: 375, height: 667 },
      baseContext(),
    )
    expect(viewport.browser.command).toHaveBeenCalledWith({
      action: 'setViewport',
      tabId: 't1',
      width: 375,
      height: 667,
    })
    expect(result.content).toContain('375x667')

    const cleared = createFakeAgentEnvironment({
      browserCommand: respondsWith({ type: 'viewportApplied' }),
    })
    const clearedTool = createBrowserTool(cleared)
    const clearedResult = await clearedTool.execute({ action: 'set_viewport', tabId: 't1' }, baseContext())
    expect(cleared.browser.command).toHaveBeenCalledWith({ action: 'setViewport', tabId: 't1' })
    expect(clearedResult.content).toContain('回自然视口')
  })

  it('renders download listings with absolute paths and forwards read_download', async () => {
    const list = createFakeAgentEnvironment({
      browserCommand: respondsWith({
        type: 'downloadList',
        directory: '/Users/x/.axiom/browser/downloads',
        entries: [
          { name: 'report.json', path: '/Users/x/.axiom/browser/downloads/report.json', sizeBytes: 42, modifiedAt: 1 },
        ],
      }),
    })
    const listTool = createBrowserTool(list)
    const listResult = await listTool.execute({ action: 'downloads' }, baseContext())
    expect(list.browser.command).toHaveBeenCalledWith({ action: 'downloads' })
    expect(listResult.content).toContain('report.json')
    expect(listResult.content).toContain('/Users/x/.axiom/browser/downloads/report.json')

    const content = createFakeAgentEnvironment({
      browserCommand: respondsWith({
        type: 'downloadContent',
        name: 'report.json',
        path: '/Users/x/.axiom/browser/downloads/report.json',
        sizeBytes: 42,
        truncated: false,
        content: '{"ok":true}',
      }),
    })
    const contentTool = createBrowserTool(content)
    const contentResult = await contentTool.execute(
      { action: 'read_download', name: 'report.json' },
      baseContext(),
    )
    expect(content.browser.command).toHaveBeenCalledWith({ action: 'readDownload', name: 'report.json' })
    expect(contentResult.content).toContain('{"ok":true}')
  })

  it('notes truncation for oversized download content', async () => {
    const environment = createFakeAgentEnvironment({
      browserCommand: respondsWith({
        type: 'downloadContent',
        name: 'big.log',
        path: '/Users/x/.axiom/browser/downloads/big.log',
        sizeBytes: 999999,
        truncated: true,
        content: 'partial',
      }),
    })
    const tool = createBrowserTool(environment)
    const result = await tool.execute({ action: 'read_download', name: 'big.log' }, baseContext())
    expect(result.content).toContain('内容已截断')
  })
})

describe('browserTool contract metadata', () => {
  it('declares never-recovery and serialized execution for stateful browser actions', () => {
    const tool = createBrowserTool(createFakeAgentEnvironment())
    expect(tool.name).toBe('browser')
    expect(tool.runtimeVersion).toBe('6')
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
