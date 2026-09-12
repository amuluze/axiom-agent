import type { AgentCapability } from '@/config/runtimePolicy'
import type { AgentTool, JsonValue, ProviderErrorKind, SubAgentKind } from '@/agent/core/types'
import { hasOnlyKeys, isJsonObject } from '@/agent/tools/workspaceToolUtils'
import { normalizeScopeEntry } from '@/agent/subagent/scopedReadEnvironment'
import { formatTaskOverflowError, MAX_TASK_LENGTH } from '@/agent/subagent/taskOverflowNotice'
import {
  BUDGET_ABORT_GUIDANCE,
  budgetPartialGuidance,
  isBudgetAbortError,
} from '@/agent/subagent/budgetAbortNotice'
import { SubAgentExecutionError } from '@/agent/subagent/contracts'
import { parseReviewerVerdict } from './reviewerCommon'

const MAX_SCOPE_ITEMS = 16
/** 最终 summary 内联部分；超出放 artifactContent 由父 externalizeToolResult 外化为 Artifact。 */
const SUMMARY_INLINE_LIMIT = 64 * 1024
/**
 * 父 run 累计回流字节软警告阈值（96 KiB ≈ 24K tokens，约为 128K–200K context window
 * 的 12–18%）。SDD 流程 inspect→examine→review 多次审查回流累积，超出后在 content
 * 追加面向父模型的警告，让其判断是否继续消耗父 run 配额（对齐 explore 同款警告）。
 */
const RETURNED_BYTES_SOFT_WARN = 96 * 1024

/** diff 参数追加进子任务首条 user message 时的固定分隔头。 */
const DIFF_SECTION_HEADER = '\n\n# 改动 diff（由父 Agent 提供）\n\n'

/**
 * 软门禁收口提示：fail 判定时前置到父工具结果。SDD 门禁链路没有运行时硬阻断
 * （硬门禁会造成「审查不过→僵局」，阶段推进刻意保持软约束），但「不通过后直接
 * finish」此前只靠系统提示词静态约束——这里把回环指令放进工具结果这一模型必读
 * 的最强信号位，随每次 fail 判定即时投递。用户显式接受风险继续是唯一合法越门路径。
 */
const FAIL_VERDICT_NOTICE =
  '[审查门禁：不通过] 本次审查未通过。按问题清单回到上一阶段修复后重新委派审查；问题闭环前不要进入 finish 收口（文档对齐、提交推送）。若用户明确决定接受风险继续，须先向用户说明未通过的审查结论。\n\n'

/** completed 但结论格式漂移无法结构化解析时，提示父 Agent 通读全文自行判定。 */
const UNKNOWN_VERDICT_NOTICE =
  '[判定未结构化] 未能从下方结论文本解析出「通过/不通过」，请通读全文自行判定后再决定下一步。\n\n'

/**
 * review 未携带 diff 时追加进子任务文本的基准说明：子 Agent 必须知道自己看不到
 * 「改动前」状态，否则会把降级审查误当作完整审查收口。与 diff 分节头同通道
 * （不进 AgentDelegationRequest），能力无关——无论父 Agent 为何未带 diff，
 * 子 Agent 的审查基准事实相同。
 */
const NO_DIFF_TASK_NOTE =
  '\n\n# 审查基准说明（由宿主附加）\n\n本次委派未附 diff 分节。以 read 复核的当前文件状态为审查基准：不要推断改动前的状态，也不要假设任务未提及的文件未被改动；结论中注明「基于当前状态、未对照 diff」。'

/**
 * 父结果侧降级提醒，仅当会话已授予 workspace:execute 时前置——有命令执行能力却
 * 未携带 diff 属可避免的降级。未授予该能力时 diff 本就无法采集（提示词安全边界段
 * 已声明降级指引），不再重复提醒（不宣传不存在的工具）。
 */
