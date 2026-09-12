import { describe, expect, it } from 'vitest'
import { createFakeAgentEnvironment } from '@/agent/tools/__fixtures__/fakeAgentEnvironment'
import { BUILTIN_SUBAGENTS } from './builtinSubAgents'
import {
  SUBAGENT_READ_MAX_LINES,
  SUBAGENT_READONLY_TOOL_FACTORIES,
  SUBAGENT_READONLY_TOOL_NAMES,
  createSubAgentReadonlyTools,
} from './readonlyTools'

describe('subagent readonlyTools 单一来源', () => {
  it('派生 NAMES 与工厂表声明顺序一致（独立期望，防止工厂表被改错）', () => {
    expect(SUBAGENT_READONLY_TOOL_NAMES)
      .toEqual(['read', 'ls', 'grep', 'find', 'web_search', 'web_fetch'])
  })

  it('工厂表工具名唯一', () => {
    const names = SUBAGENT_READONLY_TOOL_FACTORIES.map((factory) => factory.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('createSubAgentReadonlyTools 产出的工具名与 NAMES 一致', () => {
    const tools = createSubAgentReadonlyTools(createFakeAgentEnvironment())
    expect(tools.map((tool) => tool.name)).toEqual([...SUBAGENT_READONLY_TOOL_NAMES])
  })

  it('read 选项收窄默认行数并在描述中如实声明', () => {
    const readTool = createSubAgentReadonlyTools(
      createFakeAgentEnvironment(),
      { read: { maxLines: SUBAGENT_READ_MAX_LINES } },
    ).find((tool) => tool.name === 'read')
    expect(readTool?.description).toContain('100 lines')
    expect(readTool?.description).not.toContain('200 lines')
    // 缺省构造保持主 Agent 默认（200 行），不漂移
    const defaultRead = createSubAgentReadonlyTools(createFakeAgentEnvironment())
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
