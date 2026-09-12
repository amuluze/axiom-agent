import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  subscribeBrowserEvents: vi.fn(),
  addBrowserAgentActivityListener: vi.fn(),
  browserCommand: vi.fn(),
  browserSettings: { enabled: false, executablePath: '', headless: true },
}))

vi.mock('@/platform/browserSession', () => ({
  subscribeBrowserEvents: mocks.subscribeBrowserEvents,
  addBrowserAgentActivityListener: mocks.addBrowserAgentActivityListener,
  browserCommand: mocks.browserCommand,
}))

vi.mock('@/config/browserSettings', () => ({
  getBrowserSettings: () => mocks.browserSettings,
}))

vi.mock('@/platform/environment', () => ({
  isTauriRuntime: () => true,
}))

import {
  browserPanelServiceInternals,
  initBrowserPanelService,
  openUrlInBuiltinBrowser,
  resetBrowserPanelServiceForTests,
} from './browserPanelService'
import { resetBrowserStoreForTests, useBrowserStore } from '@/stores/browserStore'
import { useUiStore } from '@/stores/uiStore'
import type { BrowserEventHandlers, BrowserAgentActivityListener } from '@/platform/browserSession'

let handlers: BrowserEventHandlers | undefined
let agentListener: BrowserAgentActivityListener | undefined
let unlistenEvents: ReturnType<typeof vi.fn>
let removeAgentListener: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetBrowserStoreForTests()
  mocks.browserSettings.enabled = false
  unlistenEvents = vi.fn()
  removeAgentListener = vi.fn()
  handlers = undefined
  agentListener = undefined
  mocks.subscribeBrowserEvents.mockReset()
  mocks.addBrowserAgentActivityListener.mockReset()
  mocks.browserCommand.mockReset()
  mocks.browserCommand.mockResolvedValue({ type: 'done' })
  mocks.subscribeBrowserEvents.mockImplementation(async (received: BrowserEventHandlers) => {
    handlers = received
    return unlistenEvents
  })
  mocks.addBrowserAgentActivityListener.mockImplementation((received: BrowserAgentActivityListener) => {
    agentListener = received
    return removeAgentListener
  })
})

afterEach(() => {
  resetBrowserPanelServiceForTests()
  useUiStore.setState({ runtimeRailOpen: false, runtimeRailPane: 'picker' })
})

describe('browserPanelService 事件路由', () => {
  it('routes browser events into the store', () => {
    initBrowserPanelService()
    expect(handlers).toBeDefined()
    expect(agentListener).toBeDefined()

    handlers?.onTabs?.({
      tabs: [
        { tabId: 't-1', url: 'http://localhost:5173', title: 'Vite', active: true, hasDialog: false },
        { tabId: 't-2', url: 'https://example.com', title: '', active: false, hasDialog: false },
      ],
    })
    expect(useBrowserStore.getState().tabs).toHaveLength(2)

    handlers?.onNavigated?.({ tabId: 't-2', url: 'https://example.com/next' })
    expect(useBrowserStore.getState().tabs[1]?.url).toBe('https://example.com/next')

    handlers?.onDialog?.({ tabId: 't-2', dialog: { kind: 'confirm', message: '离开？' } })
    expect(useBrowserStore.getState().tabs[1]?.hasDialog).toBe(true)

    handlers?.onFrame?.({
      tabId: 't-1',
      imageBase64: 'ZnJhbWU=',
      mimeType: 'image/jpeg',
      width: 640,
      height: 480,
    })
    expect(useBrowserStore.getState().liveFrame?.src).toBe('data:image/jpeg;base64,ZnJhbWU=')

    handlers?.onConsole?.({
      tabId: 't-1',
      entry: { level: 'error', text: 'boom', source: 'console', timestamp: 1 },
    })
    expect(useBrowserStore.getState().consoleEntries['t-1']).toHaveLength(1)

    // 进程退出事件：清 tabs/帧，保留退出原因。
    handlers?.onStatus?.({ running: false, reason: '浏览器进程已退出' })
    expect(useBrowserStore.getState().status).toMatchObject({
      running: false,
      exitReason: '浏览器进程已退出',
    })
    expect(useBrowserStore.getState().tabs).toHaveLength(0)
    expect(useBrowserStore.getState().liveFrame).toBeNull()
  })
})

