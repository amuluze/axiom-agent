import type { AgentLoopTurnUpdate, AgentTurnSnapshot } from '@/agent/core/runAgentLoop'
import { buildSystemPrompt } from './productToolRuntime'
import type { AgentHarnessHooks } from './AgentHarness'
import type { RuntimeHookRegistration } from './RuntimeHookRegistry'
import type { SummaryRuntimeHooks } from './summaryHooks'

/**
 * Runtime hook registration fingerprint persisted to SQLite.
 *
 * NOTE: this object's `id` / `version` / `source` fields are compatibility
 * fingerprints stored in the runtime dependency manifest. They MUST NOT change
 * across file renames, otherwise prior sessions can no longer be restored. The
 * file was renamed from `desktopRuntimeHooks.ts` to `productRuntimeHooks.ts`
 * without touching these values.
 */
export const DESKTOP_RUNTIME_HOOK_REGISTRATION: RuntimeHookRegistration = Object.freeze({
  id: 'axiom.desktop.runtime-hooks',
  version: '9',
  source: 'desktop',
  priority: 100,
  timeoutMs: 5_000,
})

export interface ProductRuntimeHooks extends SummaryRuntimeHooks {
  prepareNextTurn: (snapshot: AgentTurnSnapshot) => AgentLoopTurnUpdate | undefined
}

export interface ProductRuntimeHookOptions {
  sessionId: string
  discoveryToolName: string
  /**
   * 不含工具段的基准提示词 accessor（人设/安全边界/项目上下文/discovery 说明）。
   * 每次 prepare_next_turn 重建时**读取最新值**，不在注册闭包中缓存字符串——
   * 否则 reload（runtime_dependencies_update 替换 basePrompt source）后任何工具
   * 激活都会用旧 basePrompt 重拼 systemPrompt，静默冲掉新注入的 `<available_skills>`。
   * 来源是 agentStore 的 session-scoped prompt source（模块级 activeSessionBasePrompt）。
   */
  getBasePrompt: () => string
  /**
   * Git 分支前缀规则。重建候选提示词时必须与原始组装一致地带上，
   * 否则候选恒缺 `# Git 分支规则` 段，回流会静默剥离「严禁 main 分支提交」安全规则，
   * 并使「内容与现有一致时不返回 systemPrompt」的不变式恒假。
   */
  gitBranchPrefix?: string
}

const assertSession = (actual: string, expected: string, operation: string): void => {
  if (actual !== expected) throw new Error(`${operation} Runtime Hook 检测到跨会话上下文`)
}

/**
 * Product policy hooks: keep discovery reachable, reflow newly-activated tool
 * guidelines into the system prompt, and fail closed across summary boundaries.
 */
export const createProductRuntimeHooks = ({
  sessionId,
  discoveryToolName,
  getBasePrompt,
  gitBranchPrefix,
}: ProductRuntimeHookOptions): ProductRuntimeHooks => ({
  prepareNextTurn: (snapshot) => {
    assertSession(snapshot.context.sessionId, sessionId, 'prepareNextTurn')
    // 1) discovery rescue：discover 始终保持在激活集合首位
    const current = snapshot.context.activeToolNames ?? []
    const discoveryMissing = !current.includes(discoveryToolName)
    const activeToolNames = discoveryMissing
      ? [discoveryToolName, ...current]
      : current
    // 存在临时系统提示词覆盖时（如 before_agent_start.systemPrompt），用户已主动
    // 接管提示词：跳过基于静态 base 的重建，仅做 discovery rescue。否则重建会经
    // applyTurnUpdate 清掉 temporarySystemPrompt（systemPrompt !== undefined 分支），
    // 把用户的临时覆盖冲掉。工具准则回流在此让步。
    if (snapshot.hasTemporarySystemPrompt) {
      return discoveryMissing ? { activeToolNames } : undefined
    }
    // 2) 工具准则回流：按当前激活集重建候选提示词。
    //    内容与现有一致时绝不返回 systemPrompt——否则 applyTurnUpdate 会误清
    //    temporarySystemPrompt（systemPrompt !== undefined 分支）。
    const candidateSystemPrompt = buildSystemPrompt({
      basePrompt: getBasePrompt(),
      tools: snapshot.context.tools,
      activeToolNames,
      gitBranchPrefix,
    })
    const promptChanged = candidateSystemPrompt !== snapshot.context.systemPrompt
    if (!promptChanged) {
      // 提示词未变：仅在 discover 缺失时返回 rescue，否则维持不变
      return discoveryMissing ? { activeToolNames } : undefined
    }
    return { activeToolNames, systemPrompt: candidateSystemPrompt }
  },
  beforeCompaction: ({ request }) => {
    assertSession(request.sessionId, sessionId, 'Compaction')
    return undefined
  },
  afterCompaction: ({ request, result }) => {
    assertSession(request.sessionId, sessionId, 'Compaction')
    assertSession(result.request.sessionId, sessionId, 'Compaction result')
    if (result.checkpoint.modelProvider !== request.model.provider
      || result.checkpoint.modelId !== request.model.model) {
      throw new Error('Compaction Runtime Hook 检测到模型边界漂移')
    }
  },
  beforeBranchSummary: ({ sessionId: actualSessionId }) => {
    assertSession(actualSessionId, sessionId, 'Branch Summary')
    return undefined
  },
  afterBranchSummary: ({ sessionId: actualSessionId, messages, result }) => {
    assertSession(actualSessionId, sessionId, 'Branch Summary')
    const first = messages[0]
    const last = messages[messages.length - 1]
    if (!first || !last
      || result.sourceFromMessageId !== first.id
      || result.sourceThroughMessageId !== last.id) {
      throw new Error('Branch Summary Runtime Hook 检测到来源边界漂移')
    }
  },
})

export const registerProductRuntimeHooks = (
  harnessHooks: AgentHarnessHooks,
  options: ProductRuntimeHookOptions,
): (() => void) => {
  const hooks = createProductRuntimeHooks(options)
  const unregister = [
    harnessHooks.on(
      'prepare_next_turn',
      ({ snapshot }) => hooks.prepareNextTurn(snapshot),
      DESKTOP_RUNTIME_HOOK_REGISTRATION,
    ),
    harnessHooks.on(
      'before_compaction',
      (event) => hooks.beforeCompaction?.(event),
      DESKTOP_RUNTIME_HOOK_REGISTRATION,
    ),
    harnessHooks.on('after_compaction', async (event) => {
      await hooks.afterCompaction?.(event)
      return undefined
    }, DESKTOP_RUNTIME_HOOK_REGISTRATION),
    harnessHooks.on(
      'before_branch_summary',
      (event) => hooks.beforeBranchSummary?.(event),
      DESKTOP_RUNTIME_HOOK_REGISTRATION,
    ),
    harnessHooks.on('after_branch_summary', async (event) => {
      await hooks.afterBranchSummary?.(event)
      return undefined
    }, DESKTOP_RUNTIME_HOOK_REGISTRATION),
  ]
  return () => {
    for (const cleanup of unregister.reverse()) cleanup()
  }
}
