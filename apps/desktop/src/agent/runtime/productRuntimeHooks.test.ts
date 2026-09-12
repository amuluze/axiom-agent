import type { AgentTurnSnapshot } from '@/agent/core/runAgentLoop'
import type {
  AgentContext,
  AgentTool,
  AssistantMessage,
  ModelRequest,
  ModelStreamEvent,
  ModelTransport,
} from '@/agent/core/types'
import { describe, expect, it } from 'vitest'
import { AgentSession } from './AgentSession'
import { AgentHarness } from './AgentHarness'
import {
  createProductRuntimeHooks,
  DESKTOP_RUNTIME_HOOK_REGISTRATION,
  registerProductRuntimeHooks,
} from './productRuntimeHooks'
import { buildSystemPrompt } from './productToolRuntime'

class DesktopCompactionTransport implements ModelTransport {
  readonly requests: ModelRequest[] = []

  requestByteLength = (request: ModelRequest): number =>
    request.systemPrompt.includes('上下文压缩器')
      || request.messages.some((message) => message.id.startsWith('context-summary:'))
      ? 1_000
      : 1_900_000

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(structuredClone(request))
    yield { type: 'start' }
    yield { type: 'text_delta', delta: '## 目标\n保留桌面会话目标\n\n## 后续步骤\n1. 继续' }
    yield { type: 'done', stopReason: 'stop' }
  }
}

const assistant: AssistantMessage = {
  id: 'assistant',
  role: 'assistant',
  content: 'done',
  toolCalls: [],
  stopReason: 'stop',
  createdAt: 2,
}

const BASE_PROMPT = 'BASE'

const tool = (
  name: string,
  snippet: string | undefined,
  guidelines: string[] | undefined,
): AgentTool =>
  ({
    name,
    label: name,
    description: '',
    runtimeVersion: '1',
    inputSchema: {},
    promptSnippet: snippet,
    promptGuidelines: guidelines,
  }) as unknown as AgentTool

const DISCOVER = 'discover_agent_tools'
const READ = tool('read', '读取文件。', ['优先用 read。'])
const WRITE = tool('write', '创建文件。', ['write 专属准则。'])
const ALL_TOOLS: AgentTool[] = [tool(DISCOVER, '搜索工具。', undefined), READ, WRITE]

// 与 hooks() 组装一致地传入 gitBranchPrefix：候选重建与当前提示词必须同源，
// 否则「内容一致不返回 systemPrompt」不变量恒假（见 productRuntimeHooks 注释）。
const GIT_BRANCH_PREFIX = 'feat-'

/**
 * 构造测试上下文。systemPromptActiveNames 决定提示词正文反映的激活集
 * （默认与 activeToolNames 一致）；当二者不同时即模拟"工具已激活但提示词
 * 尚未回流"的真实中间态（activateToolResults 只改 activeToolNames）。
 */
const context = (
  activeToolNames: string[],
  systemPromptActiveNames?: string[],
): AgentContext => ({
  sessionId: 'session-1',
  systemPrompt: buildSystemPrompt({
    basePrompt: BASE_PROMPT,
    tools: ALL_TOOLS,
    activeToolNames: systemPromptActiveNames ?? activeToolNames,
    gitBranchPrefix: GIT_BRANCH_PREFIX,
  }),
  model: { provider: 'provider', model: 'model' },
  messages: [assistant],
  tools: ALL_TOOLS,
  activeToolNames,
})

const snapshot = (
  activeToolNames: string[],
  systemPromptActiveNames?: string[],
  hasTemporarySystemPrompt?: boolean,
): AgentTurnSnapshot => ({
  message: assistant,
  toolResults: [],
  context: context(activeToolNames, systemPromptActiveNames),
  newMessages: [assistant],
  messages: [assistant],
  turn: 1,
  toolCalls: 0,
  hasTemporarySystemPrompt,
})

const hooks = () => createProductRuntimeHooks({
  sessionId: 'session-1',
  discoveryToolName: DISCOVER,
  getBasePrompt: () => BASE_PROMPT,
  gitBranchPrefix: GIT_BRANCH_PREFIX,
})

