import { createId } from '@/agent/core/id'
import type { AgentTool, CommandTier, JsonValue } from '@/agent/core/types'
import type { AgentEnvironment, WorkspaceCommandResult } from '@/agent/environment/AgentEnvironment'
import { desktopAgentEnvironment } from '@/agent/environment/agentEnvironmentHost'
import { hasOnlyKeys, isJsonObject, isSafeRelativePath } from './workspaceToolUtils'

const MAX_TIMEOUT_MS = 2_147_483_647
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000
/** 与 Rust workspace_command.rs 中 64 KiB 上限保持一致，由 bash-policy-audit 强制校验。 */
const MAX_COMMAND_BYTES = 64 * 1024
const textEncoder = new TextEncoder()

/**
 * 自由命令模型的最小安全基线（与 Rust workspace_command.rs 逐字一致，
 * 由 bash-policy-audit 强制）：拒绝 sudo 提升权限与重定向到工作区外。
 * 定位为"减速带"而非安全边界——逐次审批才是主要安全阀。
 * sudo 匹配命令上下文边界（行首 / 换行 / 分号 / && / | / 子shell / $() ），
 * 不匹配 `grep sudo` 这类把 sudo 当普通参数的合法命令。
 * 换行显式纳入分隔符字符类：命令经 /bin/bash -c 执行，`echo hi\nsudo whoami`
 * 中的换行是合法分隔符，若漏掉可绕过行首匹配（`^` 无 multiline 标志）。
 */
const SUDO_COMMAND_PREFIX_PATTERN = new RegExp(
  String.raw`(?:^\s*|(?:\s*[;&|(\n]\s*))\\?sudo(?:\s|$)`,
)
/**
 * 拒绝把输出重定向到工作区外：覆盖 `> /abs`、`> ~`、`> ..`、引号包裹的绝对路径
 * （`> "$HOME/x"`）、noclobber `>|`、变量/命令替换目标（`$VAR`、`$()`、反引号，
 * 反引号以 \x60 表示以兼容 String.raw 模板）、bash 的 `>&` 文件复制形式
 * （`echo hi >& /tmp/out`，目标非数字即文件写）与 `exec {fd}> /abs`（左上下文 `}`）。
 * 重定向目标必须是字面相对路径。
 * 例外：目标恰为 `/dev/null`（含引号与 `2>/dev/null` 形式，后跟分隔符边界）一律放行——
 * 空设备不产生文件写入，无数据外泄/覆盖面，且 seatbelt 沙箱已显式允许（sandbox.rs）。
 * 因 Rust regex crate 不支持 lookaround，用 RE2 兼容的子串排除交替式实现：`/` 分支按
 * 字符展开枚举 `dev/null` 前缀的各类拒绝路径，唯 `null`+边界（空格/分隔符/引号/行尾）
 * 不匹配任何分支从而放行；`/dev/nullfoo`、`/dev/nulldir`、`/dev`、`/dev/` 等仍拒绝。
 */
const OUTSIDE_WORKSPACE_REDIRECT_PATTERN = new RegExp(
  String.raw`(?:^|[;&|}]|\s|\d)>\s*(?:\|?\s*(?:>|&)?)?\s*[\x22']?(?:\/(?:[^d]|$|d(?:[^e]|e(?:[^v]|v(?:[^\/]|$|\/(?:[^n]|$|n(?:[^u]|u(?:[^l]|l(?:[^l]|l[^\s;&|>\x22']))))))))|~|\$|\x60|\.\.(?:[/\s]|$))`,
)
/** 审批展示中的危险命令标记（不拦截，仅警示用户仔细确认）。
 * rm 变体覆盖 -rf / -fr / -Rf / -RF 等任意大小写合并短 flag（只要含 r/R/f/F）、
 * -r -f 拆分形式与 --recursive/--force。`(?:\s|$)` 收尾防止 `rm -rfoo` 误匹配。 */
/** 审批展示共用的危险命令标记：ssh 工具的远程命令审批复用同一份判定。 */
export const DANGEROUS_COMMAND_MARKERS = /\bsudo\b|\brm\s+(?:--(?:recursive|force)|-[a-zA-Z]*[rRfF][a-zA-Z]*)(?:\s|$)|\bcurl\b|\bwget\b|\bnc(?:at)?\b|\bmkfs\b|\bdd\b|\bshutdown\b|\breboot\b/u

