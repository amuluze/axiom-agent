import { describe, expect, it } from 'vitest'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { createFakeAgentEnvironment } from '@/agent/tools/__fixtures__/fakeAgentEnvironment'
import type { WorkspaceEntry, WorkspaceFindResult } from '@/platform/workspace'
import {
  EMPTY_PROJECT_AGENTS_INVENTORY,
  MAX_NESTED_AGENTS_DEPTH,
  MAX_NESTED_AGENTS_ENTRIES,
  loadProjectAgents,
  projectAgentsInventoryEqual,
} from './projectAgents'

const workspace = { path: '/repo', name: 'repo' }

const file = (path: string): WorkspaceEntry => ({
  path,
  name: path.split('/').pop() ?? path,
  kind: 'file',
  sizeBytes: 0,
})

const envWith = (find: (request: { pattern: string; limit?: number; maxDepth?: number }) => Promise<WorkspaceFindResult>): AgentEnvironment =>
  createFakeAgentEnvironment({ find: (request) => find(request) })

const findReturning = (matches: WorkspaceEntry[], truncated = false) => () =>
  Promise.resolve({ workspace, pattern: '**/AGENTS.md', rootPath: '.', matches, truncated })

describe('loadProjectAgents', () => {
  it('find 抛错时返回 null（扫描失败），而不是伪装成「确实没有」的空清单', async () => {
    const environment = envWith(async () => { throw new Error('workspace is not authorized') })
    // 失败与空必须可区分：提交空清单等于把整块索引从 live 提示词删掉，
    // 退化窗口横跨一整个 run。
    await expect(loadProjectAgents(environment)).resolves.toBeNull()
  })

  it('剔除工作区根的 AGENTS.md（其正文已由 projectContext 全文注入，不重复入索引）', async () => {
    const environment = envWith(findReturning([file('AGENTS.md'), file('apps/foo/AGENTS.md')]))
    const result = await loadProjectAgents(environment)
    expect(result?.entries).toEqual(['apps/foo/AGENTS.md'])
  })

  it('浅层目录优先，其次按路径排序（与根 DESIGN.md 排索引首位的预算优先级同向）', async () => {
    const environment = envWith(findReturning([
      file('packages/b/deep/AGENTS.md'),
      file('packages/b/AGENTS.md'),
      file('apps/z/AGENTS.md'),
      file('apps/a/AGENTS.md'),
    ]))
    const result = await loadProjectAgents(environment)
    expect(result?.entries).toEqual([
      'apps/a/AGENTS.md',
      'apps/z/AGENTS.md',
      'packages/b/AGENTS.md',
      'packages/b/deep/AGENTS.md',
    ])
  })

  it('扫描达到条目上限时透传 truncated（条目只是下界，须由渲染层显式告知）', async () => {
    const environment = envWith(findReturning([file('apps/foo/AGENTS.md')], true))
    const result = await loadProjectAgents(environment)
    expect(result?.truncated).toBe(true)
    expect(result?.entries).toEqual(['apps/foo/AGENTS.md'])
  })

  it('传条目上限与深度上限——否则每个 agent_end 都要付一次全树遍历', async () => {
    const seen: { pattern: string; limit?: number; maxDepth?: number }[] = []
    const environment = envWith(async (request) => {
      seen.push(request)
      return { workspace, pattern: request.pattern, rootPath: '.', matches: [], truncated: false }
    })
    await loadProjectAgents(environment)
    expect(seen[0].pattern).toBe('**/AGENTS.md')
    expect(seen[0].limit).toBe(MAX_NESTED_AGENTS_ENTRIES)
    expect(seen[0].maxDepth).toBe(MAX_NESTED_AGENTS_DEPTH)
  })

  it('只收文件条目，目录同名条目不进索引', async () => {
    const environment = envWith(findReturning([
      { path: 'apps/foo/AGENTS.md', name: 'AGENTS.md', kind: 'directory', sizeBytes: 0 },
      file('apps/bar/AGENTS.md'),
    ]))
    const result = await loadProjectAgents(environment)
    expect(result?.entries).toEqual(['apps/bar/AGENTS.md'])
  })

  it('扫完确认无嵌套文件时返回空清单（非 null）', async () => {
    const environment = envWith(findReturning([]))
    await expect(loadProjectAgents(environment)).resolves.toEqual(EMPTY_PROJECT_AGENTS_INVENTORY)
  })
})

describe('projectAgentsInventoryEqual', () => {
  const base = { entries: ['apps/a/AGENTS.md'], truncated: false }

  it('全等返回 true', () => {
    expect(projectAgentsInventoryEqual(base, { entries: ['apps/a/AGENTS.md'], truncated: false })).toBe(true)
  })

  it('条目内容或顺序不同返回 false', () => {
    expect(projectAgentsInventoryEqual(base, { entries: ['apps/b/AGENTS.md'], truncated: false })).toBe(false)
    expect(projectAgentsInventoryEqual(
      { entries: ['a/AGENTS.md', 'b/AGENTS.md'], truncated: false },
      { entries: ['b/AGENTS.md', 'a/AGENTS.md'], truncated: false },
    )).toBe(false)
  })

  it('截断标记参与比较——它是模型可见注记的一部分，只比条目会让该事实永远传不出去', () => {
    expect(projectAgentsInventoryEqual(base, { entries: ['apps/a/AGENTS.md'], truncated: true })).toBe(false)
  })
})
