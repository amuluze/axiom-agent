import { describe, expect, it, vi } from 'vitest'
import type { AgentDelegationResult, AgentToolExecutionContext } from '@/agent/core/types'
import { SubAgentExecutionError } from '@/agent/subagent/contracts'
import { createInspectSubAgentTool } from './createInspectSubAgentTool'
import { createExamineSubAgentTool } from './createExamineSubAgentTool'
import { createReviewSubAgentTool } from './createReviewSubAgentTool'

const completedResult = (): AgentDelegationResult => ({
  status: 'completed',
  summary: '结论：通过',
  turns: 2,
  toolCalls: 4,
  modelRequests: 2,
  endReason: 'completed',
  durationMs: 800,
})

const createContext = (
  delegateAgent?: (request: { kind: string; task: string; scope?: string[] }) => Promise<AgentDelegationResult>,
): AgentToolExecutionContext => ({
  sessionId: 's',
  runId: 'r',
  toolCallId: 't',
  signal: new AbortController().signal,
  reportProgress: async () => undefined,
  ...(delegateAgent ? { delegateAgent: delegateAgent as never } : {}),
})

describe('createReviewerSubAgentTool 契约版本', () => {
  it('三个审查工具版本独立：inspect/examine v6（system prompt 双语模板 + 用户覆写），review v8（同批）', () => {
    expect(createInspectSubAgentTool().runtimeVersion).toBe('6')
    expect(createExamineSubAgentTool().runtimeVersion).toBe('6')
    expect(createReviewSubAgentTool().runtimeVersion).toBe('8')
  })
})

