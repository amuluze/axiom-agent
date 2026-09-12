import { describe, expect, it, vi } from 'vitest'
import type {
  AgentDelegationResult,
  AgentToolExecutionContext,
} from '@/agent/core/types'
import { SubAgentExecutionError } from '@/agent/subagent/contracts'
import { createExploreSubAgentTool } from './createExploreSubAgentTool'

const tool = createExploreSubAgentTool()

const createContext = (
  delegateAgent?: (request: { kind: 'explore'; task: string; scope?: string[]; breadth?: string }) => Promise<AgentDelegationResult>,
): AgentToolExecutionContext => ({
  sessionId: 's',
  runId: 'r',
  toolCallId: 't',
  signal: new AbortController().signal,
  reportProgress: async () => undefined,
  ...(delegateAgent ? { delegateAgent: delegateAgent as never } : {}),
})

describe('createExploreSubAgentTool', () => {
  it('task/scope 严格校验，additionalProperties=false', () => {
    expect(tool.validate({ task: 'x' })).toMatchObject({ ok: true })
    expect(tool.validate({})).toMatchObject({ ok: false })
    expect(tool.validate({ task: '' })).toMatchObject({ ok: false })
    expect(tool.validate({ task: 'x', scope: 'not-array' })).toMatchObject({ ok: false })
    expect(tool.validate({ task: 'x', extra: 1 })).toMatchObject({ ok: false })
    expect(tool.validate({ task: 'x'.repeat(8001) })).toMatchObject({ ok: false })
  })

  it('scope 每项校验：拒绝绝对路径、..、Windows 盘符、空值、超过 16 项', () => {
    expect(tool.validate({ task: 'x', scope: ['src/a.ts'] })).toMatchObject({ ok: true })
    expect(tool.validate({ task: 'x', scope: ['/abs'] })).toMatchObject({ ok: false })
    expect(tool.validate({ task: 'x', scope: ['../up'] })).toMatchObject({ ok: false })
    expect(tool.validate({ task: 'x', scope: ['C:\\win'] })).toMatchObject({ ok: false })
    expect(tool.validate({ task: 'x', scope: [''] })).toMatchObject({ ok: false })
    expect(tool.validate({ task: 'x', scope: Array.from({ length: 17 }, (_, i) => `p${i}`) }))
      .toMatchObject({ ok: false })
  })

  it('scope 拒绝规范化后为空的 . / ./（不得静默降级为全工作区）', () => {
    expect(tool.validate({ task: 'x', scope: ['.'] })).toMatchObject({ ok: false })
    expect(tool.validate({ task: 'x', scope: ['./'] })).toMatchObject({ ok: false })
    // 路径中的 . 分段仍被移除，保留其余部分。
    expect(tool.validate({ task: 'x', scope: ['./src/'] })).toMatchObject({ ok: true })
  })

  it('不接受 maxTurns/maxToolCalls input', () => {
    expect(tool.validate({ task: 'x', maxTurns: 100 })).toMatchObject({ ok: false })
    expect(tool.validate({ task: 'x', maxToolCalls: 100 })).toMatchObject({ ok: false })
  })

  it('task 超限报错携带回环指引：给路径让子 Agent 自行 read，不引导放弃委派', () => {
    const rejected = tool.validate({ task: 'x'.repeat(8001) })
    if (rejected.ok) throw new Error('超限 task 应被拒绝')
    expect(rejected.error).toContain('at most 8000 characters (got 8001)')
    expect(rejected.error).toContain('给出其工作区相对路径')
    expect(rejected.error).toContain('自行 read')
  })

  it('scope 纵深防御 fail-closed：execute 层任一条目规范化失败整体拒绝，不静默收窄', async () => {
    // 绕过 validate 直调 execute（纵深防御路径）：混入一条 `..` 条目必须整体拒绝，
    // 而非静默丢弃该条目后以收窄的 scope 执行（与三个审查工具同语义）。
    const delegated = vi.fn(async () => ({
      status: 'completed' as const,
      summary: 'ok',
      turns: 1,
      toolCalls: 1,
      modelRequests: 1,
      endReason: 'completed' as const,
      durationMs: 1,
    }))
    await expect(tool.execute(
      { task: 'x', scope: ['src', '../escape'] },
      createContext(delegated as never),
    )).rejects.toThrow('fail-closed')
    expect(delegated).not.toHaveBeenCalled()
  })

  it('breadth 参数校验：接受 light/standard/thorough，拒绝非法值', () => {
    expect(tool.validate({ task: 'x', breadth: 'light' })).toMatchObject({ ok: true })
    expect(tool.validate({ task: 'x', breadth: 'standard' })).toMatchObject({ ok: true })
    expect(tool.validate({ task: 'x', breadth: 'thorough' })).toMatchObject({ ok: true })
    expect(tool.validate({ task: 'x', breadth: 'medium' })).toMatchObject({ ok: false })
    expect(tool.validate({ task: 'x', breadth: 42 })).toMatchObject({ ok: false })
  })

  it('execute 透传 breadth 到 delegateAgent', async () => {
    let captured: { breadth?: string } | null = null as { breadth?: string } | null
    await tool.execute(
      { task: '探索', breadth: 'thorough' },
      createContext(async (req) => {
        captured = req as unknown as NonNullable<typeof captured>
        return {
          status: 'completed' as const,
          summary: '结论',
          turns: 1,
          toolCalls: 1,
          modelRequests: 1,
          endReason: 'completed' as const,
          durationMs: 100,
        }
      }),
    )
    expect(captured?.breadth).toBe('thorough')
  })

  it('execute 不传 breadth 时不注入 breadth 字段', async () => {
    let captured: { breadth?: string } | null = null as { breadth?: string } | null
    await tool.execute(
      { task: '探索' },
      createContext(async (req) => {
        captured = req as unknown as NonNullable<typeof captured>
        return {
          status: 'completed' as const,
          summary: '结论',
          turns: 1,
          toolCalls: 1,
          modelRequests: 1,
          endReason: 'completed' as const,
          durationMs: 100,
        }
      }),
    )
    expect(captured?.breadth).toBeUndefined()
  })

  it('delegate 缺失时抛错', async () => {
    await expect(tool.execute({ task: 'x' }, createContext())).rejects.toThrow('不支持 SubAgent')
  })

  it('completed：返回结构化 content/details，不泄露子消息全文', async () => {
    const result = await tool.execute(
      { task: '探索', scope: ['src'] },
      createContext(async () => ({
        status: 'completed',
        summary: '结论：src/a.ts 包含核心逻辑',
        turns: 3,
        toolCalls: 5,
        modelRequests: 3,
        endReason: 'completed',
        durationMs: 1200,
      })),
    )
    expect(result.content).toContain('src/a.ts 包含核心逻辑')
    expect(result.details).toMatchObject({
      status: 'completed',
      endReason: 'completed',
      turns: 3,
      toolCalls: 5,
      modelRequests: 3,
    })
    // details 不含子消息全文或 transport
    expect(JSON.stringify(result.details)).not.toContain('transport')
    expect(JSON.stringify(result.details)).not.toContain('子消息')
  })

  it('partial 状态显式标注并携带收窄重试指引', async () => {
    const result = await tool.execute(
      { task: 'x' },
      createContext(async () => ({
        status: 'partial',
        summary: '部分证据',
        turns: 8,
        toolCalls: 10,
        modelRequests: 8,
        endReason: 'turn_limit',
        durationMs: 900,
      })),
    )
    expect(result.content).toContain('[探索子任务未完整收口（turn_limit）]')
    expect(result.content).toContain('部分证据')
    // 预算中止必须携带恢复配方，避免父模型同规模盲目重试烧光父 run 配额
    expect(result.content).toContain('scope 收窄到未覆盖部分后重新委派')
  })

  it('预算耗尽且无总结的中止错误映射为带恢复配方的报错', async () => {
    await expect(
      tool.execute(
        { task: 'x' },
        createContext(async () => {
          throw new SubAgentExecutionError('子任务因预算耗尽中止（child_message_bytes）')
        }),
      ),
    ).rejects.toThrow(/子任务因预算耗尽中止（child_message_bytes）。建议：基于已收集到的信息直接收口，或把 scope 收窄到未覆盖部分后重新委派；重复同等规模的委派会更快耗尽父 run 配额/)
  })

  it('轮次中止且无总结同样携带恢复配方', async () => {
    await expect(
      tool.execute(
        { task: 'x' },
        createContext(async () => {
          throw new SubAgentExecutionError('子任务因 turn_limit 中止且没有总结')
        }),
      ),
    ).rejects.toThrow(/turn_limit 中止且没有总结。建议：基于已收集到的信息直接收口/)
  })

  it('非预算类中止错误不追加恢复配方，原样透传', async () => {
    await expect(
      tool.execute(
        { task: 'x' },
        createContext(async () => {
          throw new SubAgentExecutionError('子任务执行失败：transport 断连')
        }),
      ),
    ).rejects.toThrow('子任务执行失败：transport 断连')
  })

  it('summary 超过 64 KiB 时 content 截断并携带完整 artifactContent', async () => {
    const longSummary = 'x'.repeat(70 * 1024)
    const result = await tool.execute(
      { task: 'x' },
      createContext(async () => ({
        status: 'completed',
        summary: longSummary,
        turns: 1,
        toolCalls: 1,
        modelRequests: 1,
        endReason: 'completed',
        durationMs: 100,
      })),
    )
    expect(result.content.length).toBe(64 * 1024)
    expect(result.artifactContent).toBe(longSummary)
  })

  it('scope 规范化：移除 . 与尾随 /', async () => {
    const received = await new Promise<{ scope?: string[] }>((resolve) => {
      void tool.execute(
        { task: 'x', scope: ['./src/', 'pkg/'] },
        createContext(async (request) => {
          resolve(request)
          return {
            status: 'completed',
            summary: 'ok',
            turns: 1,
            toolCalls: 1,
            modelRequests: 1,
            endReason: 'completed',
            durationMs: 1,
          }
        }),
      )
    })
    expect(received.scope).toEqual(['src', 'pkg'])
  })

  it('Runtime error 抛错进入执行层 isError；Provider 错误分类映射为提示', async () => {
    await expect(
      tool.execute(
        { task: 'x' },
        createContext(async () => {
          throw new SubAgentExecutionError('child failed', 'authentication')
        }),
      ),
    ).rejects.toThrow('认证失败')
  })

  it('details 携带 parentRunUsage 累计计费快照', async () => {
    const result = await tool.execute(
      { task: '探索' },
      createContext(async () => ({
        status: 'completed',
        summary: '结论',
        turns: 2,
        toolCalls: 3,
        modelRequests: 2,
        endReason: 'completed',
        durationMs: 500,
        parentRunUsage: {
          calls: 1,
          modelRequests: 2,
          inputTokens: 100,
          outputTokens: 50,
          costTotal: 0.01,
          returnedBytes: 1024,
        },
      })),
    )
    expect(result.details).toMatchObject({
      parentRunUsage: {
        calls: 1,
        inputTokens: 100,
        outputTokens: 50,
        returnedBytes: 1024,
      },
    })
  })

  it('回流字节超阈值时 content 追加面向父模型的警告', async () => {
    const result = await tool.execute(
      { task: '探索' },
      createContext(async () => ({
        status: 'completed',
        summary: '结论',
        turns: 1,
        toolCalls: 1,
        modelRequests: 1,
        endReason: 'completed',
        durationMs: 100,
        parentRunUsage: {
          calls: 2,
          modelRequests: 10,
          inputTokens: 1000,
          outputTokens: 500,
          costTotal: 0.05,
          returnedBytes: 100 * 1024,
        },
      })),
    )
    expect(result.content).toContain('⚠')
    expect(result.content).toContain('累计回流')
    expect(result.content).toContain('100 KiB')
  })

  it('回流字节未超阈值时不追加警告', async () => {
    const result = await tool.execute(
      { task: '探索' },
      createContext(async () => ({
        status: 'completed',
        summary: '结论',
        turns: 1,
        toolCalls: 1,
        modelRequests: 1,
        endReason: 'completed',
        durationMs: 100,
        parentRunUsage: {
          calls: 1,
          modelRequests: 1,
          inputTokens: 10,
          outputTokens: 5,
          costTotal: 0,
          returnedBytes: 1024,
        },
      })),
    )
    expect(result.content).not.toContain('⚠')
    expect(result.content).not.toContain('累计回流')
  })

  it('promptGuidelines 引导父模型：scope 必须是授权工作区内相对路径', () => {
    expect(tool.promptGuidelines?.join('\n')).toContain('scope 必须是当前授权工作区内的相对路径')
    expect(tool.promptGuidelines?.join('\n')).toContain('先提示用户切换/授权工作区')
    expect(tool.description).toContain('resolved against the authorized workspace root')
  })
})
