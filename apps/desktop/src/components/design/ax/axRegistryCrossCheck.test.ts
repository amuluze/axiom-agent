// @vitest-environment node
/**
 * 存量稿 × 真实注册表的产物级核对（docs/ax-format.md §9「组件演进导致 `.ax` props
 * 失效」风险的守门用例）：`design_query` 读取路径（v4 起）会把组件清单注入解析器
 * 做注册表核对——组件改名/props 变更/fixture 调整都可能让**存量稿在读取时 fail-closed**，
 * 这类演进必须显式改稿而不是悄悄红。用例拿仓库里的真实 `.ax` 稿过一遍「解析 +
 * 注册表核对」，任何一条新报错都会在这里暴露，而不是等用户打开设计页。
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAxDocument } from '@/agent/design/axParser'
import { axComponentInventorySummary } from './registry'

const AX_FILES = ['.pen/axiom.ax', '.pen/website.ax']

const readAx = (relative: string): string | null => {
  const path = resolve(import.meta.dirname, '../../../../..', relative)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

describe('真实 .ax 稿过注册表核对', () => {
  const inventory = axComponentInventorySummary()
  it('注册表摘要非空且各条目带 fixtureProps（核对的前提）', () => {
    expect(inventory.length).toBeGreaterThan(0)
    for (const entry of inventory) {
      if (entry.kind === 'presentational') {
        for (const fixture of entry.fixtures) {
          expect(Array.isArray(entry.fixtureProps?.[fixture]), `${entry.name}::${fixture} 缺 fixtureProps`).toBe(true)
        }
      }
    }
  })

  for (const file of AX_FILES) {
    it(`${file}：解析 + 注册表核对零 error`, () => {
      const source = readAx(file)
      if (source === null) return // 工作区无该稿时跳过（导入产物不进 git 的场景）
      const result = parseAxDocument(source, { componentInventory: inventory })
      const errors = result.diagnostics.filter((item) => item.level === 'error')
      expect(errors, errors.map((item) => `${item.path ?? '?'}: ${item.message}`).join('\n')).toHaveLength(0)
      expect(result.document).not.toBeNull()
    })
  }
})
