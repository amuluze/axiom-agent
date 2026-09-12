import type { AgentTool, JsonValue } from '@/agent/core/types'
import { hasOnlyKeys, isJsonObject } from '@/agent/tools/workspaceToolUtils'
import { normalizeScopeEntry } from '@/agent/subagent/scopedReadEnvironment'
import { formatTaskOverflowError, MAX_TASK_LENGTH } from '@/agent/subagent/taskOverflowNotice'
import {
  BUDGET_ABORT_GUIDANCE,
  budgetPartialGuidance,
  isBudgetAbortError,
} from '@/agent/subagent/budgetAbortNotice'
import { SubAgentExecutionError } from '@/agent/subagent/contracts'
import type { ProviderErrorKind } from '@/agent/core/types'

const MAX_SCOPE_ITEMS = 16
/** 最终 summary 内联部分；超出放 artifactContent 由父 externalizeToolResult 外化为 Artifact。 */
const SUMMARY_INLINE_LIMIT = 64 * 1024
/**
 * 父 run 累计回流字节软警告阈值（96 KiB ≈ 24K tokens，约为 128K–200K context window
 * 的 12–18%）。超出后在 content 追加面向父模型的警告，让其判断是否继续消耗父 run 配额。
 */
const RETURNED_BYTES_SOFT_WARN = 96 * 1024

/** child Provider 错误分类 → 面向模型的父工具结果提示（只透传分类，不透传敏感 body）。 */
const PROVIDER_ERROR_HINT: Record<ProviderErrorKind, string> = {
  authentication: '子任务因 Provider 认证失败中止，请检查 Key 后再决定是否重试',
  rate_limit: '子任务因 Provider 限流中止，稍后再试',
  server: '子任务因 Provider 过载中止，稍后再试',
  network: '子任务因网络错误中止',
  invalid_request: '子任务因 Provider 错误中止（invalid_request）',
  unknown: '子任务因 Provider 错误中止（unknown）',
  context_overflow: '子任务因上下文溢出中止',
}

/**
 * 按 UTF-8 字节截断 summary。String.slice 按 code unit 会切断 surrogate pair / 多字节
 * 序列；这里回退到完整 UTF-8 序列边界，避免生成孤立 surrogate 或 replacement char。
 */
const truncateSummary = (summary: string, maxBytes: number): { content: string; truncated: boolean } => {
  const encoded = new TextEncoder().encode(summary)
  if (encoded.byteLength <= maxBytes) return { content: summary, truncated: false }
  let end = maxBytes
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1
  return { content: new TextDecoder().decode(encoded.subarray(0, end)), truncated: true }
}