describe('browserPanelService screencast 可见性门控', () => {
  it('starts screencast for the active tab only while the rail shows the browser panel', async () => {
    initBrowserPanelService()
    useBrowserStore.setState({
      status: { running: true },
      tabs: [{ tabId: 't-1', url: 'http://localhost:5173', title: 'Vite', active: true, hasDialog: false }],
      liveView: true,
    })
    // rail 不可见：不得推流。
    await browserPanelServiceInternals.syncScreencast()
    expect(mocks.browserCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'startScreencast' }),
    )

    useUiStore.setState({ runtimeRailOpen: true, runtimeRailPane: 'browser' })
    await browserPanelServiceInternals.syncScreencast()
    expect(mocks.browserCommand).toHaveBeenCalledWith({
      action: 'startScreencast',
      tabId: 't-1',
    })
    expect(browserPanelServiceInternals.screencastTabId).toBe('t-1')

    // 切走浏览器面板：停流。
    useUiStore.setState({ runtimeRailPane: 'picker' })
    await browserPanelServiceInternals.syncScreencast()
    expect(mocks.browserCommand).toHaveBeenCalledWith({ action: 'stopScreencast', tabId: 't-1' })
    expect(browserPanelServiceInternals.screencastTabId).toBeNull()
  })

  it('restarts screencast when the measured panel bounds change enough', async () => {
    initBrowserPanelService()
    useBrowserStore.setState({
      status: { running: true },
      tabs: [{ tabId: 't-1', url: 'http://localhost:5173', title: 'Vite', active: true, hasDialog: false }],
      liveView: true,
    })
    useUiStore.setState({ runtimeRailOpen: true, runtimeRailPane: 'browser' })
    // 首启：无 bounds → 不带 maxWidth/maxHeight。
    await browserPanelServiceInternals.syncScreencast()
    expect(browserPanelServiceInternals.screencastTabId).toBe('t-1')
    expect(mocks.browserCommand).toHaveBeenCalledWith({ action: 'startScreencast', tabId: 't-1' })
    // 首次拿到尺寸（此前启动时无线框基准）：重启一次，帧从第一帧起匹配面板。
    useBrowserStore.setState({ liveViewBounds: { width: 320, height: 240 } })
    await browserPanelServiceInternals.syncScreencast()
    expect(mocks.browserCommand).toHaveBeenCalledWith({ action: 'stopScreencast', tabId: 't-1' })
    expect(mocks.browserCommand).toHaveBeenCalledWith({
      action: 'startScreencast',
      tabId: 't-1',
      maxWidth: 320,
      maxHeight: 240,
    })
    // 明显变化（≥ 48px）：stop → start 带新尺寸。
    useBrowserStore.setState({ liveViewBounds: { width: 640, height: 900 } })
    await browserPanelServiceInternals.syncScreencast()
    expect(mocks.browserCommand).toHaveBeenCalledWith({ action: 'stopScreencast', tabId: 't-1' })
    expect(mocks.browserCommand).toHaveBeenCalledWith({
      action: 'startScreencast',
      tabId: 't-1',
      maxWidth: 640,
      maxHeight: 900,
    })
  })

  it('marks screencast unavailable when the engine rejects startScreencast', async () => {
    initBrowserPanelService()
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'startScreencast') {
        throw new Error('开启实时画面失败：not supported')
      }
      return { type: 'done' }
    })
    useBrowserStore.setState({
      status: { running: true },
      tabs: [{ tabId: 't-1', url: 'http://localhost:5173', title: 'Vite', active: true, hasDialog: false }],
      liveView: true,
    })
    useUiStore.setState({ runtimeRailOpen: true, runtimeRailPane: 'browser' })
    await browserPanelServiceInternals.syncScreencast()
    expect(useBrowserStore.getState().screencastAvailable).toBe(false)
    expect(browserPanelServiceInternals.screencastTabId).toBeNull()
  })

  it('passes the measured panel size as capture bounds', async () => {
    initBrowserPanelService()
    useBrowserStore.setState({
      status: { running: true },
      tabs: [{ tabId: 't-1', url: 'http://localhost:5173', title: 'Vite', active: true, hasDialog: false }],
      liveView: true,
      liveViewBounds: { width: 640, height: 480 },
    })
    useUiStore.setState({ runtimeRailOpen: true, runtimeRailPane: 'browser' })
    await browserPanelServiceInternals.syncScreencast()
    expect(mocks.browserCommand).toHaveBeenCalledWith({
      action: 'startScreencast',
      tabId: 't-1',
      maxWidth: 640,
      maxHeight: 480,
    })
  })
})

describe('browserPanelService Agent 联动', () => {
  it('opens the rail on the browser tab with live view when the agent opens a new tab', () => {
    initBrowserPanelService()
    agentListener?.({ action: 'newTab' } as never, { type: 'done' })
    expect(useUiStore.getState().runtimeRailOpen).toBe(true)
    expect(useUiStore.getState().runtimeRailPane).toBe('browser')
    expect(useBrowserStore.getState().liveView).toBe(true)
  })

  it('ignores agent actions other than newTab', () => {
    initBrowserPanelService()
    useUiStore.setState({ runtimeRailOpen: false, runtimeRailPane: 'picker' })
    agentListener?.({ action: 'navigate' } as never, { type: 'done' })
    expect(useUiStore.getState().runtimeRailOpen).toBe(false)
    expect(useBrowserStore.getState().liveView).toBe(false)
  })
})

describe('openUrlInBuiltinBrowser', () => {
  it('opens the rail on the browser tab and requests a new tab when enabled', async () => {
    mocks.browserSettings.enabled = true
    const result = await openUrlInBuiltinBrowser('https://example.com/docs')
    expect(result).toEqual({ ok: true })
    expect(useUiStore.getState().runtimeRailOpen).toBe(true)
    expect(useUiStore.getState().runtimeRailPane).toBe('browser')
    expect(mocks.browserCommand).toHaveBeenCalledWith({ action: 'newTab', url: 'https://example.com/docs' })
  })

  it('opens the rail but skips the SDK request when the browser capability is disabled', async () => {
    // 未启用时面板自身渲染「未启用 → 打开设置」引导，不调 SDK 打断调用方。
    const result = await openUrlInBuiltinBrowser('https://example.com/docs')
    expect(result).toEqual({ ok: false })
    expect(useUiStore.getState().runtimeRailOpen).toBe(true)
    expect(useUiStore.getState().runtimeRailPane).toBe('browser')
    expect(mocks.browserCommand).not.toHaveBeenCalled()
  })

  it('injects the error into the store when the request fails', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserCommand.mockRejectedValue('引擎未找到')
    const result = await openUrlInBuiltinBrowser('https://example.com/docs')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('引擎未找到')
    expect(useBrowserStore.getState().panelError).toBe('引擎未找到')
    // 后续成功请求清除面板错误。
    mocks.browserCommand.mockResolvedValue({ type: 'done' })
    await openUrlInBuiltinBrowser('https://example.com/ok')
    expect(useBrowserStore.getState().panelError).toBeNull()
  })
})
