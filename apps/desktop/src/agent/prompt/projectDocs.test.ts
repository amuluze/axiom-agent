import { describe, expect, it } from 'vitest'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { createFakeAgentEnvironment } from '@/agent/tools/__fixtures__/fakeAgentEnvironment'
import type { WorkspaceEntry, WorkspaceReadResult } from '@/platform/workspace'
import {
  clearProjectDocRevisionCache,
  DOC_HEAD_READ_CONCURRENCY,
  DOC_ROOTS,
  EMPTY_PROJECT_DOC_INVENTORY,
  loadProjectDocs,
  MAX_DOC_PAGE_ROOT_ENTRIES,
  projectDocInventoryEqual,
  projectDocPromptInventoryEqual,
  scanProjectDocs,
  type ProjectDocInventory,
} from './projectDocs'
import { AgentEnvironmentError } from '@/agent/environment/AgentEnvironment'

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
      const content = files[path]
      // 未登记的路径抛错：对齐真实语义（Rust 读缺失文件即 reject）——
      // 根级 DESIGN.md 探测据此判定「不存在」（返回 '' 会把它当空文件收录）。
      if (content === undefined) {
        throw new AgentEnvironmentError('not_found', `file not found: ${path}`)
      }
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
  it('列举失败计入 failedRootCount——不得与「目录为空」同形', async () => {
    const environment = createFakeAgentEnvironment({
      list: async () => { throw new Error('directory missing') },
      // 根级 DESIGN.md 探测同理缺失（真实 readText 对不存在的文件抛错）。
      readText: async () => { throw new AgentEnvironmentError('not_found', 'file missing') },
    })
    const result = await loadProjectDocs(environment)
    // 条目仍为空（fail-soft 不阻断），但四个受管目录的失败必须被记账：
    // 否则整个 role 分组会从索引里消失且零信号，模型据此断言「项目没有领域约束」。
    expect(result.entries).toEqual([])
    expect(result.failedRootCount).toBe(DOC_ROOTS.length)
    expect(result.diagnostics).toEqual(DOC_ROOTS.map(({ dir, role }) => ({
      code: 'root_list_failed',
      root: dir,
      role,
      affectedCount: 1,
      reason: 'unknown',
    })))
    expect(result).not.toEqual(EMPTY_PROJECT_DOC_INVENTORY)
  })

  it('目录正常为空时 failedRootCount 为 0（与列举失败可区分）', async () => {
    const environment = createFakeAgentEnvironment({
      list: async () => ({ workspace: { path: '/repo', name: 'repo' }, directory: '.', entries: [], truncated: false }),
      readText: async () => { throw new AgentEnvironmentError('not_found', 'file missing') },
    })
    const result = await loadProjectDocs(environment)
    expect(result.failedRootCount).toBe(0)
    expect(result).toEqual(EMPTY_PROJECT_DOC_INVENTORY)
  })

  it('可选 SDD 目录不存在时按空目录处理，不误报扫描失败', async () => {
    const environment = createFakeAgentEnvironment({
      list: async () => { throw new AgentEnvironmentError('not_found', 'No such file or directory') },
      readText: async () => { throw new AgentEnvironmentError('not_found', 'No such file') },
    })
    const result = await loadProjectDocs(environment)
    expect(result).toEqual(EMPTY_PROJECT_DOC_INVENTORY)
  })

  it('根级 DESIGN.md 存在时以 design role 排在索引首位（H1 标题 + 首选探测）', async () => {
    const { environment, calls } = makeEnv(
      {
        '.specs/domain': [entry('.specs/domain/a.md', 'file')],
      },
      {
        'DESIGN.md': '---\ntype: design\n---\n# 品牌设计基调\n正文',
        '.specs/domain/a.md': '# 领域约束',
      },
    )
    const result = await loadProjectDocs(environment)
    expect(result.entries[0]).toEqual({
      role: 'design',
      title: '品牌设计基调',
      relativePath: 'DESIGN.md',
      revision: 'e'.repeat(64),
    })
    expect(result.entries.map((item) => item.role)).toEqual(['design', 'domain'])
    // 探测顺序：DESIGN.md 在受管目录读取之前（预算紧张时最先装入）。
    expect(calls.readText[0]).toBe('DESIGN.md')
  })

  it('DESIGN.md 缺失时静默跳过（无 design 条目），不影响受管目录扫描', async () => {
    const { environment } = makeEnv(
      { '.docs': [entry('.docs/d1.md', 'file')] },
      { '.docs/d1.md': '# 实现现状' },
    )
    const result = await loadProjectDocs(environment)
    expect(result.entries.map((item) => item.role)).toEqual(['doc'])
    expect(result.entries.some((item) => item.role === 'design')).toBe(false)
  })

  it('DESIGN.md 是活文档：误写 status: done 不归档、不移出索引', async () => {
    const { environment } = makeEnv(
      {},
      { 'DESIGN.md': '---\nstatus: done\n---\n# 设计基调' },
    )
    const result = await loadProjectDocs(environment)
    expect(result.entries).toMatchObject([{
      role: 'design',
      title: '设计基调',
      relativePath: 'DESIGN.md',
    }])
    expect(result.archivedCount).toBe(0)
  })

  it('.docs/ 是活文档：误写 status: done 不归档、不移出索引', async () => {
    const { environment } = makeEnv(
      { '.docs': [entry('.docs/living.md', 'file')] },
      { '.docs/living.md': '---\nstatus: done\n---\n# 实现现状' },
    )
    const result = await loadProjectDocs(environment)
    expect(result.entries).toMatchObject([{
      role: 'doc',
      title: '实现现状',
      relativePath: '.docs/living.md',
    }])
    expect(result.archivedCount).toBe(0)
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

  it('大小写不敏感地收录 Markdown，跳过 symlink 与非 Markdown 条目', async () => {
    const { environment } = makeEnv({
      '.docs': [
        entry('.docs/link.md', 'symlink'),
        entry('.docs/notes.txt', 'file'),
        entry('.docs/readme', 'other'),
        entry('.docs/UPPER.MD', 'file'),
      ],
    }, { '.docs/UPPER.MD': '无一级标题' })
    const result = await loadProjectDocs(environment)
    expect(result.entries.map((item) => item.relativePath)).toEqual(['.docs/UPPER.MD'])
    expect(result.entries[0]?.title).toBe('UPPER')
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

  it('文档头采用有界并发读取且输出顺序保持确定', async () => {
    const files = Array.from({ length: DOC_HEAD_READ_CONCURRENCY * 2 + 1 }, (_, index) =>
      entry(`.docs/${`${index}`.padStart(2, '0')}.md`, 'file'))
    let activeReads = 0
    let maxActiveReads = 0
    const environment = createFakeAgentEnvironment({
      list: async (path) => ({
        workspace: { path: '/repo', name: 'repo' },
        directory: path ?? '.',
        entries: path === '.docs' ? [...files].reverse() : [],
        truncated: false,
      }),
      readText: async (path) => {
        if (path === 'DESIGN.md') throw new AgentEnvironmentError('not_found', 'missing')
        activeReads += 1
        maxActiveReads = Math.max(maxActiveReads, activeReads)
        await Promise.resolve()
        activeReads -= 1
        return {
          workspace: { path: '/repo', name: 'repo' },
          path,
          content: `# ${path}`,
          sha256: path.padEnd(64, '0').slice(0, 64),
          startLine: 1,
          endLine: 1,
          totalLines: 1,
          truncated: false,
          nextOffset: undefined,
        }
      },
    })
    const result = await loadProjectDocs(environment)
    expect(maxActiveReads).toBe(DOC_HEAD_READ_CONCURRENCY)
    expect(result.entries.map((item) => item.relativePath)).toEqual(
      files.map((item) => item.path).sort((left, right) => left.localeCompare(right, 'en')),
    )
  })

  it('size/mtime 未变化时复用 revision，避免重复整文件读取', async () => {
    clearProjectDocRevisionCache()
    let reads = 0
    let modifiedMs = 111
    let sha = 'c'.repeat(64)
    const environment = createFakeAgentEnvironment({
      list: async (path) => ({
        workspace: { path: '/cache-ws', name: 'cache' },
        directory: path ?? '.',
        entries: path === '.docs'
          ? [{ path: '.docs/a.md', name: 'a.md', kind: 'file', sizeBytes: 12, modifiedMs }]
          : [],
        truncated: false,
      }),
      readText: async (path) => {
        if (path !== '.docs/a.md') throw new AgentEnvironmentError('not_found', 'missing')
        reads += 1
        return {
          workspace: { path: '/cache-ws', name: 'cache' },
          path,
          content: '# A\nbody\n',
          sha256: sha,
          startLine: 1,
          endLine: 3,
          totalLines: 3,
          truncated: false,
          nextOffset: undefined,
        }
      },
    })
    const first = await loadProjectDocs(environment)
    const second = await loadProjectDocs(environment)
    expect(reads).toBe(1)
    expect(second.entries[0]?.revision).toBe(first.entries[0]?.revision)

    // metadata 变化必须失效缓存并重新读取完整 SHA。
    modifiedMs = 112
    sha = 'd'.repeat(64)
    const third = await loadProjectDocs(environment)
    expect(reads).toBe(2)
    expect(third.entries[0]?.revision).toBe(sha)
  })

  it('文档读头失败不进入索引，只保留结构化诊断', async () => {
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
    // 标题与归档状态都未确认，不得用文件名伪装成完整条目。
    expect(result.entries).toHaveLength(0)
    expect(result.archivedCount).toBe(0)
    expect(result.diagnostics).toEqual([
      { code: 'file_read_failed', root: 'DESIGN.md', role: 'design', affectedCount: 1, reason: 'unknown' },
      ...DOC_ROOTS.map(({ dir, role }) => ({
        code: 'file_read_failed' as const,
        root: dir,
        role,
        affectedCount: 1,
        reason: 'unknown' as const,
      })),
    ])
  })

  it('列举后文件消失（读头 not_found）静默跳过，不产生幽灵条目或诊断', async () => {
    const { environment } = makeEnv(
      { '.docs': [entry('.docs/vanished.md', 'file')] },
      // 未登记内容 => 读头抛 not_found，模拟 list 与 read 之间的删除竞态。
      {},
    )
    const result = await loadProjectDocs(environment)
    expect(result.entries).toHaveLength(0)
    expect(result.diagnostics).toEqual([])
  })

  it('同一根目录的文件读取失败按 reason 聚合为单条诊断', async () => {
    const environment = createFakeAgentEnvironment({
      list: async (path) => ({
        workspace: { path: '/repo', name: 'repo' },
        directory: path ?? '.',
        entries: path === '.docs'
          ? [entry('.docs/a.md', 'file'), entry('.docs/b.md', 'file')]
          : [],
        truncated: false,
      }),
      readText: async (path) => {
        if (path === 'DESIGN.md') throw new AgentEnvironmentError('not_found', 'missing')
        throw new AgentEnvironmentError('not_authorized', 'denied')
      },
    })
    const result = await loadProjectDocs(environment)
    expect(result.diagnostics).toEqual([{
      code: 'file_read_failed',
      root: '.docs',
      role: 'doc',
      affectedCount: 2,
      reason: 'not_authorized',
    }])
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
    expect(result.diagnostics).toContainEqual({
      code: 'root_list_truncated',
      root: '.specs/tasks',
      role: 'task',
      affectedCount: 1,
    })
    // 未截断的目录不计数
    const intact = await loadProjectDocs(makeEnv({
      '.specs/domain': [entry('.specs/domain/a.md', 'file')],
    }).environment)
    expect(intact.truncatedRootCount).toBe(0)
  })

  it('领域规范永不归档：误写 status: done 仍留在活跃索引', async () => {
    // spec-authoring §6.1：Domain Spec 长期演进、任务只引用不重复、永不归档。
    // 该规则此前只写在文档里，代码对 role 一视同仁——一个手滑的 frontmatter 会把
    // 长期领域不变量静默移出索引，且没有任何信号。
    const { environment } = makeEnv(
      {
        '.specs/domain': [
          entry('.specs/domain/kept.md', 'file'),
          entry('.specs/domain/mislabelled.md', 'file'),
        ],
      },
      {
        '.specs/domain/kept.md': '# 正常领域规范',
        '.specs/domain/mislabelled.md': '---\nstatus: done\n---\n# 被误标归档的领域规范',
      },
    )
    const result = await loadProjectDocs(environment)
    expect(result.entries.map((item) => item.relativePath).sort()).toEqual([
      '.specs/domain/kept.md',
      '.specs/domain/mislabelled.md',
    ])
    // 误标既不生效也不计入归档计数（否则计数会说谎）
    expect(result.archivedCount).toBe(0)
  })

  it('任务类产物仍走归档生命周期（对照上一条）', async () => {
    const { environment } = makeEnv(
      { '.specs/tasks': [entry('.specs/tasks/done.md', 'file')] },
      { '.specs/tasks/done.md': '---\nstatus: done\n---\n# 已完成任务' },
    )
    const result = await loadProjectDocs(environment)
    expect(result.entries).toHaveLength(0)
    expect(result.archivedCount).toBe(1)
  })

  it('归档文档不占用活跃配额：大量归档不得把活跃 Task Spec 挤出索引', async () => {
    // 归档的用途是「不再挤占索引」：若它继续消耗每个目录的活跃条目上限，
    // 一个累积了几十个已完成任务的仓库会在字母序上把活跃 Spec/Plan 整扇挤出索引。
    const archivedNames = Array.from({ length: 70 }, (_, index) => `a-${String(index).padStart(3, '0')}.md`)
    const activeNames = ['zz-active-task.md', 'zz-active-plan.md']
    const { environment } = makeEnv(
      {
        '.specs/tasks': [...archivedNames, ...activeNames].map((name) =>
          entry(`.specs/tasks/${name}`, 'file', name)),
      },
      Object.fromEntries([
        ...archivedNames.map((name) => [
          `.specs/tasks/${name}`,
          `---\nstatus: done\n---\n# 归档 ${name}`,
        ]),
        ...activeNames.map((name) => [`.specs/tasks/${name}`, `# ${name}`]),
      ]),
    )
    const result = await loadProjectDocs(environment)
    expect(result.entries.map((item) => item.relativePath)).toEqual([
      '.specs/tasks/zz-active-plan.md',
      '.specs/tasks/zz-active-task.md',
    ])
    expect(result.archivedCount).toBe(70)
    // 归档不占配额，因此没有任何配额诊断。
    expect(result.truncatedEntryCount).toBe(0)
    expect(result.diagnostics).toEqual([])
  })

  it('受管目录列举显式请求大 limit：活跃文档不被宿主 200 条默认上限挡在索引外', async () => {
    clearProjectDocRevisionCache()
    // 250 个已归档任务（字母序在前）+ 1 个活跃任务（字母序在后）：若列举用宿主缺省
    // 200 条，活跃文档压根不在返回清单里——配额再合理也看不到它。
    const archivedNames = Array.from({ length: 250 }, (_, index) => `a-${String(index).padStart(3, '0')}.md`)
    const activeName = 'zz-active.md'
    const names = [...archivedNames, activeName]
    const entries: WorkspaceEntry[] = names.map((name) => entry(`.specs/tasks/${name}`, 'file', name))
    const files: Record<string, string> = Object.fromEntries([
      ...archivedNames.map((name) => [`.specs/tasks/${name}`, '---\nstatus: done\n---\n# 归档']),
      [`.specs/tasks/${activeName}`, '# 活跃任务'],
    ])
    const environment = createFakeAgentEnvironment({
      list: async (path?: string, limit?: number) => {
        const workspace = { path: '/repo', name: 'repo' }
        if (path !== '.specs/tasks') {
          return { workspace, directory: path ?? '.', entries: [], truncated: false }
        }
        // 模拟真实宿主：按请求的 limit 截断（缺省 200），截断时回报 truncated。
        const effective = limit ?? 200
        return {
          workspace,
          directory: path,
          entries: entries.slice(0, effective),
          truncated: entries.length > effective,
        }
      },
      readText: async (path: string): Promise<WorkspaceReadResult> => {
        const content = files[path]
        if (content === undefined) throw new AgentEnvironmentError('not_found', `missing ${path}`)
        return {
          workspace: { path: '/repo', name: 'repo' },
          path,
          content,
          sha256: 'e'.repeat(64),
          startLine: 1,
          endLine: 1,
          totalLines: 1,
          truncated: false,
          nextOffset: undefined,
        }
      },
    })
    const result = await loadProjectDocs(environment)
    expect(result.entries.map((item) => item.relativePath)).toEqual(['.specs/tasks/zz-active.md'])
    expect(result.archivedCount).toBe(250)
    // 列举没有被截断，因此不产生 root_list_truncated。
    expect(result.truncatedRootCount).toBe(0)
  })

  it('活跃条目超额才计入 root_entry_limit，页面口径可传更大配额', async () => {
    const names = Array.from({ length: 70 }, (_, index) => `doc-${String(index).padStart(2, '0')}.md`)
    const { environment } = makeEnv(
      { '.specs/tasks': names.map((name) => entry(`.specs/tasks/${name}`, 'file', name)) },
      Object.fromEntries(names.map((name) => [`.specs/tasks/${name}`, `# ${name}`])),
    )
    const promptScan = await loadProjectDocs(environment)
    expect(promptScan.entries).toHaveLength(64)
    expect(promptScan.diagnostics).toMatchObject([
      { code: 'root_entry_limit', root: '.specs/tasks', role: 'task', affectedCount: 6 },
    ])
    expect(promptScan.truncatedEntryCount).toBe(6)

    const pageScan = await scanProjectDocs(
      { workspace: environment.workspace },
      { activeEntryLimit: MAX_DOC_PAGE_ROOT_ENTRIES },
    )
    expect(pageScan.inventory.entries).toHaveLength(70)
    expect(pageScan.inventory.diagnostics).toEqual([])
  })

  it('受管目录下的子目录被计数：索引只取一层，但不静默', async () => {
    const { environment } = makeEnv(
      {
        '.specs/domain': [
          entry('.specs/domain/a.md', 'file'),
          // 子目录本身只是一个目录条目——索引不递归，其内容不在本次 list 结果里
          entry('.specs/domain/nested', 'directory'),
        ],
      },
      { '.specs/domain/a.md': '# 顶层领域规范' },
    )
    const result = await loadProjectDocs(environment)
    expect(result.nestedDirCount).toBe(1)
    expect(result.entries.map((item) => item.relativePath)).toEqual(['.specs/domain/a.md'])
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
    entries: paths.map((relativePath) => ({
      role: 'doc',
      title: 't',
      relativePath,
      revision: 'a'.repeat(64),
    })),
    diagnostics: [],
    truncatedEntryCount: 0,
    truncatedRootCount: 0,
    archivedCount: 0,
    nestedDirCount: 0,
    failedRootCount: 0,
  })

  it('全等（含顺序）返回 true，空清单互等', () => {
    expect(projectDocInventoryEqual(inv('a.md', 'b.md'), inv('a.md', 'b.md'))).toBe(true)
    expect(projectDocInventoryEqual(
      EMPTY_PROJECT_DOC_INVENTORY,
      { entries: [], diagnostics: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0, nestedDirCount: 0, failedRootCount: 0 },
    )).toBe(true)
  })

  it('截断/归档计数差异返回 false（note 是模型可见输出，需要重建提示词）', () => {
    const left: ProjectDocInventory = { entries: [], diagnostics: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0, nestedDirCount: 0, failedRootCount: 0 }
    const right: ProjectDocInventory = { entries: [], diagnostics: [], truncatedEntryCount: 5, truncatedRootCount: 0, archivedCount: 0, nestedDirCount: 0, failedRootCount: 0 }
    expect(projectDocInventoryEqual(left, right)).toBe(false)
    expect(projectDocInventoryEqual(
      { entries: [], diagnostics: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0, nestedDirCount: 0, failedRootCount: 0 },
      { entries: [], diagnostics: [], truncatedEntryCount: 0, truncatedRootCount: 1, archivedCount: 0, nestedDirCount: 0, failedRootCount: 0 },
    )).toBe(false)
    // 归档计数变化（新任务标记 done）也必须触发提示词重建——note 文本随之变化
    expect(projectDocInventoryEqual(
      { entries: [], diagnostics: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0, nestedDirCount: 0, failedRootCount: 0 },
      { entries: [], diagnostics: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 2, nestedDirCount: 0, failedRootCount: 0 },
    )).toBe(false)
    expect(projectDocInventoryEqual(
      { entries: [], diagnostics: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0, nestedDirCount: 0, failedRootCount: 0 },
      {
        entries: [],
        diagnostics: [{ code: 'file_read_failed', root: '.docs', role: 'doc', affectedCount: 1, reason: 'unknown' }],
        truncatedEntryCount: 0,
        truncatedRootCount: 0,
        archivedCount: 0,
        nestedDirCount: 0,
        failedRootCount: 0,
      },
    )).toBe(false)
  })

  it('长度、顺序、role、路径、标题、revision 任一差异返回 false', () => {
    expect(projectDocInventoryEqual(inv('a.md'), inv('a.md', 'b.md'))).toBe(false)
    expect(projectDocInventoryEqual(inv('a.md', 'b.md'), inv('b.md', 'a.md'))).toBe(false)
    expect(projectDocInventoryEqual(
      { entries: [{ role: 'doc', title: 't', relativePath: 'a.md', revision: 'a' }], diagnostics: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0, nestedDirCount: 0, failedRootCount: 0 },
      { entries: [{ role: 'task', title: 't', relativePath: 'a.md', revision: 'a' }], diagnostics: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0, nestedDirCount: 0, failedRootCount: 0 },
    )).toBe(false)
    expect(projectDocInventoryEqual(
      { entries: [{ role: 'doc', title: 't1', relativePath: 'a.md', revision: 'a' }], diagnostics: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0, nestedDirCount: 0, failedRootCount: 0 },
      { entries: [{ role: 'doc', title: 't2', relativePath: 'a.md', revision: 'a' }], diagnostics: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0, nestedDirCount: 0, failedRootCount: 0 },
    )).toBe(false)
    expect(projectDocInventoryEqual(
      { entries: [{ role: 'doc', title: 't', relativePath: 'a.md', revision: 'a' }], diagnostics: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0, nestedDirCount: 0, failedRootCount: 0 },
      { entries: [{ role: 'doc', title: 't', relativePath: 'b.md', revision: 'a' }], diagnostics: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0, nestedDirCount: 0, failedRootCount: 0 },
    )).toBe(false)
    expect(projectDocInventoryEqual(
      { entries: [{ role: 'doc', title: 't', relativePath: 'a.md', revision: 'a' }], diagnostics: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0, nestedDirCount: 0, failedRootCount: 0 },
      { entries: [{ role: 'doc', title: 't', relativePath: 'a.md', revision: 'b' }], diagnostics: [], truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0, nestedDirCount: 0, failedRootCount: 0 },
    )).toBe(false)
  })
})

describe('projectDocPromptInventoryEqual', () => {
  const inventory = (
    revision: string,
    overrides: Partial<ProjectDocInventory> = {},
  ): ProjectDocInventory => ({
    entries: [{ role: 'doc', title: 't', relativePath: 'a.md', revision }],
    diagnostics: [],
    truncatedEntryCount: 0,
    truncatedRootCount: 0,
    archivedCount: 0,
    nestedDirCount: 0,
    failedRootCount: 0,
    ...overrides,
  })

  it('纯 revision 差异视为提示词相等（正文编辑不触发重建）', () => {
    expect(projectDocPromptInventoryEqual(inventory('a'), inventory('b'))).toBe(true)
  })

  it('标题/路径/revision 之外的元数据差异仍返回 false', () => {
    expect(projectDocPromptInventoryEqual(
      inventory('a'),
      inventory('a', { entries: [{ role: 'doc', title: 't2', relativePath: 'a.md', revision: 'a' }] }),
    )).toBe(false)
    expect(projectDocPromptInventoryEqual(
      inventory('a'),
      inventory('a', { entries: [{ role: 'doc', title: 't', relativePath: 'b.md', revision: 'a' }] }),
    )).toBe(false)
    expect(projectDocPromptInventoryEqual(
      inventory('a'),
      inventory('a', { archivedCount: 1 }),
    )).toBe(false)
    expect(projectDocPromptInventoryEqual(
      inventory('a'),
      inventory('a', {
        diagnostics: [{ code: 'file_read_failed', root: '.docs', role: 'doc', affectedCount: 1 }],
      }),
    )).toBe(false)
  })
})
