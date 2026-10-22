import { describe, expect, it } from 'vitest'
import { formatAvailableDocs as formatAvailableDocsRaw, DOCS_METADATA_BUDGET_BYTES } from './formatAvailableDocs'
import {
  EMPTY_PROJECT_DOC_INVENTORY,
  type ProjectDocEntry,
  type ProjectDocInventory,
} from './projectDocs'

const doc = (entry: Omit<ProjectDocEntry, 'revision'>): ProjectDocEntry => ({
  ...entry,
  revision: 'a'.repeat(64),
})

const formatAvailableDocs = (
  inventory: Omit<ProjectDocInventory, 'diagnostics'> & {
    diagnostics?: ProjectDocInventory['diagnostics']
  },
) => formatAvailableDocsRaw({ diagnostics: [], ...inventory })

describe('formatAvailableDocs', () => {
  it('空清单返回 null', () => {
    const result = formatAvailableDocs(EMPTY_PROJECT_DOC_INVENTORY)
    expect(result.section).toBeNull()
    expect(result.omittedCount).toBe(0)
  })

  it('全部文档已归档时活跃索引为空，但仍输出归档计数 note（不得整段丢弃）', () => {
    const result = formatAvailableDocs({
      entries: [],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 2,
      nestedDirCount: 0,
      failedRootCount: 0,
    })
    expect(result.section).not.toBeNull()
    expect(result.section).toContain('<available_docs>')
    expect(result.section).toContain('另有 2 个文档已标记 status: done 归档')
    expect(result.section).not.toContain('<doc ')
    expect(result.omittedCount).toBe(0)
  })

  it('渲染 <available_docs> 含 role/path/title', () => {
    const result = formatAvailableDocs({
      entries: [doc({ role: 'domain', title: '领域约束', relativePath: '.specs/domain/a.md' })],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 0,
        nestedDirCount: 0, failedRootCount: 0,
    })
    expect(result.section).toContain('<available_docs>')
    expect(result.section).toContain('<doc role="domain" path=".specs/domain/a.md">领域约束</doc>')
    expect(result.section).toContain('</available_docs>')
    expect(result.omittedCount).toBe(0)
  })

  it('revision 不进入提示词（完整 SHA 只用于内部变化检测）', () => {
    const full = '0123456789abcdef'.repeat(4)
    const result = formatAvailableDocs({
      entries: [{ role: 'doc', title: '实现现状', relativePath: '.docs/a.md', revision: full }],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 0,
      nestedDirCount: 0,
      failedRootCount: 0,
    })
    expect(result.section).not.toContain('revision=')
    expect(result.section).not.toContain(full)
  })

  it('role legend 含 design（项目设计意图）——DESIGN.md 条目的语义可被模型理解', () => {
    const result = formatAvailableDocs({
      entries: [doc({ role: 'design', title: '设计基调', relativePath: 'DESIGN.md' })],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 0,
        nestedDirCount: 0, failedRootCount: 0,
    })
    expect(result.section).toContain('design=项目设计意图（品牌/视觉/交互基调）')
    expect(result.section).toContain('<doc role="design" path="DESIGN.md">设计基调</doc>')
  })

  it('XML escape role/path/title 中的特殊字符', () => {
    const result = formatAvailableDocs({
      entries: [doc({ role: 'doc', title: 'A <B> & "C"', relativePath: '.docs/a&b.md' })],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 0,
        nestedDirCount: 0, failedRootCount: 0,
    })
    expect(result.section).toContain('A &lt;B&gt; &amp; &quot;C&quot;')
    expect(result.section).toContain('path=".docs/a&amp;b.md"')
    expect(result.section).not.toContain('<B>')
  })

  it('单条超过预算时保留最小提示（不让整块索引消失）', () => {
    const huge = 'x'.repeat(DOCS_METADATA_BUDGET_BYTES + 1)
    const result = formatAvailableDocs({
      entries: [doc({ role: 'doc', title: huge, relativePath: '.docs/a.md' })],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 0,
        nestedDirCount: 0, failedRootCount: 0,
    })
    expect(result.section).toContain('<available_docs>')
    expect(result.section).toContain('因索引预算省略')
    expect(result.section).toContain('</available_docs>')
    expect(result.omittedCount).toBe(1)
    expect(new TextEncoder().encode(result.section ?? '').byteLength)
      .toBeLessThanOrEqual(DOCS_METADATA_BUDGET_BYTES)
  })

  it('大量条目触发预算截断但保留已装入部分', () => {
    const entries = Array.from({ length: 1000 }, (_, index) => ({
      role: 'doc' as const,
      title: `doc-title-${index}`,
      relativePath: `.docs/doc-${index}.md`,
      revision: `${index}`.padStart(64, '0'),
    }))
    const result = formatAvailableDocs({ entries, truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0, nestedDirCount: 0, failedRootCount: 0 })
    expect(result.section).not.toBeNull()
    expect(result.section).toContain('<available_docs>')
    expect(result.omittedCount).toBeGreaterThan(0)
    expect(result.omittedCount).toBeLessThan(entries.length)
    expect(new TextEncoder().encode(result.section!).byteLength).toBeLessThanOrEqual(DOCS_METADATA_BUDGET_BYTES)
  })

  it('诊断 notes 与闭合标签计入 32 KiB 硬预算', () => {
    const entries = Array.from({ length: 64 }, (_, index) => ({
      role: index % 2 === 0 ? 'task' as const : 'plan' as const,
      title: `文档-${index}-${'中'.repeat(180)}`,
      relativePath: `.specs/tasks/doc-${index}.md`,
      revision: `${index}`.padStart(64, '0'),
    }))
    const result = formatAvailableDocs({
      entries,
      diagnostics: [
        { code: 'root_entry_limit', root: '.docs', role: 'doc', affectedCount: 999 },
        { code: 'root_list_truncated', root: '.docs', role: 'doc', affectedCount: 1 },
        { code: 'nested_directories_omitted', root: '.docs', role: 'doc', affectedCount: 999 },
        { code: 'root_list_failed', root: '.specs/domain', role: 'domain', affectedCount: 1, reason: 'unavailable' },
      ],
      truncatedEntryCount: 999,
      truncatedRootCount: 4,
      archivedCount: 999,
      nestedDirCount: 999,
      failedRootCount: 4,
    })
    expect(result.section).not.toBeNull()
    expect(result.omittedCount).toBeGreaterThan(0)
    expect(new TextEncoder().encode(result.section!).byteLength).toBeLessThanOrEqual(DOCS_METADATA_BUDGET_BYTES)
    expect(result.section).toContain('</available_docs>')
    expect(result.section).toContain('受管目录列举失败')
  })

  it('诊断本身超预算时压成一条显式计数汇总，不逐条静默丢弃', () => {
    // 嵌套目录大量列举失败可产生数百条诊断（每条一个 root），合计远超 32 KiB。
    // 此时不能直接把超预算的 section 交出去（那就是绕过硬预算），也不能逐条
    // 裁掉诊断（模型会看不到其中一部分）——必须压成一条带计数的汇总。
    const diagnostics = Array.from({ length: 200 }, (_, index) => ({
      code: 'root_list_failed' as const,
      root: `.specs/nested/dir-${index}`,
      role: 'domain' as const,
      affectedCount: 1,
      reason: 'unavailable' as const,
    }))
    const result = formatAvailableDocs({
      entries: [
        doc({ role: 'task', title: '任务甲', relativePath: '.specs/tasks/a.md' }),
        doc({ role: 'plan', title: '计划乙', relativePath: '.plans/b.md' }),
      ],
      diagnostics,
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 5,
      nestedDirCount: 0,
      failedRootCount: 200,
    })
    expect(result.section).not.toBeNull()
    expect(new TextEncoder().encode(result.section!).byteLength).toBeLessThanOrEqual(DOCS_METADATA_BUDGET_BYTES)
    expect(result.section).toContain('</available_docs>')
    // 三类事实都必须显式保留，不得静默缩窄。
    expect(result.section).toContain('2 个文档因索引预算省略')
    expect(result.section).toContain('5 个文档已归档')
    expect(result.section).toContain('200 项扫描诊断')
    expect(result.section).not.toContain('<diagnostic')
    expect(result.omittedCount).toBe(2)
  })

  it('单目录条目上限截断输出显式 note（索引不是全集）', () => {
    const result = formatAvailableDocs({
      entries: [doc({ role: 'task', title: 't', relativePath: '.specs/tasks/a.md' })],
      diagnostics: [{ code: 'root_entry_limit', root: '.specs/tasks', role: 'task', affectedCount: 12 }],
      truncatedEntryCount: 12,
      truncatedRootCount: 0,
      archivedCount: 0,
        nestedDirCount: 0, failedRootCount: 0,
    })
    expect(result.section).toContain('另有 12 个文档因单目录条目上限')
    expect(result.section).toContain('用 ls 复查目录实况')
  })

  it('宿主清单截断输出独立显式 note（条目计数只是下界）', () => {
    const result = formatAvailableDocs({
      entries: [doc({ role: 'task', title: 't', relativePath: '.specs/tasks/a.md' })],
      diagnostics: [{ code: 'root_list_truncated', root: '.specs/tasks', role: 'task', affectedCount: 1 }],
      truncatedEntryCount: 0,
      truncatedRootCount: 2,
      archivedCount: 0,
        nestedDirCount: 0, failedRootCount: 0,
    })
    expect(result.section).toContain('受管目录清单被系统截断，可能还有未列入索引的文档')
    expect(result.section).toContain('用 ls 复查目录实况')
    // 未截断时不输出该 note
    const intact = formatAvailableDocs({
      entries: [doc({ role: 'task', title: 't', relativePath: '.specs/tasks/a.md' })],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 0,
        nestedDirCount: 0, failedRootCount: 0,
    })
    expect(intact.section).not.toContain('清单被系统截断')
  })

  it('截断计数与预算省略同时存在时输出两条 note', () => {
    const entries = Array.from({ length: 1000 }, (_, index) => ({
      role: 'doc' as const,
      title: `t-${index}`,
      relativePath: `.docs/d-${index}.md`,
      revision: `${index}`.padStart(64, '0'),
    }))
    const result = formatAvailableDocs({
      entries,
      diagnostics: [{ code: 'root_entry_limit', root: '.docs', role: 'doc', affectedCount: 3 }],
      truncatedEntryCount: 3,
      truncatedRootCount: 0,
      archivedCount: 0,
      nestedDirCount: 0,
      failedRootCount: 0,
    })
    expect(result.section).toContain('因索引预算省略')
    expect(result.section).toContain('因单目录条目上限')
  })

  it('归档文档输出显式 note（status: done 不进索引但可追溯），未归档不输出', () => {
    const result = formatAvailableDocs({
      entries: [doc({ role: 'task', title: '活跃任务', relativePath: '.specs/tasks/a.md' })],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 3,
        nestedDirCount: 0, failedRootCount: 0,
    })
    expect(result.section).toContain('另有 3 个文档已标记 status: done 归档')
    expect(result.section).toContain('可用 grep "status: done" 查找')
    const none = formatAvailableDocs({
      entries: [doc({ role: 'task', title: '活跃任务', relativePath: '.specs/tasks/a.md' })],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 0,
        nestedDirCount: 0, failedRootCount: 0,
    })
    expect(none.section).not.toContain('文档已标记 status: done 归档')
  })

  it('递归扫描上限输出独立 note（文档页递归不改变浅索引契约）', () => {
    const result = formatAvailableDocs({
      entries: [doc({ role: 'doc', title: '实现现状', relativePath: '.docs/a.md' })],
      diagnostics: [{ code: 'nested_scan_truncated', root: '.docs', role: 'doc', affectedCount: 3 }],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 0,
      nestedDirCount: 0,
      failedRootCount: 0,
    })
    expect(result.section).toContain('另有 3 个嵌套文档或目录因递归扫描上限未列入')
  })

  it('受管目录列举失败时注入 note，且措辞阻止模型把整组缺失读成「项目没有这类文档」', () => {
    // 条目为空但列举失败：仍出子块承载 note，否则模型会读成「项目没有这类文档」。
    const result = formatAvailableDocs({
      entries: [],
      diagnostics: [{ code: 'root_list_failed', root: '.specs/domain', role: 'domain', affectedCount: 1, reason: 'unavailable' }],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 0,
      nestedDirCount: 0,
      failedRootCount: 1,
    })
    expect(result.section).toContain('<available_docs>')
    expect(result.section).toContain('root=".specs/domain"')
    expect(result.section).toContain('受管目录列举失败')
    expect(result.section).toContain('请勿据此认为该目录没有文档')
    const withEntry = formatAvailableDocs({
      entries: [doc({ role: 'domain', title: '领域约束', relativePath: '.specs/domain/a.md' })],
      diagnostics: [{ code: 'root_list_failed', root: '.docs', role: 'doc', affectedCount: 1, reason: 'unknown' }],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 0,
      nestedDirCount: 0,
      failedRootCount: 1,
    })
    expect(withEntry.section).toContain('root=".docs"')
    expect(withEntry.section).toContain('请勿据此认为该目录没有文档')
  })

  it('对 Git 忽略的活动 Task Spec/Plan 注入工作台巡检提示', () => {
    const result = formatAvailableDocs({
      entries: [
        doc({ role: 'task', title: '任务', relativePath: '.specs/tasks/a.md' }),
        doc({ role: 'plan', title: '计划', relativePath: '.plans/a.md' }),
      ],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 0,
      nestedDirCount: 0,
      failedRootCount: 0,
    })
    expect(result.section).toContain('1 个活动 Task Spec 和 1 个活动 Plan')
    expect(result.section).toContain('Git 忽略的本地工作台')
    expect(result.section).toContain('status: done')
  })
})
