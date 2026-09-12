import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runWorkspaceCommand: vi.fn(),
}))

vi.mock('@/platform/workspaceCommand', () => ({
  runWorkspaceCommand: mocks.runWorkspaceCommand,
}))

import { bashTool, validateBashInput } from './bashTool'
import {
  bindAgentEnvironment,
} from '@/agent/environment/agentEnvironmentHost'
import type { RuntimeInfo } from '@/platform/runtimeInfo'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'

// 接缝代理（desktopAgentEnvironment）未 bind 时 fail-closed，绕过 @/platform/workspaceCommand
// 的 mock。测试显式绑定一个把 runCommand 指向 mock 的宿主，保持与旧 platform 单例行为一致。
bindAgentEnvironment({
  runtime: { getInfo: vi.fn(async () => ({ mode: 'desktop' as const, capabilities: [] as string[] }) as unknown as RuntimeInfo) },
  authorizedFiles: { list: vi.fn(async () => []), readText: vi.fn() },
  workspace: {
    list: vi.fn(),
    readText: vi.fn(),
    searchText: vi.fn(),
    createTextFile: vi.fn(),
    editTextFile: vi.fn(),
    applyChanges: vi.fn(),
    restoreTrash: vi.fn(),
    // 注入 workspacePath（undefined，与旧 platform 单例行为一致：mock 收到 5 参）
    runCommand: ((request: unknown, signal: unknown, onProgress: unknown, approvalLease: unknown) =>
      mocks.runWorkspaceCommand(request, signal, onProgress, approvalLease, undefined)) as unknown as AgentEnvironment['workspace']['runCommand'],
    find: vi.fn(),
  },
  artifacts: { writeToolResult: vi.fn() },
  web: { search: vi.fn(), fetch: vi.fn() },
  browser: { command: vi.fn() },
  computer: { command: vi.fn() },
  ssh: { command: vi.fn() },

})

