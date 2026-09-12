// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshHostEntry } from '@/platform/sshSession'

// xterm 及其 addon 在模块顶层引用了浏览器全局；测试里用可控假类替换，
// 使 xterm 生命周期 effect 在 jsdom 下可执行（open/write/reset 可断言）。
const terminalInstances: FakeTerminal[] = []
class FakeTerminal {
  cols = 80
  rows = 24
  /** xterm options 可变字段：字号/字体偏好热更新走这里，测试可读。 */
  options: { fontSize: number; fontFamily: string } = { fontSize: 12, fontFamily: '' }
  textarea: HTMLTextAreaElement | null = null
  open = vi.fn()
  loadAddon = vi.fn()
  reset = vi.fn()
  dispose = vi.fn()
  write = vi.fn()
  onData = vi.fn(() => ({ dispose: vi.fn() }))
  onResize = vi.fn(() => ({ dispose: vi.fn() }))
  constructor() {
    terminalInstances.push(this)
  }
}
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

// jsdom 无 ResizeObserver：静默桩即可（fit 逻辑不在被测范围）。
class ResizeObserverStub {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

// jsdom 也未实现 PointerEvent：SFTP 把手拖拽用例需要 button/clientY 语义，
// 挂一个 MouseEvent 子类兜底（pointerId 仅经把手 stub 透传，不做真实性校验）。
if (typeof window.PointerEvent === 'undefined') {
  class FakePointerEvent extends MouseEvent {}
  window.PointerEvent = FakePointerEvent as unknown as typeof PointerEvent
}

const mocks = vi.hoisted(() => ({
  onSshSessionEvent: vi.fn(),
  onSshUploadEvent: vi.fn(),
  setTerminalFocus: vi.fn(),
  sshCommand: vi.fn(),
}))

vi.mock('@/platform/sshSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/sshSession')>()),
  onSshSessionEvent: mocks.onSshSessionEvent,
  onSshUploadEvent: mocks.onSshUploadEvent,
  sshCommand: mocks.sshCommand,
}))
vi.mock('@/platform/terminal', () => ({
  setTerminalFocus: mocks.setTerminalFocus,
  TERMINAL_THEME: {},
}))

const { SshTerminalPanel } = await import('./SshTerminalPanel')
const {
  ensureSshEvents,
  resetSshEventsForTests,
  resetSshStoreForTests,
  useSshStore,
} = await import('@/stores/sshStore')
const { useUiStore, DEFAULT_SFTP_PANEL_HEIGHT } = await import('@/stores/uiStore')

const host: SshHostEntry = {
  id: 'id-1',
  name: '生产机',
  hostname: 'server.example.com',
  port: 22,
  username: 'amu',
  createdAt: 1756900000,
}

beforeEach(() => {
  resetSshStoreForTests()
  resetSshEventsForTests()
  terminalInstances.length = 0
  mocks.onSshSessionEvent.mockReset().mockResolvedValue(() => {})
  mocks.onSshUploadEvent.mockReset().mockResolvedValue(() => {})
  mocks.setTerminalFocus.mockClear()
  // 与真实 sshCommand 在 jsdom 下的行为对齐（未配置时拒绝，store 吞掉）；
  // 各用例按需 mockResolvedValueOnce/mockRejectedValueOnce 覆盖。
  mocks.sshCommand.mockReset().mockRejectedValue(new Error('sshCommand 未配置'))
  ensureSshEvents()
})

afterEach(() => {
  useUiStore.getState().setRuntimeRailPane('picker')
  // 还原字号/字体偏好默认值：热更新用例会改动，避免泄漏到同文件其它用例。
  useUiStore.setState({ fontSizePx: 13, monoFontFamily: 'jetbrains' })
})