describe('productRuntimeHooks', () => {
  it('derives the sealed dependency set from identified registrations', async () => {
    const harness = new AgentHarness({
      sessionId: 'session-hooks',
      systemPrompt: 'system',
      model: { provider: 'provider', model: 'model' },
      transport: new DesktopCompactionTransport(),
      tools: [],
    })
    const cleanup = registerProductRuntimeHooks(harness.hooks, {
      sessionId: 'session-hooks',
      discoveryToolName: DISCOVER,
      getBasePrompt: () => BASE_PROMPT,
    })
    harness.addCleanup(cleanup)
    harness.hooks.seal()

    expect(harness.hooks.dependencies()).toEqual([{
      id: DESKTOP_RUNTIME_HOOK_REGISTRATION.id,
      version: DESKTOP_RUNTIME_HOOK_REGISTRATION.version,
      fingerprint: expect.any(String),
    }])
    expect(cleanup).toThrow('已封存')
    await expect(harness.dispose()).resolves.toBeUndefined()
  })

  it('repairs the product invariant that tool discovery remains active', () => {
    // discover 缺失：rescue 补回 discover。discover 的 snippet 因此回流，
    // 故连同 systemPrompt 一起返回（rescue 与回流在此自然合一）。
    const result = hooks().prepareNextTurn(snapshot(['read'], ['read']))
    expect(result).toBeDefined()
    expect(result!.activeToolNames).toEqual([DISCOVER, 'read'])
    expect(result!.systemPrompt).toContain('搜索工具。')
    // 工具集稳定且 discover 已在：维持不变
    expect(hooks().prepareNextTurn(snapshot([DISCOVER, 'read']))).toBeUndefined()
  })

  it('reflows newly-activated tool guidelines into the system prompt', () => {
    // activeToolNames 已含 write（activateToolResults 之后），但提示词正文
    // 仍只反映 discover+read（激活前的状态）：重建后应回流 write 准则
    const result = hooks().prepareNextTurn(
      snapshot([DISCOVER, 'read', 'write'], [DISCOVER, 'read']),
    )
    expect(result).toBeDefined()
    expect(result!.systemPrompt).toContain('# 可用能力')
    expect(result!.systemPrompt).toContain('write 专属准则。')
    // discover 已在集合中，不应重复 rescue
    expect(result!.activeToolNames).toEqual([DISCOVER, 'read', 'write'])
  })

  it('omits guidelines of tools that are not active', () => {
    // 仅 discover+read 激活时，write 的准则不应出现在重建后的提示词
    const result = hooks().prepareNextTurn(snapshot([DISCOVER, 'read'], ['read']))
    expect(result!.systemPrompt).not.toContain('write 专属准则。')
  })

  it('reload 后 prepare_next_turn 读取最新 getBasePrompt，不缓存旧 basePrompt（docs §10.1 回归）', () => {
    // 模拟 reload 替换 prompt source：首次 basePrompt 为 'BASE'，reload 后更新为
    // 含新 `<available_skills>` 的 basePrompt。触发 discover 激活新工具时，重建
    // 候选必须基于最新 getBasePrompt()，否则新注入的 available_skills 被旧 base
    // 重拼静默冲掉（改造前此测试必败，改造后必过）。
    let currentBasePrompt = BASE_PROMPT
    const h = createProductRuntimeHooks({
      sessionId: 'session-1',
      discoveryToolName: DISCOVER,
      getBasePrompt: () => currentBasePrompt,
      gitBranchPrefix: GIT_BRANCH_PREFIX,
    })
    currentBasePrompt = `${BASE_PROMPT}\n\n# 项目上下文\n项目技能：当任务匹配时调用 load_skill。\n\n<available_skills>\n  <skill source="project"><name>pdf-tools</name></skill>\n</available_skills>`
    const result = h.prepareNextTurn(snapshot(['read'], ['read']))
    expect(result?.systemPrompt).toContain('<available_skills>')
    expect(result?.systemPrompt).toContain('搜索工具。')
  })

  it('does not return systemPrompt when the tool set is unchanged', () => {
    // 提示词与当前一致：不返回 systemPrompt（避免误清 temporarySystemPrompt）
    const result = hooks().prepareNextTurn(snapshot([DISCOVER, 'read']))
    expect(result?.systemPrompt).toBeUndefined()
  })

  it('preserves the Git branch rule across tool reflow', () => {
    // 回归：重建候选必须与原始组装一致地携带 gitBranchPrefix，否则回流会
    // 静默剥离「严禁 main 分支提交」安全规则（既有缺陷）。激活集变化触发
    // 回流时，候选仍应包含 # Git 分支规则 段。
    const result = hooks().prepareNextTurn(
      snapshot([DISCOVER, 'read', 'write'], [DISCOVER, 'read']),
    )
    expect(result).toBeDefined()
    expect(result!.systemPrompt).toContain('# Git 分支规则')
    expect(result!.systemPrompt).toContain('严禁在 main 或 master 分支上执行 git commit 或 git push')
    expect(result!.systemPrompt).toContain('feat-')
  })

  it('skips reflow when a temporary system prompt override is active', () => {
    // 临时覆盖生效（before_agent_start.systemPrompt）：即便激活集变化（write 已激活、
    // 提示词正文滞后），也不重建 systemPrompt，仅做 discovery rescue。
    // 返回 undefined 因 discover 已在集合中——不冲掉用户的临时覆盖。
    const result = hooks().prepareNextTurn(
      snapshot([DISCOVER, 'read', 'write'], [DISCOVER, 'read'], true),
    )
    expect(result).toBeUndefined()
  })

  it('still rescues discovery under a temporary system prompt override', () => {
    // 临时覆盖下 discover 缺失：仅 rescue activeToolNames，不触碰 systemPrompt
    const result = hooks().prepareNextTurn(snapshot(['read'], ['read'], true))
    expect(result).toEqual({ activeToolNames: [DISCOVER, 'read'] })
    expect(result?.systemPrompt).toBeUndefined()
  })

  it('fails closed when branch-summary hooks cross a session or source boundary', () => {
    const hooks = createProductRuntimeHooks({
      sessionId: 'session-1',
      discoveryToolName: DISCOVER,
      getBasePrompt: () => BASE_PROMPT,
      gitBranchPrefix: GIT_BRANCH_PREFIX,
    })
    const controller = new AbortController()
    expect(() => hooks.beforeBranchSummary?.({
      sessionId: 'session-2',
      messages: [assistant],
      model: { provider: 'provider', model: 'model' },
      signal: controller.signal,
    })).toThrow('跨会话上下文')
    expect(() => hooks.afterBranchSummary?.({
      sessionId: 'session-1',
      messages: [assistant],
      model: { provider: 'provider', model: 'model' },
      signal: controller.signal,
      result: {
        content: 'summary',
        sourceFromMessageId: 'wrong',
        sourceThroughMessageId: assistant.id,
        readFiles: [],
        modifiedFiles: [],
      },
      replaced: false,
    })).toThrow('来源边界漂移')
  })

  it('allows a real compaction to cross the desktop before/after hook boundary', async () => {
    const transport = new DesktopCompactionTransport()
    const hooks = createProductRuntimeHooks({
      sessionId: 'session-compaction',
      discoveryToolName: DISCOVER,
      getBasePrompt: () => BASE_PROMPT,
      gitBranchPrefix: GIT_BRANCH_PREFIX,
    })
    const session = new AgentSession({
      sessionId: 'session-compaction',
      systemPrompt: 'system',
      model: { provider: 'provider', model: 'model' },
      transport,
      messages: [
        { id: 'user-old', role: 'user', content: 'old goal', createdAt: 1 },
        { ...assistant, id: 'assistant-old' },
      ],
      beforeCompaction: hooks.beforeCompaction,
      afterCompaction: hooks.afterCompaction,
    })

    await session.compact()

    expect(transport.requests).toHaveLength(1)
    expect(session.checkpoint).toMatchObject({
      sessionId: 'session-compaction',
      modelProvider: 'provider',
      modelId: 'model',
      throughMessageId: 'user-old',
    })
  })
})