describe('validateBashInput', () => {
  it('accepts a valid command string', () => {
    expect(validateBashInput({ command: 'echo hello' })).toBeNull()
    expect(validateBashInput({ command: 'git status --short' })).toBeNull()
    expect(validateBashInput({ command: 'npm test -- --coverage' })).toBeNull()
    expect(validateBashInput({ command: 'cargo check --locked' })).toBeNull()
  })

  it('accepts optional cwd and timeout', () => {
    expect(validateBashInput({
      command: 'ls',
      cwd: 'src',
    })).toBeNull()
    expect(validateBashInput({
      command: 'npm test',
      timeout: 30,
    })).toBeNull()
    expect(validateBashInput({
      command: 'make build',
      cwd: 'subdir',
      timeout: 300,
    })).toBeNull()
  })

  it('rejects empty command', () => {
    expect(validateBashInput({ command: '' })).toMatch(/non-empty/)
    expect(validateBashInput({ command: '   ' })).toMatch(/non-empty/)
  })

  it('rejects missing command', () => {
    expect(validateBashInput({ cwd: 'src' })).not.toBeNull()
    expect(validateBashInput({})).not.toBeNull()
  })

  it('rejects invalid cwd with parent traversal', () => {
    expect(validateBashInput({
      command: 'ls',
      cwd: '../outside',
    })).toMatch(/without ".."/)
  })

  it('rejects invalid timeout values', () => {
    expect(validateBashInput({
      command: 'ls',
      timeout: 0,
    })).toMatch(/positive/)
    expect(validateBashInput({
      command: 'ls',
      timeout: -1,
    })).toMatch(/positive/)
    expect(validateBashInput({
      command: 'ls',
      timeout: Infinity,
    })).toMatch(/finite/)
  })

  it('rejects extra unknown properties', () => {
    expect(validateBashInput({
      command: 'ls',
      shell: true,
    })).not.toBeNull()
  })

  it('rejects command exceeding 64 KiB', () => {
    const longCommand = 'x'.repeat(64 * 1024 + 1)
    expect(validateBashInput({ command: longCommand })).toMatch(/too long/)
  })

  it('rejects command with null byte', () => {
    expect(validateBashInput({ command: 'ls\0rm' })).toMatch(/null/)
  })

  it('rejects sudo commands including command-context bypasses', () => {
    expect(validateBashInput({ command: 'sudo rm -rf .' })).toMatch(/sudo/)
    expect(validateBashInput({ command: 'sudo -u root whoami' })).toMatch(/sudo/)
    // 反斜杠转义与命令上下文边界（分号 / && / | / 子shell / $()）
    expect(validateBashInput({ command: '\\sudo rm -rf .' })).toMatch(/sudo/)
    expect(validateBashInput({ command: 'git pull ; sudo rm x' })).toMatch(/sudo/)
    expect(validateBashInput({ command: 'git pull && sudo rm x' })).toMatch(/sudo/)
    expect(validateBashInput({ command: 'echo x | sudo tee /etc/hosts' })).toMatch(/sudo/)
    expect(validateBashInput({ command: '( sudo id )' })).toMatch(/sudo/)
    expect(validateBashInput({ command: 'echo $(sudo id)' })).toMatch(/sudo/)
    // 换行分隔符绕过：命令经 /bin/bash -c 执行，换行是合法分隔符，
    // 不能只靠 ^ 行首匹配（无 multiline 标志）拦截。
    expect(validateBashInput({ command: 'echo hi\nsudo whoami' })).toMatch(/sudo/)
  })

  it('does not flag sudo as a plain argument', () => {
    expect(validateBashInput({ command: 'grep sudo package.json' })).toBeNull()
    expect(validateBashInput({ command: 'echo "run sudo as root"' })).toBeNull()
  })

  it('rejects redirects outside the workspace including quoted/variable/noclobber forms', () => {
    expect(validateBashInput({ command: 'echo x > /tmp/out.log' })).toMatch(/重定向/)
    expect(validateBashInput({ command: 'make build >> /var/log/x' })).toMatch(/重定向/)
    expect(validateBashInput({ command: 'cat a > ~/notes' })).toMatch(/重定向/)
    expect(validateBashInput({ command: 'git push &> ../outside' })).toMatch(/重定向/)
    // 引号包裹的绝对路径 / home / 变量
    expect(validateBashInput({ command: 'echo x > "$HOME/out.log"' })).toMatch(/重定向/)
    expect(validateBashInput({ command: "echo x > '~/notes'" })).toMatch(/重定向/)
    expect(validateBashInput({ command: 'echo x > "$(echo /tmp/x)"' })).toMatch(/重定向/)
    // noclobber 与变量/命令替换目标
    expect(validateBashInput({ command: 'echo x >| /tmp/out.log' })).toMatch(/重定向/)
    // 语料需保持字面字符串（被测试输入）：模板内转义 \`\${` 避免插值展开
    expect(validateBashInput({ command: `echo x > \${TMPDIR}/x` })).toMatch(/重定向/)
    expect(validateBashInput({ command: 'echo x > $(echo /tmp/x)' })).toMatch(/重定向/)
    // bash `>&` 文件复制形式（目标非数字即写文件）与 `exec {fd}>` 绝对路径
    expect(validateBashInput({ command: 'echo x >& /tmp/out.log' })).toMatch(/重定向/)
    expect(validateBashInput({ command: 'echo x >&/tmp/out.log' })).toMatch(/重定向/)
    expect(validateBashInput({ command: 'echo x >& ~/notes' })).toMatch(/重定向/)
    expect(validateBashInput({ command: 'echo x 2>& /tmp/out.log' })).toMatch(/重定向/)
    expect(validateBashInput({ command: 'exec {fd}> /tmp/out.log' })).toMatch(/重定向/)
    expect(validateBashInput({ command: 'exec {fd}>/tmp/out.log' })).toMatch(/重定向/)
    // /dev/null 例外必须精确匹配设备名：带后缀的绝对路径仍拒绝
    expect(validateBashInput({ command: 'echo x > /dev/nulla' })).toMatch(/重定向/)
    expect(validateBashInput({ command: 'echo x >/dev/nulldir/x' })).toMatch(/重定向/)
  })

  it('allows workspace-relative redirects and non-redirecting >', () => {
    expect(validateBashInput({ command: 'npm test > coverage.log' })).toBeNull()
    expect(validateBashInput({ command: 'echo x > src/out.txt' })).toBeNull()
    expect(validateBashInput({ command: 'echo x > "src/out.txt"' })).toBeNull()
    expect(validateBashInput({ command: 'printf "a > b"' })).toBeNull()
    // `2>&1` / `>&1` 是 fd 复制而非文件写，`>& out.txt` 写工作区内相对路径，均应放行
    expect(validateBashInput({ command: 'echo x 2>&1' })).toBeNull()
    expect(validateBashInput({ command: 'echo x >&1' })).toBeNull()
    expect(validateBashInput({ command: 'echo x >& out.txt' })).toBeNull()
    // /dev/null 例外：空设备无文件写入，seatbelt 沙箱显式允许；标准 bash 惯用法
    expect(validateBashInput({ command: 'echo x 2>/dev/null' })).toBeNull()
    expect(validateBashInput({ command: 'echo x > /dev/null' })).toBeNull()
    expect(validateBashInput({ command: 'git push &> /dev/null' })).toBeNull()
    expect(validateBashInput({ command: 'cat big.log >/dev/null 2>&1' })).toBeNull()
    expect(validateBashInput({ command: 'echo x > "/dev/null"' })).toBeNull()
  })

  it('accepts command exactly at 64 KiB limit', () => {
    const maxCommand = 'x'.repeat(64 * 1024)
    expect(validateBashInput({ command: maxCommand })).toBeNull()
  })
})

