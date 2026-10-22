import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { PROVIDER_PROFILE_SCHEMA_VERSION } from '../../../apps/desktop/src/agent/transport/providerProfileVersion'
import type { TestRunStatus } from '../../../apps/desktop/src/agent/testing/runner/runState'
import type { RuntimeInfo } from '../../../apps/desktop/src/platform/runtimeInfo'
import { chunkBytes, textTurn, type ScriptedTurn } from './model'

export type HostApprovalPolicy = 'hold' | 'auto' | 'deny'

export interface HostWorkspace {
  path: string
  name: string
  gitBranch: string | null
}

export interface PendingApproval {
  request: Record<string, unknown>
  resolve: (lease: string) => void
  reject: (error: Error) => void
}

/** 脚本化测试页的单个元素：定位（role/name/text）与断言取值都取自这里。 */
interface ScriptedPageNode {
  role: string
  name: string
  text: string
  disabled: boolean
}

interface ScriptedTestPage {
  url: string
  title: string
  nodes: ScriptedPageNode[]
}

interface StoredTestStep {
  id: string
  stepId: string
  action: string
  status: TestRunStatus
  startedAt: number | null
  finishedAt: number | null
  detailsJson: string | null
  evidenceContentHash: string | null
}

interface StoredTestCase {
  id: string
  caseId: string
  caseName: string
  status: TestRunStatus
  startedAt: number | null
  finishedAt: number | null
  failureKind: string | null
  steps: StoredTestStep[]
}

interface StoredTestRun {
  summary: {
    id: string
    specPath: string
    specHash: string
    environmentId: string | null
    status: TestRunStatus
    startedAt: number
    finishedAt: number | null
  }
  planContentHash: string | null
  cases: StoredTestCase[]
}

export interface HostState {
  root: string
  workspaces: Map<string, HostWorkspace>
  activeWorkspacePath: string | null
  /** 原生目录选择器按顺序返回的路径（用例经控制面预置）。 */
  pickQueue: string[]
  secrets: Set<string>
  leases: Set<string>
  turns: ScriptedTurn[]
  calls: { cmd: string; args: Record<string, unknown> }[]
  approvals: Map<string, PendingApproval>
  approved: string[]
  denied: string[]
  artifacts: Map<string, { content: string; sizeBytes: number }>
  cancelled: Set<string>
  /** 测试页旅程：脚本化页面、运行记录、测试目标授权与步骤租约（全部内存态）。 */
  testPage: ScriptedTestPage
  testRuns: Map<string, StoredTestRun>
  testTargets: Map<string, { tabId: string; origin: string }>
  testStepLeases: Set<string>
}

export const createHostState = async (): Promise<HostState> => ({
  root: await mkdtemp(join(resolve(process.env.TMPDIR ?? '/tmp'), 'axiom-e2e-')),
  workspaces: new Map(),
  activeWorkspacePath: null,
  pickQueue: [],
  secrets: new Set(),
  leases: new Set(),
  turns: [],
  calls: [],
  approvals: new Map(),
  approved: [],
  denied: [],
  artifacts: new Map(),
  cancelled: new Set(),
  testPage: scriptedTestPage(),
  testRuns: new Map(),
  testTargets: new Map(),
  testStepLeases: new Set(),
})

/**
 * 脚本化测试页：测试页旅程中的 `run_ui_read_step` 断言与 `browser_command` 结果都由它驱动。
 * 元素表刻意保持最小：不足以支撑的定位字段/断言一律 fail-loud，不静默按“通过”处理。
 */
const scriptedTestPage = (): ScriptedTestPage => ({
  url: 'http://127.0.0.1:1430/e2e-target/checkout',
  title: '结算页',
  nodes: [
    { role: 'heading', name: '结算页', text: '结算页', disabled: false },
    { role: 'button', name: '提交订单', text: '提交订单', disabled: false },
    { role: 'status', name: '订单已创建', text: '订单已创建', disabled: false },
  ],
})

/** 脚本化浏览器标签页：测试运行要求目标 tab 的 origin 为 HTTP(S)。 */
const scriptedTabs = () => [
  {
    tabId: 'tab-e2e-1',
    url: 'http://127.0.0.1:1430/e2e-target/checkout',
    title: '结算页',
    active: true,
    hasDialog: false,
  },
]