export const createExploreSubAgentTool = (): AgentTool => ({
  name: 'explore_subagent',
  label: '探索子 Agent',
  promptSnippet:
    '委派一个只读探索子 Agent，跨工作区范围收集证据并返回结构化总结（结论、调用链、风险、path:line 证据）。',
  promptGuidelines: [
    '优先用于跨目录、多文件或 codebase-wide 的只读分析；让子 Agent 独立收敛证据，不占用父上下文轮次。',
    '若当前任务预计需要读取 3 个及以上文件，或需要 broad search，先调用 discover_agent_tools({ query: "explore" }) 激活本工具。',
    'scope 是运行时强制边界，超出范围读取会失败；task 必须包含子任务所需的全部上下文。',
    'scope 必须是当前授权工作区内的相对路径；任务目标不在授权工作区内时，先提示用户切换/授权工作区，不要引用工作区外路径。',
    '子 Agent 只读，不能写文件、执行命令或请求审批。',
    '探索因预算中止返回 partial 或报错时：基于已有证据直接收口，或把 scope 收窄到未覆盖部分后重新委派；不要以同等规模重复委派（配额按父 run 累计，大范围重试会更快触顶）。',
  ],
  runtimeVersion: '10',
  recoveryPolicy: 'never',
  requiresApproval: false,
  executionMode: 'sequential',
  description:
    'Delegates a read-only exploration sub-agent that searches the authorized workspace within an optional scope and returns a structured summary (conclusion, call chain, risks, path:line evidence). The sub-agent only uses read/ls/grep/find/web_search/web_fetch; scope is a hard runtime boundary, and scope paths are resolved against the authorized workspace root. Returns completed or partial (when budget-constrained).',
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_TASK_LENGTH,
        description: 'The exploration task. Must include all context needed by the sub-agent.',
      },
      scope: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: MAX_SCOPE_ITEMS,
        description: 'Workspace-relative paths the sub-agent is allowed to read. When omitted, the whole authorized workspace is allowed.',
      },
      breadth: {
        type: 'string',
        enum: ['light', 'standard', 'thorough'],
        description: 'Exploration breadth. light: locate/confirm a specific item (fewer turns). standard: default balanced search. thorough: comprehensive audit (more turns, faster parent budget consumption). Defaults to standard.',
      },
    },
    required: ['task'],
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, ['task', 'scope', 'breadth'])) {
      return { ok: false, error: 'Arguments must be an object with only task, scope, breadth.' }
    }
    if (typeof input.task !== 'string' || !input.task.trim()) {
      return { ok: false, error: 'task must be a non-empty string.' }
    }
    if (input.task.length > MAX_TASK_LENGTH) {
      return formatTaskOverflowError(input.task.length)
    }
    if (input.scope !== undefined) {
      if (!Array.isArray(input.scope) || input.scope.length === 0 || input.scope.length > MAX_SCOPE_ITEMS) {
        return { ok: false, error: `scope must be 1-${MAX_SCOPE_ITEMS} relative paths.` }
      }
      for (const entry of input.scope) {
        if (typeof entry !== 'string' || normalizeScopeEntry(entry) === null) {
          return { ok: false, error: `scope entry is invalid: ${JSON.stringify(entry)}` }
        }
      }
    }
    if (
      input.breadth !== undefined
      && input.breadth !== 'light'
      && input.breadth !== 'standard'
      && input.breadth !== 'thorough'
    ) {
      return { ok: false, error: 'breadth must be one of: light, standard, thorough.' }
    }
    return { ok: true, value: input }
  },
  execute: async (input, context) => {
    if (!isJsonObject(input) || typeof input.task !== 'string') {
      throw new Error('Invalid explore_subagent arguments.')
    }
    if (!context.delegateAgent) {
      throw new Error('当前宿主不支持 SubAgent 委派')
    }
    const rawScope = Array.isArray(input.scope) ? input.scope : undefined
    let scope: string[] | undefined
    if (rawScope) {
      // 与三个审查工具同一纵深防御语义：任一条目规范化失败即整体拒绝，不静默丢弃。
      // 丢弃后照常执行会把「带越界条目的委派」变成「收窄范围静默跑通」，调用方无感知；
      // 非法条目（绝对路径/../盘符）在 validate 已逐项拦截，这里兜住绕过 validate 的直调路径。
      const invalid: string[] = []
      const normalized: string[] = []
      for (const entry of rawScope) {
        const value = typeof entry === 'string' ? normalizeScopeEntry(entry) : null
        if (!value || value.length === 0) invalid.push(JSON.stringify(entry))
        else normalized.push(value)
      }
      if (invalid.length > 0) {
        throw new Error(`scope 规范化失败，拒绝执行（fail-closed）：${invalid.join(', ')}`)
      }
      scope = normalized
    }
    const breadth = input.breadth === 'light' || input.breadth === 'standard' || input.breadth === 'thorough'
      ? input.breadth
      : undefined
    try {
      const result = await context.delegateAgent({
        kind: 'explore',
        task: input.task,
        ...(scope && scope.length > 0 ? { scope } : {}),
        ...(breadth ? { breadth } : {}),
      })
      const partialNotice = result.status === 'partial'
        ? `[探索子任务未完整收口（${result.endReason}）]\n\n`
        : ''
      const partialGuidance = result.status === 'partial'
        ? budgetPartialGuidance('探索')
        : ''
      const summary = result.summary
      const { content: truncated, truncated: isTruncated } = truncateSummary(
        summary,
        SUMMARY_INLINE_LIMIT,
      )
      // 回流字节软警告：直接进入父模型上下文（tool result content），让模型判断
      // 是否值得继续消耗父 run 配额发起下一次 Explore。
      const returnedBytes = result.parentRunUsage?.returnedBytes
      const overflowWarn =
        typeof returnedBytes === 'number' && returnedBytes >= RETURNED_BYTES_SOFT_WARN
          ? `\n\n⚠ 本父 run 的 Explore 子结果已累计回流 ${Math.round(returnedBytes / 1024)} KiB，注意父上下文预算；后续 Explore 结果可能触发父会话压缩。`
          : ''
      const details: { [key: string]: JsonValue } = {
        status: result.status,
        endReason: result.endReason,
        turns: result.turns,
        toolCalls: result.toolCalls,
        modelRequests: result.modelRequests,
        durationMs: result.durationMs,
        ...(result.parentRunUsage ? { parentRunUsage: result.parentRunUsage } : {}),
      }
      return {
        content: `${partialNotice}${truncated}${partialGuidance}${overflowWarn}`,
        ...(isTruncated ? { artifactContent: summary } : {}),
        details,
      }
    } catch (error) {
      if (error instanceof SubAgentExecutionError && error.providerErrorKind) {
        throw new Error(PROVIDER_ERROR_HINT[error.providerErrorKind] ?? error.message)
      }
      // 预算类中止无 providerErrorKind：失败现场是模型看到的唯一信号，
      // 必须携带恢复配方，避免盲目同规模重试烧光父 run 配额。
      if (error instanceof SubAgentExecutionError && isBudgetAbortError(error.message)) {
        throw new Error(`${error.message}。${BUDGET_ABORT_GUIDANCE}`)
      }
      throw error
    }
  },
})
