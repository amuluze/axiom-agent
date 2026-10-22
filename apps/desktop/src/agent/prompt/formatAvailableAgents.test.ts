import { describe, expect, it } from 'vitest'
import { MAX_NESTED_AGENTS_DEPTH, MAX_NESTED_AGENTS_ENTRIES } from './projectAgents'
import { AGENTS_METADATA_BUDGET_BYTES, formatAvailableAgents } from './formatAvailableAgents'

describe('formatAvailableAgents', () => {
  it('空清单返回 null（不输出空壳 XML）', () => {
    expect(formatAvailableAgents({ entries: [], truncated: false })).toEqual({ section: null, omittedCount: 0 })
  })

  it('渲染路径条目，并说明「先读再改」与「索引只含路径」', () => {
    const result = formatAvailableAgents({
      entries: ['apps/desktop/AGENTS.md', 'packages/api/AGENTS.md'],
      truncated: false,
    })
    expect(result.section).toContain('<agents-file path="apps/desktop/AGENTS.md"/>')
    expect(result.section).toContain('<agents-file path="packages/api/AGENTS.md"/>')
    expect(result.section).toContain('开始修改某个目录前')
    expect(result.section).toContain('索引只含路径不含正文')
    expect(result.section).toContain('</available_agents>')
  })

  it('常驻说明 .gitignore、跳过目录与深度上限——所有不可见来源都要让模型知道', () => {
    const result = formatAvailableAgents({ entries: ['apps/AGENTS.md'], truncated: false })
    expect(result.section).toContain('.gitignore')
    expect(result.section).toContain('node_modules')
    expect(result.section).toContain(`扫描深度上限为 ${MAX_NESTED_AGENTS_DEPTH} 层`)
  })

  it('path 做 XML 转义', () => {
    const result = formatAvailableAgents({ entries: ['a&b/<c>/AGENTS.md'], truncated: false })
    expect(result.section).toContain('path="a&amp;b/&lt;c&gt;/AGENTS.md"')
  })

  it('超出预算的条目跳过并计数（不静默缩窄）', () => {
    const entries = Array.from({ length: 400 }, (_, index) => `deep/nested/dir/${index}/AGENTS.md`)
    const result = formatAvailableAgents({ entries, truncated: false })
    expect(result.omittedCount).toBeGreaterThan(0)
    expect(result.section).toContain('因索引预算省略')
    expect(new TextEncoder().encode(result.section ?? '').byteLength)
      .toBeLessThanOrEqual(AGENTS_METADATA_BUDGET_BYTES + 256)
  })

  it('全部条目超预算时仍输出带省略计数的提示（不整块消失）', () => {
    // 累计预算下「一行都没装进」要求每行本身就超过整个预算，故用超长路径构造。
    const entries = Array.from({ length: 3 }, (_, index) => `${'x'.repeat(AGENTS_METADATA_BUDGET_BYTES)}/${index}/AGENTS.md`)
    const result = formatAvailableAgents({ entries, truncated: false })
    expect(result.section).toContain('<available_agents>')
    expect(result.section).toContain('因索引预算省略')
    expect(result.section).toContain('</available_agents>')
    expect(result.omittedCount).toBe(entries.length)
    expect(new TextEncoder().encode(result.section ?? '').byteLength)
      .toBeLessThanOrEqual(AGENTS_METADATA_BUDGET_BYTES)
  })

  it('扫描触达条目上限时注入 note，指明可能还有未列入的 AGENTS.md', () => {
    const result = formatAvailableAgents({ entries: ['apps/AGENTS.md'], truncated: true })
    expect(result.section).toContain(`条目上限（${MAX_NESTED_AGENTS_ENTRIES}）`)
    expect(result.section).toContain('find')
  })

  it('未触达上限时不注入截断 note', () => {
    const result = formatAvailableAgents({ entries: ['apps/AGENTS.md'], truncated: false })
    expect(result.section).not.toContain('条目上限')
  })
})
