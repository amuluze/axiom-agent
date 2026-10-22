import { BASH_POLICY } from './bashPolicy.generated'
import { toolApprovalScope } from '@/agent/core/approvalScope'
import { createId } from '@/agent/core/id'
import type { AgentTool, CommandTier, JsonValue } from '@/agent/core/types'
import type { AgentEnvironment, WorkspaceCommandResult } from '@/agent/environment/AgentEnvironment'
import { desktopAgentEnvironment } from '@/agent/environment/agentEnvironmentHost'
import { hasOnlyKeys, isJsonObject, isSafeRelativePath } from './workspaceToolUtils'

const MAX_TIMEOUT_MS = BASH_POLICY.maxTimeoutMs
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000
/** 由 contracts/bash-policy.json 生成，`generate:bash-policy:check` 强制。 */
const MAX_COMMAND_BYTES = BASH_POLICY.maxCommandBytes
const textEncoder = new TextEncoder()

/**
 * 自由命令模型的尽力拦截（与 Rust workspace_command.rs 逐字一致，
 * 由 bash-policy-audit 强制）：拒绝常见 sudo 调用与重定向到工作区外。
 * 定位为"减速带"而非安全边界——标准模式的沙箱才是执行边界，完全访问没有
 * 可靠的命令级隔离。
 * sudo 匹配命令上下文边界（行首 / 换行 / 分号 / && / | / 子shell / $() ），
 * 不匹配 `grep sudo` 这类把 sudo 当普通参数的合法命令。
 * 换行显式纳入分隔符字符类：命令经 /bin/bash -c 执行，`echo hi\nsudo whoami`
 * 中的换行是合法分隔符，若漏掉可绕过行首匹配（`^` 无 multiline 标志）。
 */
const SUDO_COMMAND_PREFIX_PATTERN = new RegExp(BASH_POLICY.sudoCommandPrefixPattern)
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
const OUTSIDE_WORKSPACE_REDIRECT_PATTERN = new RegExp(BASH_POLICY.outsideWorkspaceRedirectPattern)
/** 审批展示中的危险命令标记（不拦截，仅警示用户仔细确认）。
 *
 * 判定分两步，缺一不可：
 * 1. **剥引号**：单引号与双引号内的内容是数据而非可执行命令，`grep -r "sudo" docs`、
 *    `sed "s/sudo/x/" README.md` 这类把危险词当字面量用的命令不应被升级。
 * 2. **命令位置**：危险词只在命令起始位置（行首，或 `;` `&` `|` 反引号 `(` 换行
 *    之后，允许一个 `\` 转义）才算执行。`ls wget-cache`、`git checkout
 *    feature/curling` 里的词是路径/分支名而非命令。
 *
 * `rm` 变体覆盖 -rf / -fr / -Rf / -RF 等任意大小写合并短 flag（只要含 r/R/f/F）、
 * -r -f 拆分形式与 --recursive/--force。`(?:\s|$)` 收尾防止 `rm -rfoo` 误匹配。
 *
 * Rust 同源实现见 `workspace_approval.rs::command_is_dangerous`，两侧逐字比对由
 * `scripts/bash-policy-audit.mjs` 强制。ssh 工具的远程命令审批复用同一份判定。 */
const DANGEROUS_COMMAND_ALTERNATION = String.raw`su(?:do)?|cu(?:rl)?|wg(?:et)?|n(?:c|cat)|mkfs|dd|shut(?:down)?|re(?:boot)?`
// 反引号以 \x60 表示（与 OUTSIDE_WORKSPACE_REDIRECT_PATTERN 同款处理）：保持单段
// 字面量以便 bash-policy 审计逐字比对两侧，且 Rust regex crate 同样支持该转义。
// 收尾用「行尾或非标识符字符」交替而非 lookaround（RE2 不支持）：mkfs.ext4 /
// nc.open 这类带紧跟分隔符的命令名必须命中，而单字命令（reboot）在行尾没有后续
// 字符。漏判比误判危险。
const DANGEROUS_COMMAND_POSITION = String.raw`(?:^\s*|(?:\s*[;&|\x60(\n]\s*))\\?`
const DANGEROUS_COMMAND_TAIL = String.raw`(?:[^\w-]|$)`
const DANGEROUS_RM_FLAG = String.raw`rm\s+(?:--(?:recursive|force)|-[a-zA-Z]*[rRfF][a-zA-Z]*)(?:\s|$)`
const dangerousCommandPattern = new RegExp(
  `${DANGEROUS_COMMAND_POSITION}(?:${DANGEROUS_COMMAND_ALTERNATION})${DANGEROUS_COMMAND_TAIL}`,
  'u',
)
const dangerousRmPattern = new RegExp(`${DANGEROUS_COMMAND_POSITION}${DANGEROUS_RM_FLAG}`, 'u')
export const isDangerousCommand = (command: string): boolean => {
  // 先剥引号：引号内是数据而非命令。内容替换为转义后的空引号而非删除，
  // 否则 `echo "x" && rm -rf /` 这类拼接的分隔符会随引号内容一起丢失。
  const stripped = command.replace(/'[^']*'/gu, "''").replace(/"[^"]*"/gu, '""')
  return dangerousCommandPattern.test(stripped) || dangerousRmPattern.test(stripped)
}

