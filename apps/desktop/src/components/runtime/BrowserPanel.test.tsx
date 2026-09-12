// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from './BrowserPanel'
import { resetBrowserStoreForTests, useBrowserStore } from '@/stores/browserStore'
import type { BrowserCommandResponse } from '@/platform/browserSession'

const mocks = vi.hoisted(() => {
  const statusRunning: BrowserCommandResponse = {
    type: 'status',
    running: true,
    port: 9222,
    engine: 'Google Chrome',
    headless: true,
    version: '130',
    tabs: 1,
  }
  const statusStopped: BrowserCommandResponse = { type: 'status', running: false }
  const tabsEmpty: BrowserCommandResponse = { type: 'tabs', tabs: [] }
  const tabsOne: BrowserCommandResponse = {
    type: 'tabs',
    tabs: [
      { tabId: 't-1', url: 'http://localhost:5173', title: 'Vite', active: true, hasDialog: false },
    ],
  }
  const tabsTwo: BrowserCommandResponse = {
    type: 'tabs',
    tabs: [
      { tabId: 't-1', url: 'http://localhost:5173', title: 'Vite', active: true, hasDialog: false },
      { tabId: 't-2', url: 'https://example.com/', title: 'Example Domain', active: false, hasDialog: false },
    ],
  }
  const tabsDialog: BrowserCommandResponse = {
    type: 'tabs',
    tabs: [
      { tabId: 't-1', url: 'http://localhost:5173', title: 'Vite', active: true, hasDialog: true },
    ],
  }
  const screenshotResponse: BrowserCommandResponse = {
    type: 'screenshot',
    imageBase64: 'YWJj',
    mimeType: 'image/png',
    width: 800,
    height: 600,
    resized: false,
  }
  const snapshotResponse: BrowserCommandResponse = {
    type: 'snapshot',
    url: 'http://localhost:5173',
    title: 'Vite',
    text: 'Welcome to Vite. Fastest frontend tool.',
    truncated: false,
  }
  return {
    statusRunning,
    statusStopped,
    tabsEmpty,
    tabsOne,
    tabsTwo,
    tabsDialog,
    screenshotResponse,
    snapshotResponse,
    browserCommand: vi.fn(),
    browserStatus: vi.fn(),
    ensureBrowserRunning: vi.fn(),
    shutdownBrowser: vi.fn(),
    setSettingsSection: vi.fn(),
    setView: vi.fn(),
    openExternalUrl: vi.fn(async () => Promise.resolve()),
    browserSettings: { enabled: false, executablePath: '', headless: true },
  }
})

vi.mock('@/platform/browserSession', () => ({
  browserCommand: mocks.browserCommand,
  browserStatus: mocks.browserStatus,
  ensureBrowserRunning: mocks.ensureBrowserRunning,
  shutdownBrowser: mocks.shutdownBrowser,
}))

vi.mock('@/config/browserSettings', () => ({
  getBrowserSettings: () => mocks.browserSettings,
}))

vi.mock('@/platform/webAccess', () => ({
  openExternalUrl: mocks.openExternalUrl,
}))

vi.mock('@/stores/uiStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/uiStore')>()
  type UiState = ReturnType<typeof original.useUiStore.getState>
  return {
    ...original,
    useUiStore: <T,>(selector: (state: UiState) => T): T => selector({
      ...original.useUiStore.getState(),
      setSettingsSection: mocks.setSettingsSection,
      setView: mocks.setView,
    } as UiState),
  }
})

