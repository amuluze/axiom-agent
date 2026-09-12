// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserSection } from './BrowserSection'
import {
  browserStatus,
  ensureBrowserRunning,
  shutdownBrowser,
  validateBrowserExecutable,
} from '@/platform/browserSession'

const STORAGE_KEY = 'axiom.browser.config.v1'

vi.mock('@/platform/browserSession', () => ({
  browserStatus: vi.fn(async () => ({ type: 'status', running: false })),
  detectBrowserEngines: vi.fn(async () => ({
    type: 'detected',
    engines: [
      { engine: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', available: true },
      { engine: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium', available: false },
    ],
  })),
  ensureBrowserRunning: vi.fn(async () => ({
    type: 'status',
    running: true,
    port: 49152,
    engine: 'Google Chrome',
    headless: true,
    version: 'Chrome/140.0.0.0',
    tabs: 0,
  })),
  shutdownBrowser: vi.fn(async () => ({ type: 'done' })),
  validateBrowserExecutable: vi.fn(async (path: string) => ({
    type: 'executableValid',
    path,
    engine: 'Google Chrome',
  })),
}))

const mockStatus = vi.mocked(browserStatus)
const mockEnsure = vi.mocked(ensureBrowserRunning)
const mockShutdown = vi.mocked(shutdownBrowser)
const mockValidate = vi.mocked(validateBrowserExecutable)

beforeEach(() => {
  window.localStorage.removeItem(STORAGE_KEY)
})

afterEach(() => {
  window.localStorage.removeItem(STORAGE_KEY)
  vi.clearAllMocks()
})

describe('BrowserSection', () => {
  it('默认关闭，开关切换进入 draft（未保存前不落盘）', async () => {
    render(<BrowserSection />)
    const toggle = await screen.findByRole('checkbox', { name: '启用浏览器能力' }) as HTMLInputElement
    expect(toggle.checked).toBe(false)

    fireEvent.click(toggle)
    expect(toggle.checked).toBe(true)
    // draft 尚未保存：localStorage 仍为空。
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('保存按钮持久化配置并回写 Rust 归一化路径', async () => {
    render(<BrowserSection />)
    const toggle = await screen.findByRole('checkbox', { name: '启用浏览器能力' })
    fireEvent.click(toggle)

    const pathInput = screen.getByRole('textbox', { name: '浏览器可执行文件路径（可选）' }) as HTMLInputElement
    fireEvent.change(pathInput, {
      target: { value: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    })

    const save = screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)

    await waitFor(() => {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      expect(stored).toBeTruthy()
      expect(JSON.parse(stored as string)).toEqual({
        enabled: true,
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true,
      })
    })
    expect(mockValidate).toHaveBeenCalledWith('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    expect(screen.getByText(/浏览器配置已保存/)).toBeTruthy()
  })

  it('检测到的引擎进入下拉，未安装的引擎不可选', async () => {
    render(<BrowserSection />)
    const select = await screen.findByRole('combobox', { name: '浏览器引擎' }) as HTMLSelectElement
    await waitFor(() => expect(select.options.length).toBe(3))
    expect(select.options[0].value).toBe('')
    expect(select.options[1].textContent).toBe('Google Chrome')
    expect((select.options[2] as HTMLOptionElement).disabled).toBe(true)

    fireEvent.change(select, { target: { value: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } })
    expect((select as HTMLSelectElement).value).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  })

  it('测试连接用当前 draft 启动浏览器并显示版本', async () => {
    render(<BrowserSection />)
    const test = await screen.findByRole('button', { name: /测试连接/ })
    fireEvent.click(test)
    await waitFor(() => expect(mockEnsure).toHaveBeenCalledWith({
      enabled: true,
      executablePath: '',
      headless: true,
    }))
    await waitFor(() => expect(screen.getByText(/连接成功：Google Chrome（Chrome\/140.0.0.0）/)).toBeTruthy())
  })

  it('关闭浏览器进程调用 shutdown 并刷新状态', async () => {
    mockStatus.mockResolvedValueOnce({ type: 'status', running: true, port: 49152, engine: 'Google Chrome', version: 'Chrome/140.0.0.0', headless: true, tabs: 2 })
    render(<BrowserSection />)
    const shutdown = await screen.findByRole('button', { name: /关闭浏览器进程/ })
    await waitFor(() => expect((shutdown as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(shutdown)
    await waitFor(() => expect(mockShutdown).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText(/浏览器进程已关闭/)).toBeTruthy())
  })

  it('校验失败时保存报错且不落盘', async () => {
    mockValidate.mockRejectedValueOnce(new Error('不支持的浏览器 bundle：Safari（支持：Google Chrome / Chromium / Microsoft Edge / Brave）'))
    render(<BrowserSection />)
    const toggle = await screen.findByRole('checkbox', { name: '启用浏览器能力' })
    fireEvent.click(toggle)
    const pathInput = screen.getByRole('textbox', { name: '浏览器可执行文件路径（可选）' }) as HTMLInputElement
    fireEvent.change(pathInput, { target: { value: '/Applications/Safari.app/Contents/MacOS/Safari' } })

    const save = screen.getByRole('button', { name: /保存/ }) as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)

    await waitFor(() => expect(screen.getByText(/不支持的浏览器 bundle/)).toBeTruthy())
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('渲染安全边界说明（隔离 profile 与回环端口）', async () => {
    render(<BrowserSection />)
    await screen.findByRole('checkbox', { name: '启用浏览器能力' })
    expect(screen.getByText(/独立隔离 profile/)).toBeTruthy()
    expect(screen.getByText(/仅绑定本机回环/)).toBeTruthy()
  })
})
