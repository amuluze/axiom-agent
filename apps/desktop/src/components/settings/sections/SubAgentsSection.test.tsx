import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReadTool } from '@/agent/tools/readTool'
import { createLsTool } from '@/agent/tools/lsTool'
import { createGrepTool } from '@/agent/tools/grepTool'
import { createFindTool } from '@/agent/tools/findTool'
import { createWebSearchTool } from '@/agent/tools/webSearchTool'
import { createWebFetchTool } from '@/agent/tools/webFetchTool'
import { createFakeAgentEnvironment } from '@/agent/tools/__fixtures__/fakeAgentEnvironment'
import { BUILTIN_SUBAGENTS } from '@/agent/subagent/builtinSubAgents'
import { SubAgentsSection } from './SubAgentsSection'

const mocks = vi.hoisted(() => ({
  capabilities: [] as string[],
  emptyCatalog: false,
}))

// getter 形式：mock 工厂只在模块加载时执行一次，测试运行时重赋值 mocks.capabilities /
// mocks.emptyCatalog 需通过 getter 每次访问求值，否则组件读到加载时的快照。
vi.mock('@/config/runtimePolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/runtimePolicy')>()
  return {
    ...actual,
    RUNTIME_POLICY: {
      ...actual.RUNTIME_POLICY,
      get toolCapabilities() {
        return mocks.capabilities
      },
    },
  }
})

vi.mock('@/agent/subagent/builtinSubAgents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/subagent/builtinSubAgents')>()
  return {
    ...actual,
    get BUILTIN_SUBAGENTS() {
      return mocks.emptyCatalog ? [] : actual.BUILTIN_SUBAGENTS
    },
  }
})

afterEach(() => {
  mocks.capabilities = []
  mocks.emptyCatalog = false
})

describe('SubAgentsSection', () => {
  it('renders all four sub-agents with budget and active state when capability is granted', () => {
    mocks.capabilities = ['workspace:read', 'subagent:explore', 'subagent:review']
    const html = renderToStaticMarkup(createElement(SubAgentsSection))
    expect(html).toContain('id="settings-subagents"')
    expect(html).toContain('内置子智能体')
    expect(html).toContain('4 个')
    expect(html).toContain('Explore')
    expect(html).toContain('探索子 Agent')
    expect(html).toContain('Inspect')
    expect(html).toContain('审查 Task Spec')
    expect(html).toContain('Examine')
    expect(html).toContain('检查实施方案')
    expect(html).toContain('Review')
    expect(html).toContain('复核代码改动')
    expect(html).toContain('settings__subagent-kind')
    expect(html).toContain('已启用')
    expect(html).toContain('discover_agent_tools')
    expect(html).toContain('允许工具：read、ls、grep、find')
    // 子会话预算
    expect(html).toContain('16 轮')
    expect(html).toContain('48 次工具')
    expect(html).toContain('240 秒')
    expect(html).toContain('16,384 tokens')
    expect(html).toContain('512 KiB 消息')
    expect(html).toContain('64 KiB 内联结果')
    // 父 run 预算（全链路 SDD 3 次委派 + 返工重审余量）
    expect(html).toContain('8 次调用')
    expect(html).toContain('120 次模型请求')
    expect(html).toContain('900 秒')
    expect(html).toContain('runtime v10')
    expect(html).toContain('sequential')
  })

  it('marks the sub-agent as inactive when capabilities are not granted', () => {
    mocks.capabilities = ['web:read']
    const html = renderToStaticMarkup(createElement(SubAgentsSection))
    expect(html).toContain('未启用')
    expect(html).toContain('需同时授予 workspace:read 与 subagent:explore 后才会注册该工具。')
    expect(html).toContain('需同时授予 workspace:read 与 subagent:review 后才会注册该工具。')
    expect(html).not.toContain('已启用')
  })

  it('shows the empty state when no built-in sub-agent exists', () => {
    mocks.emptyCatalog = true
    const html = renderToStaticMarkup(createElement(SubAgentsSection))
    expect(html).toContain('暂无内置子智能体。')
    expect(html).toContain('0 个')
    expect(html).not.toContain('settings__subagent-item')
  })
})

describe('BuiltinSubAgents catalog drift guard', () => {
  it('catalog allowedTools matches SubAgentRuntime child tool names', () => {
    // 防止 SubAgentRuntime.buildChildContext 改了子工具集但忘了同步 catalog 硬编码。
    const env = createFakeAgentEnvironment({})
    const expectedNames = [
      createReadTool(env).name,
      createLsTool(env).name,
      createGrepTool(env).name,
      createFindTool(env).name,
      createWebSearchTool(env).name,
      createWebFetchTool(env).name,
    ]
    const explore = BUILTIN_SUBAGENTS.find((sub) => sub.kind === 'explore')
    expect(explore).toBeDefined()
    expect(explore!.allowedTools).toEqual(expectedNames)
  })
})