/**
 * 清空**运行时累积状态**,保留 workspaces/activeWorkspacePath/secrets/leases
 * ——这些由用例显式 setup(原生选择器、注册表登记),不应跨用例被回收。
 * 只清跨用例会污染断言的字段:
 *  - turns: 脚本化模型响应队列,被自动标题请求消费掉会污染下游
 *  - calls/approved/denied: 累计记录,「本用例未签发租约」类断言的参照基线
 *  - approvals: hold 模式待裁决的 Promise,跨用例残留会让后续裁决失配
 *  - artifacts/cancelled: 临时中间态,与用例强绑定
 *  - pickQueue: 选目录队列,跨用例残留会让 picker 用错目录
 *  - testRuns/testTargets/testStepLeases: 测试页旅程的运行记录、目标授权与步骤租约
 */
export const resetHostState = (state: HostState): void => {
  // hold 模式下挂起的 Promise 必须先拒绝,避免用例结束后回调落空;
  // 收齐后再 clear,避免迭代中修改 Map。
  const pending = [...state.approvals.values()]
  state.approvals.clear()
  for (const entry of pending) {
    entry.reject(new Error('host state 已 reset,挂起的审批被丢弃'))
  }
  state.turns = []
  state.calls = []
  state.approved = []
  state.denied = []
  state.artifacts.clear()
  state.cancelled.clear()
  state.pickQueue = []
  state.testRuns.clear()
  state.testTargets.clear()
  state.testStepLeases.clear()
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const workspaceOf = (state: HostState, args: Record<string, unknown>): HostWorkspace => {
  const path = (typeof args.workspacePath === 'string' ? args.workspacePath : state.activeWorkspacePath) ?? ''
  const workspace = state.workspaces.get(path)
  if (!workspace) throw new Error(`工作区未授权：${path || '(空)'}`)
  return workspace
}

/** 工作区内的相对路径解析（拒绝 `..` 逃逸），与 Rust 侧同语义。 */
const inside = (root: string, candidate: string): string => {
  const target = resolve(root, candidate)
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`路径越出工作区：${candidate}`)
  return target
}

const requireLease = (state: HostState, args: Record<string, unknown>): void => {
  if (typeof args.approvalLease !== 'string' || !state.leases.has(args.approvalLease)) {
    throw new Error('工作区写操作缺少有效审批租约')
  }
}

const execInWorkspace = (command: string, cwd: string, timeoutMs: number): Promise<{
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}> => new Promise((settle) => {
  const startedAt = Date.now()
  execFile('/bin/bash', ['-c', command], { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = (error as { code?: unknown } | null)?.code
    settle({
      exitCode: typeof code === 'number' ? code : error ? 1 : 0,
      stdout: String(stdout),
      stderr: String(stderr),
      durationMs: Date.now() - startedAt,
    })
  })
})

/** 简单 glob：`*` 不跨路径分隔符，`?` 匹配单字符；测试索引用 `*.testspec.json`。 */
const globMatcher = (pattern: string): ((name: string) => boolean) => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*/gu, '[^/]*')
    .replace(/\?/gu, '.')
  const regex = new RegExp(`^${escaped}$`, 'u')
  return (name) => regex.test(name)
}

const missingDirectory = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('no such file or directory') || message.includes('ENOENT')
}

/** 终态不可再转移；与前端 runState.ts 的转移表同语义。 */
const TERMINAL_TEST_STATUS: Record<TestRunStatus, boolean> = {
  queued: false,
  running: false,
  waiting_approval: false,
  passed: true,
  failed: true,
  error: true,
  rejected: true,
  skipped: true,
  canceled: true,
  interrupted: true,
}

const findStoredCase = (state: HostState, caseRunId: string): StoredTestCase | null => {
  for (const run of state.testRuns.values()) {
    const found = run.cases.find((candidate) => candidate.id === caseRunId)
    if (found) return found
  }
  return null
}

const findStoredStep = (state: HostState, stepRunId: string): StoredTestStep | null => {
  for (const run of state.testRuns.values()) {
    for (const storedCase of run.cases) {
      const found = storedCase.steps.find((candidate) => candidate.id === stepRunId)
      if (found) return found
    }
  }
  return null
}

type UiReadVerdict = { verdict: 'passed' } | { verdict: 'failed'; message: string }

