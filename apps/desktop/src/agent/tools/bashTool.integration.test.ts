import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 完全访问 Bash 的跨层执行结果契约集成测试。
 *
 * 这里只替换最外层 IPC 接缝（`@tauri-apps/api` 与 `isTauriRuntime`），其余全部走
 * 真实实现：`bashTool.execute` → `desktopAgentEnvironment` → `runWorkspaceCommand`
 * 事件归并。假宿主按 Rust `run_workspace_command` 的真实事件序列回放（chunk 事件
 * 不携带 `sandboxed`，done 事件携带），并像真宿主一样「执行一次命令、记一次副作用」，
 * 从而把「命令已执行却被报失败 → 模型重试 → 副作用执行两次」这条跨层缺陷钉死在
 * 回归里。
 */

type HostPayload = {
  requestId: string
  stream?: 'stdout' | 'stderr'
  chunk?: number[]
  done: boolean
  exitCode?: number
  durationMs?: number
  stdoutBytes?: number
  stderrBytes?: number
  truncated?: boolean
  cancelled?: boolean
  timedOut?: boolean
  sandboxed?: boolean
}

const mocks = vi.hoisted(() => {
  const state = {
    handler: undefined as ((event: { payload: HostPayload }) => void) | undefined,
    unlisten: undefined as (() => void) | undefined,
    invocations: [] as Array<{ command: string; request: { requestId: string; command: string } }>,
    cancellations: [] as string[],
  }
  return {
    state,
    invoke: vi.fn(),
    listen: vi.fn(),
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('@/platform/environment', () => ({ isTauriRuntime: () => true }))

import { bindAgentEnvironment } from '@/agent/environment/agentEnvironmentHost'
import type { JsonValue } from '@/agent/core/types'
import { createDesktopAgentEnvironment } from '@/platform/desktopAgentEnvironment'
import { bashTool } from './bashTool'

const encode = (value: string): number[] => Array.from(new TextEncoder().encode(value))

/** 假宿主：真实执行一次命令并回放 Rust 事件序列，`sandboxed` 由调用方指定。 */
const installHost = (options: { sandboxed: boolean; stdout?: string; exitCode?: number }) => {
  const sideEffects: string[] = []
  mocks.listen.mockImplementation(async (_event: string, handler: (event: { payload: HostPayload }) => void) => {
    mocks.state.handler = handler
    return () => undefined
  })
  mocks.invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === 'cancel_workspace_command') {
      mocks.state.cancellations.push(String((args as { requestId?: string }).requestId ?? ''))
      return false
    }
    expect(command).toBe('run_workspace_command')
    const request = (args as { request: { requestId: string; command: string } }).request
    mocks.state.invocations.push({ command, request })
    // 副作用只记录一次：真宿主同样只为每条命令派生一次进程。
    sideEffects.push(request.command)
    const stdout = options.stdout ?? ''
    mocks.state.handler?.({
      payload: {
        requestId: request.requestId,
        stream: 'stdout',
        chunk: encode(stdout),
        done: false,
      },
    })
    mocks.state.handler?.({
      payload: {
        requestId: request.requestId,
        done: true,
        exitCode: options.exitCode ?? 0,
        durationMs: 42,
        stdoutBytes: encode(stdout).length,
        stderrBytes: 0,
        truncated: false,
        cancelled: false,
        timedOut: false,
        sandboxed: options.sandboxed,
      },
    })
    return null
  })
  return { sideEffects }
}

const execute = (
  approvalSource: 'automatic' | 'interactive',
  overrides: { input?: JsonValue } = {},
) => {
  bindAgentEnvironment(createDesktopAgentEnvironment('/workspace/axiom', 'session-1'))
  return bashTool.execute(overrides.input ?? { command: 'npm install lodash', network: true }, {
    sessionId: 'session-1',
    runId: 'run-1',
    toolCallId: 'tool-1',
    approvalLease: 'lease-1',
    approvalSource,
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
  })
}

describe('bash 跨层执行结果契约（真实 platform 栈 + 假 IPC 宿主）', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.listen.mockReset()
    mocks.state.handler = undefined
    mocks.state.invocations = []
    mocks.state.cancellations = []
  })

  it('完全访问下接受无沙箱结果，如实上报执行边界且副作用只执行一次', async () => {
    const host = installHost({ sandboxed: false, stdout: 'added 1 package\n' })

    const result = await execute('automatic')

    expect(result.content).toContain('Execution boundary: Host access (OS sandbox disabled)')
    expect(result.content).toContain('Network policy: Unrestricted')
    expect(result.content).toContain('added 1 package')
    expect(result.details).toMatchObject({ sandboxed: false, executionPolicy: 'Unrestricted' })
    // 命令已真实执行：不能因为无沙箱就报失败（否则模型会重试，副作用执行两次）。
    expect(host.sideEffects).toEqual(['npm install lodash'])
    expect(mocks.state.invocations).toHaveLength(1)
    expect(mocks.state.cancellations).toEqual([])
  })

  it('标准模式收到无沙箱结果时 fail-closed，不把已执行的命令当成功回灌', async () => {
    const host = installHost({ sandboxed: false })

    await expect(execute('interactive')).rejects.toThrow('命令结果缺少 OS 沙箱保护')

    // 契约违例被显式暴露；宿主侧仍只执行了一次，重试与否由上层决定而非被静默吞掉。
    expect(host.sideEffects).toEqual(['npm install lodash'])
    expect(mocks.state.invocations).toHaveLength(1)
  })

  it('标准模式沙箱内结果照常成功并上报沙箱边界', async () => {
    installHost({ sandboxed: true, stdout: 'ok\n' })

    const result = await execute('interactive', { input: { command: 'npm test' } })

    expect(result.content).toContain('Execution boundary: OS sandbox')
    expect(result.content).toContain('Network policy: LoopbackOnly')
    expect(result.details).toMatchObject({ sandboxed: true, executionPolicy: 'LoopbackOnly' })
  })
})
