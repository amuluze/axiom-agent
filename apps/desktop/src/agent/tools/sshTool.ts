import type { AgentTool, JsonValue } from '@/agent/core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { DANGEROUS_COMMAND_MARKERS } from './bashTool'
import { hasOnlyKeys, isJsonObject, optionalInteger } from './workspaceToolUtils'

/** 镜像 Rust `ssh_agent.rs` 的输入上限（schema 层上限，Rust 权威复验）。 */
export const SSH_MAX_HOST_CHARS = 255
export const SSH_MAX_COMMAND_CHARS = 64 * 1024
export const SSH_DEFAULT_TIMEOUT_MS = 60_000
export const SSH_MAX_TIMEOUT_MS = 600_000

const TRUNCATED_PREVIEW_LENGTH = 240

const truncateForDisplay = (text: string): string =>
  text.length > TRUNCATED_PREVIEW_LENGTH ? `${text.slice(0, TRUNCATED_PREVIEW_LENGTH)}…` : text

const asSshInput = (input: JsonValue): { host: string; command: string; timeoutMs?: number } => {
  const record = isJsonObject(input) ? input : {}
  return {
    host: typeof record.host === 'string' ? record.host : '',
    command: typeof record.command === 'string' ? record.command : '',
    timeoutMs: typeof record.timeoutMs === 'number' ? record.timeoutMs : undefined,
  }
}

const validateSshInput = (input: JsonValue): string | undefined => {
  if (!isJsonObject(input)) return 'Arguments must be an object.'
  if (!hasOnlyKeys(input, ['host', 'command', 'timeoutMs'])) {
    return 'Arguments may only include: host, command, timeoutMs.'
  }
  const host = typeof input.host === 'string' ? input.host : ''
  const command = typeof input.command === 'string' ? input.command : ''
  if (!host.trim()) return 'host is required.'
  if (host.trim().length > SSH_MAX_HOST_CHARS) {
    return `host must be at most ${SSH_MAX_HOST_CHARS} characters.`
  }
  if (host.trim().startsWith('-')) return 'host must not start with "-".'
  if (/\s/.test(host.trim())) return 'host must not contain whitespace.'
  if (!command.trim()) return 'command is required.'
  if (command.length > SSH_MAX_COMMAND_CHARS) {
    return `command must be at most ${SSH_MAX_COMMAND_CHARS} characters.`
  }
  if (!optionalInteger(input.timeoutMs, 1, SSH_MAX_TIMEOUT_MS)) {
    return `timeoutMs must be an integer between 1 and ${SSH_MAX_TIMEOUT_MS}.`
  }
  return undefined
}

const renderExecResult = (result: {
  exitCode?: number | null
  stdout: string
  stderr: string
  truncated: boolean
  durationMs: number
  timedOut: boolean
}): string => {
  const parts: string[] = []
  if (result.timedOut) {
    parts.push('⚠️ 执行超时：本地 ssh 进程已被终止，远端命令可能仍在运行。')
  }
  parts.push(`exit code: ${result.exitCode ?? '(无——被信号终止或连接失败)'}`)
  parts.push(`duration: ${(result.durationMs / 1000).toFixed(1)}s`)
  if (result.stdout) parts.push(`--- stdout ---\n${result.stdout}`)
  if (result.stderr) parts.push(`--- stderr ---\n${result.stderr}`)
  if (result.truncated) {
    parts.push('⚠️ 输出超过 2 MiB 上限被截断：请用更窄的命令（如管道到 tail/grep）重试。')
  }
  return parts.join('\n')
}

/**
 * SSH 远程执行工具：对已登记主机（config 别名或注册表 hostId，经 ssh_hosts 发现）
 * 执行一次性远程命令。逐次审批 + 会话内主机授权（首连原生三选一）；lease 绑定
 * {host, command}；超时（默认 60s/上限 10min）与 2 MiB 输出上限由 Rust 强制；
 * stdout/stderr 经凭据脱敏后交付。
 */