describe('review_subagent diff 通道', () => {
  const tool = createReviewSubAgentTool()

  it('diff 可选：不传合法、传字符串合法、超限拒绝', () => {
    expect(tool.validate({ task: '审查改动' })).toMatchObject({ ok: true })
    expect(tool.validate({ task: '审查改动', diff: '--- a\n+++ b' })).toMatchObject({ ok: true })
    expect(tool.validate({ task: '审查改动', diff: 42 })).toMatchObject({ ok: false })
    expect(tool.validate({ task: '审查改动', diff: 'x'.repeat(128 * 1024 + 1) })).toMatchObject({ ok: false })
  })

  it('diff 上限按 UTF-8 字节口径：CJK 字符数未超限但字节超限时拒绝', () => {
    // 43690 个 CJK 字符 = 131070 字节（未超 128 KiB）；43691 个 = 131073 字节（超限）。
    // 按旧字符口径两者都放行——diff 常含 CJK，字节才是子会话消息预算的真实口径。
    expect(tool.validate({ task: '审查改动', diff: '改'.repeat(43690) })).toMatchObject({ ok: true })
    expect(tool.validate({ task: '审查改动', diff: '改'.repeat(43691) })).toMatchObject({ ok: false })
    // 纯 ASCII 字符数与字节数一致：恰好 128 KiB 放行
    expect(tool.validate({ task: '审查改动', diff: 'x'.repeat(128 * 1024) })).toMatchObject({ ok: true })
  })

  it('diff 超限报错携带分批重委派回环指引：带实际上限与字节数、禁止降级为主 Agent 自查', () => {
    // 超限拒绝是失败现场最强信号位：只报事实不给恢复配方时模型会放弃委派、自查替代，
    // 独立审查门禁恰在大改动上失效——报错文本本身必须收口回环路径。
    const rejected = tool.validate({ task: '审查改动', diff: 'x'.repeat(128 * 1024 + 1) })
    if (rejected.ok) throw new Error('超限 diff 应被拒绝')
    expect(rejected.error).toContain('131072')
    expect(rejected.error).toContain('got 131073')
    expect(rejected.error).toContain('按文件拆成多批逐批重新委派')
    expect(rejected.error).toContain('不要因参数超限放弃委派')
  })

  it('task 超限报错携带回环指引：review 把内容导回 diff 通道，inspect/examine 引导全文给路径', () => {
    // diff 被拒后模型常改走 task 塞 spec/diff 全文——review 的报错必须把内容
    // 重新导回 diff 参数（分批），inspect/examine 无 diff 通道则引导给路径让子 Agent read。
    const reviewRejected = createReviewSubAgentTool().validate({ task: 'x'.repeat(8001) })
    if (reviewRejected.ok) throw new Error('超限 task 应被拒绝')
    expect(reviewRejected.error).toContain('at most 8000 characters (got 8001)')
    expect(reviewRejected.error).toContain('给出其工作区相对路径')
    expect(reviewRejected.error).toContain('放 diff 参数传入')

    const inspectRejected = createInspectSubAgentTool().validate({ task: 'x'.repeat(8001) })
    if (inspectRejected.ok) throw new Error('超限 task 应被拒绝')
    expect(inspectRejected.error).toContain('给出其工作区相对路径')
    expect(inspectRejected.error).not.toContain('diff 参数传入')
  })

  it('diff 经固定分节头追加进子任务文本，不进独立委派字段', async () => {
    let captured: { kind: string; task: string } | null = null as { kind: string; task: string } | null
    await tool.execute(
      { task: '审查登录重构', diff: '+ 新增一行' },
      createContext(async (request) => {
        captured = request as unknown as NonNullable<typeof captured>
        return completedResult()
      }),
    )
    expect(captured?.task).toContain('审查登录重构')
    expect(captured?.task).toContain('# 改动 diff（由父 Agent 提供）')
    expect(captured?.task.endsWith('+ 新增一行')).toBe(true)
    expect(Object.keys(captured ?? {})).not.toContain('diff')
  })

  it('不传 diff 时子任务文本追加「当前状态基准」说明（子 Agent 必须知道是降级审查）', async () => {
    let captured: { task: string } | null = null as { task: string } | null
    await tool.execute(
      { task: '审查改动' },
      createContext(async (request) => {
        captured = request as unknown as NonNullable<typeof captured>
        return completedResult()
      }),
    )
    expect(captured?.task).toContain('审查改动')
    expect(captured?.task).toContain('# 审查基准说明（由宿主附加）')
    expect(captured?.task).toContain('基于当前状态、未对照 diff')
    // 不出现 diff 分节头——两者互斥
    expect(captured?.task).not.toContain('# 改动 diff（由父 Agent 提供）')
  })

  it('空 diff 字符串等价于未提供（追加基准说明而非分节头）', async () => {
    let captured: { task: string } | null = null as { task: string } | null
    await tool.execute(
      { task: '审查改动', diff: '' },
      createContext(async (request) => {
        captured = request as unknown as NonNullable<typeof captured>
        return completedResult()
      }),
    )
    expect(captured?.task).toContain('# 审查基准说明（由宿主附加）')
    expect(captured?.task).not.toContain('# 改动 diff（由父 Agent 提供）')
  })

  it('无 diff 委派：会话有 workspace:execute 时父结果前置降级提醒，无该能力时不提醒', async () => {
    // 缺省（未传 capabilities，视为未授予命令执行）——不提醒，子任务仍带基准说明
    let content = ''
    await tool.execute({ task: '审查' }, createContext(async () => completedResult()))
      .then((result) => { content = result.content })
    expect(content.startsWith('[降级审查')).toBe(false)

    const withExecute = createReviewSubAgentTool({
      capabilities: ['workspace:read', 'workspace:execute', 'subagent:review'],
    })
    await withExecute.execute({ task: '审查' }, createContext(async () => completedResult()))
      .then((result) => { content = result.content })
    expect(content.startsWith('[降级审查：未携带 diff]')).toBe(true)
    expect(content).toContain('建议先用 bash 采集 git diff')

    // 携带 diff 时不提醒（完整审查）
    await withExecute.execute(
      { task: '审查', diff: '+ 改动' },
      createContext(async () => completedResult()),
    ).then((result) => { content = result.content })
    expect(content.startsWith('[降级审查')).toBe(false)
  })
})

describe('inspect/examine 不开放 diff 参数', () => {
  it.each([
    ['inspect_subagent', createInspectSubAgentTool],
    ['examine_subagent', createExamineSubAgentTool],
  ] as const)('%s 拒绝 diff 字段', (name, factory) => {
    const tool = factory()
    expect(tool.name).toBe(name)
    expect(tool.validate({ task: '审查 spec', diff: 'xxx' })).toMatchObject({ ok: false })
    expect(tool.inputSchema.properties).not.toHaveProperty('diff')
  })
})

describe('scope 纵深防御 fail-closed', () => {
  it.each([
    ['inspect_subagent', createInspectSubAgentTool],
    ['examine_subagent', createExamineSubAgentTool],
    ['review_subagent', createReviewSubAgentTool],
  ] as const)('%s execute 层任一条目规范化失败整体拒绝，不静默收窄', async (_name, factory) => {
    const tool = factory()
    // 绕过 validate 直调 execute（纵深防御路径）：混入一条 `..` 条目必须整体拒绝，
    // 而非静默丢弃该条目后以收窄的 scope 执行（fail-open）。
    const delegated = vi.fn(async () => completedResult())
    await expect(tool.execute(
      { task: '审查', scope: ['src', '../escape'] },
      createContext(delegated as never),
    )).rejects.toThrow('fail-closed')
    expect(delegated).not.toHaveBeenCalled()
  })
})

