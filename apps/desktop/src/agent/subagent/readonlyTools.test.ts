import { describe, expect, it } from 'vitest'
import { createFakeAgentEnvironment } from '@/agent/tools/__fixtures__/fakeAgentEnvironment'
import { BUILTIN_SUBAGENTS } from './builtinSubAgents'
import {
  SUBAGENT_READ_MAX_LINES,
  SUBAGENT_READONLY_TOOL_FACTORIES,
  SUBAGENT_READONLY_TOOL_NAMES,
  createSubAgentReadonlyTools,
  readonlyToolsSection,
} from './readonlyTools'

describe('subagent readonlyTools 单一来源', () => {
  it('派生 NAMES 与工厂表声明顺序一致（独立期望，防止工厂表被改错）', () => {
    expect(SUBAGENT_READONLY_TOOL_NAMES)
      .toEqual(['read', 'ls', 'grep', 'find'])
  })

  it('子代理工具表不含任何 *_subagent：委派不可嵌套', () => {
    // 不可嵌套由两处**隐式**保证：工具表不含 delegate 类工具，且子循环不传
    // runDelegate。任一处被改（把 delegate 加进工厂表 / 给子循环传入 delegate）
    // 都会静默开放嵌套委派并让子委派再取一次父 run 配额。此处把前半条钉死。
    expect(SUBAGENT_READONLY_TOOL_NAMES.some((name) => name.endsWith('_subagent'))).toBe(false)
    const tools = createSubAgentReadonlyTools(createFakeAgentEnvironment(), {
      parentActiveToolNames: [...SUBAGENT_READONLY_TOOL_NAMES],
    })
    expect(tools.map((tool) => tool.name)).toEqual([...SUBAGENT_READONLY_TOOL_NAMES])
  })

  it('提示词工具段从工厂表派生：增删工具后清单自动跟随', () => {
    const section = readonlyToolsSection('zh-CN')
    for (const name of SUBAGENT_READONLY_TOOL_NAMES) {
      expect(section).toContain(`- ${name}：`)
    }
    // 不得出现工厂表之外的工具名——这正是此前文案漂移的形态
    // （宣称有 web_search/web_fetch，而工厂表里从来没有）。
    const mentioned = [...section.matchAll(/^- ([a-z_]+)：/gm)].map((match) => match[1])
    expect(mentioned.sort()).toEqual([...SUBAGENT_READONLY_TOOL_NAMES].sort())
  })

  it('en 工具段使用英文说明', () => {
    const section = readonlyToolsSection('en')
    expect(section).toContain('- read: read file contents')
    expect(section).toContain('- grep: search text within the workspace')
    expect(section).not.toContain('读取文件内容')
  })

  it('工厂表工具名唯一', () => {
    const names = SUBAGENT_READONLY_TOOL_FACTORIES.map((factory) => factory.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('createSubAgentReadonlyTools 产出的工具名与 NAMES 一致', () => {
    const tools = createSubAgentReadonlyTools(createFakeAgentEnvironment(), { parentActiveToolNames: SUBAGENT_READONLY_TOOL_NAMES })
    expect(tools.map((tool) => tool.name)).toEqual([...SUBAGENT_READONLY_TOOL_NAMES])
  })

  it('read 选项收窄默认行数并在描述中如实声明', () => {
    const readTool = createSubAgentReadonlyTools(
      createFakeAgentEnvironment(),
      { parentActiveToolNames: SUBAGENT_READONLY_TOOL_NAMES, read: { maxLines: SUBAGENT_READ_MAX_LINES } },
    ).find((tool) => tool.name === 'read')
    expect(readTool?.description).toContain('100 lines')
    expect(readTool?.description).not.toContain('200 lines')
    // 缺省构造保持主 Agent 默认（200 行），不漂移
    const defaultRead = createSubAgentReadonlyTools(createFakeAgentEnvironment(), { parentActiveToolNames: SUBAGENT_READONLY_TOOL_NAMES })
      .find((tool) => tool.name === 'read')
    expect(defaultRead?.description).toContain('200 lines')
  })

  it('BUILTIN_SUBAGENTS 展示元数据与运行时权威常量一致', () => {
    // 锁死：设置页展示的 allowedTools 必须与子代理实际可用的只读工具集同源，
    // 防止展示与运行时行为漂移。
    for (const agent of BUILTIN_SUBAGENTS) {
      expect(agent.allowedTools).toEqual([...SUBAGENT_READONLY_TOOL_NAMES])
    }
  })
})
