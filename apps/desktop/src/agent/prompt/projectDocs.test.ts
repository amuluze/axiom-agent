import { describe, expect, it } from 'vitest'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { createFakeAgentEnvironment } from '@/agent/tools/__fixtures__/fakeAgentEnvironment'
import type { WorkspaceEntry, WorkspaceReadResult } from '@/platform/workspace'
import { loadProjectDocs, projectDocInventoryEqual, EMPTY_PROJECT_DOC_INVENTORY, DOC_ROOTS, type ProjectDocInventory } from './projectDocs'

const entry = (path: string, kind: WorkspaceEntry['kind'], name?: string): WorkspaceEntry => ({
  path,
  name: name ?? path.split('/').pop() ?? path,
  kind,
  sizeBytes: 0,
})

const makeEnv = (
  dirEntries: Record<string, WorkspaceEntry[]>,
  files: Record<string, string> = {},
  truncatedDirs: string[] = [],
): { environment: AgentEnvironment; calls: { list: string[]; readText: string[] } } => {
  const calls = { list: [] as string[], readText: [] as string[] }
  const environment = createFakeAgentEnvironment({
    list: async (path) => {
      calls.list.push(path ?? '.')
      return {
        workspace: { path: '/repo', name: 'repo' },
        directory: path ?? '.',
        entries: dirEntries[path ?? '.'] ?? [],
        truncated: truncatedDirs.includes(path ?? '.'),
      }
    },
    readText: async (path: string): Promise<WorkspaceReadResult> => {
      calls.readText.push(path)
      const content = files[path] ?? ''
      return {
        workspace: { path: '/repo', name: 'repo' },
        path,
        content,
        sha256: 'e'.repeat(64),
        startLine: 1,
        endLine: content.split('\n').length,
        totalLines: content.split('\n').length,
        truncated: false,
        nextOffset: undefined,
      }
    },
  })
  return { environment, calls }
}

describe('loadProjectDocs', () => {
  it('目录缺失（list 抛错）fail-soft 返回空清单', async () => {
    const environment = createFakeAgentEnvironment({
      list: async () => { throw new Error('directory missing') },
    })
    const result = await loadProjectDocs(environment)
    expect(result).toEqual(EMPTY_PROJECT_DOC_INVENTORY)
  })

  it('扫描四个受管目录并按 role 分组', async () => {
    const { environment, calls } = makeEnv(
      {
        '.specs/domain': [entry('.specs/domain/a.md', 'file')],
        '.specs/tasks': [entry('.specs/tasks/t1.md', 'file')],
        '.plans': [entry('.plans/p1.md', 'file')],
        '.docs': [entry('.docs/d1.md', 'file')],
      },
      {
        '.specs/domain/a.md': '# 领域约束\n正文',
        '.specs/tasks/t1.md': '# 任务规格\n正文',
        '.plans/p1.md': '# 实施计划\n正文',
        '.docs/d1.md': '# 实现现状\n正文',
      },
    )
    const result = await loadProjectDocs(environment)
    expect(calls.list).toEqual(DOC_ROOTS.map((root) => root.dir))
    expect(result.entries.map((item) => item.role)).toEqual(['domain', 'task', 'plan', 'doc'])
    expect(result.entries.map((item) => item.title)).toEqual(['领域约束', '任务规格', '实施计划', '实现现状'])
    expect(result.entries.map((item) => item.relativePath)).toEqual([
      '.specs/domain/a.md',
      '.specs/tasks/t1.md',
      '.plans/p1.md',
      '.docs/d1.md',
    ])
  })

  it('跳过开头 frontmatter 提取首个 H1 标题', async () => {
    const { environment } = makeEnv(
      { '.specs/domain': [entry('.specs/domain/a.md', 'file')] },
      { '.specs/domain/a.md': '---\ntitle: 忽略的标题\n---\n# 真实标题\n正文' },
    )
    const result = await loadProjectDocs(environment)
    expect(result.entries[0]!.title).toBe('真实标题')
  })

  it('无 H1 时用文件名 stem 兜底', async () => {
    const { environment } = makeEnv(
      { '.docs': [entry('.docs/no-title.md', 'file')] },
      { '.docs/no-title.md': '这是没有标题的正文\n第二行' },
    )
    const result = await loadProjectDocs(environment)
    expect(result.entries[0]!.title).toBe('no-title')
  })

  it('跳过 symlink 与非 .md 条目', async () => {
    const { environment } = makeEnv({
      '.docs': [
        entry('.docs/link.md', 'symlink'),
        entry('.docs/notes.txt', 'file'),
        entry('.docs/readme', 'other'),
      ],
    })
    const result = await loadProjectDocs(environment)
    expect(result.entries).toHaveLength(0)
  })

  it('组内按相对路径 ASCII 排序（确定性）', async () => {
    const { environment } = makeEnv(
      { '.docs': [entry('.docs/b.md', 'file'), entry('.docs/a.md', 'file'), entry('.docs/c.md', 'file')] },
      {
        '.docs/a.md': '# A',
        '.docs/b.md': '# B',
        '.docs/c.md': '# C',
      },
    )
    const result = await loadProjectDocs(environment)
    expect(result.entries.map((item) => item.relativePath)).toEqual([
      '.docs/a.md',
      '.docs/b.md',
      '.docs/c.md',
    ])
  })

  it('文档读取失败用文件名兜底', async () => {
    const environment = createFakeAgentEnvironment({
      list: async (path) => ({
        workspace: { path: '/repo', name: 'repo' },
        directory: path ?? '.',
        entries: [entry(`${path}/broken.md`, 'file')],
        truncated: false,
      }),
      readText: async () => { throw new Error('read failed') },
    })
    const result = await loadProjectDocs(environment)
    expect(result.entries).toHaveLength(DOC_ROOTS.length)
    expect(result.entries.every((item) => item.title === 'broken')).toBe(true)
  })

  it('宿主清单截断（listing.truncated）计入 truncatedRootCount，不静默缩窄', async () => {
    // 目录条目超过宿主 list 上限（默认 200）时清单不是全集，未列出的条目里可能
    // 还有更多 markdown——无法精确计数，必须显式传递截断事实。
    const { environment } = makeEnv(
      {
        '.specs/domain': [entry('.specs/domain/a.md', 'file')],
        '.specs/tasks': [entry('.specs/tasks/t1.md', 'file')],
      },
      {
        '.specs/domain/a.md': '# 领域约束',
        '.specs/tasks/t1.md': '# 任务规格',
      },
      ['.specs/tasks'],
    )
    const result = await loadProjectDocs(environment)
    expect(result.truncatedRootCount).toBe(1)
    // 未截断的目录不计数
    const intact = await loadProjectDocs(makeEnv({
      '.specs/domain': [entry('.specs/domain/a.md', 'file')],
    }).environment)
    expect(intact.truncatedRootCount).toBe(0)
  })

  it('frontmatter status: done 归档——不进索引但显式计数', async () => {
    const { environment } = makeEnv(
      {
        '.specs/tasks': [
          entry('.specs/tasks/done-task.md', 'file'),
          entry('.specs/tasks/active-task.md', 'file'),
          entry('.specs/tasks/draft-task.md', 'file'),
        ],
        '.plans': [entry('.plans/done-plan.md', 'file')],
      },
      {
        '.specs/tasks/done-task.md': '---\nstatus: done\n---\n# 已完成任务',
        '.specs/tasks/active-task.md': '---\nstatus: in_progress\n---\n# 进行中任务',
        '.specs/tasks/draft-task.md': '---\ntitle: 无状态字段\n---\n# 草稿任务',
        '.plans/done-plan.md': '---\nstatus: done\n---\n# 已完成计划',
      },
    )
    const result = await loadProjectDocs(environment)
    // 归档文档移出活跃索引，其余状态（in_progress/无 status）保持活跃
    expect(result.entries.map((item) => item.relativePath)).toEqual([
      '.specs/tasks/active-task.md',
      '.specs/tasks/draft-task.md',
    ])
    expect(result.archivedCount).toBe(2)
  })

  it('正文中的 status: done（无 frontmatter 包裹）不视为归档', async () => {
    const { environment } = makeEnv(
      { '.docs': [entry('.docs/living.md', 'file')] },
      { '.docs/living.md': '# 活文档\n正文中出现 status: done 字样，不在 frontmatter 内' },
    )
    const result = await loadProjectDocs(environment)
    expect(result.entries).toHaveLength(1)
    expect(result.archivedCount).toBe(0)
  })
})