describe('breadth 档位与结构化 verdict', () => {
  const tool = createReviewSubAgentTool()

  it('breadth 校验：接受 light/standard/thorough，拒绝非法值并透传委派', async () => {
    expect(tool.validate({ task: 'x', breadth: 'thorough' })).toMatchObject({ ok: true })
    expect(tool.validate({ task: 'x', breadth: 'medium' })).toMatchObject({ ok: false })
    expect(tool.validate({ task: 'x', breadth: 42 })).toMatchObject({ ok: false })
    let captured: { breadth?: string } | null = null as { breadth?: string } | null
    await tool.execute(
      { task: '大审查', breadth: 'thorough' },
      createContext(async (request) => {
        captured = request as unknown as NonNullable<typeof captured>
        return completedResult()
      }),
    )
    expect(captured?.breadth).toBe('thorough')
  })

  it('不传 breadth 时不注入 breadth 字段', async () => {
    let captured: { breadth?: string } | null = null as { breadth?: string } | null
    await tool.execute(
      { task: '审查' },
      createContext(async (request) => {
        captured = request as unknown as NonNullable<typeof captured>
        return completedResult()
      }),
    )
    expect(captured?.breadth).toBeUndefined()
  })

  it('details.verdict 从结论解析：通过→pass、不通过→fail、格式漂移→unknown', async () => {
    const verdictOf = async (summary: string): Promise<unknown> => {
      let details: unknown
      await tool.execute(
        { task: '审查' },
        createContext(async () => ({ ...completedResult(), summary })),
      ).then((result) => { details = result.details })
      return (details as Record<string, unknown>).verdict
    }
    expect(await verdictOf('结论：通过\n- 依据：测试齐全')).toBe('pass')
    expect(await verdictOf('结论：不通过\n- 问题：…')).toBe('fail')
    expect(await verdictOf('审查发现若干问题但未按格式收口')).toBe('unknown')
  })

  it('partial 收口强制 verdict=unknown（结论可能不完整）', async () => {
    let details: unknown
    await tool.execute(
      { task: '审查' },
      createContext(async () => ({
        ...completedResult(),
        status: 'partial' as const,
        endReason: 'turn_limit' as const,
        summary: '结论：通过',
      })),
    ).then((result) => { details = result.details })
    expect((details as Record<string, unknown>).verdict).toBe('unknown')
  })
})

describe('软门禁收口提示（verdict notice）', () => {
  const tool = createReviewSubAgentTool()

  const contentOf = async (result: Omit<AgentDelegationResult, never>): Promise<string> => {
    let content = ''
    await tool.execute(
      { task: '审查' },
      createContext(async () => result),
    ).then((r) => { content = r.content })
    return content
  }

  it('fail 判定前置回环提示：问题闭环前不进入 finish，用户显式接受是唯一越门路径', async () => {
    const content = await contentOf({ ...completedResult(), summary: '结论：不通过\n- 问题：…' })
    expect(content.startsWith('[审查门禁：不通过]')).toBe(true)
    expect(content).toContain('不要进入 finish 收口')
    expect(content).toContain('结论：不通过')
  })

  it('pass 判定不加前缀（summary 本身以结论开头）', async () => {
    const content = await contentOf(completedResult())
    expect(content.startsWith('[审查门禁')).toBe(false)
    expect(content.startsWith('[判定未结构化]')).toBe(false)
  })

  it('completed 但格式漂移时提示通读全文；partial 保持原有未完整收口提示、不叠加判定前缀', async () => {
    const unknown = await contentOf({ ...completedResult(), summary: '发现若干问题但未按格式收口' })
    expect(unknown.startsWith('[判定未结构化]')).toBe(true)
    const partial = await contentOf({
      ...completedResult(),
      status: 'partial' as const,
      endReason: 'turn_limit' as const,
      summary: '结论：通过',
    })
    expect(partial.startsWith('[审查子任务未完整收口')).toBe(true)
    expect(partial.startsWith('[判定未结构化]')).toBe(false)
  })

  it('三个审查器同构：inspect/examine 的 fail 判定同样前置门禁提示', async () => {
    for (const factory of [createInspectSubAgentTool, createExamineSubAgentTool]) {
      let content = ''
      await factory().execute(
        { task: '审查' },
        createContext(async () => ({ ...completedResult(), summary: '结论：不通过' })),
      ).then((r) => { content = r.content })
      expect(content.startsWith('[审查门禁：不通过]')).toBe(true)
    }
  })
})