beforeEach(() => {
  mocks.browserSettings.enabled = false
  mocks.browserCommand.mockReset()
  mocks.browserStatus.mockReset()
  mocks.ensureBrowserRunning.mockReset()
  mocks.shutdownBrowser.mockReset()
  mocks.setSettingsSection.mockReset()
  mocks.setView.mockReset()
  mocks.openExternalUrl.mockReset()
  // 面板状态已 store 化：跨用例复位，避免上一个用例的 tabs/直播帧泄漏。
  resetBrowserStoreForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

const submitUrl = async (value: string): Promise<void> => {
  const input = screen.getByLabelText('地址栏')
  fireEvent.change(input, { target: { value } })
  const form = input.closest('form')
  expect(form).toBeTruthy()
  await act(async () => {
    fireEvent.submit(form as HTMLFormElement)
  })
}

describe('BrowserPanel', () => {
  it('shows the disabled state and routes to settings when the browser is not enabled', async () => {
    mocks.browserSettings.enabled = false
    mocks.browserStatus.mockResolvedValue(mocks.statusStopped)
    mocks.browserCommand.mockResolvedValue(mocks.tabsEmpty)

    render(<BrowserPanel />)
    expect(await screen.findByText('浏览器未启用')).toBeTruthy()
    // 未启用时隐藏工具栏与页脚，只留设置引导。
    expect(screen.queryByLabelText('地址栏')).toBeNull()
    expect(screen.queryByText('关闭浏览器')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }))
    expect(mocks.setSettingsSection).toHaveBeenCalledWith('browser')
    expect(mocks.setView).toHaveBeenCalledWith('settings')
  })

  it('shows the not-running state and lets the user start the browser', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusStopped)
    mocks.browserCommand.mockResolvedValue(mocks.tabsEmpty)
    mocks.ensureBrowserRunning.mockResolvedValue(mocks.statusRunning)

    render(<BrowserPanel />)
    expect(await screen.findByText('浏览器未启动')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '启动浏览器' }))
    })
    await waitFor(() => {
      expect(mocks.ensureBrowserRunning).toHaveBeenCalledWith({
        enabled: true,
        executablePath: '',
        headless: true,
      })
    })
  })

  it('does not auto-spawn the browser when mounting with the browser stopped', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusStopped)
    mocks.browserCommand.mockResolvedValue(mocks.tabsEmpty)

    render(<BrowserPanel />)
    expect(await screen.findByText('浏览器未启动')).toBeTruthy()
    // tabs 动作带 spawn 门控：未运行时不得调用，避免打开面板就拉起浏览器。
    expect(mocks.browserCommand).not.toHaveBeenCalled()
  })

  it('surfaces raw string rejections from Tauri invoke', async () => {
    mocks.browserSettings.enabled = true
    // Tauri invoke 拒绝值是 Rust 侧原始字符串，不是 Error 实例。
    mocks.browserStatus.mockRejectedValue('未找到可用的 Chromium 系浏览器')
    mocks.browserCommand.mockRejectedValue('未找到可用的 Chromium 系浏览器')

    render(<BrowserPanel />)
    expect(await screen.findByText('浏览器状态拉取失败')).toBeTruthy()
    expect(screen.getByText('未找到可用的 Chromium 系浏览器')).toBeTruthy()
  })

  it('renders the tab strip when the browser is running and highlights the active tab', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      return mocks.statusRunning
    })

    render(<BrowserPanel />)
    expect(await screen.findByText('Vite')).toBeTruthy()
    // 高亮 active tab（tab 条内）
    const activeTab = screen.getByRole('tab', { name: /Vite/ })
    expect(activeTab).toHaveAttribute('aria-selected', 'true')
    expect(activeTab.closest('.rail__browser-tab--active')).toBeTruthy()
    // 关闭按钮 aria-label 含 title
    expect(screen.getByRole('button', { name: '关闭 tab Vite' })).toBeTruthy()
    // 页脚状态行展示 tab 数与引擎
    expect(screen.getByText('1 tab · Google Chrome')).toBeTruthy()
  })

  it('shows the centered empty state when running without any tab', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockResolvedValue(mocks.tabsEmpty)

    render(<BrowserPanel />)
    expect(await screen.findByText('浏览器')).toBeTruthy()
    expect(screen.getByText('粘贴或输入 URL 以打开网页。')).toBeTruthy()
  })

  it('surfaces IPC errors and lets the user retry', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockRejectedValue(new Error('cdp unreachable'))
    mocks.browserCommand.mockRejectedValue(new Error('cdp unreachable'))

    render(<BrowserPanel />)
    expect(await screen.findByText('浏览器状态拉取失败')).toBeTruthy()
    expect(screen.getByText('cdp unreachable')).toBeTruthy()

    // 重试：第二次调用应回到成功分支。
    mocks.browserStatus.mockResolvedValueOnce(mocks.statusRunning)
    mocks.browserCommand.mockResolvedValueOnce(mocks.tabsOne)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试' }))
    })
    expect(await screen.findByText('Vite')).toBeTruthy()
  })

  it('shows action errors as an inline banner without replacing the tab list', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      if (request.action === 'closeTab') throw new Error('close failed')
      return mocks.statusRunning
    })

    render(<BrowserPanel />)
    expect(await screen.findByText('Vite')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '关闭 tab Vite' }))
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('close failed')
    // 列表仍在，未整页替换为错误态。
    expect(screen.getByText('Vite')).toBeTruthy()
  })

  it('navigates the active tab when submitting a localhost URL', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      return mocks.statusRunning
    })

    render(<BrowserPanel />)
    expect(await screen.findByText('Vite')).toBeTruthy()
    await submitUrl('localhost:5174/foo')
    expect(mocks.browserCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'navigate', tabId: 't-1', url: 'http://localhost:5174/foo' }),
    )
  })

  it('opens a new tab with an https URL when there is no active tab', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsEmpty
      return mocks.statusRunning
    })

    render(<BrowserPanel />)
    expect(await screen.findByText('浏览器')).toBeTruthy()
    await submitUrl('example.com')
    expect(mocks.browserCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'newTab', url: 'https://example.com' }),
    )
  })

  it('keeps explicit schemes and ignores blank URL submissions', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      return mocks.statusRunning
    })

    render(<BrowserPanel />)
    expect(await screen.findByText('Vite')).toBeTruthy()
    await submitUrl('  ')
    expect(mocks.browserCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'navigate' }),
    )
    expect(mocks.browserCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'newTab' }),
    )

    await submitUrl('http://localhost:5173/explicit')
    expect(mocks.browserCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'navigate', url: 'http://localhost:5173/explicit' }),
    )
  })

  it('disables page navigation buttons without an active tab and reloads the active one', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsEmpty
      return mocks.statusRunning
    })

    render(<BrowserPanel />)
    expect(await screen.findByText('浏览器')).toBeTruthy()
    expect(screen.getByRole('button', { name: '后退' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '前进' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重新加载页面' })).toBeDisabled()
  })

  it('syncs the URL bar with the active tab and skips duplicate submissions', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      return mocks.statusRunning
    })

    render(<BrowserPanel />)
    const input = await screen.findByLabelText('地址栏') as HTMLInputElement
    // 地址栏回显 active tab 当前地址。
    await waitFor(() => { expect(input.value).toBe('http://localhost:5173') })

    // 提交相同地址时不重复导航。
    await submitUrl('http://localhost:5173')
    expect(mocks.browserCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'navigate' }),
    )
  })

  it('reverts the URL bar to the active tab address on Escape', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      return mocks.statusRunning
    })

    render(<BrowserPanel />)
    const input = await screen.findByLabelText('地址栏') as HTMLInputElement
    await waitFor(() => { expect(input.value).toBe('http://localhost:5173') })

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'typed-but-abandoned' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('http://localhost:5173')
  })

  it('exposes dialog handling for tabs with a pending JS dialog', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsDialog
      return mocks.statusRunning
    })

    render(<BrowserPanel />)
    expect(await screen.findByText('Vite')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '处理对话框 Vite' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '接受' }))
    })
    expect(mocks.browserCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'respondDialog', tabId: 't-1', accept: true }),
    )
  })

  it('activates an inactive tab when its row is clicked and skips the active one', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsTwo
      return mocks.statusRunning
    })

    render(<BrowserPanel />)
    expect(await screen.findByText('Example Domain')).toBeTruthy()

    // 点击非 active 行 → activateTab。
    await act(async () => {
      fireEvent.click(screen.getByText('Example Domain'))
    })
    expect(mocks.browserCommand).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'activateTab', tabId: 't-2' }),
    )

    // 点击 active 行不重复激活。
    await act(async () => {
      fireEvent.click(screen.getByText('Vite'))
    })
    expect(mocks.browserCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'activateTab', tabId: 't-1' }),
    )
  })

  it('disables back/forward according to the active tab navigation history', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      if (request.action === 'navigationHistory') {
        return { type: 'navigationState', canGoBack: false, canGoForward: true }
      }
      return mocks.statusRunning
    })

    render(<BrowserPanel />)
    await screen.findByText('Vite')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '后退' })).toBeDisabled()
    })
    expect(screen.getByRole('button', { name: '前进' })).toBeEnabled()
  })

  it('shows dialog details and sends prompt text when accepting a prompt dialog', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsDialog
      if (request.action === 'dialog') {
        return { type: 'dialogState', dialog: { kind: 'prompt', message: '请输入用户名' } }
      }
      return mocks.statusRunning
    })

    render(<BrowserPanel />)
    await screen.findByText('Vite')
    fireEvent.click(screen.getByRole('button', { name: '处理对话框 Vite' }))
    // 展开后可见对话框类型与内容。
    expect(await screen.findByText('输入框')).toBeTruthy()
    expect(screen.getByText('请输入用户名')).toBeTruthy()
    const input = screen.getByLabelText('回应文本 Vite')
    fireEvent.change(input, { target: { value: 'amy' } })
    fireEvent.click(screen.getByRole('button', { name: '接受' }))
    expect(mocks.browserCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'respondDialog',
        tabId: 't-1',
        accept: true,
        promptText: 'amy',
      }),
    )
  })

  it('falls back to screenshot polling when screencast is unavailable', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    let screenshotCalls = 0
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      if (request.action === 'screenshot') {
        screenshotCalls += 1
        return mocks.screenshotResponse
      }
      return mocks.statusRunning
    })
    // 引擎不支持 screencast（极旧 Chromium）→ 面板回退截图轮询。
    useBrowserStore.setState({ screencastAvailable: false })

    render(<BrowserPanel />)
    await screen.findByText('Vite')
    const toggle = screen.getByRole('button', { name: '实时画面' })
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    // 首帧立即渲染，带「实时」徽标；实时态下没有手动关闭按钮。
    expect(await screen.findByAltText('active tab 截图预览')).toBeTruthy()
    expect(screen.getByText(/实时 · 800×600/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '关闭截图预览' })).toBeNull()
    // 轮询持续发生（至少两帧）。
    await waitFor(
      () => {
        expect(screenshotCalls).toBeGreaterThanOrEqual(2)
      },
      { timeout: 3000 },
    )

    // 关闭实时：轮询停止（一个轮询周期内无新帧），最后画面保留、出现手动关闭。
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '关闭截图预览' })).toBeTruthy()
    })
    const frozen = screenshotCalls
    await new Promise((resolve) => {
      setTimeout(resolve, 1800)
    })
    expect(screenshotCalls).toBe(frozen)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '关闭截图预览' }))
    })
    expect(screen.queryByAltText('active tab 截图预览')).toBeNull()
  })

  it('renders the screencast live frame from the store for the active tab', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      return mocks.statusRunning
    })

    render(<BrowserPanel />)
    await screen.findByText('Vite')
    // 打开面板自动开启实时画面（对齐 zcode：进入浏览器即可见页面）。
    await waitFor(() => { expect(useBrowserStore.getState().liveView).toBe(true) })
    await act(async () => {
      useBrowserStore.getState().applyFrame({
        tabId: 't-1',
        imageBase64: 'ZnJhbWU=',
        mimeType: 'image/jpeg',
        width: 800,
        height: 600,
      })
    })
    const image = screen.getByAltText('active tab 实时画面') as HTMLImageElement
    expect(image.src).toBe('data:image/jpeg;base64,ZnJhbWU=')
    // 直播帧属于另一 tab 时不渲染。
    await act(async () => {
      useBrowserStore.getState().applyFrame({
        tabId: 't-other',
        imageBase64: 'b3RoZXI=',
        mimeType: 'image/jpeg',
        width: 800,
        height: 600,
      })
    })
    expect(screen.queryByAltText('active tab 实时画面')).toBeNull()
  })

  it('forwards preview clicks and keystrokes as CDP input actions', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      return mocks.statusRunning
    })

    // jsdom 的 getBoundingClientRect 返回 0：stub 成 400×300，验证显示坐标
    // 到页面坐标（800×600 帧）的比例换算。
    const rectSpy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        width: 400,
        height: 300,
        top: 0,
        left: 0,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect)

    render(<BrowserPanel />)
    await screen.findByText('Vite')
    // 打开面板自动开启实时画面。
    await waitFor(() => { expect(useBrowserStore.getState().liveView).toBe(true) })
    await act(async () => {
      useBrowserStore.getState().applyFrame({
        tabId: 't-1',
        imageBase64: 'ZnJhbWU=',
        mimeType: 'image/jpeg',
        width: 800,
        height: 600,
      })
    })
    const liveBox = screen.getByRole('button', { name: '实时画面（点击与键盘会转发到页面）' })
    await act(async () => {
      fireEvent.click(liveBox, { clientX: 100, clientY: 75 })
    })
    expect(mocks.browserCommand).toHaveBeenCalledWith({
      action: 'clickAt',
      tabId: 't-1',
      x: 200,
      y: 150,
    })
    await act(async () => {
      fireEvent.keyDown(liveBox, { key: 'Enter' })
    })
    expect(mocks.browserCommand).toHaveBeenCalledWith({
      action: 'press',
      tabId: 't-1',
      key: 'Enter',
    })
    await act(async () => {
      fireEvent.keyDown(liveBox, { key: 'a' })
    })
    expect(mocks.browserCommand).toHaveBeenCalledWith({
      action: 'press',
      tabId: 't-1',
      key: 'a',
    })
    // 功能修饰键组合不注入页面（留给应用快捷键）。
    await act(async () => {
      fireEvent.keyDown(liveBox, { key: 'r', metaKey: true })
    })
    expect(mocks.browserCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'press', key: 'r' }),
    )
    rectSpy.mockRestore()
  })

  it('shows a console drawer with level tags, error badge and clearing', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      return mocks.statusRunning
    })

    render(<BrowserPanel />)
    await screen.findByText('Vite')
    const consoleButton = screen.getByRole('button', { name: 'console 输出' })
    // 无错误时没有徽标。
    expect(consoleButton.querySelector('.rail__browser-console-badge')).toBeNull()
    await act(async () => {
      useBrowserStore.getState().appendConsoleEvent({
        tabId: 't-1',
        entry: { level: 'info', text: 'vite ready', source: 'console', timestamp: 1 },
      })
      useBrowserStore.getState().appendConsoleEvent({
        tabId: 't-1',
        entry: { level: 'error', text: 'Failed to load resource: 404', source: 'network', timestamp: 2 },
      })
    })
    // 错误计数徽标出现（不展开也可见）。
    expect(consoleButton.querySelector('.rail__browser-console-badge')).toHaveTextContent('1')

    await act(async () => {
      fireEvent.click(consoleButton)
    })
    expect(await screen.findByText('vite ready')).toBeTruthy()
    expect(screen.getByText('Failed to load resource: 404')).toBeTruthy()
    // 级别标签归一为中文。
    expect(screen.getByText('错误')).toBeTruthy()
    expect(screen.queryByText('警告')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '清空 console 输出' }))
    })
    expect(screen.getByText('暂无输出（从连接该 tab 起累积）')).toBeTruthy()
  })



  it('invokes newTab, reload and shutdown actions through browserCommand', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      if (request.action === 'newTab') return { type: 'tabOpened', tab: { tabId: 't-2', url: 'about:blank', title: '', active: false, hasDialog: false } }
      return mocks.statusRunning
    })
    mocks.shutdownBrowser.mockResolvedValue({ type: 'done' } as BrowserCommandResponse)

    render(<BrowserPanel />)
    expect(await screen.findByText('Vite')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '新建 tab' }))
    })
    expect(mocks.browserCommand).toHaveBeenCalledWith(expect.objectContaining({
      action: 'newTab',
      url: 'about:blank',
    }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重新加载页面' }))
    })
    expect(mocks.browserCommand).toHaveBeenCalledWith(expect.objectContaining({
      action: 'reload',
      tabId: 't-1',
    }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '关闭浏览器' }))
    })
    expect(mocks.shutdownBrowser).toHaveBeenCalledTimes(1)
  })

  it('selects the full URL on focus for quick re-navigation', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      return mocks.statusRunning
    })
    render(<BrowserPanel />)
    const input = (await screen.findByLabelText('地址栏')) as HTMLInputElement
    await waitFor(() => { expect(input.value).toBe('http://localhost:5173') })
    const selectSpy = vi.spyOn(input, 'select').mockImplementation(() => undefined)
    fireEvent.focus(input)
    expect(selectSpy).toHaveBeenCalledTimes(1)
    selectSpy.mockRestore()
  })

  it('opens the active tab URL in the system browser', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      return mocks.statusRunning
    })
    render(<BrowserPanel />)
    await screen.findByText('Vite')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '在系统浏览器打开当前地址' }))
    })
    expect(mocks.openExternalUrl).toHaveBeenCalledWith('http://localhost:5173')
    expect(vi.mocked(mocks.openExternalUrl).mock.calls.length).toBe(1)
  })

  it('shows a navigation spinner while navigating and hides it when the URL settles', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      return mocks.statusRunning
    })
    render(<BrowserPanel />)
    await screen.findByText('Vite')
    expect(screen.queryByLabelText('页面加载中')).toBeNull()
    // 提交导航：spinner 出现（URL 未变前）。
    await submitUrl('http://localhost:5173/next')
    expect(await screen.findByLabelText('页面加载中')).toBeTruthy()
    // 事件流刷新 URL 后 spinner 消失。
    await act(async () => {
      useBrowserStore.getState().applyNavigatedEvent({
        tabId: 't-1',
        url: 'http://localhost:5173/next',
      })
    })
    await waitFor(() => { expect(screen.queryByLabelText('页面加载中')).toBeNull() })
  })

  it('aggregates console error badges across all tabs', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsTwo
      return mocks.statusRunning
    })
    render(<BrowserPanel />)
    await screen.findByText('Example Domain')
    const consoleButton = screen.getByRole('button', { name: 'console 输出' })
    await act(async () => {
      useBrowserStore.getState().appendConsoleEvent({
        tabId: 't-1',
        entry: { level: 'error', text: 'active err', source: 'console', timestamp: 1 },
      })
      useBrowserStore.getState().appendConsoleEvent({
        tabId: 't-2',
        entry: { level: 'error', text: 'inactive err', source: 'console', timestamp: 2 },
      })
    })
    // 非 active tab 的错误也计入徽标。
    expect(consoleButton.querySelector('.rail__browser-console-badge')).toHaveTextContent('2')
  })

  it('reads and shows the active tab page text snapshot on demand', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      if (request.action === 'snapshot') return mocks.snapshotResponse
      return mocks.statusRunning
    })
    render(<BrowserPanel />)
    await screen.findByText('Vite')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '页面文本' }))
    })
    // 打开抽屉即读 active tab 快照，正文可读。
    expect(await screen.findByText('Welcome to Vite. Fastest frontend tool.')).toBeTruthy()
    expect(mocks.browserCommand).toHaveBeenCalledWith({ action: 'snapshot', tabId: 't-1' })
    // 标题与复制/收起动作可见。
    expect(screen.getByLabelText('复制页面文本')).toBeEnabled()
    expect(screen.getByLabelText('收起页面文本')).toBeTruthy()
    // 截图截断提示。
    await act(async () => {
      useBrowserStore.getState().setPageSnapshot({
        tabId: 't-1',
        url: 'http://localhost:5173',
        title: 'Vite',
        text: 'long text',
        truncated: true,
        at: Date.now(),
      })
    })
    expect(screen.getByText(/快照已截断/)).toBeTruthy()
  })

  it('closes the console drawer when the page text drawer opens', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      if (request.action === 'snapshot') return mocks.snapshotResponse
      return mocks.statusRunning
    })
    render(<BrowserPanel />)
    await screen.findByText('Vite')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'console 输出' }))
    })
    expect(useBrowserStore.getState().consoleOpen).toBe(true)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '页面文本' }))
    })
    expect(useBrowserStore.getState().consoleOpen).toBe(false)
    expect(useBrowserStore.getState().pageTextOpen).toBe(true)
  })

  it('shows externally injected panel errors and clears them on successful refresh', async () => {
    mocks.browserSettings.enabled = true
    mocks.browserStatus.mockResolvedValue(mocks.statusRunning)
    mocks.browserCommand.mockImplementation(async (request: { action: string }) => {
      if (request.action === 'tabs') return mocks.tabsOne
      return mocks.statusRunning
    })
    render(<BrowserPanel />)
    await screen.findByText('Vite')
    // 面板外动作（如消息链接「在面板打开」失败）注入的错误：横幅展示。
    await act(async () => {
      useBrowserStore.getState().setPanelError('引擎未找到')
    })
    expect(screen.getByRole('alert')).toHaveTextContent('引擎未找到')
    // 刷新成功（面板健康）即清除。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '刷新浏览器状态' }))
    })
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  })


})
