import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateAuthorizedWorkspace,
  applyWorkspaceChanges,
  cancelWorkspaceSearch,
  createWorkspaceTextFile,
  editWorkspaceTextFile,
  findWorkspaceFiles,
  getAuthorizedWorkspace,
  getAuthorizedWorkspaces,
  getWorkspaceRecoveryIssue,
  listWorkspace,
  readWorkspaceText,
  restoreAuthorizedWorkspaces,
  restoreWorkspaceTrash,
  retryWorkspaceRecovery,
  revokeWorkspace,
  searchWorkspaceText,
  selectAndAuthorizeWorkspace,
} from './workspace'

const mocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(),
  openDialog: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.openDialog }))
vi.mock('./environment', () => ({ isTauriRuntime: mocks.isTauriRuntime }))

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mocks.isTauriRuntime.mockReturnValue(true)
  mocks.openDialog.mockReset()
  mockedInvoke.mockReset()
  mockedInvoke.mockResolvedValue(undefined)
})

describe('workspace IPC', () => {

  it('forwards the approval lease for every workspace mutation', async () => {
    await createWorkspaceTextFile('notes/new.md', 'hello', 'lease-create')
    expect(mockedInvoke).toHaveBeenLastCalledWith('create_workspace_text_file', {
      path: 'notes/new.md',
      content: 'hello',
      approvalLease: 'lease-create',
    })

    await editWorkspaceTextFile('notes/new.md', [{ oldText: 'hello', newText: 'updated' }], 'lease-edit')
    expect(mockedInvoke).toHaveBeenLastCalledWith('edit_workspace_text_file', {
      request: {
        path: 'notes/new.md',
        edits: [{ oldText: 'hello', newText: 'updated' }],
      },
      approvalLease: 'lease-edit',
    })

    const request = {
      requestId: 'change-1',
      operations: [{ type: 'create-directory' as const, path: 'notes/archive' }],
    }
    await applyWorkspaceChanges(request, 'lease-apply')
    expect(mockedInvoke).toHaveBeenLastCalledWith('apply_workspace_changes', {
      request,
      approvalLease: 'lease-apply',
    })

    await restoreWorkspaceTrash('recovery-1', 'lease-restore')
    expect(mockedInvoke).toHaveBeenLastCalledWith('restore_workspace_trash', {
      recoveryId: 'recovery-1',
      approvalLease: 'lease-restore',
    })
  })

  it('restores unique persisted workspace paths and reports invalid entries', async () => {
    mockedInvoke.mockImplementation(async (command, args) => {
      if (command === 'authorize_workspace' && args && 'path' in args && args.path === '/missing') {
        throw new Error('missing workspace')
      }
      if (command === 'get_authorized_workspaces') {
        return [{ path: '/repo/axiom', name: 'axiom', gitBranch: 'main' }]
      }
      return undefined
    })

    await expect(restoreAuthorizedWorkspaces([
      '/repo/axiom',
      '/repo/axiom',
      '  ',
      '/missing',
    ])).resolves.toEqual({
      workspaces: [{ path: '/repo/axiom', name: 'axiom', gitBranch: 'main' }],
      failedPaths: ['/missing'],
    })
    expect(mockedInvoke.mock.calls.filter(([command]) => command === 'authorize_workspace'))
      .toEqual([
        ['authorize_workspace', { path: '/repo/axiom' }],
        ['authorize_workspace', { path: '/missing' }],
      ])
  })
})