interface CommandInput {
  command: string
  cwd?: string
  timeoutMs?: number
  network?: boolean
}

const resolveTimeoutMs = (timeout: number | undefined): number | undefined => {
  if (timeout === undefined) return undefined
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`Invalid timeout: must be a finite positive number of seconds, got ${timeout}`)
  }
  const timeoutMs = timeout * 1000
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`)
  }
  return timeoutMs
}

const asCommandInput = (input: JsonValue): CommandInput => {
  if (!isJsonObject(input) || typeof input.command !== 'string') {
    throw new Error('Invalid bash arguments.')
  }
  return {
    command: input.command,
    cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
    timeoutMs: typeof input.timeout === 'number' ? resolveTimeoutMs(input.timeout) : undefined,
    network: typeof input.network === 'boolean' ? input.network : undefined,
  }
}

/** 网络关键字（镜像 Rust `sandbox.rs::NETWORK_KEYWORDS`，`bash-policy-audit` 强制一致）。
 * 定位是"减速带"而非安全边界：解释器内联网络调用可绕过，真正的网络阻断在 OS 沙箱层；
 * 漏报只会让命令在沙箱内失败（fail-closed）。关键词用前缀/整词形式避免误匹配。 */
export const NETWORK_KEYWORDS = [
  'curl', 'wget', 'nc ', 'ncat', 'netcat', '/usr/bin/nc', 'ssh', 'scp', 'rsync',
  'npm install', 'npm i ', 'npm ci', 'npm publish', 'npx ',
  'yarn add', 'yarn install', 'yarn upgrade', 'yarn publish',
  'pnpm add', 'pnpm install', 'pnpm update', 'pnpm publish',
  'pip install', 'pip3 install', 'uv pip',
  'cargo add', 'cargo update', 'cargo publish', 'cargo install',
  'go get ', 'go install', 'go mod download', 'go mod tidy',
  'git clone', 'git fetch', 'git pull', 'git push', 'git ls-remote',
  'git submodule update',
  'gem install', 'bundle install', 'dotnet restore',
  'brew install', 'docker pull', 'telnet', 'socat',
  'http://', 'https://', 'ftp://',
]

/**
 * bash 分级提示（镜像 Rust `CommandTier`）：`network: true` 或命令含网络关键字 →
 * networkRequired，否则 sandboxSafe。仅供审批 UI 分流与展示；Rust 签发 lease 时
 * 重新权威分类（§6.1），本函数返回值不参与安全决策。
 */
export const resolveBashTier = (input: JsonValue): CommandTier => {
  if (!isJsonObject(input)) return 'sandboxSafe'
  const command = input.command
  if (input.network === true) return 'networkRequired'
  if (typeof command === 'string'
    && NETWORK_KEYWORDS.some((keyword) => command.includes(keyword))) {
    return 'networkRequired'
  }
  return 'sandboxSafe'
}

export const validateBashInput = (input: JsonValue): string | null => {
  if (!isJsonObject(input) || !hasOnlyKeys(input, ['command', 'cwd', 'timeout', 'network'])) {
    return 'Arguments must be an object with only command, cwd, timeout, network.'
  }
  if (typeof input.command !== 'string' || input.command.trim().length === 0) {
    return 'command must be a non-empty string.'
  }
  if (input.command.includes('\0')) {
    return 'command must not contain null bytes.'
  }
  if (SUDO_COMMAND_PREFIX_PATTERN.test(input.command)) {
    return 'sudo 命令被拒绝：Axiom 不允许以超级用户权限执行命令。'
  }
  if (OUTSIDE_WORKSPACE_REDIRECT_PATTERN.test(input.command)) {
    return '重定向到工作区外被拒绝：命令输出目标必须是工作区内的相对路径。'
  }
  if (textEncoder.encode(input.command).byteLength > MAX_COMMAND_BYTES) {
    return `command is too long (max ${MAX_COMMAND_BYTES} bytes).`
  }
  if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !isSafeRelativePath(input.cwd, true))) {
    return 'cwd must be a workspace-relative directory without "..".'
  }
  if (input.timeout !== undefined) {
    if (typeof input.timeout !== 'number' || !Number.isFinite(input.timeout) || input.timeout <= 0) {
      return 'timeout must be a finite positive number of seconds.'
    }
    if (input.timeout > MAX_TIMEOUT_SECONDS) {
      return `timeout must not exceed ${MAX_TIMEOUT_SECONDS} seconds.`
    }
  }
  if (input.network !== undefined && typeof input.network !== 'boolean') {
    return 'network must be a boolean.'
  }
  return null
}

const TRUNCATED_PREVIEW_LENGTH = 120
const TRUNCATED_AUDIT_LENGTH = 80

/** 展示用截断，始终保留开头（可能包含 sudo/rm 等关键信息）。 */
const truncateForDisplay = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, maxLength)}...` : value