const DIFF_DOWNGRADE_NOTICE =
  '[降级审查：未携带 diff] 本次审查以当前文件状态为基准，未对照改动前后差异。本会话已授予命令执行能力——建议先用 bash 采集 git diff（超限按文件分批）携带 diff 参数重新委派，结论更可靠。\n\n'

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

const truncateSummary = (summary: string, maxBytes: number): { content: string; truncated: boolean } => {
  const encoded = new TextEncoder().encode(summary)
  if (encoded.byteLength <= maxBytes) return { content: summary, truncated: false }
  let end = maxBytes
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1
  return { content: new TextDecoder().decode(encoded.subarray(0, end)), truncated: true }
}

/** UTF-8 字节长度——与子会话消息预算（maxMessageBytes）同口径。 */
const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength

/**
 * 审查类 SubAgent 工具工厂：inspect/examine/review 三者的 validate/execute 完全同构
 * （委派只读审查 + summary 截断 + verdict 解析 + Provider 错误映射），仅 kind/名称/
 * 文案/diff 通道不同。breadth 档位与 explore 同语义（映射不同 child 预算，父 run
 * 累计预算不变）：light 适合单文件小审，thorough 适合大规模 Spec/跨文件审查。
 */
interface ReviewerToolSpec {
  kind: Extract<SubAgentKind, 'inspect' | 'examine' | 'review'>
  toolName: string
  /** 各工具独立契约版本（改 schema/语义时各自 bump，见 toolNameMigrations.ts）。 */
  runtimeVersion: string
  label: string
  promptSnippet: string
  promptGuidelines: string[]
  description: string
  /**
   * 可选 diff 参数上限：子 Agent 无 bash/git，审查代码改动的工具（review）需要
   * 父 Agent 直接携带 diff 文本才能看到「改了什么」，仅靠 task 意图描述会形成
   * diff 盲区。spec 类审查（inspect/examine）读文件即可对账，不开放该参数。
   */
  diffMaxLength?: number
  /**
   * 当前运行时授予的能力集（registry 透传）：review 无 diff 委派的父结果降级
   * 提醒按 workspace:execute 分化。缺省视为未授予（不提醒，保守侧）。
   */
  capabilities?: readonly AgentCapability[]
}