const uiVerdict = (passed: boolean, message: string): UiReadVerdict =>
  passed ? { verdict: 'passed' } : { verdict: 'failed', message }

const matchesLocator = (node: ScriptedPageNode, locator: Record<string, unknown>): boolean => {
  if (typeof locator.role === 'string' && node.role !== locator.role) return false
  if (typeof locator.name === 'string') {
    const matched = locator.exact === true ? node.name === locator.name : node.name.includes(locator.name)
    if (!matched) return false
  }
  if (typeof locator.text === 'string') {
    const matched = locator.exact === true ? node.text === locator.text : node.text.includes(locator.text)
    if (!matched) return false
  }
  return true
}

/**
 * 按定位器筛选脚本化页面的元素。只实现测试页旅程用到的定位字段；其余字段
 * **fail-loud**（抛错），绝不把“无法判定”当成匹配成功。
 */
const scriptedNodes = (page: ScriptedTestPage, locator: Record<string, unknown>): ScriptedPageNode[] => {
  const unsupported = ['testId', 'label', 'css'].filter((field) => locator[field] !== undefined)
  if (unsupported.length > 0) {
    throw new Error(`假宿主脚本化页面模型不支持定位字段：${unsupported.join('、')}`)
  }
  return page.nodes.filter((node) => matchesLocator(node, locator))
}

/**
 * 脚本化页面的断言判定。只实现测试页旅程用到的断言；其余组合 **fail-loud**（抛错），
 * 绝不把“无法判定”当成通过。
 */
const evaluateUiReadStep = (page: ScriptedTestPage, request: Record<string, unknown>): UiReadVerdict => {
  const locator = (request.locator ?? {}) as Record<string, unknown>
  const matches = scriptedNodes(page, locator)
  const expect = (request.expect ?? {}) as Record<string, unknown>
  const [key] = Object.keys(expect)
  const value = expect[key ?? '']
  const expected = value === true
  switch (key) {
    case 'exists':
      return uiVerdict((matches.length > 0) === expected, `期望 exists=${String(value)}，实际匹配 ${matches.length} 个元素`)
    case 'visible':
      return uiVerdict((matches.length > 0) === expected, `期望 visible=${String(value)}，实际匹配 ${matches.length} 个元素`)
    case 'enabled':
      return uiVerdict(matches.some((node) => !node.disabled) === expected, `期望 enabled=${String(value)}，实际匹配 ${matches.length} 个元素`)
    case 'count':
      return uiVerdict(matches.length === value, `期望 count=${String(value)}，实际匹配 ${matches.length} 个元素`)
    case 'textContains':
      return uiVerdict(
        matches.some((node) => node.text.includes(String(value))),
        `期望元素文本包含「${String(value)}」，脚本化页面未匹配到`,
      )
    case 'textEquals':
      return uiVerdict(
        matches.some((node) => node.text === String(value)),
        `期望元素文本等于「${String(value)}」，脚本化页面未匹配到`,
      )
    case 'urlContains':
      return uiVerdict(page.url.includes(String(value)), `期望 URL 包含「${String(value)}」，实际为 ${page.url}`)
    case 'urlEquals':
      return uiVerdict(page.url === String(value), `期望 URL 等于「${String(value)}」，实际为 ${page.url}`)
    default:
      throw new Error(`假宿主脚本化页面模型不支持断言：${String(key)}`)
  }
}

export interface CommandContext {
  clientId: string
  state: HostState
  approvalPolicy: HostApprovalPolicy
  chunkSize: number
  emit: (clientId: string, event: string, payload: unknown) => void
}

/**
 * 假宿主的命令面。覆盖四个套件所需的界面：运行时信息、工作区授权、
 * 审批模式与租约、脚本化模型流、工作区读写/文件枚举、命令执行，以及测试页
 * 旅程（测试索引读取、测试运行记录、UI 读写步骤、浏览器标签页）。
 * 未实现的命令 fail-loud（错误里带命令名），据此按需扩展。
 */
