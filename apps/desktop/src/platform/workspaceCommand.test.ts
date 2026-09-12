import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelWorkspaceCommand,
  runWorkspaceCommand,
  type WorkspaceCommandPayload,
} from './workspaceCommand'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  handler: undefined as ((event: { payload: WorkspaceCommandPayload }) => void) | undefined,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('./environment', () => ({ isTauriRuntime: () => true }))

const textEncoder = new TextEncoder()
const bytes = (value: string): number[] => Array.from(textEncoder.encode(value))

/** 安装 listen 并返回手动派发 payload 的能力。 */
const installListener = (): void => {
  mocks.listen.mockImplementation(async (_eventName, handler) => {
    mocks.handler = handler
    return mocks.unlisten
  })
}

const baseRequest = { requestId: 'command-1', command: 'echo hi' }

describe('workspace command IPC', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.listen.mockReset()
    mocks.unlisten.mockReset()
    mocks.handler = undefined
    mocks.invoke.mockResolvedValue(undefined)
  })

  it('forwards the approval lease with the command request', async () => {
    mocks.listen.mockImplementation(async (_eventName, handler) => {
      queueMicrotask(() => handler({
        payload: {
          requestId: 'command-1',
          done: true,
          exitCode: 0,
          durationMs: 12,
          stdoutBytes: 0,
          stderrBytes: 0,
        },
      }))
      return mocks.unlisten
    })
    const request = {
      requestId: 'command-1',
      command: 'npm run typecheck',
    }

    await expect(runWorkspaceCommand(
      request,
      new AbortController().signal,
      undefined,
      'lease-command',
    )).resolves.toMatchObject({ exitCode: 0, durationMs: 12 })
    expect(mocks.invoke).toHaveBeenCalledWith('run_workspace_command', {
      request,
      approvalLease: 'lease-command',
    })
    expect(mocks.unlisten).toHaveBeenCalledOnce()
  })

  it('accumulates stdout/stderr chunks, reports byte progress and decodes on done', async () => {
    installListener()
    const onProgress = vi.fn()
    const run = runWorkspaceCommand(baseRequest, new AbortController().signal, onProgress, 'lease')
    await vi.waitFor(() => expect(mocks.handler).toBeTypeOf('function'))

    mocks.handler?.({
      payload: {
        requestId: 'command-1',
        stream: 'stdout',
        chunk: bytes('hello '),
        done: false,
      },
    })
    mocks.handler?.({
      payload: {
        requestId: 'command-1',
        stream: 'stderr',
        chunk: bytes('warn'),
        done: false,
      },
    })
    mocks.handler?.({
      payload: {
        requestId: 'command-1',
        stream: 'stdout',
        chunk: bytes('world'),
        done: true,
        exitCode: 0,
        durationMs: 5,
      },
    })

    const result = await run
    expect(result.stdout).toBe('hello world')
    expect(result.stderr).toBe('warn')
    expect(result.exitCode).toBe(0)
    expect(result.cancelled).toBe(false)
    expect(result.timedOut).toBe(false)
    expect(result.truncated).toBe(false)
    // onProgress 至少被 stdout/stderr 各调用一次,字节计数累加
    expect(onProgress).toHaveBeenCalled()
    const lastStdout = onProgress.mock.calls.at(-1)![0]
    expect(lastStdout.capturedStdoutBytes).toBeGreaterThanOrEqual(6)
  })

  it('throws when a payload carries an error string', async () => {
    installListener()
    const run = runWorkspaceCommand(baseRequest, new AbortController().signal, undefined, 'lease')
    await vi.waitFor(() => expect(mocks.handler).toBeTypeOf('function'))

    mocks.handler?.({
      payload: { requestId: 'command-1', done: true, error: 'spawn failed' },
    })

    await expect(run).rejects.toThrow('spawn failed')
    expect(mocks.unlisten).toHaveBeenCalledOnce()
  })

  it('maps run_workspace_command invoke rejection into a thrown error', async () => {
    installListener()
    mocks.invoke.mockImplementation((command: string) =>
      command === 'run_workspace_command'
        ? Promise.reject(new Error('backend rejected'))
        : Promise.resolve(false),
    )
    const run = runWorkspaceCommand(baseRequest, new AbortController().signal, undefined, 'lease')
    await vi.waitFor(() => expect(mocks.handler).toBeTypeOf('function'))

    await expect(run).rejects.toThrow('backend rejected')
  })

  it('aborts mid-flight: pushes cancelled terminal payload and calls cancel command', async () => {
    installListener()
    mocks.invoke.mockImplementation((command: string) =>
      command === 'cancel_workspace_command' ? Promise.resolve(true) : Promise.resolve(undefined),
    )
    const controller = new AbortController()
    const run = runWorkspaceCommand(baseRequest, controller.signal, undefined, 'lease')
    await vi.waitFor(() => expect(mocks.handler).toBeTypeOf('function'))

    controller.abort()
    await expect(run).rejects.toThrow()

    expect(mocks.invoke).toHaveBeenCalledWith('cancel_workspace_command', {
      requestId: 'command-1',
    })
  })

  it('propagates timedOut / truncated flags from the terminal payload', async () => {
    installListener()
    const run = runWorkspaceCommand(baseRequest, new AbortController().signal, undefined, 'lease')
    await vi.waitFor(() => expect(mocks.handler).toBeTypeOf('function'))

    mocks.handler?.({
      payload: {
        requestId: 'command-1',
        done: true,
        exitCode: null as unknown as number | undefined,
        durationMs: 3000,
        stdoutBytes: 0,
        stderrBytes: 0,
        timedOut: true,
        truncated: true,
      },
    })

    const result = await run
    expect(result.timedOut).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it('forwards optional workspacePath into the run_workspace_command invoke args', async () => {
    installListener()
    const run = runWorkspaceCommand(
      baseRequest,
      new AbortController().signal,
      undefined,
      'lease',
      '/repo',
    )
    await vi.waitFor(() => expect(mocks.handler).toBeTypeOf('function'))
    mocks.handler?.({
      payload: { requestId: 'command-1', done: true, exitCode: 0, durationMs: 1 },
    })
    await run

    expect(mocks.invoke).toHaveBeenCalledWith('run_workspace_command', {
      request: baseRequest,
      approvalLease: 'lease',
      workspacePath: '/repo',
    })
  })
})

describe('cancelWorkspaceCommand', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue(true)
  })

  it('invokes cancel_workspace_command with the requestId', async () => {
    await expect(cancelWorkspaceCommand('command-9')).resolves.toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith('cancel_workspace_command', {
      requestId: 'command-9',
    })
  })
})