export const createReviewerSubAgentTool = (spec: ReviewerToolSpec): AgentTool => ({
  name: spec.toolName,
  label: spec.label,
  promptSnippet: spec.promptSnippet,
  promptGuidelines: spec.promptGuidelines,
  runtimeVersion: spec.runtimeVersion,
  recoveryPolicy: 'never',
  requiresApproval: false,
  executionMode: 'sequential',
  description: spec.description,
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_TASK_LENGTH,
        description: 'The review task. Must include the object to review and all context the sub-agent needs.',
      },
      scope: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: MAX_SCOPE_ITEMS,
        description: 'Workspace-relative paths the sub-agent is allowed to read. When omitted, the whole authorized workspace is allowed.',
      },
      ...(spec.diffMaxLength !== undefined
        ? {
          diff: {
            type: 'string',
            maxLength: spec.diffMaxLength,
            description: `Unified diff of the changes under review, at most ${spec.diffMaxLength} UTF-8 bytes. The sub-agent has no bash/git, so pass the diff text here instead of describing it in task.`,
          },
        }
        : {}),
      breadth: {
        type: 'string',
        enum: ['light', 'standard', 'thorough'],
        description: 'Review depth. light: single-file or small focused review (fewer turns). standard: default balanced review. thorough: large spec or cross-file audit (more turns, faster parent budget consumption). Defaults to standard.',
      },
    },
    required: ['task'],
    additionalProperties: false,
  },
  validate: (input) => {
    if (!isJsonObject(input) || !hasOnlyKeys(input, spec.diffMaxLength !== undefined ? ['task', 'scope', 'diff', 'breadth'] : ['task', 'scope', 'breadth'])) {
      return { ok: false, error: `Arguments must be an object with only ${spec.diffMaxLength !== undefined ? 'task, scope, diff, breadth' : 'task, scope, breadth'}.` }
    }
    if (typeof input.task !== 'string' || !input.task.trim()) {
      return { ok: false, error: 'task must be a non-empty string.' }
    }
    if (input.task.length > MAX_TASK_LENGTH) {
      // review 的 diff 被拒后模型常改走 task 塞全文——尾巴把内容重新导回 diff 通道。
      const overflow = formatTaskOverflowError(input.task.length)
      return spec.diffMaxLength !== undefined
        ? { ...overflow, error: `${overflow.error} 改动差异不经 task，放 diff 参数传入；diff 本身超限时按文件拆成多批逐批委派。` }
        : overflow
    }
    if (spec.diffMaxLength !== undefined && input.diff !== undefined) {
      if (typeof input.diff !== 'string') {
        return { ok: false, error: 'diff must be a string.' }
      }
      // 字节口径（非 JS 字符数）：diff 常含 CJK（每字符最多 3 字节），按字符数放行
      // 会让实际字节接近上限的 3 倍，吞掉子会话 512 KiB 单请求消息预算的余量。
      const diffBytes = utf8ByteLength(input.diff)
      if (diffBytes > spec.diffMaxLength) {
        // 超限拒绝是「分批重委派」唯一能触达模型的强信号位：静态指引在提示词里、
        // 离失败现场太远，报错只给事实不给恢复配方时，模型倾向选最省事的退出路径
        // （改由主 Agent 自查替代委派）——独立审查门禁恰在大改动上静默失效。
        return {
          ok: false,
          error: `diff must be at most ${spec.diffMaxLength} bytes (UTF-8), got ${diffBytes}. 把 diff 按文件拆成多批逐批重新委派：每批携带该批 diff 并将 scope 收窄到对应文件；不要因参数超限放弃委派、改由主 Agent 自查代替独立审查。`,
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
    return { ok: true, value: input }
  },
  execute: async (input, context) => {
    if (!isJsonObject(input) || typeof input.task !== 'string') {
      throw new Error(`Invalid ${spec.toolName} arguments.`)
    }
    if (!context.delegateAgent) {
      throw new Error('当前宿主不支持 SubAgent 委派')
    }
    // diff 只经固定分隔头追加进子任务文本——不进 AgentDelegationRequest，子会话
    // 的消息组装（SubAgentRuntime）保持与 explore 完全同构。未携带 diff 时追加
    // 基准说明（子 Agent 必须知道本次是「当前状态基准」的降级审查）。
    const diff = spec.diffMaxLength !== undefined && typeof input.diff === 'string' && input.diff.length > 0
      ? input.diff
      : undefined
    const task = diff
      ? `${input.task}${DIFF_SECTION_HEADER}${diff}`
      : spec.diffMaxLength !== undefined
        ? `${input.task}${NO_DIFF_TASK_NOTE}`
        : input.task
    const breadth = input.breadth === 'light' || input.breadth === 'standard' || input.breadth === 'thorough'
      ? input.breadth
      : undefined
    const rawScope = Array.isArray(input.scope) ? input.scope : undefined
    let scope: string[] | undefined
    if (rawScope) {
      // 纵深防御 fail-closed：任一条目规范化失败即整体拒绝，不静默收窄 scope
      // （validate 已逐项拦截非法条目，这里兜住绕过 validate 的直调路径）。
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
    try {
      const result = await context.delegateAgent({
        kind: spec.kind,
        task,
        ...(scope && scope.length > 0 ? { scope } : {}),
        ...(breadth ? { breadth } : {}),
      })
      const partialNotice = result.status === 'partial'
        ? `[审查子任务未完整收口（${result.endReason}）]\n\n`
        : ''
      // 预算中止（partial）的恢复配方：收口已有证据或收窄 scope 重审，
      // 避免父模型以同等规模盲目重试烧光父 run 配额（对齐 explore 同款指引）。
      const partialGuidance = result.status === 'partial'
        ? budgetPartialGuidance('审查')
        : ''
      // 无 diff 降级提醒仅对开放 diff 通道的工具（review）且会话有命令执行能力时
      // 前置（可避免的降级才值得提醒）；verdict notice 只在 completed 时判定
      //（partial 的 verdict 恒为 unknown，由 partialNotice 承担提示职责，避免双重前缀）。
      const diffDowngradeNotice = spec.diffMaxLength !== undefined
        && diff === undefined
        && spec.capabilities?.includes('workspace:execute')
        ? DIFF_DOWNGRADE_NOTICE
        : ''
      const verdict = result.status === 'completed' ? parseReviewerVerdict(result.summary) : 'unknown'
      const verdictNotice = verdict === 'fail'
        ? FAIL_VERDICT_NOTICE
        : verdict === 'unknown' && result.status === 'completed'
          ? UNKNOWN_VERDICT_NOTICE
          : ''
      // 回流字节软警告：SDD 全链路多次审查回流累积，让父模型判断是否
      // 值得继续消耗父 run 配额（对齐 explore 的 RETURNED_BYTES_SOFT_WARN）。
      const returnedBytes = result.parentRunUsage?.returnedBytes
      const overflowWarn =
        typeof returnedBytes === 'number' && returnedBytes >= RETURNED_BYTES_SOFT_WARN
          ? `\n\n⚠ 本父 run 的审查子结果已累计回流 ${Math.round(returnedBytes / 1024)} KiB，注意父上下文预算；后续审查结果可能触发父会话压缩。`
          : ''
      const { content: truncated, truncated: isTruncated } = truncateSummary(
        result.summary,
        SUMMARY_INLINE_LIMIT,
      )
      const details: { [key: string]: JsonValue } = {
        status: result.status,
        // 结构化判定（pass/fail/unknown）：partial 中途收口或结论格式漂移时为
        // unknown，父 Agent 回退到阅读 summary 全文做决策。
        verdict,
        endReason: result.endReason,
        turns: result.turns,
        toolCalls: result.toolCalls,
        modelRequests: result.modelRequests,
        durationMs: result.durationMs,
        ...(result.parentRunUsage ? { parentRunUsage: result.parentRunUsage } : {}),
      }
      return {
        content: `${diffDowngradeNotice}${verdictNotice}${partialNotice}${partialGuidance}${truncated}${overflowWarn}`,
        ...(isTruncated ? { artifactContent: result.summary } : {}),
        details,
      }
    } catch (error) {
      if (error instanceof SubAgentExecutionError && error.providerErrorKind) {
        throw new Error(PROVIDER_ERROR_HINT[error.providerErrorKind] ?? error.message)
      }
      // 预算类中止无 providerErrorKind：失败现场是模型看到的唯一信号，
      // 必须携带恢复配方，避免盲目同规模重试烧光父 run 配额（对齐 explore）。
      if (error instanceof SubAgentExecutionError && isBudgetAbortError(error.message)) {
        // 体量类中止（context_window/message_bytes）在 diff 通道工具上有专门对症配方：
        // scope 收窄救不了过大的 diff——diff 随首条 user message 每轮全量重发，只有
        // 按文件分批才能把单次委派的消息体量降下来（小上下文窗口模型首轮即触顶）。
        const bulkExhaustionHint = spec.diffMaxLength !== undefined
          && /child_context_window|child_message_bytes/.test(error.message)
          ? ' 本次中止与消息体量相关：若委派携带了大段 diff，把 diff 按文件拆成多批、每批 scope 收窄到对应文件逐批委派。'
          : ''
        throw new Error(`${error.message}。${BUDGET_ABORT_GUIDANCE}${bulkExhaustionHint}`)
      }
      throw error
    }
  },
})
