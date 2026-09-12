import { describe, expect, it } from 'vitest'
import type { AgentToolExecutionContext } from '@/agent/core/types'
import type {
  SshAgentCommandRequest,
  SshAgentCommandResponse,
} from '@/agent/environment/AgentEnvironment'
import { createFakeAgentEnvironment } from './__fixtures__/fakeAgentEnvironment'
import { createSshTool, SSH_MAX_COMMAND_CHARS } from './sshTool'

const baseContext = (overrides: Partial<AgentToolExecutionContext> = {}): AgentToolExecutionContext => ({
  sessionId: 'session-1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  approvalLease: 'lease-token',
  signal: new AbortController().signal,
  reportProgress: async () => undefined,
  ...overrides,
})

const execResponse: SshAgentCommandResponse = {
  type: 'exec',
  exitCode: 0,
  stdout: 'ok',
  stderr: '',
  truncated: false,
  durationMs: 1200,
  timedOut: false,
}

describe('sshTool validate', () => {
  const tool = createSshTool(createFakeAgentEnvironment())

  it('accepts host + command with optional timeoutMs', () => {
    expect(tool.validate({ host: 'prod', command: 'uptime' }).ok).toBe(true)
    expect(tool.validate({ host: 'prod', command: 'uptime', timeoutMs: 5000 }).ok).toBe(true)
  })

  it('rejects malformed host references (option-injection surface)', () => {
    expect(tool.validate({ host: '', command: 'uptime' }).ok).toBe(false)
    expect(tool.validate({ host: '-oProxyCommand=x', command: 'uptime' }).ok).toBe(false)
    expect(tool.validate({ host: 'has space', command: 'uptime' }).ok).toBe(false)
    expect(tool.validate({ command: 'uptime' }).ok).toBe(false)
    expect(tool.validate({ host: 'prod', command: '' }).ok).toBe(false)
    expect(tool.validate({ host: 'prod' }).ok).toBe(false)
    expect(
      tool.validate({ host: 'prod', command: 'x'.repeat(SSH_MAX_COMMAND_CHARS + 1) }).ok,
    ).toBe(false)
    // 超时边界：0 / 负数 / 超上限拒绝。
    expect(tool.validate({ host: 'prod', command: 'uptime', timeoutMs: 0 }).ok).toBe(false)
    expect(tool.validate({ host: 'prod', command: 'uptime', timeoutMs: 600_001 }).ok).toBe(false)
    // 未知参数拒绝（schema 附加属性封闭）。
    expect(tool.validate({ host: 'prod', command: 'uptime', extra: true }).ok).toBe(false)
  })
})

describe('sshTool contract flags', () => {
  const tool = createSshTool(createFakeAgentEnvironment())

  it('逐次审批 + 顺序执行 + 崩溃不重放（远程副作用）', () => {
    expect(tool.name).toBe('ssh')
    expect(tool.requiresApproval).toBe(true)
    expect(tool.executionMode).toBe('sequential')
    expect(tool.recoveryPolicy).toBe('never')
    expect(tool.runtimeVersion).toBe('1')
  })

  it('approvalPresentation 展示主机+命令并标记危险关键字', () => {
    const tool = createSshTool(createFakeAgentEnvironment())
    const presentation = tool.approvalPresentation?.({ host: 'prod', command: 'sudo rm -rf /tmp/x' })
    expect(presentation?.category).toBe('workspace-command')
    expect(presentation?.title).toContain('SSH 远程执行')
    expect(presentation?.preview).toContain('ssh prod --')
    expect(presentation?.preview).toContain('sudo')
    expect(presentation?.danger).toBe(true)
    const benign = tool.approvalPresentation?.({
      host: 'prod',
      command: 'uptime',
      timeoutMs: 30000,
    })
    expect(benign?.danger).toBe(false)
    expect(benign?.preview).toContain('timeout: 30.0s')
  })
})

describe('sshTool execute', () => {
  it('缺少审批租赁时拒绝执行（与 bash 工具同一硬前置）', async () => {
    const tool = createSshTool(createFakeAgentEnvironment())
    await expect(
      tool.execute({ host: 'prod', command: 'uptime' }, baseContext({ approvalLease: undefined })),
    ).rejects.toThrow('approval lease')
  })

  it('携带 sessionId 与租赁调用 ssh 通道并渲染执行结果', async () => {
    const seen: Array<{ request: SshAgentCommandRequest; lease?: string }> = []
    const environment = createFakeAgentEnvironment({
      sshAgentCommand: async (request, options) => {
        seen.push({ request, lease: options?.approvalLease })
        return execResponse
      },
    })
    const tool = createSshTool(environment)
    const result = await tool.execute(
      { host: ' prod ', command: 'uptime', timeoutMs: 30_000 },
      baseContext(),
    )
    expect(seen).toEqual([
      {
        request: {
          action: 'exec',
          sessionId: 'session-1',
          host: 'prod',
          command: 'uptime',
          timeoutMs: 30_000,
        },
        lease: 'lease-token',
      },
    ])
    expect(result.content).toContain('exit code: 0')
    expect(result.content).toContain('ok')
    expect(result.content).toContain('duration: 1.2s')
  })

  it('超时与截断在结果中如实呈现', async () => {
    const environment = createFakeAgentEnvironment({
      sshAgentCommand: async () => ({
        type: 'exec',
        exitCode: null,
        stdout: '',
        stderr: 'killed',
        truncated: true,
        durationMs: 60_000,
        timedOut: true,
      }),
    })
    const tool = createSshTool(environment)
    const result = await tool.execute({ host: 'prod', command: 'sleep 1h' }, baseContext())
    expect(result.content).toContain('执行超时')
    expect(result.content).toContain('2 MiB')
    expect(result.content).toContain('killed')
  })

  it('环境错误原样上抛（运行时标记 isError）', async () => {
    const environment = createFakeAgentEnvironment({
      sshAgentCommand: async () => {
        throw new Error('主机「ghost」未在 SSH 配置（~/.ssh/config）或 Axiom 主机注册表中登记')
      },
    })
    const tool = createSshTool(environment)
    await expect(tool.execute({ host: 'ghost', command: 'uptime' }, baseContext()))
      .rejects.toThrow('未在 SSH 配置')
  })
})
