import { describe, expect, it } from 'vitest'
import { parseAxDocument } from '@/agent/design/axParser'
import { projectAxToPenDocument } from '@/agent/design/axProjection'
import { densityIssuesOf, extractScanPages } from '@/agent/design/designScan'
import { designDraftsAvailable, readDesignDraft } from './designDraftFixtures'
import { axComponentInventorySummary } from './registry'

/**
 * 真实稿的密度口径回归（`densitySparse` 的豁免条件在真稿上的表现）。
 *
 * 背景：该检查曾只按 `text < 8 && frame >= 5` 判定——「组件库 · 导航与输入」这类
 * 结构由真实组件实例承担的页会被误报（页面本身只有 3 行文案，5 个 frame 全是组件
 * 宿主布局）。豁免条件（`part + component` 合计 ≥ 2 视为结构已交给实现词汇）落地后，
 * 需要在**真稿**上锁住它：单元用例只喂构造输入，防不住「真稿形态落在豁免边界之外」。
 *
 * 稿件路径与「公开快照缺席即 skip」的判据见 ./designDraftFixtures。
 */
describe('axiom.ax 的密度口径（真稿）', () => {
  it.skipIf(!designDraftsAvailable)('全稿无 densitySparse 误报（含组件库页）', () => {
    const source = readDesignDraft('axiom.ax')
    const parsed = parseAxDocument(source, { componentInventory: axComponentInventorySummary() })
    expect(parsed.diagnostics.filter((item) => item.level === 'error')).toEqual([])
    if (!parsed.document) throw new Error(parsed.error ?? 'invalid design document')
    const projection = projectAxToPenDocument(parsed.document, 'axiom.ax').document
    if (!projection) throw new Error('投影失败')

    const { pages } = extractScanPages(projection)
    const libNav = pages.find((page) => page.id === 'libNav')
    expect(libNav).toBeDefined()
    if (libNav) {
      // 前提成立：文案不足 8 行且 frame 数达到「列表/表格样态」阈值——豁免只能来自
      // 「结构已交给实现词汇」这一条，不能靠形态本身。
      expect(libNav.textNodes).toBeLessThan(8)
      expect(libNav.frameCount).toBeGreaterThanOrEqual(5)
      expect(libNav.partCount + libNav.componentCount).toBeGreaterThanOrEqual(2)
      expect(densityIssuesOf(libNav, undefined).find((issue) => issue.check === 'densitySparse')).toBeUndefined()
    }

    const sparse = pages
      .flatMap((page) => densityIssuesOf(page, undefined))
      .filter((issue) => issue.check === 'densitySparse')
    expect(sparse).toEqual([])
  })
})