interface CommandInput {
  command: string
  cwd?: string
  timeoutMs?: number
  network?: boolean
  vcsCredentials?: boolean
  containerControl?: boolean
}

const isWholeMillisecond = (value: number): boolean =>
  Math.abs(value - Math.round(value)) <= Number.EPSILON * Math.max(1, Math.abs(value)) * 4

const resolveTimeoutMs = (timeout: number | undefined): number | undefined => {
  if (timeout === undefined) return undefined
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`Invalid timeout: must be a finite positive number of seconds, got ${timeout}`)
  }
  const timeoutMs = timeout * 1000
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`)
  }
  if (!isWholeMillisecond(timeoutMs) || Math.round(timeoutMs) <= 0) {
    throw new Error('Invalid timeout: must resolve to a whole millisecond')
  }
  return Math.round(timeoutMs)
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
    vcsCredentials: typeof input.vcsCredentials === 'boolean' ? input.vcsCredentials : undefined,
    containerControl: typeof input.containerControl === 'boolean' ? input.containerControl : undefined,
  }
}

/** 网络关键字（由 contracts/bash-policy.json 生成；Rust 侧消费同一份契约）。
 * 定位是"减速带"而非安全边界：解释器内联网络调用可绕过，真正的网络阻断在 OS 沙箱层；
 * 漏报只会让命令在沙箱内失败（fail-closed）。关键词用前缀/整词形式避免误匹配。 */
export const NETWORK_KEYWORDS = BASH_POLICY.networkKeywords

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
  if (!isJsonObject(input) || !hasOnlyKeys(input, ['command', 'cwd', 'timeout', 'network', 'vcsCredentials', 'containerControl'])) {
    return 'Arguments must be an object with only command, cwd, timeout, network, vcsCredentials, containerControl.'
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
    if (!isWholeMillisecond(input.timeout * 1000) || Math.round(input.timeout * 1000) <= 0) {
      return 'timeout must resolve to a whole millisecond.'
    }
  }
  if (input.network !== undefined && typeof input.network !== 'boolean') {
    return 'network must be a boolean.'
  }
  for (const name of ['vcsCredentials', 'containerControl']) {
    if (input[name] !== undefined && typeof input[name] !== 'boolean') return `${name} must be a boolean.`
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
  tier: CommandTier,
): string => {
  const policy = result.sandboxed === false
    ? 'Unrestricted'
    : tier === 'sandboxSafe'
      ? 'LoopbackOnly'
      : 'OutboundEnabled'
  const executionBoundary = result.sandboxed === false ? 'Host access (OS sandbox disabled)' : 'OS sandbox'
  const sections = [
    `Command: ${resolvedCommand}`,
    `Execution boundary: ${executionBoundary}`,
    `Network policy: ${policy}`,
    `Exit code: ${result.exitCode ?? 'signal'}`,
  ]
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
      '工作区授权不能解除凭据或 Axiom 数据保护；隐私目录只开放经原生确认的项目子目录，拒绝后不要通过改名或其他工具绕过。',
      '接受任意 bash 命令字符串；标准模式下每次调用经审批卡片确认一次，命令始终在 OS 沙箱内执行。「完全访问」模式下命令以宿主用户权限在沙箱外直接执行、不再有任何确认——该模式是权限档而非效率档，只在完全信任当前任务时使用。',
      '标准模式下所有命令都在 OS 沙箱内执行（仅工作区与临时目录可写）；需要外网的命令（安装依赖、git push 等）必须声明 network: true 以启用网络，本地开发服务器（npm run dev 等）无需声明——本机回环端口默认可用。',
      '标准模式下命令始终在 OS 沙箱内执行：出网需声明 network: true（仅本次放开），凭据与容器权限分别经 vcsCredentials / containerControl 声明并在沙箱内定点放行；沙箱不可用时所有命令都拒绝执行。「完全访问」下这三项声明不再有意义——命令已不经沙箱，网络、凭据与容器权限直接由宿主用户权限决定。',
      '输出超过 2 MiB 时尾截断；用更精确的命令缩小范围以获取缺失部分。',
    ],
    runtimeVersion: '26',
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
            + 'false (default): runs inside the OS sandbox with loopback-only networking. '
            + 'true: runs inside the OS sandbox with network enabled (writes still confined to the workspace). '
            + 'Both tiers use the same single approval. In full-access mode the sandbox is off and network is unrestricted.',
          default: false,
        },
        vcsCredentials: {
          type: 'boolean',
          description: 'Request SSH private-key and Git credential reads inside the sandbox for this command only. Approval applies to this single command. In full-access mode the sandbox is off and the flag has no effect.',
          default: false,
        },
        containerControl: {
          type: 'boolean',
          description: 'Request container daemon access and Docker config reads/writes inside the sandbox for this command only. Can reach files outside the workspace through mounts. Approval applies to this single command. In full-access mode the sandbox is off and the flag has no effect.',
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
      const { command, cwd, timeoutMs, vcsCredentials, containerControl } = asCommandInput(input)
      const preview = truncateForDisplay(command, TRUNCATED_PREVIEW_LENGTH)
      const dangerous = isDangerousCommand(command)
      const dangerNote = dangerous
        ? '\n\n⚠️ 危险命令：包含 sudo / 删除 / 外传 / 磁盘写入等高风险关键字，请仔细确认'
        : ''
      const sandboxed = resolveBashTier(input) === 'sandboxSafe'
      const vcsNote = vcsCredentials === true
        ? '\n\n🔑 本次审批将为该命令在沙箱内放行读取 ~/.ssh 与 ~/.config/git/credentials；其它凭据目录仍拒绝。'
        : ''
      const containerNote = containerControl === true
        ? '\n\n⚠️ 本次审批将为该命令放行容器 daemon 与 Docker 配置；容器可访问工作区外文件和网络。'
        : ''
      const writeScope = containerControl === true
        ? '容器 daemon 操作不受工作区写范围约束'
        : '仅工作区与临时目录可写'
      const sandboxNote = sandboxed
        ? `\n\n🔒 策略 LoopbackOnly：命令在沙箱内执行，外网禁用（本机回环可用）；${writeScope}`
        : `\n\n🌐 策略 OutboundEnabled：本次审批后命令在沙箱内执行并启用网络；${writeScope}；凭据与容器权限需另行声明`
      return {
        category: 'workspace-command',
        title: 'Run bash command?',
        titleKey: 'app.approval.bash.title',
        description: 'This approval is the only confirmation for this command. It runs via /bin/bash -c inside the authorized workspace and remains inside the OS sandbox. The approval lease is valid only for this single command.'
          + (dangerous ? ' ⚠️ 危险命令，请仔细确认。' : '')
          + (sandboxed ? ' 🔒 沙箱内执行。' : ' 🌐 沙箱内执行＋启用网络。'),
        descriptionKey: 'app.approval.bash.description',
        path: cwd || '.',
        preview: `$ ${preview}${timeoutMs !== undefined ? `\n\ntimeout: ${(timeoutMs / 1000).toFixed(1)}s` : ''}${sandboxNote}${vcsNote}${containerNote}${dangerNote}`,
        danger: dangerous || vcsCredentials === true || containerControl === true,
      }
    },
    auditArguments: (input) => {
      const { command, cwd, timeoutMs, vcsCredentials, containerControl } = asCommandInput(input)
      return {
        commandPreview: truncateForDisplay(command, TRUNCATED_AUDIT_LENGTH),
        commandLength: command.length,
        cwd: cwd ?? '.',
        timeoutMs: timeoutMs ?? null,
        vcsCredentials: vcsCredentials ?? false,
        containerControl: containerControl ?? false,
        requestedNetworkPolicy: resolveBashTier(input) === 'sandboxSafe' ? 'LoopbackOnly' : 'OutboundEnabled',
      }
    },
    execute: async (input, context) => {
      if (!context.approvalLease) throw new Error('Missing workspace approval lease.')
      if (!isJsonObject(input)) throw new Error('Invalid bash arguments.')
      const { command, cwd, timeoutMs, vcsCredentials, containerControl } = asCommandInput(input)

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
        ...(vcsCredentials !== undefined ? { vcsCredentials } : {}),
        ...(containerControl !== undefined ? { containerControl } : {}),
      }, context.signal, (progress) => {
        const capturedBytes = progress.capturedStdoutBytes + progress.capturedStderrBytes
        if (capturedBytes - reportedBytes < 32 * 1024) return
        reportedBytes = capturedBytes
        progressChain = progressChain.then(() => context.reportProgress(
          `Workspace command produced ${capturedBytes} bytes of output`,
          { capturedBytes },
        ))
      }, context.approvalLease, toolApprovalScope(context))
      await progressChain

      // 跨层结果契约：Rust 只对完全访问签发的租约返回 sandboxed=false。命令此时
      // 已真实执行，因此只按「租约来源」判定边界是否合法——标准模式拿到无沙箱
      // 结果说明契约被破坏，必须报错而不是当成功回灌模型（后者会诱发重试，让
      // 副作用再执行一次）。
      if (result.sandboxed === false && context.approvalSource !== 'automatic') {
        throw new Error('命令结果缺少 OS 沙箱保护，已拒绝接收；请检查宿主沙箱支持。')
      }

      return {
        content: commandOutput(command, result, resolveBashTier(input)),
        details: {
          cwd: cwd ?? '.',
          exitCode: result.exitCode ?? null,
          durationMs: result.durationMs,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          truncated: result.truncated,
          timedOut: result.timedOut,
          sandboxed: result.sandboxed ?? null,
          executionPolicy: result.sandboxed === false
            ? 'Unrestricted'
            : resolveBashTier(input) === 'sandboxSafe'
              ? 'LoopbackOnly'
              : 'OutboundEnabled',
        },
      }
    },
  }
}

export const bashTool = createBashTool(desktopAgentEnvironment)