const commandOutput = (
  resolvedCommand: string,
  result: WorkspaceCommandResult,
): string => {
  const sections = [`Command: ${resolvedCommand}`, `Exit code: ${result.exitCode ?? 'signal'}`]
  // 沙箱降级警示：NetworkRequired 命令在沙箱不可用时回退常规用户权限执行，
  // 写限工作区与凭据读取保护未生效——显式告知模型/用户，而非静默裸跑。
  if (result.sandboxed === false) {
    sections.push(
      'Sandbox unavailable (degraded execution): macOS Seatbelt sandbox was not available, '
      + 'so this command ran as a regular user process WITHOUT sandboxing — '
      + 'workspace-write confinement and credential-read denials did NOT apply. '
      + 'Review the command and its output accordingly.',
    )
  }
  if (result.timedOut) sections.push('Status: timed out')
  if (result.stdout) sections.push(`STDOUT:\n${result.stdout}`)
  if (result.stderr) sections.push(`STDERR:\n${result.stderr}`)
  if (!result.stdout && !result.stderr) sections.push('[No output]')
  if (result.truncated) {
    const total = result.stdoutBytes + result.stderrBytes
    sections.push(
      `[Output exceeded 2 MiB and was tail-truncated; ${total} bytes were produced in total. `
      + 'Refine the command to retrieve the missing portion.]',
    )
  }
  // seatbelt deny 摘要：把「沙箱拒了什么」明确告诉模型，替代裸 EPERM 猜谜——
  // 网络类 deny（network-outbound 等）提示重新以 network: true 声明执行。
  if (result.sandboxDenials && result.sandboxDenials.length > 0) {
    const lines = result.sandboxDenials.map((denial) => `- ${denial}`)
    const networkHint = result.sandboxDenials.some((denial) => denial.startsWith('network'))
      ? '\nIf this command needs outbound network access, retry with network: true.'
      : ''
    sections.push(
      `Sandbox denials (macOS Seatbelt blocked these operations):\n${lines.join('\n')}${networkHint}`,
    )
  }
  return sections.join('\n\n')
}