export const handleCommand = async (
  cmd: string,
  args: Record<string, unknown>,
  ctx: CommandContext,
): Promise<unknown> => {
  const { state, clientId } = ctx
  switch (cmd) {
    case 'get_runtime_info':
      return {
        appName: 'Axiom',
        appVersion: '0.0.0-e2e',
        operatingSystem: 'macos',
        architecture: 'aarch64',
        sandboxAvailable: true,
      } satisfies RuntimeInfo
    case 'get_workspace_recovery_issue':
    case 'retry_workspace_recovery':
      return null
    case 'list_authorized_read_files':
      return []
    case 'set_prevent_idle_sleep':
    case 'set_workspace_approval_mode':
    case 'persist_provider_secret_cleanup_intent':
    case 'set_terminal_focus':
    case 'open_external_url':
      return null
    case 'decode_provider_profile': {
      const raw = args.raw as Record<string, unknown>
      if (raw.schemaVersion !== PROVIDER_PROFILE_SCHEMA_VERSION) {
        throw new Error(
          `E2E Provider Profile 版本漂移：期望 ${PROVIDER_PROFILE_SCHEMA_VERSION}，实际 ${String(raw.schemaVersion)}`,
        )
      }
      return { profile: raw, requiresPersistenceMigration: false }
    }
    case 'normalize_provider_profile_draft':
      return args.draft
    case 'is_provider_secret_compatible':
      return true
    case 'is_legacy_provider_secret_compatible':
    case 'is_known_legacy_provider_secret':
      return false
    case 'has_secret':
      // 脚本化宿主不校验密钥material，Provider 一律视为已配置（否则会话
      // 会停在 providerSetupRequired 分支，无法进入模型流旅程）。
      return true
    case 'save_secret':
      state.secrets.add(String(args.key))
      return null
    case 'delete_secret':
      state.secrets.delete(String(args.key))
      return null
    case 'migrate_secret': {
      const source = String(args.sourceKey)
      const target = String(args.targetKey)
      if (!state.secrets.has(source)) return false
      state.secrets.delete(source)
      state.secrets.add(target)
      return true
    }
    case 'load_provider_secret_cleanup_intent':
      return []
    case 'get_artifact_storage_stats':
      return { activeCount: state.artifacts.size, activeBytes: 0, trashCount: 0, trashBytes: 0 }
    case 'write_artifact': {
      const request = (args.request ?? {}) as { content?: string }
      const content = String(request.content ?? '')
      const contentHash = sha256(content)
      state.artifacts.set(contentHash, { content, sizeBytes: Buffer.byteLength(content) })
      return { contentHash, sizeBytes: Buffer.byteLength(content), kind: 'text', mediaType: 'text/plain;charset=utf-8' }
    }
    case 'read_artifact': {
      const request = (args.request ?? {}) as { contentHash?: string }
      const artifact = state.artifacts.get(String(request.contentHash ?? ''))
      if (!artifact) throw new Error('Artifact 不存在')
      return {
        contentBase64: Buffer.from(artifact.content, 'utf8').toString('base64'),
        contentHash: String(request.contentHash),
        sizeBytes: artifact.sizeBytes,
        recoveredFromTrash: false,
      }
    }
    case 'pick_and_authorize_workspace': {
      const path = state.pickQueue.shift() ?? (await mkdtemp(join(state.root, 'picked-')))
      await mkdir(path, { recursive: true })
      const workspace: HostWorkspace = { path, name: basename(path), gitBranch: null }
      state.workspaces.set(path, workspace)
      state.activeWorkspacePath = path
      return workspace
    }
    case 'authorize_workspace': {
      const path = resolve(String(args.path))
      await stat(path)
      const workspace: HostWorkspace = { path, name: basename(path), gitBranch: null }
      state.workspaces.set(path, workspace)
      return workspace
    }
    case 'get_authorized_workspaces':
      return [...state.workspaces.values()]
    case 'get_authorized_workspace': {
      const active = state.activeWorkspacePath
      return active ? state.workspaces.get(active) ?? null : null
    }
    case 'activate_authorized_workspace': {
      const path = resolve(String(args.path))
      const workspace = state.workspaces.get(path)
      if (!workspace) throw new Error(`未授权的工作区：${path}`)
      state.activeWorkspacePath = path
      return workspace
    }
    case 'revoke_workspace': {
      const path = typeof args.path === 'string' ? resolve(args.path) : null
      if (path) state.workspaces.delete(path)
      else state.workspaces.clear()
      if (!path || state.activeWorkspacePath === path) state.activeWorkspacePath = null
      return true
    }
    case 'request_workspace_approval_lease': {
      const request = (args.request ?? {}) as Record<string, unknown>
      if (ctx.approvalPolicy === 'deny') {
        state.denied.push(String(request.toolName ?? ''))
        throw new Error('用户拒绝了本次操作')
      }
      const lease = `lease-${state.leases.size + 1}-${Date.now()}`
      if (ctx.approvalPolicy === 'auto') {
        state.leases.add(lease)
        state.approved.push(String(request.toolName ?? ''))
        return lease
      }
      // hold：等待用例经控制面显式允许/拒绝，覆盖审批卡片旅程。
      return new Promise<string>((settle, fail) => {
        state.approvals.set(lease, {
          request,
          resolve: () => {
            state.leases.add(lease)
            state.approved.push(String(request.toolName ?? ''))
            settle(lease)
          },
          reject: (error) => {
            state.denied.push(String(request.toolName ?? ''))
            fail(error)
          },
        })
      })
    }
    case 'create_workspace_text_file': {
      requireLease(state, args)
      const workspace = workspaceOf(state, args)
      const content = String(args.content ?? '')
      const target = inside(workspace.path, String(args.path))
      await mkdir(resolve(target, '..'), { recursive: true })
      await writeFile(target, content)
      return { workspace, path: String(args.path), sizeBytes: Buffer.byteLength(content), sha256: sha256(content) }
    }
    case 'run_workspace_command': {
      requireLease(state, args)
      const workspace = workspaceOf(state, args)
      const request = (args.request ?? {}) as { requestId?: string; command?: string; cwd?: string; timeoutMs?: number }
      const requestId = String(request.requestId ?? `cmd-${Date.now()}`)
      const result = await execInWorkspace(
        String(request.command ?? ''),
        inside(workspace.path, request.cwd ?? '.'),
        request.timeoutMs ?? 30_000,
      )
      ctx.emit(clientId, 'axiom:workspace-command', {
        requestId,
        stream: 'stdout',
        chunk: Array.from(new TextEncoder().encode(result.stdout)),
        done: false,
      })
      ctx.emit(clientId, 'axiom:workspace-command', {
        requestId,
        done: true,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdoutBytes: Buffer.byteLength(result.stdout),
        stderrBytes: Buffer.byteLength(result.stderr),
        truncated: false,
        cancelled: false,
        timedOut: false,
        sandboxed: true,
      })
      return null
    }
    case 'cancel_workspace_command':
    case 'cancel_model_http': {
      if (typeof args.requestId === 'string') state.cancelled.add(args.requestId)
      return true
    }
    case 'stream_model_http': {
      const request = (args.request ?? {}) as { requestId?: string }
      const requestId = String(request.requestId ?? `model-${Date.now()}`)
      const turn = state.turns.shift() ?? textTurn('（e2e 未设置脚本化响应，返回兜底文本）')
      ctx.emit(clientId, 'axiom:model-stream', { requestId, status: 200, done: false })
      for (const chunk of chunkBytes(turn, ctx.chunkSize)) {
        if (state.cancelled.has(requestId)) return null
        ctx.emit(clientId, 'axiom:model-stream', { requestId, chunk, done: false })
      }
      ctx.emit(clientId, 'axiom:model-stream', { requestId, done: true })
      return null
    }
    case 'find_workspace_files': {
      const workspace = workspaceOf(state, args)
      const request = (args.request ?? {}) as {
        pattern?: string
        path?: string
        limit?: number
        maxDepth?: number
      }
      const pattern = String(request.pattern ?? '*')
      const limit = request.limit ?? 500
      const rootPath = request.path ?? ''
      const root = inside(workspace.path, rootPath === '' ? '.' : rootPath)
      const matcher = globMatcher(pattern)
      const matches: { path: string; name: string; kind: 'file'; sizeBytes: number }[] = []
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (matches.length >= limit) return
        if (request.maxDepth !== undefined && depth > request.maxDepth) return
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch (error) {
          // 与 Rust 侧一致：根目录不存在时抛可识别的错误，由调用方（测试索引）降级为空集。
          if (missingDirectory(error)) throw new Error(`No such file or directory: ${rootPath || '.'}`)
          throw error
        }
        for (const entry of entries) {
          if (matches.length >= limit) return
          const full = join(dir, entry.name)
          if (entry.isDirectory()) {
            await walk(full, depth + 1)
            continue
          }
          if (!entry.isFile() || !matcher(entry.name)) continue
          const info = await stat(full)
          matches.push({
            path: relative(workspace.path, full).split(sep).join('/'),
            name: entry.name,
            kind: 'file',
            sizeBytes: info.size,
          })
        }
      }
      await walk(root, 1)
      return { workspace, pattern, rootPath, matches, truncated: matches.length >= limit }
    }
    case 'read_workspace_text': {
      const workspace = workspaceOf(state, args)
      const rel = String(args.path ?? '')
      const offset = Math.max(0, Number(args.offset ?? 0))
      const limit = Math.max(1, Number(args.limit ?? 2_000))
      const full = inside(workspace.path, rel)
      let raw: string
      try {
        raw = await readFile(full, 'utf8')
      } catch {
        throw new Error(`No such file or directory: ${rel}`)
      }
      // 行语义与 Rust 一致：offset 为 0 基行号，endLine 为 1 基最后一行。
      const lines = raw.split('\n')
      const selected = lines.slice(offset, offset + limit)
      const endLine = Math.min(lines.length, offset + selected.length)
      return {
        workspace,
        path: rel,
        content: selected.join('\n'),
        sha256: sha256(raw),
        startLine: offset + 1,
        endLine,
        totalLines: lines.length,
        truncated: endLine < lines.length,
      }
    }
    case 'list_test_environment_records':
      // 测试环境不在本旅程范围内；空集即可让扫描/运行走无环境覆盖分支。
      return []
    case 'latest_test_batch_record':
      // 页面加载时按批次回读最近运行；本旅程不跨批次断言，返回空即可。
      return null
    case 'create_test_run_record': {
      const run = (args.run ?? {}) as {
        id?: string
        specPath?: string
        specHash?: string
        planContentHash?: string
        environmentId?: string
        startedAt?: number
        cases?: {
          id: string
          caseId: string
          caseName: string
          steps: { id: string; stepId: string; action: string }[]
        }[]
      }
      const id = String(run.id)
      state.testRuns.set(id, {
        summary: {
          id,
          specPath: String(run.specPath ?? ''),
          specHash: String(run.specHash ?? ''),
          environmentId: run.environmentId ?? null,
          status: 'queued',
          startedAt: Number(run.startedAt ?? Date.now()),
          finishedAt: null,
        },
        planContentHash: run.planContentHash ?? null,
        cases: (run.cases ?? []).map((storedCase) => ({
          id: storedCase.id,
          caseId: storedCase.caseId,
          caseName: storedCase.caseName,
          status: 'queued',
          startedAt: null,
          finishedAt: null,
          failureKind: null,
          steps: storedCase.steps.map((step) => ({
            id: step.id,
            stepId: step.stepId,
            action: step.action,
            status: 'queued',
            startedAt: null,
            finishedAt: null,
            detailsJson: null,
            evidenceContentHash: null,
          })),
        })),
      })
      return null
    }
    case 'transition_test_run_record': {
      const run = state.testRuns.get(String(args.runId))
      if (!run) throw new Error(`测试运行记录不存在：${String(args.runId)}`)
      run.summary.status = args.status as TestRunStatus
      if (args.finishedAt !== null && args.finishedAt !== undefined) {
        run.summary.finishedAt = Number(args.finishedAt)
      }
      return null
    }
    case 'transition_test_case_record': {
      const record = findStoredCase(state, String(args.caseRunId))
      if (!record) throw new Error(`测试用例记录不存在：${String(args.caseRunId)}`)
      const status = args.status as TestRunStatus
      const now = Number(args.now ?? Date.now())
      if (status === 'running' && record.startedAt === null) record.startedAt = now
      if (TERMINAL_TEST_STATUS[status]) record.finishedAt = now
      if (typeof args.failureKind === 'string') record.failureKind = args.failureKind
      record.status = status
      return null
    }
    case 'transition_test_step_record': {
      const record = findStoredStep(state, String(args.stepRunId))
      if (!record) throw new Error(`测试步骤记录不存在：${String(args.stepRunId)}`)
      const status = args.status as TestRunStatus
      const now = Number(args.now ?? Date.now())
      if (status === 'running' && record.startedAt === null) record.startedAt = now
      if (TERMINAL_TEST_STATUS[status]) record.finishedAt = now
      if (typeof args.detailsJson === 'string') record.detailsJson = args.detailsJson
      if (typeof args.evidenceContentHash === 'string') record.evidenceContentHash = args.evidenceContentHash
      record.status = status
      return null
    }
    case 'list_test_run_records': {
      const summaries = [...state.testRuns.values()]
        .map((run) => run.summary)
        .sort((left, right) => right.startedAt - left.startedAt)
      return typeof args.limit === 'number' ? summaries.slice(0, args.limit) : summaries
    }
    case 'get_test_run_record': {
      const run = state.testRuns.get(String(args.runId))
      if (!run) return null
      return {
        summary: run.summary,
        planContentHash: run.planContentHash,
        // 证据本体留在 artifacts 表；报告只回引用所需字段，这里不回填图片内容。
        cases: run.cases.map((storedCase) => ({
          ...storedCase,
          steps: storedCase.steps.map((step) => ({ ...step, evidenceArtifact: null })),
        })),
      }
    }
    case 'issue_test_target_grant': {
      const request = (args.request ?? {}) as { runId?: string; tabId?: string; expectedOrigin?: string }
      const runId = String(request.runId ?? '')
      const origin = String(request.expectedOrigin ?? '')
      state.testTargets.set(runId, { tabId: String(request.tabId ?? ''), origin })
      return { runId, tabId: String(request.tabId ?? ''), origin, workspaceGeneration: 1, viewport: null }
    }
    case 'revoke_test_target_grant':
      state.testTargets.delete(String(args.runId))
      return true
    case 'issue_test_step_lease': {
      const request = (args.request ?? {}) as { runId?: string; stepId?: string }
      if (!request.runId || !request.stepId) throw new Error('测试步骤租约请求缺少 runId/stepId')
      const leaseId = `test-lease-${state.testStepLeases.size + 1}-${Date.now()}`
      state.testStepLeases.add(leaseId)
      return { leaseId, ttlMs: 30_000 }
    }
    case 'run_ui_write_step': {
      const request = (args.request ?? {}) as {
        leaseId?: string
        stepId?: string
        action?: { action?: string; locator?: Record<string, unknown> }
      }
      const leaseId = String(request.leaseId ?? '')
      if (!state.testStepLeases.has(leaseId)) {
        throw new Error(`测试步骤租约无效或已被消费：${leaseId || '(空)'}`)
      }
      // 单次消费：与 Rust 一致，重复执行同一租约必须失败而不是静默通过。
      state.testStepLeases.delete(leaseId)
      const action = request.action ?? {}
      if (action.action !== 'ui.click' && action.action !== 'ui.input' && action.action !== 'ui.select') {
        throw new Error(`假宿主未实现 UI 写动作：${String(action.action)}`)
      }
      // 写动作同样要落到脚本化页面的真实元素上；未命中即 failed，不谎报通过。
      const matched = scriptedNodes(state.testPage, action.locator ?? {}).length > 0
      return matched
        ? { verdict: 'passed' }
        : { verdict: 'failed', message: `未找到写动作的目标元素：${String(request.stepId ?? '')}` }
    }
    case 'run_ui_read_step':
      return evaluateUiReadStep(state.testPage, (args.request ?? {}) as Record<string, unknown>)
    case 'capture_ui_evidence': {
      const content = `e2e-screenshot:${state.testPage.url}`
      const sizeBytes = Buffer.byteLength(content)
      const contentHash = sha256(content)
      state.artifacts.set(contentHash, { content, sizeBytes })
      return {
        artifact: { contentHash, mediaType: 'image/png', sizeBytes },
        width: 1280,
        height: 800,
      }
    }
    case 'browser_command': {
      const request = (args.request ?? {}) as { action?: string }
      switch (request.action) {
        case 'status':
        case 'ensureRunning':
          return {
            type: 'status',
            running: true,
            port: 9222,
            engine: 'chromium',
            headless: true,
            version: 'e2e-1.0',
            tabs: scriptedTabs().length,
          }
        case 'tabs':
          return { type: 'tabs', tabs: scriptedTabs() }
        case 'startScreencast':
          return { type: 'screencastStarted' }
        case 'stopScreencast':
          return { type: 'done' }
        default:
          throw new Error(`假宿主未实现浏览器动作：${String(request.action)}`)
      }
    }
    default:
      throw new Error(`假宿主未实现命令：${cmd}（需要时在 e2e/src/host/commands.ts 扩展）`)
  }
}

export type { ScriptedTurn }
