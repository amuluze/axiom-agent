import { describe, expect, it } from 'vitest'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { AgentEnvironmentError } from '@/agent/environment/AgentEnvironment'
import { createFakeAgentEnvironment } from '@/agent/tools/__fixtures__/fakeAgentEnvironment'
import type { WorkspaceEntry, WorkspaceReadResult } from '@/platform/workspace'
import {
  docsIndexHasContent,
  scanWorkspaceDocs,
  type WorkspaceDocsIndex,
} from './docsIndex'

interface FakeWorkspace {
  /** 目录 -> 直接条目；未登记的目录列举即 not_found（与 Rust 缺失目录语义一致）。 */
  dirs?: Record<string, WorkspaceEntry[]>
  /** 文件路径 -> 内容；未登记的文件读取即 not_found。 */
  files?: Record<string, string>
  /** 列举结果被宿主截断的目录。 */
  truncatedDirs?: string[]
  /** AGENTS.md 发现（AGENTS.md 递归 glob）的匹配路径；缺省为空结果。 */
  agentsPaths?: string[]
  /** AGENTS.md 发现被截断。 */
  agentsTruncated?: boolean
  /** AGENTS.md 发现失败（find 抛错）。 */
  agentsFindError?: Error
  /** 指定路径（目录或文件）的失败；优先于上面的登记。 */
  failures?: Record<string, AgentEnvironmentError>
}

const mdFile = (dir: string, name: string): WorkspaceEntry => ({
  path: `${dir}/${name}`,
  name,
  kind: 'file',
  sizeBytes: 0,
})

const readResult = (path: string, content: string): WorkspaceReadResult => ({
  workspace: { path: '/ws', name: 'ws' },
  path,
  content,
  sha256: 'e'.repeat(64),
  startLine: 1,
  endLine: content.split('\n').length,
  totalLines: content.split('\n').length,
  truncated: false,
  nextOffset: undefined,
})

const makeEnvironment = ({
  dirs = {},
  files = {},
  truncatedDirs = [],
  agentsPaths = [],
  agentsTruncated = false,
  agentsFindError,
  failures = {},
}: FakeWorkspace): AgentEnvironment => createFakeAgentEnvironment({
  list: async (path) => {
    const dir = path ?? '.'
    const failure = failures[dir]
    if (failure) throw failure
    if (!(dir in dirs)) throw new AgentEnvironmentError('not_found', `directory not found: ${dir}`)
    return {
      workspace: { path: '/ws', name: 'ws' },
      directory: dir,
      entries: dirs[dir] ?? [],
      truncated: truncatedDirs.includes(dir),
    }
  },
  readText: async (path: string): Promise<WorkspaceReadResult> => {
    const failure = failures[path]
    if (failure) throw failure
    const content = files[path]
    if (content === undefined) throw new AgentEnvironmentError('not_found', `file not found: ${path}`)
    return readResult(path, content)
  },
  find: async () => {
    if (agentsFindError) throw agentsFindError
    return {
      workspace: { path: '/ws', name: 'ws' },
      pattern: '**/AGENTS.md',
      rootPath: '.',
      matches: agentsPaths.map((path) => ({ path, name: 'AGENTS.md', kind: 'file' as const, sizeBytes: 0 })),
      truncated: agentsTruncated,
    }
  },
})

const groupOf = (index: WorkspaceDocsIndex, role: string) => {
  const group = index.groups.find((item) => item.role === role)
  if (!group) throw new Error(`missing group ${role}`)
  return group
}