export const createBashTool = (
  environment: AgentEnvironment,
): AgentTool => {
  return {
    name: 'bash',
    label: 'bash',
    promptSnippet: '执行 Bash 命令（ls、grep、find、git、npm test 等）。',
    promptGuidelines: [
      '接受任意 bash 命令字符串；每次调用需用户逐次审批。',
      '所有命令都在 OS 沙箱内执行（仅工作区与临时目录可写）；需要外网的命令（安装依赖、git push 等）必须声明 network: true 以启用网络，本地开发服务器（npm run dev 等）无需声明——本机回环端口默认可用。',
      'git clone/fetch/pull/push/ls-remote/submodule-update 等 VCS 网络命令会在沙箱内被放行读取 ~/.ssh 与 ~/.config/git/credentials，以便 SSH/HTTPS 认证正常工作；其它凭据目录仍保持拒绝。',
      '输出超过 2 MiB 时尾截断；用更精确的命令缩小范围以获取缺失部分。',
    ],
    runtimeVersion: '15',
    recoveryPolicy: 'never',
    description:
      'Execute a bash command in the authorized workspace. The command runs via /bin/bash -c inside the workspace directory. Output is truncated at 2 MiB (tail retained). Each invocation requires an approval lease. Optionally provide a timeout in seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Bash command to execute. Runs inside the authorized workspace directory via /bin/bash -c.',
        },
        cwd: {
          type: 'string',
          description: 'Workspace-relative working directory; defaults to the workspace root.',
        },
        timeout: {
          type: 'number',
          description: `Timeout in seconds (optional, no default). Maximum ${MAX_TIMEOUT_SECONDS} seconds.`,
        },
        network: {
          type: 'boolean',
          description: 'Whether this command requires outbound network access. '
            + 'false (default): runs inside the OS sandbox with loopback-only networking, single approval. '
            + 'true: runs inside the OS sandbox with network enabled (writes still confined to the workspace), '
            + 'double approval required.',
          default: false,
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    executionMode: 'sequential',
    requiresApproval: true,
    resolveTier: resolveBashTier,
    validate: (input) => {
      const error = validateBashInput(input)
      return error ? { ok: false, error } : { ok: true, value: input }
    },
    approvalPresentation: (input) => {
      const { command, cwd, timeoutMs } = asCommandInput(input)
      const preview = truncateForDisplay(command, TRUNCATED_PREVIEW_LENGTH)
      const dangerous = DANGEROUS_COMMAND_MARKERS.test(command)
      const dangerNote = dangerous
        ? '\n\n⚠️ 危险命令：包含 sudo / 删除 / 外传 / 磁盘写入等高风险关键字，请仔细确认'
        : ''
      const sandboxed = resolveBashTier(input) === 'sandboxSafe'
      // 沙箱策略：两级分类都在沙箱内执行、仅工作区可写；读取为全局 + 凭据路径 deny
      // （见 sandbox.rs），故文案说"仅工作区可写"而非"仅限工作区"。差别只在网络档位：
      // 默认档仅本机回环可用（dev server 场景），network:true 档外网启用。
      const vcsNote = /\bgit\s+(clone|fetch|pull|push|ls-remote|submodule\s+update)\b/.test(command)
        ? '\n\n🔑 此 VCS 命令需要认证：沙箱会放行读取 ~/.ssh 与 ~/.config/git/credentials，其它凭据目录仍拒绝。'
        : ''
      const sandboxNote = sandboxed
        ? '\n\n🔒 沙箱内执行：外网禁用（本机回环可用），仅工作区可写'
        : '\n\n🌐 沙箱内执行＋启用网络：仅工作区可写，需双重确认'
      return {
        category: 'workspace-command',
        title: 'Run bash command?',
        description: 'This command runs via /bin/bash -c inside the authorized workspace, sandboxed by macOS Seatbelt (workspace-only writes, credentials denied). This approval lease is valid only for this single command.'
          + (dangerous ? ' ⚠️ 危险命令，请仔细确认。' : '')
          + (sandboxed ? ' 🔒 沙箱内执行。' : ' 🌐 沙箱内执行＋启用网络。'),
        path: cwd || '.',
        preview: `$ ${preview}${timeoutMs !== undefined ? `\n\ntimeout: ${(timeoutMs / 1000).toFixed(1)}s` : ''}${sandboxNote}${vcsNote}${dangerNote}`,
        danger: dangerous,
      }
    },
    auditArguments: (input) => {
      const { command, cwd, timeoutMs } = asCommandInput(input)
      return {
        commandPreview: truncateForDisplay(command, TRUNCATED_AUDIT_LENGTH),
        commandLength: command.length,
        cwd: cwd ?? '.',
        timeoutMs: timeoutMs ?? null,
      }
    },
    execute: async (input, context) => {
      if (!context.approvalLease) throw new Error('Missing workspace approval lease.')
      if (!isJsonObject(input)) throw new Error('Invalid bash arguments.')
      const { command, cwd, timeoutMs } = asCommandInput(input)

      await context.reportProgress('Starting bash command', {
        cwd: cwd ?? '.',
        commandPreview: truncateForDisplay(command, TRUNCATED_AUDIT_LENGTH),
      })
  
      let reportedBytes = 0
      let progressChain = Promise.resolve()
      const result = await environment.workspace.runCommand({
        requestId: createId('workspace-command'),
        command,
        cwd,
        timeoutMs,
      }, context.signal, (progress) => {
        const capturedBytes = progress.capturedStdoutBytes + progress.capturedStderrBytes
        if (capturedBytes - reportedBytes < 32 * 1024) return
        reportedBytes = capturedBytes
        progressChain = progressChain.then(() => context.reportProgress(
          `Workspace command produced ${capturedBytes} bytes of output`,
          { capturedBytes },
        ))
      }, context.approvalLease)
      await progressChain
  
      return {
        content: commandOutput(command, result),
        details: {
          cwd: cwd ?? '.',
          exitCode: result.exitCode ?? null,
          durationMs: result.durationMs,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          truncated: result.truncated,
          timedOut: result.timedOut,
          sandboxed: result.sandboxed ?? null,
        },
      }
    },
  }
}

export const bashTool = createBashTool(desktopAgentEnvironment)
