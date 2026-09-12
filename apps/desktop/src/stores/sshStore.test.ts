import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureSshEvents,
  resetSshEventsForTests,
  resetSshStoreForTests,
  useSshStore,
} from './sshStore'
import type { SshCommandResponse } from '@/platform/sshSession'

const mocks = vi.hoisted(() => ({
  sshCommand: vi.fn(),
  uploadListeners: [] as Array<(event: Record<string, unknown>) => void>,
  sessionListeners: [] as Array<(event: Record<string, unknown>) => void>,
}))

vi.mock('@/platform/sshSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/sshSession')>()),
  sshCommand: mocks.sshCommand,
  onSshSessionEvent: vi.fn((handler: (event: Record<string, unknown>) => void) => {
    mocks.sessionListeners.push(handler)
    return Promise.resolve(() => {})
  }),
  onSshUploadEvent: vi.fn((handler: (event: Record<string, unknown>) => void) => {
    mocks.uploadListeners.push(handler)
    return Promise.resolve(() => {})
  }),
}))

/** 模拟 Rust 发出的一条上传事件。 */
const deliverUpload = (event: Record<string, unknown>): void => {
  for (const handler of mocks.uploadListeners) handler(event)
}

/** 模拟 Rust 发出的一条会话事件。 */
const deliverSession = (event: Record<string, unknown>): void => {
  for (const handler of mocks.sessionListeners) handler(event)
}

const hostEntry = {
  id: 'id-1',
  name: '生产机',
  hostname: 'server.example.com',
  port: 22,
  username: 'amu',
  createdAt: 1756900000,
}

const hostsResponse = (hosts: unknown[]): SshCommandResponse =>
  ({ type: 'hosts', hosts }) as SshCommandResponse

