import { describe, expect, it, vi } from 'vitest'
import { AgentEnvironmentError } from '@/agent/environment/AgentEnvironment'

const mocks = vi.hoisted(() => ({
  getRuntimeInfo: vi.fn(),
  listAuthorizedReadFiles: vi.fn(),
  readAuthorizedText: vi.fn(),
  listWorkspace: vi.fn(),
  readWorkspaceText: vi.fn(),
  searchWorkspaceText: vi.fn(),
  createWorkspaceTextFile: vi.fn(),
  editWorkspaceTextFile: vi.fn(),
  applyWorkspaceChanges: vi.fn(),
  restoreWorkspaceTrash: vi.fn(),
  findWorkspaceFiles: vi.fn(),
  runWorkspaceCommand: vi.fn(),
  writeToolResultArtifact: vi.fn(),
}))

vi.mock('@/platform/authorizedFiles', () => ({
  listAuthorizedReadFiles: mocks.listAuthorizedReadFiles,
  readAuthorizedText: mocks.readAuthorizedText,
}))
vi.mock('@/platform/runtimeInfo', () => ({ getRuntimeInfo: mocks.getRuntimeInfo }))
vi.mock('@/platform/workspace', () => ({
  applyWorkspaceChanges: mocks.applyWorkspaceChanges,
  createWorkspaceTextFile: mocks.createWorkspaceTextFile,
  editWorkspaceTextFile: mocks.editWorkspaceTextFile,
  findWorkspaceFiles: mocks.findWorkspaceFiles,
  listWorkspace: mocks.listWorkspace,
  readWorkspaceText: mocks.readWorkspaceText,
  restoreWorkspaceTrash: mocks.restoreWorkspaceTrash,
  searchWorkspaceText: mocks.searchWorkspaceText,
}))
vi.mock('@/platform/workspaceCommand', () => ({
  runWorkspaceCommand: mocks.runWorkspaceCommand,
}))
vi.mock('@/platform/artifacts', () => ({
  writeToolResultArtifact: mocks.writeToolResultArtifact,
}))

import { createDesktopAgentEnvironment } from './desktopAgentEnvironment'

const signal = new AbortController().signal

describe('createDesktopAgentEnvironment', () => {
  it('delegates runtime info and authorized file reads', async () => {
    mocks.getRuntimeInfo.mockResolvedValueOnce({ mode: 'desktop', capabilities: [] })
    mocks.listAuthorizedReadFiles.mockResolvedValueOnce([])
    mocks.readAuthorizedText.mockResolvedValueOnce({ path: 'a.ts', content: 'x' })

    const env = createDesktopAgentEnvironment('/repo')
    await expect(env.runtime.getInfo()).resolves.toEqual({ mode: 'desktop', capabilities: [] })
    await expect(env.authorizedFiles.list()).resolves.toEqual([])
    await expect(env.authorizedFiles.readText('a.ts')).resolves.toEqual({ path: 'a.ts', content: 'x' })
    expect(mocks.readAuthorizedText).toHaveBeenCalledWith('a.ts')
  })

  it('injects the bound workspace path and forwards arguments for every workspace capability', async () => {
    const env = createDesktopAgentEnvironment('/repo')
    const lease = 'lease-1'

    await env.workspace.list('src', 5)
    expect(mocks.listWorkspace).toHaveBeenCalledWith('src', 5, '/repo')

    await env.workspace.readText('a.ts', 10, 20)
    expect(mocks.readWorkspaceText).toHaveBeenCalledWith('a.ts', 10, 20, '/repo')

    await env.workspace.searchText({ requestId: 'search-1', pattern: 'foo' }, signal)
    expect(mocks.searchWorkspaceText).toHaveBeenCalledWith({ requestId: 'search-1', pattern: 'foo' }, signal, '/repo')

    await env.workspace.createTextFile('n.ts', 'code', lease)
    expect(mocks.createWorkspaceTextFile).toHaveBeenCalledWith('n.ts', 'code', lease, '/repo')

    const edits = [{ oldText: 'a', newText: 'x' }]
    await env.workspace.editTextFile('a.ts', edits, lease)
    expect(mocks.editWorkspaceTextFile).toHaveBeenCalledWith('a.ts', edits, lease, '/repo')

    const request = { requestId: 'r1', operations: [] }
    await env.workspace.applyChanges(request, lease)
    expect(mocks.applyWorkspaceChanges).toHaveBeenCalledWith(request, lease, '/repo')

    await env.workspace.restoreTrash('recovery-1', lease)
    expect(mocks.restoreWorkspaceTrash).toHaveBeenCalledWith('recovery-1', lease, '/repo')

    const onProgress = vi.fn()
    await env.workspace.runCommand({ requestId: 'cmd-1', command: 'ls' }, signal, onProgress, lease)
    expect(mocks.runWorkspaceCommand).toHaveBeenCalledWith(
      { requestId: 'cmd-1', command: 'ls' }, signal, onProgress, lease, '/repo',
    )

    await env.workspace.find({ requestId: 'f1', pattern: '*.ts', signal })
    expect(mocks.findWorkspaceFiles).toHaveBeenCalledWith({ requestId: 'f1', pattern: '*.ts', signal, workspacePath: '/repo' })
  })

  it('delegates artifact writes', async () => {
    mocks.writeToolResultArtifact.mockResolvedValueOnce({ kind: 'tool-result', sha256: 'abc', sizeBytes: 3 })
    const env = createDesktopAgentEnvironment('/repo')
    await expect(env.artifacts.writeToolResult({
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'bash',
      content: 'out',
    })).resolves.toEqual({ kind: 'tool-result', sha256: 'abc', sizeBytes: 3 })
  })

  it('classifies platform errors into stable AgentEnvironmentError codes', async () => {
    const env = createDesktopAgentEnvironment('/repo')
    const cases: Array<[string, 'aborted' | 'not_authorized' | 'invalid_path' | 'timeout' | 'conflict' | 'unavailable']> = [
      ['操作已取消', 'aborted'],
      ['文件未授权', 'not_authorized'],
      ['路径超出工作区', 'invalid_path'],
      ['命令执行超时', 'timeout'],
      ['sha256 校验失败', 'conflict'],
      ['仅在 Axiom 桌面应用中可用', 'unavailable'],
    ]
    for (const [message, code] of cases) {
      mocks.getRuntimeInfo.mockRejectedValueOnce(new Error(message))
      await expect(env.runtime.getInfo()).rejects.toMatchObject({
        code,
        name: 'AgentEnvironmentError',
      })
    }
  })

  it('treats an AbortError DOMException as aborted', async () => {
    const env = createDesktopAgentEnvironment('/repo')
    mocks.getRuntimeInfo.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
    await expect(env.runtime.getInfo()).rejects.toMatchObject({ code: 'aborted' })
  })

  it('rethrows an existing AgentEnvironmentError unchanged', async () => {
    const env = createDesktopAgentEnvironment('/repo')
    const original = new AgentEnvironmentError('conflict', '已有冲突')
    mocks.getRuntimeInfo.mockRejectedValueOnce(original)
    await expect(env.runtime.getInfo()).rejects.toBe(original)
  })

  it('keeps a resolved value from the wrapped platform call', async () => {
    const env = createDesktopAgentEnvironment('/repo')
    mocks.listWorkspace.mockResolvedValueOnce({ entries: [], total: 0 })
    await expect(env.workspace.list()).resolves.toEqual({ entries: [], total: 0 })
  })
})
