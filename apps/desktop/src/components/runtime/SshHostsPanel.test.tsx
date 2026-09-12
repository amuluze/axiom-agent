// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshHostsPanel } from './SshHostsPanel'
import { resetSshStoreForTests, useSshStore } from '@/stores/sshStore'
import type { SshCommandResponse, SshHostEntry } from '@/platform/sshSession'

const mocks = vi.hoisted(() => ({
  sshCommand: vi.fn(),
}))

vi.mock('@/platform/sshSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/sshSession')>()),
  sshCommand: mocks.sshCommand,
  onSshSessionEvent: vi.fn(() => Promise.resolve(() => {})),
}))

const host: SshHostEntry = {
  id: 'id-1',
  name: '生产机',
  hostname: 'server.example.com',
  port: 22,
  username: 'amu',
  createdAt: 1756900000,
}

const hostsResponse = (hosts: SshHostEntry[]): SshCommandResponse =>
  ({ type: 'hosts', hosts })

const seedHosts = (entries: SshHostEntry[]): void => {
  useSshStore.setState({ hosts: entries, listStatus: 'ready', error: null })
}

beforeEach(() => {
  resetSshStoreForTests()
  mocks.sshCommand.mockReset()
  // 默认解析为空列表：组件挂载即触发 loadHosts，未显式 mock 的用例不致误入错误态。
  mocks.sshCommand.mockResolvedValue(hostsResponse([]))
})