describe('sshStore', () => {
  beforeEach(() => {
    resetSshStoreForTests()
    resetSshEventsForTests()
    mocks.sshCommand.mockReset()
    mocks.sessionListeners.length = 0
    mocks.uploadListeners.length = 0
    // 注册会话/上传事件分发（内部单例：reset 后每段用例独立订阅）。
    ensureSshEvents()
  })

  it('loadHosts replaces the host list on success', async () => {
    mocks.sshCommand.mockResolvedValue(hostsResponse([hostEntry]))
    await useSshStore.getState().loadHosts()
    expect(mocks.sshCommand).toHaveBeenCalledWith({ action: 'listHosts' })
    expect(useSshStore.getState().hosts).toEqual([hostEntry])
    expect(useSshStore.getState().listStatus).toBe('ready')
    expect(useSshStore.getState().error).toBeNull()
  })

  it('loadHosts records the error and keeps the list empty on failure', async () => {
    mocks.sshCommand.mockRejectedValue(new Error('通道不可用'))
    await useSshStore.getState().loadHosts()
    expect(useSshStore.getState().listStatus).toBe('error')
    expect(useSshStore.getState().error).toBe('通道不可用')
    expect(useSshStore.getState().hosts).toEqual([])
  })

  it('saveHost without id issues a saveHost action and replaces the list', async () => {
    mocks.sshCommand.mockResolvedValue(hostsResponse([hostEntry]))
    await useSshStore.getState().saveHost(
      { name: '生产机', hostname: 'server.example.com', port: 22, username: 'amu' },
    )
    expect(mocks.sshCommand).toHaveBeenCalledWith({
      action: 'saveHost',
      id: null,
      name: '生产机',
      hostname: 'server.example.com',
      port: 22,
      username: 'amu',
    })
    expect(useSshStore.getState().hosts).toEqual([hostEntry])
  })

  it('saveHost keeps the list stale and rethrows on failure', async () => {
    useSshStore.setState({ hosts: [hostEntry], listStatus: 'ready' })
    mocks.sshCommand.mockRejectedValue(new Error('主机名称不能为空'))
    await expect(
      useSshStore.getState().saveHost({ name: '', hostname: 'h', port: 22, username: 'u' }),
    ).rejects.toThrow('主机名称不能为空')
    expect(useSshStore.getState().hosts).toEqual([hostEntry])
    expect(useSshStore.getState().error).toBe('主机名称不能为空')
  })

  it('deleteHost issues a deleteHost action and replaces the list', async () => {
    useSshStore.setState({ hosts: [hostEntry], listStatus: 'ready' })
    mocks.sshCommand.mockResolvedValue(hostsResponse([]))
    await useSshStore.getState().deleteHost('id-1')
    expect(mocks.sshCommand).toHaveBeenCalledWith({ action: 'deleteHost', id: 'id-1' })
    expect(useSshStore.getState().hosts).toEqual([])
  })

  it('deleteHost surfaces errors without mutating the list', async () => {
    useSshStore.setState({ hosts: [hostEntry], listStatus: 'ready' })
    mocks.sshCommand.mockRejectedValue('注册表损坏')
    await expect(useSshStore.getState().deleteHost('id-1')).rejects.toBe('注册表损坏')
    expect(useSshStore.getState().hosts).toEqual([hostEntry])
    expect(useSshStore.getState().error).toBe('注册表损坏')
  })

  it('deleteHost clears the session projection and active selection', async () => {
    useSshStore.setState({
      hosts: [hostEntry],
      sessions: { 'id-1': 'connected' },
      activeHostId: 'id-1',
      listStatus: 'ready',
    })
    mocks.sshCommand.mockResolvedValue(hostsResponse([]))
    await useSshStore.getState().deleteHost('id-1')
    expect(useSshStore.getState().sessions).toEqual({})
    expect(useSshStore.getState().activeHostId).toBeNull()
  })

  it('openSession marks connecting on entry and failed on failure', async () => {
    useSshStore.setState({ hosts: [hostEntry] })
    mocks.sshCommand
      .mockResolvedValueOnce({ type: 'ack' })
      .mockRejectedValueOnce(new Error('ssh 进程启动失败'))
    await useSshStore.getState().openSession('id-1', 80, 24)
    expect(mocks.sshCommand).toHaveBeenCalledWith({
      action: 'openSession',
      hostId: 'id-1',
      cols: 80,
      rows: 24,
    })
    expect(useSshStore.getState().sessions['id-1']).toBe('connecting')

    await expect(useSshStore.getState().openSession('id-1', 80, 24)).rejects.toThrow(
      'ssh 进程启动失败',
    )
    // 打开失败 → failed（主机行「连接失败」态），不再是 closed。
    expect(useSshStore.getState().sessions['id-1']).toBe('failed')
  })

  it('refreshSessions projects the alive session list as connected', async () => {
    mocks.sshCommand.mockResolvedValue({
      type: 'sessions',
      sessions: [{ hostId: 'id-1' }],
    })
    await useSshStore.getState().refreshSessions()
    expect(useSshStore.getState().sessions).toEqual({ 'id-1': 'connected' })
  })

  it('closeSession falls back to closed even when the command fails', async () => {
    useSshStore.setState({ sessions: { 'id-1': 'connected' } })
    mocks.sshCommand.mockRejectedValue(new Error('通道不可用'))
    await useSshStore.getState().closeSession('id-1')
    expect(mocks.sshCommand).toHaveBeenCalledWith({ action: 'closeSession', hostId: 'id-1' })
    expect(useSshStore.getState().sessions['id-1']).toBe('closed')
  })

  it('upload events drive the projection through its lifecycle', async () => {
    await useSshStore.getState().uploadFile('id-1', '~').catch(() => undefined)
    // 非 Tauri 环境真实 sshCommand 拒绝：此处 mock 为 ack 以单独测生命周期。
    mocks.sshCommand.mockResolvedValue({ type: 'ack' })
    await useSshStore.getState().uploadFile('id-1', '~')
    expect(mocks.sshCommand).toHaveBeenCalledWith({ action: 'uploadFile', hostId: 'id-1', remoteDir: '~' })

    deliverUpload({ phase: 'start', hostId: 'id-1', name: 'a.bin', totalBytes: 1000 })
    deliverUpload({ phase: 'progress', hostId: 'id-1', name: 'a.bin', transferredBytes: 450, totalBytes: 1000 })
    expect(useSshStore.getState().uploads['id-1']).toEqual({
      name: 'a.bin',
      transferred: 450,
      total: 1000,
    })

    deliverUpload({ phase: 'done', hostId: 'id-1', name: 'a.bin' })
    expect(useSshStore.getState().uploads['id-1']).toBeUndefined()
  })

  it('upload terminal events refresh the browsed directory listing', async () => {
    mocks.sshCommand.mockResolvedValue({ type: 'ack' })
    // 面板曾浏览过 ~（currentDir 有记录）：上传终态应触发 listFiles 刷新。
    useSshStore.setState({ currentDir: { 'id-1': '~' } })
    deliverUpload({ phase: 'start', hostId: 'id-1', name: 'a.bin', totalBytes: 10 })
    deliverUpload({ phase: 'done', hostId: 'id-1', name: 'a.bin' })
    expect(mocks.sshCommand).toHaveBeenCalledWith({ action: 'listFiles', hostId: 'id-1', path: '~' })
    expect(useSshStore.getState().uploads['id-1']).toBeUndefined()

    // 失败同样刷新：先前文件可能已部分落盘（文件夹上传在第 N 个文件失败）。
    mocks.sshCommand.mockClear()
    deliverUpload({ phase: 'start', hostId: 'id-1', name: 'b.bin', totalBytes: 10 })
    deliverUpload({ phase: 'failed', hostId: 'id-1', name: 'b.bin', error: '远端写入失败' })
    expect(mocks.sshCommand).toHaveBeenCalledWith({ action: 'listFiles', hostId: 'id-1', path: '~' })

    // 从未浏览过的主机没有列表可刷新，不发起 listFiles。
    mocks.sshCommand.mockClear()
    deliverUpload({ phase: 'start', hostId: 'id-2', name: 'c.bin', totalBytes: 10 })
    deliverUpload({ phase: 'done', hostId: 'id-2', name: 'c.bin' })
    expect(mocks.sshCommand).not.toHaveBeenCalled()
  })

  it('loadDir projects remote directory entries with path tag and clears dirError', async () => {
    mocks.sshCommand.mockResolvedValue({
      type: 'files',
      hostId: 'id-1',
      path: '~',
      entries: [
        { name: 'boot', sizeBytes: 4096, isDir: true, perms: 'drwxr-xr-x', modifiedAt: 'May 3 2026 06:08' },
      ],
      truncated: false,
    })
    await useSshStore.getState().loadDir('id-1', '~')
    expect(mocks.sshCommand).toHaveBeenCalledWith({ action: 'listFiles', hostId: 'id-1', path: '~' })
    expect(useSshStore.getState().dirs['id-1']).toEqual({
      path: '~',
      entries: [
        { name: 'boot', sizeBytes: 4096, isDir: true, perms: 'drwxr-xr-x', modifiedAt: 'May 3 2026 06:08' },
      ],
    })
    expect(useSshStore.getState().currentDir['id-1']).toBe('~')
    expect(useSshStore.getState().dirError['id-1']).toBeNull()
  })

  it('loadDir failure records dirError without clobbering the last listing', async () => {
    mocks.sshCommand.mockResolvedValueOnce({
      type: 'files',
      hostId: 'id-1',
      path: '~',
      entries: [
        { name: 'boot', sizeBytes: 4096, isDir: true, perms: 'drwxr-xr-x', modifiedAt: 'May 3 2026 06:08' },
      ],
      truncated: false,
    })
    await useSshStore.getState().loadDir('id-1', '~')
    mocks.sshCommand.mockRejectedValueOnce(new Error('连接已断开'))
    await useSshStore.getState().loadDir('id-1', '~/logs')
    expect(useSshStore.getState().dirError['id-1']).toBe('连接已断开')
    // 上一次成功列表原样保留（带路径标签），由渲染层按路径匹配决定展示。
    expect(useSshStore.getState().dirs['id-1']).toEqual({
      path: '~',
      entries: [
        { name: 'boot', sizeBytes: 4096, isDir: true, perms: 'drwxr-xr-x', modifiedAt: 'May 3 2026 06:08' },
      ],
    })
    // 恢复成功后 dirError 清除。
    mocks.sshCommand.mockResolvedValueOnce({
      type: 'files',
      hostId: 'id-1',
      path: '~/logs',
      entries: [],
      truncated: false,
    })
    await useSshStore.getState().loadDir('id-1', '~/logs')
    expect(useSshStore.getState().dirError['id-1']).toBeNull()
  })

  it('makeDir posts the mkdir command', async () => {
    mocks.sshCommand.mockResolvedValue({ type: 'ack' })
    await useSshStore.getState().makeDir('id-1', '~/logs')
    expect(mocks.sshCommand).toHaveBeenCalledWith({ action: 'makeDir', hostId: 'id-1', path: '~/logs' })
  })

  it('uploadFolder posts the recursive upload command', async () => {
    mocks.sshCommand.mockResolvedValue({ type: 'ack' })
    await useSshStore.getState().uploadFolder('id-1', '~')
    expect(mocks.sshCommand).toHaveBeenCalledWith({ action: 'uploadFolder', hostId: 'id-1', remoteDir: '~' })
  })

  it('distinguishes user-initiated close from unexpected drop', async () => {
    useSshStore.setState({ sessions: { 'id-1': 'connected' } })
    // 主动断开：closeSession 记录 userClosed，done 事件不再标记意外。
    mocks.sshCommand.mockResolvedValue({ type: 'ack' })
    await useSshStore.getState().closeSession('id-1')
    useSshStore.getState().handleSessionDone('id-1')
    expect(useSshStore.getState().unexpectedCloses['id-1']).toBeUndefined()

    // 意外掉线：无 userClosed 记录的 connected 会话收到 done → 标记意外。
    useSshStore.setState({ sessions: { 'id-2': 'connected' } })
    useSshStore.getState().handleSessionDone('id-2')
    expect(useSshStore.getState().unexpectedCloses['id-2']).toBe(true)
    expect(useSshStore.getState().sessions['id-2']).toBe('closed')

    // 意外标记只由显式的用户重连动作清除（clearUnexpectedClose）——openSession
    // 本身不清除，挂载期自动连接才不会误消费重连提示。
    mocks.sshCommand.mockResolvedValue({ type: 'ack' })
    await useSshStore.getState().openSession('id-2', 80, 24)
    expect(useSshStore.getState().unexpectedCloses['id-2']).toBe(true)
    useSshStore.getState().clearUnexpectedClose('id-2')
    expect(useSshStore.getState().unexpectedCloses['id-2']).toBeUndefined()
  })

  it('marks a session failed when it exits non-zero before ever connecting', () => {
    // 认证失败/主机拒绝/网络不可达：ssh 进程在首包数据前以非零码退出。
    useSshStore.setState({ sessions: { 'id-1': 'connecting' } })
    useSshStore.getState().handleSessionDone('id-1', 255)
    expect(useSshStore.getState().sessions['id-1']).toBe('failed')
    // 失败不是意外掉线：不展示「重连 + 已断开」组合。
    expect(useSshStore.getState().unexpectedCloses['id-1']).toBeUndefined()

    // failed 是终态：迟到的 done（零码/无码）不把「连接失败」改写回已断开。
    useSshStore.getState().handleSessionDone('id-1')
    expect(useSshStore.getState().sessions['id-1']).toBe('failed')
  })

  it('refreshSessions merges projections instead of clobbering last-known states', async () => {
    useSshStore.setState({ sessions: { 'id-1': 'failed', 'id-9': 'closed' } })
    mocks.sshCommand.mockResolvedValue({
      type: 'sessions',
      sessions: [{ hostId: 'id-2' }],
    })
    await useSshStore.getState().refreshSessions()
    expect(useSshStore.getState().sessions).toEqual({
      'id-1': 'failed',
      'id-9': 'closed',
      'id-2': 'connected',
    })
  })

  it('cancel and resume issue their actions', async () => {
    mocks.sshCommand.mockResolvedValue({ type: 'ack' })
    await useSshStore.getState().cancelUpload('id-1')
    expect(mocks.sshCommand).toHaveBeenCalledWith({ action: 'cancelUpload', hostId: 'id-1' })
    await useSshStore.getState().resumeUpload('id-1')
    expect(mocks.sshCommand).toHaveBeenCalledWith({ action: 'resumeUpload', hostId: 'id-1' })
  })

  it('cancelled upload event marks the projection as resumable', async () => {
    deliverUpload({ phase: 'start', hostId: 'id-1', name: 'a.bin', totalBytes: 100 })
    deliverUpload({ phase: 'cancelled', hostId: 'id-1', name: 'a.bin' })
    expect(useSshStore.getState().uploads['id-1']).toMatchObject({ error: '已取消，可续传' })
  })

  it('upload failure keeps the projection with the error for display', async () => {
    deliverUpload({ phase: 'start', hostId: 'id-1', name: 'a.bin', totalBytes: 100 })
    deliverUpload({ phase: 'failed', hostId: 'id-1', name: 'a.bin', error: '远端写入失败' })
    expect(useSshStore.getState().uploads['id-1']).toMatchObject({ error: '远端写入失败' })
    // 用户点「知道了」清除投影。
    useSshStore.getState().markUploadDone('id-1')
    expect(useSshStore.getState().uploads['id-1']).toBeUndefined()
  })

  it('session phase markers are idempotent', () => {
    const { markSessionConnecting, markSessionConnected, markSessionClosed } =
      useSshStore.getState()
    // connected 只从 connecting 单向转换：重复调用与无会话记录都不产生投影。
    markSessionConnected('id-1')
    expect(useSshStore.getState().sessions['id-1']).toBeUndefined()
    markSessionConnecting('id-1')
    markSessionConnected('id-1')
    markSessionConnected('id-1')
    expect(useSshStore.getState().sessions['id-1']).toBe('connected')
    markSessionClosed('id-1')
    markSessionClosed('id-1')
    expect(useSshStore.getState().sessions['id-1']).toBe('closed')
    // closed 不被迟到数据事件复活。
    markSessionConnected('id-1')
    expect(useSshStore.getState().sessions['id-1']).toBe('closed')
    // 对无记录主机的 closed 不产生投影（保持「未连接」语义）。
    markSessionClosed('id-unknown')
    expect(useSshStore.getState().sessions['id-unknown']).toBeUndefined()
  })

  it('session events drive the full phase machine through ensureSshEvents', async () => {
    // 首包数据 → connecting 升级 connected（上传按钮与状态列依赖该转换）。
    // data 载荷是 base64 字节（btoa('hi')），与 Rust 事件镜像一致。
    useSshStore.setState({ sessions: { 'id-1': 'connecting' } })
    deliverSession({ hostId: 'id-1', data: btoa('hi') })
    expect(useSshStore.getState().sessions['id-1']).toBe('connected')

    // done 事件走 handleSessionDone 语义：无 userClosed 记录的连接中会话
    // 掉线 → 标记意外并回落 closed（页脚「重连」入口的驱动源）。
    useSshStore.setState({ sessions: { 'id-2': 'connecting' } })
    deliverSession({ hostId: 'id-2', data: btoa('h') })
    deliverSession({ hostId: 'id-2', done: true, exitCode: 255 })
    expect(useSshStore.getState().sessions['id-2']).toBe('closed')
    expect(useSshStore.getState().unexpectedCloses['id-2']).toBe(true)

    // 主动断开后的 done：消费 userClosed 标记、不产生意外掉线提示。
    useSshStore.setState({
      sessions: { 'id-3': 'connected' },
      userClosedHosts: { 'id-3': true },
    })
    deliverSession({ hostId: 'id-3', done: true })
    expect(useSshStore.getState().sessions['id-3']).toBe('closed')
    expect(useSshStore.getState().unexpectedCloses['id-3']).toBeUndefined()
    expect(useSshStore.getState().userClosedHosts['id-3']).toBeUndefined()
  })
})