export const createSshTool = (environment: AgentEnvironment): AgentTool => ({
  name: 'ssh',
  label: 'ssh',
  promptSnippet:
    '通过 SSH 在远程主机上执行一次性命令（非交互）：使用 ~/.ssh/config 与 Axiom 主机注册表里已登记的主机，适合部署、查看远程状态、日志排查等跨机操作。',
  promptGuidelines: [
    'host 只接受 ssh_hosts 清单里的标识（config 别名或注册表 hostId），不能传任意 IP/URL；不确定目标时先调用 ssh_hosts。',
    '连接与认证由宿主进程用你的 SSH 配置完成（密钥/密码不进入上下文）；远程命令应为非交互命令（无密码/确认提示），交互式程序不会得到响应。',
    '首个命令会请求用户批准（原生对话框可选「本会话内允许该主机」，选择后同主机后续命令免打扰）；用户拒绝时停止在该主机上的操作并向用户说明。',
    '命令超时默认 60 秒（可用 timeoutMs 调整，上限 10 分钟）、输出上限 2 MiB；大输出用 tail/grep 收窄。主机密钥首次信任（accept-new）、变更会拒绝。',
  ],
  // v2：共享源文件 bashTool.ts 的审批语义变化（bash 出网取消二次原生确认）触发
  // 语义审计重绑——ssh 工具自身 schema/行为不变，仅随审计契约 bump。
  runtimeVersion: '2',
  recoveryPolicy: 'never',
  requiresApproval: true,
  executionMode: 'sequential',
  description:
    'Execute a one-shot non-interactive command on a registered remote host over SSH (aliases from ~/.ssh/config or Axiom host registry). Per-command approval with session-scoped host remember; 60s default timeout (max 10min, timeoutMs), 2 MiB output cap, credential-redacted stdout/stderr.',
  inputSchema: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        description: `目标主机标识：~/.ssh/config 的 Host 别名或 ssh_hosts 清单里的注册表 hostId（至多 ${SSH_MAX_HOST_CHARS} 字符，不含空白）。`,
      },
      command: {
        type: 'string',
        description: `要在远程主机执行的非交互命令（经远端默认 shell 解释，至多 ${SSH_MAX_COMMAND_CHARS} 字符）。`,
      },
      timeoutMs: {
        type: 'number',
        description: `可选超时（毫秒，1..${SSH_MAX_TIMEOUT_MS}，默认 ${SSH_DEFAULT_TIMEOUT_MS}）；超时会终止本地 ssh 进程。`,
      },
    },
    required: ['host', 'command'],
    additionalProperties: false,
  },
  validate: (input) => {
    const error = validateSshInput(input)
    return error ? { ok: false, error } : { ok: true, value: input }
  },
  resolveTier: () => 'networkRequired',
  approvalPresentation: (input) => {
    const { host, command, timeoutMs } = asSshInput(input)
    const preview = truncateForDisplay(command)
    const dangerous = DANGEROUS_COMMAND_MARKERS.test(command)
    const dangerNote = dangerous
      ? '\n\n⚠️ 危险命令：包含 sudo / 删除 / 外传 / 磁盘写入等高风险关键字，且将在远程主机上执行，请仔细确认'
      : ''
    return {
      category: 'workspace-command',
      title: 'SSH 远程执行命令？',
      description:
        '该命令将使用你的 SSH 配置与凭据在远程主机上执行（宿主进程发起，非沙箱）。批准仅对本次主机+命令有效；首次批准时可在系统对话框选择「本会话内允许该主机」。',
      path: host,
      preview: `ssh ${host} -- ${preview}${
        timeoutMs !== undefined ? `\n\ntimeout: ${(timeoutMs / 1000).toFixed(1)}s` : ''
      }${dangerNote}`,
      danger: dangerous,
    }
  },
  execute: async (input, context) => {
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (!context.approvalLease) {
      throw new Error('Missing workspace approval lease.')
    }
    const { host, command, timeoutMs } = asSshInput(input)
    const response = await environment.ssh.command(
      {
        action: 'exec',
        sessionId: context.sessionId,
        host: host.trim(),
        command,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
      { approvalLease: context.approvalLease },
    )
    if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (response.type !== 'exec') {
      throw new Error('SSH 执行响应类型不符合预期')
    }
    return {
      content: renderExecResult(response),
      details: {
        exitCode: response.exitCode ?? null,
        stdout: response.stdout,
        stderr: response.stderr,
        truncated: response.truncated,
        durationMs: response.durationMs,
        timedOut: response.timedOut,
      },
    }
  },
})