describe('projectDocInventoryEqual', () => {
  const inv = (...paths: string[]): ProjectDocInventory => ({
    entries: paths.map((relativePath) => ({ role: 'doc', title: 't', relativePath })),
    truncatedEntryCount: 0,
    truncatedRootCount: 0,
    archivedCount: 0,
  })

  it('全等（含顺序）返回 true，空清单互等', () => {
    expect(projectDocInventoryEqual(inv('a.md', 'b.md'), inv('a.md', 'b.md'))).toBe(true)
    expect(projectDocInventoryEqual(
      EMPTY_PROJECT_DOC_INVENTORY,
      { entries: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0 },
    )).toBe(true)
  })

  it('截断/归档计数差异返回 false（note 是模型可见输出，需要重建提示词）', () => {
    const left: ProjectDocInventory = { entries: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0 }
    const right: ProjectDocInventory = { entries: [], truncatedEntryCount: 5, truncatedRootCount: 0, archivedCount: 0 }
    expect(projectDocInventoryEqual(left, right)).toBe(false)
    expect(projectDocInventoryEqual(
      { entries: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0 },
      { entries: [], truncatedEntryCount: 0, truncatedRootCount: 1, archivedCount: 0 },
    )).toBe(false)
    // 归档计数变化（新任务标记 done）也必须触发提示词重建——note 文本随之变化
    expect(projectDocInventoryEqual(
      { entries: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0 },
      { entries: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 2 },
    )).toBe(false)
  })

  it('长度、顺序、role、路径、标题任一差异返回 false', () => {
    expect(projectDocInventoryEqual(inv('a.md'), inv('a.md', 'b.md'))).toBe(false)
    expect(projectDocInventoryEqual(inv('a.md', 'b.md'), inv('b.md', 'a.md'))).toBe(false)
    expect(projectDocInventoryEqual(
      { entries: [{ role: 'doc', title: 't', relativePath: 'a.md' }], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0 },
      { entries: [{ role: 'task', title: 't', relativePath: 'a.md' }], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0 },
    )).toBe(false)
    expect(projectDocInventoryEqual(
      { entries: [{ role: 'doc', title: 't1', relativePath: 'a.md' }], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0 },
      { entries: [{ role: 'doc', title: 't2', relativePath: 'a.md' }], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0 },
    )).toBe(false)
    expect(projectDocInventoryEqual(
      { entries: [{ role: 'doc', title: 't', relativePath: 'a.md' }], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0 },
      { entries: [{ role: 'doc', title: 't', relativePath: 'b.md' }], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0 },
    )).toBe(false)
  })
})