describe('SshTerminalPanel 空态（无主机）', () => {
  it('guides to adding a host on the left pane', () => {
    render(<SshTerminalPanel />)
    expect(screen.getByText('尚未连接任何主机')).toBeTruthy()
    expect(screen.getByText('在左侧「主机管理」添加主机后，远程终端会在这里打开。')).toBeTruthy()
  })

  it('creates the terminal once the host list arrives asynchronously', async () => {
    // 首次打开 SshView 时主机列表尚未加载：空态分支不渲染容器，xterm 创建
    // 必须等完整分支出现后重建；不重建即「已连接但终端空白且无法输入」。
    useSshStore.setState({ hosts: [] })
    render(<SshTerminalPanel />)
    expect(terminalInstances).toHaveLength(0)

    await act(async () => {
      useSshStore.setState({ hosts: [host] })
    })
    await waitFor(() => expect(terminalInstances).toHaveLength(1))
    expect(terminalInstances[0].open).toHaveBeenCalled()
  })
})

describe('SshTerminalPanel 终端态', () => {
  it('renders host selector, term bar and status footer', () => {
    useSshStore.setState({ hosts: [host] })
    const { container } = render(<SshTerminalPanel />)
    // 未选择主机：选择器显示占位，终端为空白。
    expect(screen.getByText('未选择主机')).toBeTruthy()
    expect(container.querySelector('.sshview__term-body')).toBeTruthy()
    expect(screen.getByText('未连接')).toBeTruthy()
  })

  it('auto-connects the selected host and enters connecting phase', async () => {
    const openSession = vi.fn(async () => {})
    useSshStore.setState({ hosts: [host], activeHostId: host.id, openSession })
    render(<SshTerminalPanel />)
    await waitFor(() => expect(openSession).toHaveBeenCalledWith(host.id, 80, 24))
    await waitFor(() => expect(useSshStore.getState().sessions[host.id]).toBe('connecting'))
    // 选择器显示当前主机（设计稿形态）；切换不再 reset、无 term bar 行。
    expect(screen.getByText('生产机 · server.example.com:22')).toBeTruthy()
  })

  it('热更新字号与等宽字体偏好到 xterm options', async () => {
    useSshStore.setState({ hosts: [host] })
    render(<SshTerminalPanel />)
    expect(terminalInstances[0].options.fontFamily).toContain('JetBrains Mono')
    expect(terminalInstances[0].options.fontSize).toBe(12)

    act(() => {
      useUiStore.getState().setFontSizePx(16)
      useUiStore.getState().setMonoFontFamily('menlo')
    })
    // SSH 终端基准 12px 随界面字号等比换算：12 * 16/13 ≈ 14.77 → 15。
    await waitFor(() => {
      expect(terminalInstances[0].options.fontSize).toBe(15)
      expect(terminalInstances[0].options.fontFamily).toContain("'Menlo'")
    })
  })

  it('shows the failure status when openSession rejects (failed phase)', async () => {
    // 非 Tauri 环境下真实 sshCommand 调用即抛错：走 store openSession 的
    // 失败回落路径（connecting → failed，主机行「连接失败」态）。
    useSshStore.setState({ hosts: [host], activeHostId: host.id })
    render(<SshTerminalPanel />)
    await waitFor(() => expect(screen.getByText('连接失败')).toBeTruthy())
    await waitFor(() => expect(useSshStore.getState().sessions[host.id]).toBe('failed'))
    await waitFor(() =>
      expect(terminalInstances[0].write).toHaveBeenCalledWith(expect.stringContaining('连接失败')),
    )
    // 连接失败也可直接重连（选择器行 ↻ 图标可点）。
    expect((screen.getByRole('button', { name: '重连' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('marks session closed on done event and prints the banner', async () => {
    useSshStore.setState({
      hosts: [host],
      activeHostId: host.id,
      sessions: { [host.id]: 'connected' },
    })
    let deliver: ((event: { hostId: string; done: boolean; data?: number[] }) => void) | undefined
    mocks.onSshSessionEvent.mockImplementation((handler: (event: unknown) => void) => {
      deliver = handler
      return Promise.resolve(() => {})
    })
    render(<SshTerminalPanel />)
    await waitFor(() => expect(deliver).toBeTruthy())
    deliver?.({ hostId: host.id, done: true })
    await waitFor(() => expect(useSshStore.getState().sessions[host.id]).toBe('closed'))
    await waitFor(() => expect(screen.getByText('已断开')).toBeTruthy())
    expect(terminalInstances[0].write).toHaveBeenCalledWith(
      expect.stringContaining('连接已断开'),
    )
  })

  it('treats an early non-zero exit while connecting as connection failure', async () => {
    useSshStore.setState({ hosts: [host], activeHostId: host.id })
    render(<SshTerminalPanel />)
    useSshStore.getState().handleSessionDone(host.id, 255)
    await waitFor(() => expect(useSshStore.getState().sessions[host.id]).toBe('failed'))
    expect(screen.getByText('连接失败')).toBeTruthy()
    // 失败不是「意外掉线」：↻ 图标可点（刷新而非重连+已断开）。
    expect((screen.getByRole('button', { name: '重连' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('reassembles multibyte output split across PTY read chunks', async () => {
    // PTY 读块边界可能切在 UTF-8 字符中间：解码器必须跨事件复用（stream 模式
    // 携带未完成序列），否则中文输出会拆成替换符。
    useSshStore.setState({
      hosts: [host],
      activeHostId: host.id,
      sessions: { [host.id]: 'connected' },
    })
    let deliver: ((event: { hostId: string; data?: string }) => void) | undefined
    mocks.onSshSessionEvent.mockImplementation((handler: (event: unknown) => void) => {
      deliver = handler
      return Promise.resolve(() => {})
    })
    render(<SshTerminalPanel />)
    await waitFor(() => expect(deliver).toBeTruthy())
    // 「连」= E8 BF 9E：前两个字节与第三个字节分两个事件到达（base64 载荷）。
    const b64 = (bytes: number[]): string => btoa(String.fromCharCode(...bytes))
    deliver?.({ hostId: host.id, data: b64([0xe8, 0xbf]) })
    deliver?.({ hostId: host.id, data: b64([0x9e]) })
    const written = terminalInstances[0].write.mock.calls
      .map((call) => String(call[0]))
      .join('')
    expect(written).toBe('连')
    expect(written).not.toContain('\uFFFD')
  })

  it('disconnects from the footer and closes the session', async () => {
    // 真实 closeSession：命令层失败也被吞掉，状态经 finally 回落 closed。
    useSshStore.setState({
      hosts: [host],
      activeHostId: host.id,
      sessions: { [host.id]: 'connected' },
    })
    render(<SshTerminalPanel />)
    const disconnect = screen.getByRole('button', { name: '断开' }) as HTMLButtonElement
    expect(disconnect.disabled).toBe(false)
    fireEvent.click(disconnect)
    await waitFor(() => expect(useSshStore.getState().sessions[host.id]).toBe('closed'))
    await waitFor(() => expect(screen.getByText('已断开')).toBeTruthy())
  })

  it('keeps the disconnect control disabled before any session exists', () => {
    useSshStore.setState({ hosts: [host] })
    render(<SshTerminalPanel />)
    const disconnect = screen.getByRole('button', { name: '断开' }) as HTMLButtonElement
    expect(disconnect.disabled).toBe(true)
  })

  it('clears the selection via the host bar close button', () => {
    useSshStore.setState({ hosts: [host], activeHostId: host.id, sessions: { [host.id]: 'connected' } })
    render(<SshTerminalPanel />)
    expect(screen.getByText('生产机 · server.example.com:22')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消选择主机' }))
    expect(useSshStore.getState().activeHostId).toBeNull()
    expect(screen.getByText('未选择主机')).toBeTruthy()
  })

  it('enables the upload control only for a connected session and triggers it', async () => {
    const uploadFile = vi.fn(async () => {})
    useSshStore.setState({
      hosts: [host],
      activeHostId: host.id,
      sessions: { [host.id]: 'connected' },
      uploadFile,
    })
    render(<SshTerminalPanel />)
    // 上传文件入口在 SFTP 面板头部：先经主机选择器行文件夹图标打开面板。
    fireEvent.click(screen.getByRole('button', { name: '打开文件浏览器' }))
    const uploadButton = (await screen.findByRole('button', { name: '上传文件' })) as HTMLButtonElement
    expect(uploadButton.disabled).toBe(false)
    fireEvent.click(uploadButton)
    await waitFor(() => expect(uploadFile).toHaveBeenCalledWith(host.id, '~'))
  })

  it('keeps the upload control disabled unless connected', async () => {
    useSshStore.setState({
      hosts: [host],
      activeHostId: host.id,
      sessions: { [host.id]: 'closed' },
    })
    render(<SshTerminalPanel />)
    fireEvent.click(screen.getByRole('button', { name: '打开文件浏览器' }))
    const uploadButton = (await screen.findByRole('button', { name: '上传文件' })) as HTMLButtonElement
    expect(uploadButton.disabled).toBe(true)
    expect(uploadButton.title).toBe('上传文件到当前目录')
  })

  it('shows upload progress in the footer and clears the failure on dismiss', async () => {
    useSshStore.setState({
      hosts: [host],
      activeHostId: host.id,
      sessions: { [host.id]: 'connected' },
    })
    // 通过 beforeEach 已注册的 ensureSshEvents 订阅通道模拟 Rust 上传事件。
    let deliver: ((event: Record<string, unknown>) => void) | undefined
    mocks.onSshUploadEvent.mockImplementation((handler: (event: Record<string, unknown>) => void) => {
      deliver = handler
      return Promise.resolve(() => {})
    })
    resetSshEventsForTests()
    ensureSshEvents()
    render(<SshTerminalPanel />)
    await waitFor(() => expect(deliver).toBeTruthy())
    deliver?.({ phase: 'start', hostId: host.id, name: 'a.bin', totalBytes: 1000 })
    deliver?.({ phase: 'progress', hostId: host.id, name: 'a.bin', transferredBytes: 450, totalBytes: 1000 })
    await waitFor(() => expect(screen.getByText('上传 a.bin 45%')).toBeTruthy())
    expect(document.querySelector('.sshview__upload-bar-fill')).toBeTruthy()

    deliver?.({ phase: 'failed', hostId: host.id, name: 'a.bin', error: '远端写入失败' })
    await waitFor(() => expect(screen.getByText('上传失败：远端写入失败')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '关闭上传错误提示' }))
    await waitFor(() => expect(screen.queryByText('上传失败：远端写入失败')).toBeNull())
  })

  it('cancels an in-flight upload from the footer', async () => {
    const cancelUpload = vi.fn(async () => {})
    useSshStore.setState({
      hosts: [host],
      activeHostId: host.id,
      sessions: { [host.id]: 'connected' },
      uploads: { [host.id]: { name: 'a.bin', transferred: 100, total: 1000 } },
      cancelUpload,
    })
    render(<SshTerminalPanel />)
    await waitFor(() => expect(screen.getByText('上传 a.bin 10%')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(cancelUpload).toHaveBeenCalledWith(host.id))
  })

  it('offers resume after an upload failure and dismisses the error', async () => {
    const resumeUpload = vi.fn(async () => {})
    useSshStore.setState({
      hosts: [host],
      activeHostId: host.id,
      sessions: { [host.id]: 'connected' },
      uploads: { [host.id]: { name: 'a.bin', transferred: 100, total: 1000, error: '远端写入失败' } },
      resumeUpload,
    })
    render(<SshTerminalPanel />)
    expect(screen.getByText('上传失败：远端写入失败')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '续传' }))
    await waitFor(() => expect(resumeUpload).toHaveBeenCalledWith(host.id))
    fireEvent.click(screen.getByRole('button', { name: '关闭上传错误提示' }))
    await waitFor(() => expect(screen.queryByText('上传失败：远端写入失败')).toBeNull())
  })

  it('offers reconnect after an unexpected drop mid-session', async () => {
    // 真实场景：会话已连接 → Rust done 事件（非用户断开）→ 选择器行 ↻ 变为可点。
    useSshStore.setState({
      hosts: [host],
      activeHostId: host.id,
      sessions: { [host.id]: 'connected' },
    })
    render(<SshTerminalPanel />)
    const reconnect = (): HTMLButtonElement =>
      screen.getByRole('button', { name: '重连' }) as HTMLButtonElement
    expect(reconnect().disabled).toBe(true)
    useSshStore.getState().handleSessionDone(host.id)
    await waitFor(() => expect(reconnect().disabled).toBe(false))
    // 点击重连 → 清除意外标记并发起连接（非 Tauri 下连接失败回落 failed，仍可点）。
    fireEvent.click(reconnect())
    await waitFor(() => expect(reconnect().disabled).toBe(false))
  })

  it('does not flag manual disconnect as a reconnect-able drop', async () => {
    useSshStore.setState({
      hosts: [host],
      activeHostId: host.id,
      sessions: { [host.id]: 'connected' },
    })
    render(<SshTerminalPanel />)
    fireEvent.click(screen.getByRole('button', { name: '断开' }))
    await waitFor(() => expect(useSshStore.getState().sessions[host.id]).toBe('closed'))
    useSshStore.getState().handleSessionDone(host.id)
    // 主动断开不设意外标记：↻ 不进入警示态（无 --warn 类），但 closed 仍可点重连。
    const reconnect = screen.getByRole('button', { name: '重连' }) as HTMLButtonElement
    expect(reconnect.disabled).toBe(false)
    expect(reconnect.className).not.toContain('sshview__term-action--warn')
  })

  it('keeps per-host terminal history when switching hosts (no reset)', async () => {
    const h2: SshHostEntry = { ...host, id: 'id-2', name: '跳板机', hostname: 'vpn.example.com' }
    useSshStore.setState({
      hosts: [host, h2],
      activeHostId: host.id,
      sessions: { [host.id]: 'connected' },
    })
    render(<SshTerminalPanel />)
    // 两个主机各建一个终端实例。
    await waitFor(() => expect(terminalInstances).toHaveLength(2))
    act(() => {
      useSshStore.getState().setActiveHostId(h2.id)
    })
    // 切换只切显示，不 reset——各主机缓冲保留。
    expect(terminalInstances[0].reset).not.toHaveBeenCalled()
    expect(terminalInstances[1].reset).not.toHaveBeenCalled()
  })

  it('opens the SFTP file panel from the host bar and renders directory entries', async () => {
    mocks.sshCommand.mockResolvedValue({
      type: 'files',
      hostId: host.id,
      path: '~',
      entries: [
        { name: 'boot', sizeBytes: 4096, isDir: true, perms: 'drwxr-xr-x', modifiedAt: 'May 3 2026 06:08' },
        { name: 'app.log', sizeBytes: 12, isDir: false, perms: '-rw-r--r--', modifiedAt: 'May 3 2026 06:09' },
      ],
      truncated: false,
    })
    useSshStore.setState({
      hosts: [host],
      activeHostId: host.id,
      sessions: { [host.id]: 'connected' },
      currentDir: { [host.id]: '~' },
    })
    render(<SshTerminalPanel />)
    // 默认收起：主机选择器行文件夹图标打开 SFTP 面板。
    expect(screen.queryByLabelText('SFTP 文件浏览器')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开文件浏览器' }))
    expect(screen.getByLabelText('SFTP 文件浏览器')).toBeTruthy()
    // 列表经异步 loadDir 后呈现（sshCommand mock 返回 files 响应）。
    expect(await screen.findByText('boot')).toBeTruthy()
    expect(screen.getByText('app.log')).toBeTruthy()
    expect(screen.getByText('drwxr-xr-x')).toBeTruthy()
    // 面板头部关闭按钮收起。
    fireEvent.click(screen.getByRole('button', { name: '关闭文件浏览器' }))
    expect(screen.queryByLabelText('SFTP 文件浏览器')).toBeNull()
  })

  it('goes up from ~ to / and disables the button at the root', async () => {
    const listCalls: string[] = []
    mocks.sshCommand.mockImplementation(async (request: { action: string; path?: string }) => {
      if (request.action === 'listFiles') {
        listCalls.push(request.path ?? '')
        return {
          type: 'files',
          hostId: host.id,
          path: request.path,
          entries: [{ name: 'home', sizeBytes: 4096, isDir: true, perms: 'drwxr-xr-x', modifiedAt: 'x' }],
          truncated: false,
        }
      }
      throw new Error(`未预期的动作：${request.action}`)
    })
    useSshStore.setState({
      hosts: [host],
      activeHostId: host.id,
      sessions: { [host.id]: 'connected' },
      currentDir: { [host.id]: '~' },
    })
    render(<SshTerminalPanel />)
    fireEvent.click(screen.getByRole('button', { name: '打开文件浏览器' }))
    expect(await screen.findByText('home')).toBeTruthy()
    // `~` 下返回按钮可点，点击后到 `/`（文件系统根）。
    const up = screen.getByRole('button', { name: '返回上级目录' }) as HTMLButtonElement
    expect(up.disabled).toBe(false)
    fireEvent.click(up)
    await waitFor(() => expect(listCalls).toEqual(['~', '/']))
    // `/` 为真顶层：按钮禁用且再点不发起列目录。
    await waitFor(() => {
      const upAtRoot = screen.getByRole('button', { name: '返回上级目录' }) as HTMLButtonElement
      expect(upAtRoot.disabled).toBe(true)
    })
    fireEvent.click(screen.getByRole('button', { name: '返回上级目录' }))
    expect(listCalls).toEqual(['~', '/'])
  })

  it('shows a listing failure with retry instead of silently keeping stale entries', async () => {
    useSshStore.setState({
      hosts: [host],
      activeHostId: host.id,
      sessions: { [host.id]: 'connected' },
      currentDir: { [host.id]: '~' },
      // 预置一份属于其它路径的旧列表：失败时绝不张冠李戴地渲染。
      dirs: {
        [host.id]: {
          path: '~/elsewhere',
          entries: [
            { name: 'stale-entry', sizeBytes: 1, isDir: false, perms: '-rw-r--r--', modifiedAt: 'x' },
          ],
        },
      },
    })
    mocks.sshCommand.mockRejectedValue(new Error('连接已断开'))
    render(<SshTerminalPanel />)
    fireEvent.click(screen.getByRole('button', { name: '打开文件浏览器' }))
    // 失败可见：错误行 + 重试入口；旧路径的条目不渲染。
    expect(await screen.findByText(/列目录失败：连接已断开/)).toBeTruthy()
    expect(screen.queryByText('stale-entry')).toBeNull()
    // 重试成功后错误行消失、列表渲染。
    mocks.sshCommand.mockResolvedValue({
      type: 'files',
      hostId: host.id,
      path: '~',
      entries: [
        { name: 'recovered', sizeBytes: 2, isDir: false, perms: '-rw-r--r--', modifiedAt: 'x' },
      ],
      truncated: false,
    })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('recovered')).toBeTruthy()
    expect(screen.queryByText(/列目录失败/)).toBeNull()
  })

  it('routes session events to the matching per-host terminal', async () => {
    const h2: SshHostEntry = { ...host, id: 'id-2', name: '跳板机', hostname: 'vpn.example.com' }
    let deliver: ((event: { hostId: string; data?: string; done?: boolean }) => void) | undefined
    mocks.onSshSessionEvent.mockImplementation((handler: (event: unknown) => void) => {
      deliver = handler
      return Promise.resolve(() => {})
    })
    useSshStore.setState({
      hosts: [host, h2],
      activeHostId: host.id,
      sessions: { [host.id]: 'connected', [h2.id]: 'connected' },
    })
    render(<SshTerminalPanel />)
    await waitFor(() => expect(terminalInstances).toHaveLength(2))
    await waitFor(() => expect(deliver).toBeTruthy())
    // 事件按 hostId 路由到对应实例（各自独立 decoder，不串字节）。
    const b64 = (bytes: number[]): string => btoa(String.fromCharCode(...bytes))
    deliver?.({ hostId: host.id, data: b64([0x41]) }) // 'A' → 实例 0
    deliver?.({ hostId: h2.id, data: b64([0x42]) })   // 'B' → 实例 1
    expect(terminalInstances[0].write).toHaveBeenCalledWith('A')
    expect(terminalInstances[1].write).toHaveBeenCalledWith('B')
  })

  it('renders the default empty chrome in SSR', () => {
    // SSR 下 zustand useSyncExternalStore 只读初始态（AGENTS 约定：只断言
    // 默认态）——默认无主机，渲染空态引导。
    const html = renderToStaticMarkup(<SshTerminalPanel />)
    expect(html).toContain('sshview__terminal-pane')
    expect(html).toContain('尚未连接任何主机')
  })
})

describe('SshTerminalPanel SFTP 面板高度调整', () => {
  beforeEach(() => {
    useUiStore.setState({ sftpPanelHeight: DEFAULT_SFTP_PANEL_HEIGHT })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    useUiStore.setState({ sftpPanelHeight: DEFAULT_SFTP_PANEL_HEIGHT })
  })

  /** jsdom 无真实布局：stub 终端栏高与 pointer capture 三件套，让拖拽语义可断言。 */
  const stubLayout = (resizer: HTMLElement): void => {
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(600)
    resizer.setPointerCapture = vi.fn()
    resizer.releasePointerCapture = vi.fn()
    resizer.hasPointerCapture = vi.fn(() => true)
  }

  const openPanel = async (): Promise<HTMLElement> => {
    useSshStore.setState({
      hosts: [host],
      activeHostId: host.id,
      sessions: { [host.id]: 'connected' },
    })
    render(<SshTerminalPanel />)
    fireEvent.click(screen.getByRole('button', { name: '打开文件浏览器' }))
    return await screen.findByRole('separator', { name: '拖拽调整文件浏览器高度' })
  }

  it('renders the resize handle and applies the persisted height inline', async () => {
    useSshStore.setState({ hosts: [host], activeHostId: host.id, sessions: { [host.id]: 'connected' } })
    const { container } = render(<SshTerminalPanel />)
    fireEvent.click(screen.getByRole('button', { name: '打开文件浏览器' }))
    const resizer = await screen.findByRole('separator', { name: '拖拽调整文件浏览器高度' })
    expect(resizer).toHaveAttribute('aria-orientation', 'horizontal')
    const panel = container.querySelector<HTMLElement>('.sshview__sftp')
    expect(panel?.style.height).toBe(`${DEFAULT_SFTP_PANEL_HEIGHT}px`)
  })

  it('drags the handle to resize and persists the height preference', async () => {
    const resizer = await openPanel()
    stubLayout(resizer)
    fireEvent.pointerDown(resizer, { button: 0, pointerId: 1, clientY: 500 })
    fireEvent.pointerMove(resizer, { pointerId: 1, clientY: 460 })
    expect(useUiStore.getState().sftpPanelHeight).toBe(DEFAULT_SFTP_PANEL_HEIGHT + 40)
    fireEvent.pointerUp(resizer, { pointerId: 1, clientY: 460 })
    // 高度偏好持久化（面板开关与重启共享同一偏好）。
    expect(window.localStorage.getItem('axiom.sftp.panelHeight.v1')).toBe(
      String(DEFAULT_SFTP_PANEL_HEIGHT + 40),
    )
  })

  it('keeps drag updates inside the pane-measured bounds', async () => {
    const resizer = await openPanel()
    stubLayout(resizer) // 终端栏高 600 → 上限 600 - 180 = 420，下限 160。
    fireEvent.pointerDown(resizer, { button: 0, pointerId: 1, clientY: 500 })
    fireEvent.pointerMove(resizer, { pointerId: 1, clientY: 100 })
    expect(useUiStore.getState().sftpPanelHeight).toBe(420)
    fireEvent.pointerMove(resizer, { pointerId: 1, clientY: 900 })
    expect(useUiStore.getState().sftpPanelHeight).toBe(160)
  })

  it('adjusts height via keyboard and resets on double click', async () => {
    const resizer = await openPanel()
    stubLayout(resizer)
    fireEvent.keyDown(resizer, { key: 'ArrowUp' })
    expect(useUiStore.getState().sftpPanelHeight).toBe(DEFAULT_SFTP_PANEL_HEIGHT + 24)
    fireEvent.keyDown(resizer, { key: 'ArrowDown' })
    expect(useUiStore.getState().sftpPanelHeight).toBe(DEFAULT_SFTP_PANEL_HEIGHT)
    // 双击把手重置回默认高度（非默认值下才可区分）。
    useUiStore.setState({ sftpPanelHeight: DEFAULT_SFTP_PANEL_HEIGHT + 100 })
    fireEvent.doubleClick(resizer)
    expect(useUiStore.getState().sftpPanelHeight).toBe(DEFAULT_SFTP_PANEL_HEIGHT)
  })
})
