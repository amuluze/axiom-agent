import { describe, expect, it } from 'vitest'
import { TESTING_CONTEXT_MAX_BYTES, buildTestingContextSection } from './testingContextSection'

const file = (
  path: string,
  options: { valid?: boolean; caseCount?: number; issue?: { path: string; message: string } } = {},
) => ({
  path,
  valid: options.valid ?? true,
  caseCount: options.caseCount ?? 1,
  firstIssue: options.issue ?? null,
})

describe('buildTestingContextSection', () => {
  it('returns null when the workspace has no test assets', () => {
    expect(buildTestingContextSection({ files: [], environments: [] })).toBeNull()
  })

  it('summarises files, needs-repair reasons and environments', () => {
    const section = buildTestingContextSection({
      files: [
        file('tests/checkout.testspec.json', { caseCount: 2 }),
        file('tests/broken.testspec.json', { valid: false, issue: { path: '$.version', message: '不支持的版本，当前支持 1 / 2 / 3' } }),
      ],
      environments: [
        { name: '本地开发', kind: 'local', hasRecipe: true },
        { name: '预发', kind: 'remote', hasRecipe: false },
      ],
    })
    expect(section).toContain('# 测试会话上下文')
    expect(section).toContain('共 2 个用例文件（校验通过 1，需要修复 1）')
    expect(section).toContain('- tests/checkout.testspec.json（2 条用例）')
    expect(section).toContain('- tests/broken.testspec.json：$.version 不支持的版本，当前支持 1 / 2 / 3')
    expect(section).toContain('- 本地开发（本地（Axiom 起停），有起停配方）')
    expect(section).toContain('- 预发（远程（只读校验））')
    // 技能与文档指向必须始终在：这是"模型知道自己该怎么做"的最小抓手。
    expect(section).toContain('test-design')
    expect(section).toContain('docs/ui-api-automation-usage.md')
  })

  it('works when only environments exist and when only files exist', () => {
    const environmentsOnly = buildTestingContextSection({
      files: [],
      environments: [{ name: '预发', kind: 'remote', hasRecipe: false }],
    })
    expect(environmentsOnly).toContain('共 0 个用例文件')
    expect(environmentsOnly).toContain('运行环境：')
    expect(environmentsOnly).not.toContain('校验通过：')

    const filesOnly = buildTestingContextSection({ files: [file('tests/a.testspec.json')], environments: [] })
    expect(filesOnly).toContain('校验通过：')
    expect(filesOnly).not.toContain('运行环境：')
  })

  it('keeps the section inside the byte budget and counts what it dropped', () => {
    const files = Array.from({ length: 400 }, (_, index) => file(
      `tests/very-long-file-name-${index.toString().padStart(3, '0')}.testspec.json`,
      { caseCount: 3 },
    ))
    const section = buildTestingContextSection({ files, environments: [] })
    expect(section).not.toBeNull()
    if (section === null) return
    expect(new TextEncoder().encode(section).byteLength).toBeLessThanOrEqual(TESTING_CONTEXT_MAX_BYTES)
    // 截断必须显式：出现省略计数，且纪律收尾仍然完整。
    expect(section).toMatch(/另有 \d+ 项因上下文预算省略/)
    expect(section).toContain('docs/ui-api-automation-usage.md')
    expect(section).not.toContain('very-long-file-name-399')
  })

  it('never lists transient UI selections', () => {
    const section = buildTestingContextSection({
      files: [file('tests/a.testspec.json', { caseCount: 1 })],
      environments: [{ name: '预发', kind: 'remote', hasRecipe: false }],
    })
    // 选中态不进提示词：段里不出现"当前选中 / 当前环境 id"这类词。
    expect(section).not.toContain('当前选中')
    expect(section).not.toContain('当前环境：')
  })
})