describe('审查预算中止恢复配方（对齐 explore）', () => {
  const tool = createReviewSubAgentTool()

  it('partial 收口追加收窄重审指引', async () => {
    let content = ''
    await tool.execute(
      { task: '审查' },
      createContext(async () => ({
        ...completedResult(),
        status: 'partial' as const,
        endReason: 'context_limit' as const,
        summary: '结论：通过',
      })),
    ).then((r) => { content = r.content })
    expect(content).toContain('[审查子任务未完整收口（context_limit）]')
    expect(content).toContain('审查预算已用尽：建议：基于已收集到的信息直接收口，或把 scope 收窄到未覆盖部分后重新委派')
    expect(content).toContain('重复同等规模的委派会更快耗尽父 run 配额')
  })

  it('预算耗尽且无总结的中止错误映射为带恢复配方的报错', async () => {
    await expect(
      tool.execute(
        { task: '审查' },
        createContext(async () => {
          throw new SubAgentExecutionError('子任务因预算耗尽中止（child_message_bytes）')
        }),
      ),
    ).rejects.toThrow(/子任务因预算耗尽中止（child_message_bytes）。建议：基于已收集到的信息直接收口，或把 scope 收窄到未覆盖部分后重新委派；重复同等规模的委派会更快耗尽父 run 配额/)
  })

  it('体量类中止（context_window/message_bytes）追加「diff 分批」定向指引：scope 收窄救不了大 diff', async () => {
    // diff 随首条 user message 每轮全量重发；小上下文窗口模型首轮即触顶。通用配方
    // 「收窄 scope 重委派」对此不对症——只有按文件分批才能降单次委派的消息体量。
    await expect(
      tool.execute(
        { task: '审查' },
        createContext(async () => {
          throw new SubAgentExecutionError('子任务因预算耗尽中止（child_context_window）')
        }),
      ),
    ).rejects.toThrow('把 diff 按文件拆成多批、每批 scope 收窄到对应文件逐批委派')
  })

  it('非体量类中止不附加分批 diff 指引；无 diff 通道的审查器（inspect）永不附加', async () => {
    const outputError = await tool.execute(
      { task: '审查' },
      createContext(async () => {
        throw new SubAgentExecutionError('子任务因预算耗尽中止（child_output_tokens）')
      }),
    ).catch((caught: unknown) => caught)
    expect((outputError as Error).message).not.toContain('按文件拆成多批')

    const inspectError = await createInspectSubAgentTool().execute(
      { task: '审查' },
      createContext(async () => {
        throw new SubAgentExecutionError('子任务因预算耗尽中止（child_message_bytes）')
      }),
    ).catch((caught: unknown) => caught)
    expect((inspectError as Error).message).not.toContain('按文件拆成多批')
  })

  it('轮次中止且无总结同样携带恢复配方', async () => {
    await expect(
      tool.execute(
        { task: '审查' },
        createContext(async () => {
          throw new SubAgentExecutionError('子任务因 turn_limit 中止且没有总结')
        }),
      ),
    ).rejects.toThrow(/turn_limit 中止且没有总结。建议：基于已收集到的信息直接收口/)
  })

  it('非预算类中止错误不追加恢复配方，原样透传', async () => {
    await expect(
      tool.execute(
        { task: '审查' },
        createContext(async () => {
          throw new SubAgentExecutionError('子任务执行失败：transport 断连')
        }),
      ),
    ).rejects.toThrow('子任务执行失败：transport 断连')
  })

  it('回流字节超阈值时 content 追加面向父模型的警告（对齐 explore）', async () => {
    let content = ''
    await tool.execute(
      { task: '审查' },
      createContext(async () => ({
        ...completedResult(),
        parentRunUsage: {
          calls: 2,
          modelRequests: 4,
          inputTokens: 1000,
          outputTokens: 500,
          costTotal: 0.01,
          returnedBytes: 100 * 1024,
        },
      })),
    ).then((r) => { content = r.content })
    expect(content).toContain('本父 run 的审查子结果已累计回流 100 KiB')
    expect(content).toContain('注意父上下文预算')
  })

  it('回流字节未超阈值时不追加警告', async () => {
    let content = ''
    await tool.execute(
      { task: '审查' },
      createContext(async () => ({
        ...completedResult(),
        parentRunUsage: {
          calls: 1,
          modelRequests: 2,
          inputTokens: 100,
          outputTokens: 50,
          costTotal: 0,
          returnedBytes: 1024,
        },
      })),
    ).then((r) => { content = r.content })
    expect(content).not.toContain('累计回流')
  })
})