describe('bashTool', () => {
  it('appends sandbox denial summary with network hint when denials are present', async () => {
    mocks.runWorkspaceCommand.mockImplementationOnce(async () => ({
      exitCode: 1,
      durationMs: 100,
      stdoutBytes: 0,
      stderrBytes: 60,
      stdout: '',
      stderr: 'curl: (7) Couldn\'t connect',
      truncated: false,
      cancelled: false,
      timedOut: false,
      sandboxDenials: [
        'network-outbound (remote ip "93.184.216.34:80") (×3)',
        'file-read-metadata /Users/x/.npmrc',
      ],
    }))
    const controller = new AbortController()
    const result = await bashTool.execute(
      { command: 'curl https://example.com', network: true },
      {
        sessionId: 'session-1',
        runId: 'run-1',
        toolCallId: 'tool-1',
        signal: controller.signal,
        reportProgress: async () => undefined,
        approvalLease: 'lease-1',
      },
    )
    expect(result.content).toContain('Sandbox denials')
    expect(result.content).toContain('- network-outbound (remote ip "93.184.216.34:80") (×3)')
    expect(result.content).toContain('- file-read-metadata /Users/x/.npmrc')
    // 网络类 deny 追加 network: true 重试提示
    expect(result.content).toContain('retry with network: true')
  })

  it('flags degraded execution when the command ran without sandboxing', async () => {
    mocks.runWorkspaceCommand.mockImplementationOnce(async () => ({
      exitCode: 0,
      durationMs: 100,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      cancelled: false,
      timedOut: false,
      sandboxed: false,
    }))
    const controller = new AbortController()
    const result = await bashTool.execute(
      { command: 'npm install lodash', network: true },
      {
        sessionId: 'session-1',
        runId: 'run-1',
        toolCallId: 'tool-1',
        signal: controller.signal,
        reportProgress: async () => undefined,
        approvalLease: 'lease-1',
      },
    )
    expect(result.content).toContain('Sandbox unavailable (degraded execution)')
    expect(result.content).toContain('WITHOUT sandboxing')
    expect((result.details as { sandboxed?: boolean } | null)?.sandboxed).toBe(false)
  })

  it('streams byte-count progress and returns structured stdout/stderr metadata', async () => {
    mocks.runWorkspaceCommand.mockImplementationOnce(async (_request, _signal, onProgress) => {
      onProgress?.({ stream: 'stdout', capturedStdoutBytes: 40_000, capturedStderrBytes: 0 })
      return {
        exitCode: 1,
        durationMs: 250,
        stdoutBytes: 40_000,
        stderrBytes: 12,
        stdout: 'tests started',
        stderr: 'one failure',
        truncated: false,
        cancelled: false,
        timedOut: false,
      }
    })
    const reportProgress = vi.fn(async () => undefined)
    const controller = new AbortController()
    const result = await bashTool.execute({
      command: 'npm test',
      cwd: '.',
      timeout: 60,
    }, {
      sessionId: 'session-1',
      runId: 'run-1',
      toolCallId: 'tool-1',
      signal: controller.signal,
      reportProgress,
      approvalLease: 'lease-1',
    })

    expect(mocks.runWorkspaceCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'npm test',
      cwd: '.',
      timeoutMs: 60_000,
    }), controller.signal, expect.any(Function), 'lease-1', undefined)
    expect(reportProgress).toHaveBeenCalledTimes(2)
    expect(result.content).toContain('Exit code: 1')
    expect(result.content).toContain('STDOUT:\ntests started')
    expect(result.content).toContain('STDERR:\none failure')
    expect(result.content).not.toContain('Sandbox denials')
    expect(result.details).toMatchObject({
      cwd: '.',
      exitCode: 1,
      stdoutBytes: 40_000,
      stderrBytes: 12,
    })
  })

  it('marks timed-out and truncated output for the model', async () => {
    mocks.runWorkspaceCommand.mockResolvedValueOnce({
      exitCode: undefined,
      durationMs: 1_000,
      stdoutBytes: 3_000_000,
      stderrBytes: 0,
      stdout: 'partial',
      stderr: '',
      truncated: true,
      cancelled: false,
      timedOut: true,
    })
    const result = await bashTool.execute({
      command: 'cargo check',
      timeout: 1,
    }, {
      sessionId: 'session-1',
      runId: 'run-1',
      toolCallId: 'tool-1',
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
      approvalLease: 'lease-1',
    })

    expect(result.content).toContain('Status: timed out')
    expect(result.content).toContain('truncated')
  })

  it('works without optional timeout', async () => {
    mocks.runWorkspaceCommand.mockResolvedValueOnce({
      exitCode: 0,
      durationMs: 100,
      stdoutBytes: 10,
      stderrBytes: 0,
      stdout: 'hello',
      stderr: '',
      truncated: false,
      cancelled: false,
      timedOut: false,
    })
    const result = await bashTool.execute({
      command: 'echo hello',
    }, {
      sessionId: 'session-1',
      runId: 'run-1',
      toolCallId: 'tool-1',
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
      approvalLease: 'lease-1',
    })

    expect(mocks.runWorkspaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: undefined }),
      expect.any(AbortSignal),
      expect.any(Function),
      'lease-1',
      undefined,
    )
    expect(result.content).toContain('hello')
  })

  it('redacts full command from audit arguments', () => {
    const command = 'curl -X POST https://secret.example.com --data "sensitive"'
    expect(bashTool.auditArguments?.({
      command,
      cwd: '.',
      timeout: 30,
    })).toEqual({
      commandPreview: command,
      commandLength: command.length,
      cwd: '.',
      timeoutMs: 30_000,
    })
  })

  it('approval presentation shows preview of command', () => {
    const presentation = bashTool.approvalPresentation?.({
      command: 'npm test -- --coverage --verbose',
      cwd: 'apps/desktop',
      timeout: 120,
    })
    expect(presentation?.title).toBe('Run bash command?')
    expect(presentation?.preview).toContain('npm test -- --coverage --verbose')
    expect(presentation?.preview).toContain('timeout: 120.0s')
    expect(presentation?.path).toBe('apps/desktop')
  })

  it('flags dangerous keywords in the approval presentation without blocking', () => {
    const dangerous = bashTool.approvalPresentation?.({
      command: 'rm -rf node_modules && npm install',
    })
    expect(dangerous?.preview).toContain('⚠️ 危险命令')
    expect(dangerous?.danger).toBe(true)

    // rm 危险变体：合并短 flag 乱序、拆分形式与长 flag 都应被标记
    for (const variant of ['rm -fr build', 'rm -Rf build', 'rm -r -f build', 'rm --recursive --force build']) {
      const presentation = bashTool.approvalPresentation?.({ command: variant })
      expect(presentation?.danger).toBe(true)
    }

    const safe = bashTool.approvalPresentation?.({
      command: 'npm test',
    })
    expect(safe?.preview).not.toContain('⚠️')
    expect(safe?.danger).toBe(false)
  })
})
