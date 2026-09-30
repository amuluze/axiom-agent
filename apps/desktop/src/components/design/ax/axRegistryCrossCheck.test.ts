// @vitest-environment node
/**
 * 存量稿 × 真实注册表的产物级核对（docs/ax-format.md §9「组件演进导致 `.ax` props
 * 失效」风险的守门用例）：`design_query` 读取路径（v4 起）会把组件清单注入解析器
 * 做注册表核对——组件改名/props 变更/fixture 调整都可能让**存量稿在读取时 fail-closed**，
 * 这类演进必须显式改稿而不是悄悄红。用例拿仓库里的真实 `.ax` 稿过一遍「解析 +
 * 注册表核对」，任何一条新报错都会在这里暴露，而不是等用户打开设计页。
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAxDocument } from '@/agent/design/axParser'
import { axComponentInventorySummary } from './registry'

const AX_FILES = ['.pen/axiom.ax', '.pen/website.ax']

/**
 * 样稿读取：缺失返回 null；**空文件单独标记**（0 字节是工作区残片，不是可核对
 * 的稿——与「缺失」同为显式 skip，但记账口径分开，避免把残片当正常态吞掉）。
 *
 * 路径注意：本文件在 apps/desktop/src/components/design/ax/ 下，到仓库根要上溯
 * **6 级**（importPen.test.ts 在 src/agent/design/ 下是 5 级）——这里曾少一级
 * 解析到 apps/.pen/（不存在），两条守门用例静默空转、绿灯毫无含义。
 */
const readAx = (relative: string): { source: string | null; empty: boolean } => {
  const path = resolve(import.meta.dirname, '../../../../../..', relative)
  if (!existsSync(path) || !statSync(path).isFile()) return { source: null, empty: false }
  if (statSync(path).size === 0) return { source: null, empty: true }
  return { source: readFileSync(path, 'utf8'), empty: false }
}

const AX_AVAILABLE = AX_FILES.map((file) => ({ file, ...readAx(file) }))

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

  // 空转守卫：本套件的存在意义是「真实稿 × 真实注册表」——样稿全部缺失时守门
  // 名存实亡，必须显式红（而不是静默全跳过、绿灯掩盖空转）。
  it('守门前提：至少一份真实 .ax 稿参与核对', () => {
    expect(AX_AVAILABLE.filter((item) => item.source !== null).length).toBeGreaterThan(0)
  })

  for (const { file, source, empty } of AX_AVAILABLE) {
    // 显式 skip（vitest 输出里可见的 skipped，而非通过）：缺失 = 已迁移/未导入，
    // 空文件 = 工作区残片（应清理或重建，不参与核对）。
    it.skipIf(source === null)(`${file}：解析 + 注册表核对零 error${empty ? '（空文件，工作区残片）' : ''}`, () => {
      const result = parseAxDocument(source as string, { componentInventory: inventory })
      const errors = result.diagnostics.filter((item) => item.level === 'error')
      expect(errors, errors.map((item) => `${item.path ?? '?'}: ${item.message}`).join('\n')).toHaveLength(0)
      expect(result.document).not.toBeNull()
    })
  }
})
