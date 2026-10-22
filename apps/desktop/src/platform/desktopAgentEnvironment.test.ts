import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  writeImageArtifact: vi.fn(),
  browserCommand: vi.fn(),
  notifyBrowserAgentActivity: vi.fn(),
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
  writeImageArtifact: mocks.writeImageArtifact,
}))
vi.mock('@/platform/browserSession', () => ({
  browserCommand: mocks.browserCommand,
  notifyBrowserAgentActivity: mocks.notifyBrowserAgentActivity,
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
    const env = createDesktopAgentEnvironment('/repo', 's1')
    const lease = 'lease-1'
    const scope = { sessionId: 's1', runId: 'r1', toolCallId: 'c1' }

    await env.workspace.list('src', 5)
    expect(mocks.listWorkspace).toHaveBeenCalledWith('src', 5, '/repo')

    await env.workspace.readText('a.ts', 10, 20)
    expect(mocks.readWorkspaceText).toHaveBeenCalledWith('a.ts', 10, 20, '/repo')

    await env.workspace.searchText({ requestId: 'search-1', pattern: 'foo' }, signal)
    expect(mocks.searchWorkspaceText).toHaveBeenCalledWith({ requestId: 'search-1', pattern: 'foo' }, signal, '/repo')

    await env.workspace.createTextFile('n.ts', 'code', lease, scope)
    expect(mocks.createWorkspaceTextFile).toHaveBeenCalledWith('n.ts', 'code', lease, '/repo', scope)

    const edits = [{ oldText: 'a', newText: 'x' }]
    await env.workspace.editTextFile('a.ts', edits, lease, scope)
    expect(mocks.editWorkspaceTextFile).toHaveBeenCalledWith('a.ts', edits, lease, '/repo', scope)

    const request = { requestId: 'r1', operations: [] }
    await env.workspace.applyChanges(request, lease, scope)
    expect(mocks.applyWorkspaceChanges).toHaveBeenCalledWith(request, lease, '/repo', scope)

    await env.workspace.restoreTrash('recovery-1', lease, scope)
    expect(mocks.restoreWorkspaceTrash).toHaveBeenCalledWith('recovery-1', lease, '/repo', scope)

    const onProgress = vi.fn()
    await env.workspace.runCommand({ requestId: 'cmd-1', command: 'ls' }, signal, onProgress, lease, scope)
    expect(mocks.runWorkspaceCommand).toHaveBeenCalledWith(
      { requestId: 'cmd-1', command: 'ls' }, signal, onProgress, lease, '/repo', scope,
    )

    await env.workspace.find({ requestId: 'f1', pattern: '*.ts', signal })
    expect(mocks.findWorkspaceFiles).toHaveBeenCalledWith({ requestId: 'f1', pattern: '*.ts', signal, workspacePath: '/repo' })
  })

  it('拒绝未绑定宿主、缺身份或跨会话写入，且不发起原生调用', async () => {
    vi.clearAllMocks()
    for (const sessionId of [undefined, 's1']) {
      const env = createDesktopAgentEnvironment('/repo', sessionId)
      for (const scope of [undefined, { sessionId: 's2', runId: 'r1', toolCallId: 'c1' }]) {
        await expect(env.workspace.createTextFile('n.ts', 'x', 'lease', scope)).rejects.toThrow('审批调用身份')
        await expect(env.workspace.editTextFile('n.ts', [], 'lease', scope)).rejects.toThrow('审批调用身份')
        await expect(env.workspace.applyChanges({ requestId: 'r1', operations: [] }, 'lease', scope)).rejects.toThrow('审批调用身份')
        await expect(env.workspace.restoreTrash('recovery', 'lease', scope)).rejects.toThrow('审批调用身份')
        await expect(env.workspace.runCommand({ requestId: 'r1', command: 'ls' }, signal, undefined, 'lease', scope)).rejects.toThrow('审批调用身份')
      }
    }
    expect(mocks.createWorkspaceTextFile).not.toHaveBeenCalled()
    expect(mocks.editWorkspaceTextFile).not.toHaveBeenCalled()
    expect(mocks.applyWorkspaceChanges).not.toHaveBeenCalled()
    expect(mocks.restoreWorkspaceTrash).not.toHaveBeenCalled()
    expect(mocks.runWorkspaceCommand).not.toHaveBeenCalled()
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

  it('preserves structured platform error codes without parsing message text', async () => {
    const env = createDesktopAgentEnvironment('/repo')
    const cases = [
      ['not_authorized', '任意消息 A'],
      ['not_found', '任意消息 B'],
      ['invalid_path', '任意消息 C'],
      ['timeout', '任意消息 D'],
      ['conflict', '任意消息 E'],
      ['unavailable', '任意消息 F'],
      ['unknown', '任意消息 G'],
    ] as const
    for (const [code, message] of cases) {
      mocks.getRuntimeInfo.mockRejectedValueOnce({ code, message })
      await expect(env.runtime.getInfo()).rejects.toMatchObject({
        code,
        message,
        name: 'AgentEnvironmentError',
      })
    }
  })

  it('does not infer error codes from localized legacy strings', async () => {
    const env = createDesktopAgentEnvironment('/repo')
    const messages = [
      '文件未授权',
      'failed to inspect workspace directory: No such file or directory',
      'sha256 校验失败',
    ]
    for (const message of messages) {
      mocks.getRuntimeInfo.mockRejectedValueOnce(new Error(message))
      await expect(env.runtime.getInfo()).rejects.toMatchObject({
        code: 'unknown',
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

  describe('浏览器只读通道与图片 Artifact', () => {
    beforeEach(() => {
      mocks.browserCommand.mockReset()
      mocks.notifyBrowserAgentActivity.mockReset()
      mocks.writeImageArtifact.mockReset()
    })

    it('转发只读浏览器命令，并只在成功返回后通知面板', async () => {
      const response = { type: 'tabs', tabs: [] }
      mocks.browserCommand.mockResolvedValueOnce(response)
      const env = createDesktopAgentEnvironment('/repo')
      await expect(env.browser.command({ action: 'tabs' })).resolves.toEqual(response)
      expect(mocks.browserCommand).toHaveBeenCalledWith({ action: 'tabs' })
      expect(mocks.notifyBrowserAgentActivity).toHaveBeenCalledWith({ action: 'tabs' }, response)
    })

    it('浏览器命令失败时映射结构化错误码且不通知面板', async () => {
      mocks.browserCommand.mockRejectedValueOnce({ code: 'unavailable', message: '浏览器未运行' })
      const env = createDesktopAgentEnvironment('/repo')
      await expect(env.browser.command({ action: 'snapshot', tabId: 'tab-1' })).rejects.toMatchObject({
        code: 'unavailable',
        message: '浏览器未运行',
        name: 'AgentEnvironmentError',
      })
      expect(mocks.notifyBrowserAgentActivity).not.toHaveBeenCalled()
    })

    it('委派图片 Artifact 写入（F0-2 平台入口的 Agent 面）', async () => {
      mocks.writeImageArtifact.mockResolvedValueOnce({ kind: 'image', sha256: 'abc', sizeBytes: 5 })
      const env = createDesktopAgentEnvironment('/repo')
      const request = { contentBase64: 'iVBORw0KGgo=', mediaType: 'image/png' }
      await expect(env.artifacts.writeImage(request))
        .resolves.toEqual({ kind: 'image', sha256: 'abc', sizeBytes: 5 })
      expect(mocks.writeImageArtifact).toHaveBeenCalledWith(request)
    })
  })
})
