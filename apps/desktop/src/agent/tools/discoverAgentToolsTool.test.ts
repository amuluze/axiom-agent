import type { AgentTool } from '../core/types'
import { describe, expect, it } from 'vitest'
import { createDiscoverAgentToolsTool } from './discoverAgentToolsTool'

const tool = (name: string, label: string, description: string): AgentTool => ({
  name,
  runtimeVersion: '1',
  label,
  description,
  inputSchema: { type: 'object' },
  validate: (input) => ({ ok: true, value: input }),
  execute: async () => ({ content: 'unused' }),
})

const registry = [
  tool('read', 'read', 'Read a file in the authorized workspace'),
  tool('edit', 'edit', 'Edit a workspace file with oldText/newText'),
  tool('bash', 'bash', 'Run a structured command in the workspace'),
]

describe('discoverAgentToolsTool', () => {
  it('activates exact-name and natural-language matches deterministically', async () => {
    const discovery = createDiscoverAgentToolsTool(registry)
    await expect(discovery.execute({ query: 'edit' }, {
      sessionId: 'session',
      runId: 'run',
      toolCallId: 'call',
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
    })).resolves.toMatchObject({ addedToolNames: ['edit'] })

    await expect(discovery.execute({ query: 'bash', limit: 1 }, {
      sessionId: 'session',
      runId: 'run',
      toolCallId: 'call',
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
    })).resolves.toMatchObject({ addedToolNames: ['bash'] })
  })

  it('returns an empty discovery result without activating unknown tools', async () => {
    const discovery = createDiscoverAgentToolsTool(registry)
    await expect(discovery.execute({ query: 'deploy kubernetes cluster' }, {
      sessionId: 'session',
      runId: 'run',
      toolCallId: 'call',
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
    })).resolves.toEqual({
      content: 'No authorized tool matched "deploy kubernetes cluster" outside your currently active capabilities. Rephrase with a more specific capability.',
      details: { query: 'deploy kubernetes cluster', matches: [] },
    })
  })

  it('rejects unsafe or unbounded discovery parameters', () => {
    const discovery = createDiscoverAgentToolsTool(registry)
    expect(discovery.validate({ query: '', extra: true })).toEqual({
      ok: false,
      error: 'Arguments must be an object with only query and limit.',
    })
    expect(discovery.validate({ query: 'read', limit: 9 })).toEqual({
      ok: false,
      error: 'limit must be an integer between 1 and 8.',
    })
  })
})

describe('discoverAgentToolsTool — load_skill discoverability', () => {
  // 镜像真实 load_skill 的 snippet/guidelines 文案，验证恢复会话场景下
  // 模型经 discover 激活 load_skill 的打分路径（新会话默认激活，恢复会话需 discover）。
  const registryWithSkill: AgentTool[] = [
    ...registry,
    {
      name: 'load_skill',
      runtimeVersion: '1',
      label: '加载技能',
      description: 'Load the full body of a project skill that matches the current task.',
      promptSnippet: '加载一个项目技能（Skill）的完整正文。',
      promptGuidelines: ['load_skill 返回当前会话冻结的技能版本。'],
      inputSchema: { type: 'object' },
      validate: (input) => ({ ok: true, value: input }),
      execute: async () => ({ content: 'unused' }),
    },
  ]

  const exec = async (query: string) => {
    const discovery = createDiscoverAgentToolsTool(registryWithSkill)
    const result = await discovery.execute({ query }, {
      sessionId: 'session',
      runId: 'run',
      toolCallId: 'call',
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
    })
    return result
  }

  it('matches load_skill by exact name query', async () => {
    await expect(exec('load_skill')).resolves.toMatchObject({ addedToolNames: ['load_skill'] })
  })

  it('matches load_skill by intent word "skill"', async () => {
    await expect(exec('skill')).resolves.toMatchObject({ addedToolNames: ['load_skill'] })
  })

  it('does not match load_skill for unrelated intent words', async () => {
    const result = await exec('deploy kubernetes')
    expect(result).toMatchObject({ details: { matches: [] } })
  })
})

describe('discoverAgentToolsTool — explore_subagent discoverability', () => {
  // 镜像真实 explore_subagent 的 snippet/guidelines 文案，验证模型通过 discover
  // 用 "explore" / "analyze codebase" 等意图词激活 Explore 的路径。
  const registryWithExplore: AgentTool[] = [
    ...registry,
    {
      name: 'explore_subagent',
      runtimeVersion: '6',
      label: '探索子 Agent',
      description: 'Delegates a read-only exploration sub-agent within the authorized workspace.',
      promptSnippet:
        '委派一个只读探索子 Agent，跨工作区范围收集证据并返回结构化总结（结论、调用链、风险、path:line 证据）。',
      promptGuidelines: [
        '优先用于跨目录、多文件或 codebase-wide 的只读分析；让子 Agent 独立收敛证据，不占用父上下文轮次。',
        '若当前任务预计需要读取 3 个及以上文件，或需要 broad search，先调用 discover_agent_tools({ query: "explore" }) 激活本工具。',
        'scope 是运行时强制边界，超出范围读取会失败；task 必须包含子任务所需的全部上下文。',
        '子 Agent 只读，不能写文件、执行命令或请求审批。',
      ],
      inputSchema: { type: 'object' },
      validate: (input) => ({ ok: true, value: input }),
      execute: async () => ({ content: 'unused' }),
    },
  ]

  const exec = async (query: string) => {
    const discovery = createDiscoverAgentToolsTool(registryWithExplore)
    const result = await discovery.execute({ query }, {
      sessionId: 'session',
      runId: 'run',
      toolCallId: 'call',
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
    })
    return result
  }

  it('matches explore_subagent by exact name query', async () => {
    await expect(exec('explore')).resolves.toMatchObject({ addedToolNames: ['explore_subagent'] })
  })

  it('matches explore_subagent by broad-analysis intent', async () => {
    await expect(exec('analyze codebase')).resolves.toMatchObject({ addedToolNames: ['explore_subagent'] })
  })

  it('does not match explore_subagent for unrelated intent words', async () => {
    const result = await exec('deploy kubernetes')
    expect((result.details as { matches?: unknown } | null)?.matches ?? []).not.toContain('explore_subagent')
  })
})