describe('workspace read variants and cancellation', () => {
  it('falls back through macOS filename variants before giving up', async () => {
    mockedInvoke
      .mockRejectedValueOnce(new Error('not found'))
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({
        workspace: {}, path: "Capture d'écran 2024 PM.png", content: 'x',
        sha256: 'h', startLine: 1, endLine: 1, totalLines: 1, truncated: false,
      })

    const result = await readWorkspaceText("Capture d'écran 2024 PM.png")
    expect(result.path).toBe("Capture d'écran 2024 PM.png")
    expect(mockedInvoke).toHaveBeenCalledTimes(3)
  })

  it('rethrows the original error when every filename variant fails', async () => {
    mockedInvoke.mockRejectedValue(new Error('not found'))
    await expect(readWorkspaceText("Capture d'écran.png")).rejects.toThrow('not found')
    // 原始路径 + 全部变体（NFD/弯引号）均尝试后仍失败。
    expect(mockedInvoke.mock.calls.length).toBeGreaterThan(1)
  })

  it('short-circuits an already-aborted search', async () => {
    const aborted = new AbortController()
    aborted.abort()
    await expect(searchWorkspaceText({ requestId: 's1', pattern: 'x' }, aborted.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('cancels the native search on abort and forwards the request payload', async () => {
    const controller = new AbortController()
    mockedInvoke.mockResolvedValueOnce({ workspace: {}, matches: [], truncated: false })

    const promise = searchWorkspaceText({ requestId: 's1', pattern: 'foo', path: 'src' }, controller.signal)
    controller.abort()
    await promise

    expect(mockedInvoke).toHaveBeenCalledWith('search_workspace_text', {
      request: { requestId: 's1', pattern: 'foo', path: 'src' },
    })
    expect(mockedInvoke).toHaveBeenCalledWith('cancel_workspace_search', { requestId: 's1' })
  })

  it('returns false for cancelWorkspaceSearch outside the desktop runtime', async () => {
    mocks.isTauriRuntime.mockReturnValue(false)
    await expect(cancelWorkspaceSearch('s1')).resolves.toBe(false)
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('rejects an aborted find and rejects outside the desktop runtime', async () => {
    const aborted = new AbortController()
    aborted.abort()
    await expect(findWorkspaceFiles({
      requestId: 'f1', pattern: '*.ts', signal: aborted.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })

    mocks.isTauriRuntime.mockReturnValue(false)
    await expect(findWorkspaceFiles({
      requestId: 'f1', pattern: '*.ts', signal: new AbortController().signal,
    })).rejects.toThrow('仅在 Axiom 桌面应用中可用')
  })
})

describe('workspace authorization IPC', () => {
  it('selects and authorizes a workspace via the Rust-owned native picker', async () => {
    // 目录选择器在 Rust 侧打开并直接授权；WebView 不再传递任意绝对路径。
    mockedInvoke.mockResolvedValueOnce({ path: '/repo', name: 'repo' })

    await expect(selectAndAuthorizeWorkspace()).resolves.toEqual({ path: '/repo', name: 'repo' })
    expect(mockedInvoke).toHaveBeenCalledWith('pick_and_authorize_workspace')
    expect(mocks.openDialog).not.toHaveBeenCalled()
    expect(mockedInvoke).not.toHaveBeenCalledWith('authorize_workspace', expect.anything())
  })

  it('returns null when the Rust-owned workspace picker is cancelled', async () => {
    mockedInvoke.mockResolvedValueOnce(null)
    await expect(selectAndAuthorizeWorkspace()).resolves.toBeNull()
    expect(mockedInvoke).toHaveBeenCalledWith('pick_and_authorize_workspace')
  })

  it('forwards authorization reads, activation, revocation and recovery IPC', async () => {
    mockedInvoke.mockResolvedValue({ path: '/repo', name: 'repo' })
    await getAuthorizedWorkspace()
    await getAuthorizedWorkspaces()
    await activateAuthorizedWorkspace('/repo')
    await revokeWorkspace('/repo')
    await revokeWorkspace()
    await getWorkspaceRecoveryIssue()
    await retryWorkspaceRecovery()

    expect(mockedInvoke).toHaveBeenCalledWith('get_authorized_workspace')
    expect(mockedInvoke).toHaveBeenCalledWith('get_authorized_workspaces')
    expect(mockedInvoke).toHaveBeenCalledWith('activate_authorized_workspace', { path: '/repo' })
    expect(mockedInvoke).toHaveBeenCalledWith('revoke_workspace', { path: '/repo' })
    expect(mockedInvoke).toHaveBeenCalledWith('revoke_workspace', { path: null })
    expect(mockedInvoke).toHaveBeenCalledWith('get_workspace_recovery_issue')
    expect(mockedInvoke).toHaveBeenCalledWith('retry_workspace_recovery')
  })

  it('refuses workspace mutations outside the desktop runtime', async () => {
    mocks.isTauriRuntime.mockReturnValue(false)
    await expect(listWorkspace()).rejects.toThrow('仅在 Axiom 桌面应用中可用')
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('forwards listWorkspace with the bound workspace path', async () => {
    mockedInvoke.mockResolvedValueOnce({ workspace: {}, directory: '.', entries: [], truncated: false })
    await listWorkspace('src', 5, '/repo')
    expect(mockedInvoke).toHaveBeenCalledWith('list_workspace', {
      path: 'src', limit: 5, workspacePath: '/repo',
    })
  })
})
