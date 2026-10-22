// @vitest-environment node
/**
 * 完整度 rubric 镜像校验：`completenessRubric.ts` 的数字字段必须与 design skill
 * body `# 完整度清单` / `# Completeness rubric` 段逐字段一致——提示词改了数字，
 * 机器侧忘了同步会直接被这条测试发现。两边任何一边改数字时也必须同步另一边。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AX_COMPLETENESS } from './completenessRubric'

const SKILL_FILE = resolve(import.meta.dirname, '../skills/builtinSkillBodies.ts')

interface SkillBlock {
  name: string
  startLine: number
  endLine: number
}

/** 在 design skill body 中定位 `# 完整度清单` / `# Completeness rubric` 段。 */
const findBlocks = (lines: string[]): { zh: SkillBlock; en: SkillBlock } => {
  const find = (heading: string): SkillBlock => {
    const startIndex = lines.findIndex((line) => line.trim() === heading)
    if (startIndex < 0) throw new Error(`找不到节标题：${heading}`)
    // 下一个 `# ` 标题前收尾
    let endIndex = startIndex + 1
    while (endIndex < lines.length) {
      const next = lines[endIndex] ?? ''
      if (next.trim().startsWith('# ') && endIndex !== startIndex) break
      endIndex += 1
    }
    return { name: heading, startLine: startIndex + 1, endLine: endIndex }
  }
  return { zh: find('# 完整度清单'), en: find('# Completeness rubric') }
}

/** 提取段中所有中文/阿拉伯数字字面量（含「≥ 8」「8 行」之类）。 */
const extractNumbers = (text: string): number[] => {
  const matches = text.match(/\d+/g) ?? []
  return matches.map((value) => Number.parseInt(value, 10)).filter((value) => Number.isFinite(value))
}

describe('完整度 rubric 镜像校验', () => {
  const lines = readFileSync(SKILL_FILE, 'utf8').split('\n')
  const blocks = findBlocks(lines)

  it('zh `# 完整度清单` 与 en `# Completeness rubric` 数字字面量集合完全一致', () => {
    const zhText = lines.slice(blocks.zh.startLine, blocks.zh.endLine).join('\n')
    const enText = lines.slice(blocks.en.startLine, blocks.en.endLine).join('\n')
    // 数字集合相同 = 任何一边新增/删除/改数字时立刻显式红
    expect(extractNumbers(zhText).sort((a, b) => a - b)).toEqual(extractNumbers(enText).sort((a, b) => a - b))
  })

  it('rubric 关键阈值（8/3/5/7）显式出现在 zh 与 en 段中', () => {
    const zhText = lines.slice(blocks.zh.startLine, blocks.zh.endLine).join('\n')
    const enText = lines.slice(blocks.en.startLine, blocks.en.endLine).join('\n')
    // 8: 列表/表格行、导航项
    // 3: 特性段、定价档、KPI 卡
    // 5: FAQ
    // 7: 管理后台页数
    for (const expected of [8, 3, 5, 7]) {
      expect(extractNumbers(zhText)).toContain(expected)
      expect(extractNumbers(enText)).toContain(expected)
    }
  })

  it('rubric 字段值的数值与段中字面量一致（4 个核心阈值）', () => {
    // 双向：rubric 改了 → 段也得改；段改了 → rubric 字段也得改
    // 这一例只断言 4 个最常被引用的「最低数」字段，避免 rubric 内部常量（阈值/比例）漂移
    const expectations: Array<[string, keyof typeof AX_COMPLETENESS, number]> = [
      ['textNodeFloor', 'textNodeFloor', 8],
      ['adminPageFloor', 'adminPageFloor', 7],
      ['kpiCardFloor', 'kpiCardFloor', 3],
      ['faqItemFloor', 'faqItemFloor', 5],
    ]
    for (const [label, key, expected] of expectations) {
      expect(AX_COMPLETENESS[key], `${label} 期望 ${expected}`).toBe(expected)
    }
  })
})