describe('SshHostsPanel', () => {
  it('loads the host list on mount', async () => {
    mocks.sshCommand.mockResolvedValue(hostsResponse([host]))
    render(<SshHostsPanel />)
    await waitFor(() => expect(mocks.sshCommand).toHaveBeenCalledWith({ action: 'listHosts' }))
    await waitFor(() => expect(screen.getByText('生产机')).toBeTruthy())
    expect(screen.getByText('amu@server.example.com:22')).toBeTruthy()
    expect(screen.getByText('未连接')).toBeTruthy()
  })

  it('renders an empty state when no hosts exist', async () => {
    seedHosts([])
    render(<SshHostsPanel />)
    // 挂载即触发 loadHosts，等它落定（默认 mock 空列表）后再断言空态。
    await waitFor(() => expect(screen.getByText('还没有主机')).toBeTruthy())
    expect(screen.getByText('点击「添加」添加第一台远程机器。')).toBeTruthy()
  })

  it('creates a host through the inline form', async () => {
    seedHosts([])
    mocks.sshCommand.mockResolvedValue(
      hostsResponse([{ ...host, id: 'id-2', name: '新主机' }]),
    )
    render(<SshHostsPanel />)
    fireEvent.click(screen.getByRole('button', { name: /添加/ }))

    fireEvent.change(screen.getByPlaceholderText('生产机'), { target: { value: '新主机' } })
    fireEvent.change(screen.getByPlaceholderText('192.168.1.10 或 host.example.com'), {
      target: { value: '10.0.0.5' },
    })
    fireEvent.change(screen.getByPlaceholderText('root'), { target: { value: 'deploy' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(mocks.sshCommand).toHaveBeenCalledWith({
        action: 'saveHost',
        id: null,
        name: '新主机',
        hostname: '10.0.0.5',
        port: 22,
        username: 'deploy',
        privateKeyPath: '',
      }),
    )
    // 保存成功后收起表单并展示新列表。
    await waitFor(() => expect(screen.getByText('新主机')).toBeTruthy())
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('rejects an invalid port locally without issuing a command', () => {    seedHosts([])
    render(<SshHostsPanel />)
    // 挂载时的 loadHosts 已消费一次调用，此后保存不得再发命令。
    const callsBefore = mocks.sshCommand.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /添加/ }))
    fireEvent.change(screen.getByPlaceholderText('生产机'), { target: { value: '坏端口' } })
    fireEvent.change(screen.getByPlaceholderText('192.168.1.10 或 host.example.com'), {
      target: { value: '10.0.0.5' },
    })
    // label 包裹写法下 getByLabelText 直接命中 input 本身。
    const portInput = screen.getByLabelText('端口') as HTMLInputElement
    fireEvent.change(portInput, { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByText('端口必须是 1-65535 的整数')).toBeTruthy()
    expect(mocks.sshCommand.mock.calls.length).toBe(callsBefore)
  })

  it('edits an existing host through the same form', async () => {
    seedHosts([host])
    mocks.sshCommand.mockResolvedValue(
      hostsResponse([{ ...host, name: '生产机（改名）' }]),
    )
    render(<SshHostsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '编辑 生产机' }))
    expect((screen.getByPlaceholderText('生产机') as HTMLInputElement).value).toBe('生产机')
    fireEvent.change(screen.getByPlaceholderText('生产机'), { target: { value: '生产机（改名）' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(mocks.sshCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'saveHost', id: 'id-1', name: '生产机（改名）' }),
      ),
    )
  })

  it('deletes a host from its row', async () => {
    seedHosts([host])
    mocks.sshCommand.mockResolvedValue(hostsResponse([]))
    render(<SshHostsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '删除 生产机' }))
    await waitFor(() =>
      expect(mocks.sshCommand).toHaveBeenCalledWith({ action: 'deleteHost', id: 'id-1' }),
    )
    await waitFor(() => expect(screen.queryByText('生产机')).toBeNull())
  })

  it('surfaces list load errors with a retry control', async () => {
    mocks.sshCommand.mockRejectedValue(new Error('注册表已损坏'))
    render(<SshHostsPanel />)
    await waitFor(() => expect(screen.getByText('注册表已损坏')).toBeTruthy())
    mocks.sshCommand.mockResolvedValue(hostsResponse([host]))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.getByText('生产机')).toBeTruthy())
  })

  it('reflects session phases in the status column, including failed', () => {
    seedHosts([
      host,
      { ...host, id: 'id-2', name: '连接中' },
      { ...host, id: 'id-3', name: '第三台' },
      { ...host, id: 'id-4', name: '失败机' },
    ])
    useSshStore.setState({
      sessions: { 'id-2': 'connecting', 'id-3': 'connected', 'id-4': 'failed' },
    })
    render(<SshHostsPanel />)
    expect(screen.getByText('未连接')).toBeTruthy()
    expect(screen.getByText('连接中…')).toBeTruthy()
    expect(screen.getByText('已连接')).toBeTruthy()
    expect(screen.getByText('已连接').className).toContain('sshview__host-status--connected')
    expect(screen.getByText('连接失败')).toBeTruthy()
    expect(screen.getByText('连接失败').className).toContain('sshview__host-status--failed')
  })

  it('selects the host on row click (terminal pane auto-connects)', () => {
    seedHosts([host])
    render(<SshHostsPanel />)
    fireEvent.click(screen.getByRole('button', { name: `连接 ${host.name}` }))
    expect(useSshStore.getState().activeHostId).toBe(host.id)
  })

  it('shows the host count in the footer', () => {
    seedHosts([host, { ...host, id: 'id-2', name: '第二台' }])
    render(<SshHostsPanel />)
    expect(screen.getByText('2 台主机')).toBeTruthy()
  })

  it('renders the back row above the hosts head and exits on click', () => {
    seedHosts([host])
    const onBack = vi.fn()
    render(<SshHostsPanel onBack={onBack} />)
    // 返回行在主机管理标题上方（Header 不再承载返回键）。
    const backRow = document.querySelector('.sshview__hosts-back')
    expect(backRow?.nextElementSibling?.className).toContain('sshview__hosts-head')
    fireEvent.click(screen.getByRole('button', { name: '返回上一视图' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('omits the back row when no onBack is provided', () => {
    seedHosts([host])
    render(<SshHostsPanel />)
    expect(screen.queryByRole('button', { name: '返回上一视图' })).toBeNull()
  })

  it('saves a private key path with the host and clears it when emptied', async () => {
    seedHosts([{ ...host, privateKeyPath: '/Users/amu/.ssh/old_key' }])
    mocks.sshCommand.mockResolvedValue(hostsResponse([host]))
    render(<SshHostsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '编辑 生产机' }))
    // 编辑表单回填既有路径。
    const keyInput = screen.getByPlaceholderText('/Users/you/.ssh/id_ed25519') as HTMLInputElement
    expect(keyInput.value).toBe('/Users/amu/.ssh/old_key')
    fireEvent.change(keyInput, { target: { value: '/Users/amu/.ssh/id_ed25519' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(mocks.sshCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'saveHost',
          privateKeyPath: '/Users/amu/.ssh/id_ed25519',
        }),
      ),
    )

    // 清空输入 → 提交空串（Rust 语义 = 清除）。
    await waitFor(() => expect(screen.queryByRole('button', { name: '保存' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '编辑 生产机' }))
    fireEvent.change(screen.getByPlaceholderText('/Users/you/.ssh/id_ed25519'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(mocks.sshCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'saveHost', privateKeyPath: '' }),
      ),
    )
  })

  it('rejects a relative private key path locally without issuing a command', () => {
    seedHosts([])
    render(<SshHostsPanel />)
    const callsBefore = mocks.sshCommand.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /添加/ }))
    fireEvent.change(screen.getByPlaceholderText('生产机'), { target: { value: '相对路径' } })
    fireEvent.change(screen.getByPlaceholderText('192.168.1.10 或 host.example.com'), {
      target: { value: '10.0.0.5' },
    })
    fireEvent.change(screen.getByPlaceholderText('root'), { target: { value: 'deploy' } })
    fireEvent.change(screen.getByPlaceholderText('/Users/you/.ssh/id_ed25519'), {
      target: { value: 'id_rsa' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByText('私钥路径必须是绝对路径（以 / 开头）')).toBeTruthy()
    expect(mocks.sshCommand.mock.calls.length).toBe(callsBefore)
  })

  it('saves an optional password with the host', async () => {
    seedHosts([])
    mocks.sshCommand.mockResolvedValue(
      hostsResponse([{ ...host, id: 'id-3', name: '带密码主机', secretId: 'ssh.host.id-3' }]),
    )
    render(<SshHostsPanel />)
    fireEvent.click(screen.getByRole('button', { name: /添加/ }))
    fireEvent.change(screen.getByPlaceholderText('生产机'), { target: { value: '带密码主机' } })
    fireEvent.change(screen.getByPlaceholderText('192.168.1.10 或 host.example.com'), {
      target: { value: '10.0.0.9' },
    })
    fireEvent.change(screen.getByPlaceholderText('root'), { target: { value: 'deploy' } })
    fireEvent.change(screen.getByPlaceholderText(/留空则连接时交互输入/), {
      target: { value: 's3cret' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(mocks.sshCommand).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'saveHost', password: 's3cret' }),
      ),
    )
  })

  it('omits the password field when left empty (keep current secret)', async () => {
    seedHosts([{ ...host, secretId: 'ssh.host.id-1' }])
    mocks.sshCommand.mockResolvedValue(hostsResponse([{ ...host }]))
    render(<SshHostsPanel />)
    fireEvent.click(screen.getByRole('button', { name: '编辑 生产机' }))
    expect(screen.getByPlaceholderText(/已保存密码/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      const call = mocks.sshCommand.mock.calls.find(([request]) => request.action === 'saveHost')
      expect(call).toBeTruthy()
      const request = call?.[0] as { password?: string } | undefined
      expect(request?.password).toBeUndefined()
    })
  })

  it('renders the default empty markup in SSR', () => {
    // SSR 下 zustand 只断言默认态（AGENTS 约定）：列表头 + 空态 + 添加按钮。
    const html = renderToStaticMarkup(<SshHostsPanel />)
    expect(html).toContain('主机管理')
    expect(html).toContain('添加')
    expect(html).toContain('sshview__hosts-head')
  })
})
