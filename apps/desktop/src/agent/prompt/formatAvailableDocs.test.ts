import { describe, expect, it } from 'vitest'
import { formatAvailableDocs, DOCS_METADATA_BUDGET_BYTES } from './formatAvailableDocs'
import { EMPTY_PROJECT_DOC_INVENTORY } from './projectDocs'

describe('formatAvailableDocs', () => {
  it('空清单返回 null', () => {
    const result = formatAvailableDocs(EMPTY_PROJECT_DOC_INVENTORY)
    expect(result.section).toBeNull()
    expect(result.omittedCount).toBe(0)
  })

  it('渲染 <available_docs> 含 role/path/title', () => {
    const result = formatAvailableDocs({
      entries: [{ role: 'domain', title: '领域约束', relativePath: '.specs/domain/a.md' }],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 0,
    })
    expect(result.section).toContain('<available_docs>')
    expect(result.section).toContain('<doc role="domain" path=".specs/domain/a.md">领域约束</doc>')
    expect(result.section).toContain('</available_docs>')
    expect(result.omittedCount).toBe(0)
  })

  it('XML escape role/path/title 中的特殊字符', () => {
    const result = formatAvailableDocs({
      entries: [{ role: 'doc', title: 'A <B> & "C"', relativePath: '.docs/a&b.md' }],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 0,
    })
    expect(result.section).toContain('A &lt;B&gt; &amp; &quot;C&quot;')
    expect(result.section).toContain('path=".docs/a&amp;b.md"')
    expect(result.section).not.toContain('<B>')
  })

  it('单条超过预算被省略且 section 为 null', () => {
    const huge = 'x'.repeat(DOCS_METADATA_BUDGET_BYTES + 1)
    const result = formatAvailableDocs({
      entries: [{ role: 'doc', title: huge, relativePath: '.docs/a.md' }],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 0,
    })
    expect(result.section).toBeNull()
    expect(result.omittedCount).toBe(1)
  })

  it('大量条目触发预算截断但保留已装入部分', () => {
    const entries = Array.from({ length: 1000 }, (_, index) => ({
      role: 'doc' as const,
      title: `doc-title-${index}`,
      relativePath: `.docs/doc-${index}.md`,
    }))
    const result = formatAvailableDocs({ entries, truncatedEntryCount: 0, truncatedRootCount: 0, archivedCount: 0 })
    expect(result.section).not.toBeNull()
    expect(result.section).toContain('<available_docs>')
    expect(result.omittedCount).toBeGreaterThan(0)
    expect(result.omittedCount).toBeLessThan(entries.length)
  })

  it('单目录条目上限截断输出显式 note（索引不是全集）', () => {
    const result = formatAvailableDocs({
      entries: [{ role: 'task', title: 't', relativePath: '.specs/tasks/a.md' }],
      truncatedEntryCount: 12,
      truncatedRootCount: 0,
      archivedCount: 0,
    })
    expect(result.section).toContain('另有 12 个文档因单目录条目上限')
    expect(result.section).toContain('可用 ls 查看目录实况')
  })

  it('宿主清单截断输出独立显式 note（条目计数只是下界）', () => {
    const result = formatAvailableDocs({
      entries: [{ role: 'task', title: 't', relativePath: '.specs/tasks/a.md' }],
      truncatedEntryCount: 0,
      truncatedRootCount: 2,
      archivedCount: 0,
    })
    expect(result.section).toContain('另有 2 个受管目录的清单被系统截断，可能还有未列入索引的文档')
    expect(result.section).toContain('可用 ls 查看目录实况')
    // 未截断时不输出该 note
    const intact = formatAvailableDocs({
      entries: [{ role: 'task', title: 't', relativePath: '.specs/tasks/a.md' }],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 0,
    })
    expect(intact.section).not.toContain('清单被系统截断')
  })

  it('截断计数与预算省略同时存在时输出两条 note', () => {
    const entries = Array.from({ length: 1000 }, (_, index) => ({
      role: 'doc' as const,
      title: `t-${index}`,
      relativePath: `.docs/d-${index}.md`,
    }))
    const result = formatAvailableDocs({ entries, truncatedEntryCount: 3, truncatedRootCount: 0, archivedCount: 0 })
    expect(result.section).toContain('因索引预算省略')
    expect(result.section).toContain('因单目录条目上限')
  })

  it('归档文档输出显式 note（status: done 不进索引但可追溯），未归档不输出', () => {
    const result = formatAvailableDocs({
      entries: [{ role: 'task', title: '活跃任务', relativePath: '.specs/tasks/a.md' }],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 3,
    })
    expect(result.section).toContain('另有 3 个文档已标记 status: done 归档')
    expect(result.section).toContain('可用 grep "status: done" 查找')
    const none = formatAvailableDocs({
      entries: [{ role: 'task', title: '活跃任务', relativePath: '.specs/tasks/a.md' }],
      truncatedEntryCount: 0,
      truncatedRootCount: 0,
      archivedCount: 0,
    })
    expect(none.section).not.toContain('status: done')
  })
})