describe('scanWorkspaceDocs', () => {
  it('返回完整分组骨架（项目指南置首、子目录指南置尾）；空项目不产生诊断', async () => {
    const index = await scanWorkspaceDocs('/ws', makeEnvironment({}))
    expect(index.groups.map((group) => group.role)).toEqual(
      ['agents-root', 'design', 'domain', 'task', 'plan', 'doc', 'agents-nested'],
    )
    expect(index.groups.every((group) => group.entries.length === 0 && group.archivedEntries.length === 0)).toBe(true)
    expect(index.groups.every((group) => group.diagnostics.length === 0)).toBe(true)
    expect(docsIndexHasContent(index)).toBe(false)
  })

  it('AGENTS.md 发现按根/嵌套分组：根进「项目指南」，其余按路径排序进「子目录指南」', async () => {
    const index = await scanWorkspaceDocs('/ws', makeEnvironment({
      agentsPaths: ['AGENTS.md', 'packages/pkg/AGENTS.md', 'apps/desktop/AGENTS.md'],
    }))
    expect(groupOf(index, 'agents-root').entries.map((entry) => entry.path)).toEqual(['AGENTS.md'])
    expect(groupOf(index, 'agents-root').entries[0]).toMatchObject({ title: 'AGENTS.md', fileName: 'AGENTS.md' })
    expect(groupOf(index, 'agents-nested').entries.map((entry) => entry.path)).toEqual([
      'apps/desktop/AGENTS.md',
      'packages/pkg/AGENTS.md',
    ])
    // 指南组只做页面展示：不参与 SDD 分组、不产生诊断。
    expect(groupOf(index, 'agents-root').diagnostics).toHaveLength(0)
    expect(groupOf(index, 'domain').entries).toHaveLength(0)
    expect(docsIndexHasContent(index)).toBe(true)
  })

  it('AGENTS.md 发现截断时在子目录指南组标记 truncated（不得静默缩窄）', async () => {
    const index = await scanWorkspaceDocs('/ws', makeEnvironment({
      agentsPaths: ['a/AGENTS.md'],
      agentsTruncated: true,
    }))
    expect(groupOf(index, 'agents-nested').truncated).toBe(true)
    expect(groupOf(index, 'agents-root').truncated).toBeFalsy()
  })

  it('AGENTS.md 发现失败 fail-soft：两组留空，SDD 分组照常返回', async () => {
    const index = await scanWorkspaceDocs('/ws', makeEnvironment({
      agentsFindError: new Error('find failed'),
      dirs: { '.specs/domain': [mdFile('.specs/domain', 'spec.md')] },
      files: { '.specs/domain/spec.md': '# spec\n' },
    }))
    expect(groupOf(index, 'agents-root').entries).toHaveLength(0)
    expect(groupOf(index, 'agents-root').scanFailed).toBe(true)
    expect(groupOf(index, 'agents-nested').entries).toHaveLength(0)
    expect(groupOf(index, 'domain').entries).toHaveLength(1)
    expect(docsIndexHasContent(index)).toBe(true)
  })

  it('活跃与归档分离，domain 永不归档（误写 status: done 仍留在活跃索引）', async () => {
    const index = await scanWorkspaceDocs('/ws', makeEnvironment({
      dirs: {
        '.specs/domain': [mdFile('.specs/domain', 'spec.md'), mdFile('.specs/domain', 'done.md')],
        '.specs/tasks': [mdFile('.specs/tasks', 'spec.md'), mdFile('.specs/tasks', 'done.md')],
      },
      files: {
        'DESIGN.md': '# 品牌基调\n\ndesign body\n',
        '.specs/domain/spec.md': '---\nstatus: done\n---\n# active but archived attempt\n',
        '.specs/domain/done.md': '# Real domain spec\n',
        '.specs/tasks/spec.md': '# Active task\n',
        '.specs/tasks/done.md': '---\nstatus: done\n---\n# Done task\n',
      },
    }))
    expect(groupOf(index, 'design').entries[0]?.path).toBe('DESIGN.md')
    const domain = groupOf(index, 'domain')
    expect(domain.entries.map((entry) => entry.path).sort()).toEqual(['.specs/domain/done.md', '.specs/domain/spec.md'])
    expect(domain.archivedEntries).toHaveLength(0)
    const tasks = groupOf(index, 'task')
    expect(tasks.entries.map((entry) => entry.path)).toEqual(['.specs/tasks/spec.md'])
    expect(tasks.archivedEntries.map((entry) => entry.path)).toEqual(['.specs/tasks/done.md'])
  })

  it('非 not_found 的列举失败产生 root_list_failed 诊断，与目录为空可区分', async () => {
    const index = await scanWorkspaceDocs('/ws', makeEnvironment({
      failures: { '.specs/domain': new AgentEnvironmentError('not_authorized', 'permission denied') },
    }))
    const domain = groupOf(index, 'domain')
    expect(domain.entries).toHaveLength(0)
    expect(domain.diagnostics).toMatchObject([{ code: 'root_list_failed', root: '.specs/domain' }])
    expect(docsIndexHasContent(index)).toBe(true)
  })

  it('单文件读头失败不进入索引，只保留 file_read_failed 诊断', async () => {
    const index = await scanWorkspaceDocs('/ws', makeEnvironment({
      dirs: { '.specs/domain': [mdFile('.specs/domain', 'spec.md')] },
      failures: { '.specs/domain/spec.md': new AgentEnvironmentError('unknown', 'read failed') },
    }))
    const domain = groupOf(index, 'domain')
    // 标题与归档状态未确认时不得用文件名伪装成完整条目。
    expect(domain.entries).toHaveLength(0)
    expect(domain.archivedEntries).toHaveLength(0)
    expect(domain.diagnostics).toMatchObject([{ code: 'file_read_failed', affectedCount: 1, reason: 'unknown' }])
    expect(docsIndexHasContent(index)).toBe(true)
  })

  it('DESIGN.md 的非 not_found 读取失败被报告（不再被根级探测静默吞掉）', async () => {
    const index = await scanWorkspaceDocs('/ws', makeEnvironment({
      failures: { 'DESIGN.md': new AgentEnvironmentError('not_authorized', 'denied') },
    }))
    const design = groupOf(index, 'design')
    expect(design.entries).toHaveLength(0)
    expect(design.diagnostics).toMatchObject([{ code: 'file_read_failed', root: 'DESIGN.md', affectedCount: 1 }])
  })

  it('页面树不再按 64 条截断直接子项：宿主能返回的文档都应可打开', async () => {
    const names = Array.from({ length: 70 }, (_, index) => `doc-${String(index).padStart(2, '0')}.md`)
    const index = await scanWorkspaceDocs('/ws', makeEnvironment({
      dirs: { '.specs/tasks': names.map((name) => mdFile('.specs/tasks', name)) },
      files: Object.fromEntries(names.map((name) => [`.specs/tasks/${name}`, `# ${name}\n`])),
    }))
    const tasks = groupOf(index, 'task')
    // 页面是可浏览的全集面（配额 MAX_DOC_PAGE_ROOT_ENTRIES，对齐宿主 list 上限），
    // 与 `<available_docs>` 的 64 条元数据摘要线不是同一条截断线。
    expect(tasks.entries).toHaveLength(70)
    expect(tasks.diagnostics).toEqual([])
  })

  it('宿主列举截断产生 root_list_truncated 诊断', async () => {
    const index = await scanWorkspaceDocs('/ws', makeEnvironment({
      dirs: { '.specs/tasks': [mdFile('.specs/tasks', 'a.md')] },
      files: { '.specs/tasks/a.md': '# a\n' },
      truncatedDirs: ['.specs/tasks'],
    }))
    expect(groupOf(index, 'task').diagnostics).toMatchObject([{ code: 'root_list_truncated', root: '.specs/tasks' }])
  })

  it('文档页树递归收录受管目录子目录中的文档', async () => {
    const index = await scanWorkspaceDocs('/ws', makeEnvironment({
      dirs: {
        '.plans': [
          mdFile('.plans', 'a.md'),
          { path: '.plans/archive', name: 'archive', kind: 'directory', sizeBytes: 0 },
        ],
        '.plans/archive': [mdFile('.plans/archive', 'old.md')],
      },
      files: {
        '.plans/a.md': '# a\n',
        '.plans/archive/old.md': '# old plan\n',
      },
    }))
    const plans = groupOf(index, 'plan')
    expect(plans.entries.map((entry) => entry.path)).toEqual([
      '.plans/a.md',
      '.plans/archive/old.md',
    ])
    expect(plans.diagnostics).toEqual([])
  })

  it('嵌套递归深度超限产生 nested_scan_truncated 诊断，不静默缩窄', async () => {
    const dir = (parent: string, name: string): WorkspaceEntry => ({
      path: `${parent}/${name}`,
      name,
      kind: 'directory',
      sizeBytes: 0,
    })
    const index = await scanWorkspaceDocs('/ws', makeEnvironment({
      dirs: {
        '.plans': [dir('.plans', 'd1')],
        '.plans/d1': [dir('.plans/d1', 'd2')],
        '.plans/d1/d2': [dir('.plans/d1/d2', 'd3')],
        '.plans/d1/d2/d3': [dir('.plans/d1/d2/d3', 'd4')],
        '.plans/d1/d2/d3/d4': [dir('.plans/d1/d2/d3/d4', 'd5')],
      },
    }))
    expect(groupOf(index, 'plan').diagnostics).toMatchObject([
      { code: 'nested_scan_truncated', root: '.plans', affectedCount: 1 },
    ])
  })
})

describe('docsIndexHasContent', () => {
  it('空索引返回 false', async () => {
    const index = await scanWorkspaceDocs('/ws', makeEnvironment({}))
    expect(docsIndexHasContent(index)).toBe(false)
  })

  it('仅含诊断也返回 true（页面需如实展示失败与截断）', () => {
    const index: WorkspaceDocsIndex = {
      groups: [{
        role: 'domain',
        root: '.specs/domain',
        entries: [],
        archivedEntries: [],
        diagnostics: [{ code: 'root_list_failed', root: '.specs/domain', role: 'domain', affectedCount: 1 }],
      }],
    }
    expect(docsIndexHasContent(index)).toBe(true)
  })
})
