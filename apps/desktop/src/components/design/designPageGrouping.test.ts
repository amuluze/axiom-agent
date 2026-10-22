import { describe, expect, it } from 'vitest'
import {
  AUTO_LAYOUT_GAP,
  AUTO_LAYOUT_ROW_MAX_WIDTH,
  buildPlacements,
  resolvePageGroups,
} from './designPageGrouping'
import type { PenDocument, PenNodeUnion } from '@/agent/design/penParser'

const frame = (props: {
  id: string
  name?: string
  x?: number
  y?: number
  width?: number
  height?: number
  children?: PenNodeUnion[]
}): PenNodeUnion => ({ type: 'frame', ...props })

const text = (id: string, content: string): PenNodeUnion => ({ type: 'text', id, content })

const doc = (
  pages: PenNodeUnion[],
  pageMetadata?: PenDocument['pageMetadata'],
): PenDocument => ({
  fileName: '.pen/design.ax',
  pages,
  components: {},
  variables: {},
  modeVariables: { light: {}, dark: {} },
  diagnostics: [],
  ...(pageMetadata ? { pageMetadata } : {}),
})

describe('resolvePageGroups 三级分组', () => {
  it('声明分组（.ax 页级 group）优先，组按首次出现排序', () => {
    const result = resolvePageGroups(doc(
      [frame({ id: 'a', width: 100, height: 100 }), frame({ id: 'b', width: 100, height: 100 }), frame({ id: 'c', width: 100, height: 100 })],
      { a: { group: 'session' }, b: { group: 'settings' }, c: { group: 'session' } },
    ))
    // 页名（即 id）无信息量 → 标题退化到声明键本身；单页组不展示标题（组头
    // 会与页标签重复成噪声）。
    expect(result).toEqual([
      { key: 'declared:session', title: 'session', pageIds: ['a', 'c'] },
      { key: 'declared:settings', title: null, pageIds: ['b'] },
    ])
  })

  it('声明组标题：成员名公共前缀就是文档前缀时退化到声明键', () => {
    // 两页稿的严格 LCP「设置」会被当作文档前缀剥掉（剩余段无复现），标题退化
    // 到声明键——大稿里文档前缀由多数派（≥2/3）判定，不受此影响。
    const result = resolvePageGroups(doc(
      [
        frame({ id: 'a', name: '设置 / 模型 · 1180×780', width: 100, height: 100 }),
        frame({ id: 'b', name: '设置 / 常规 · 1180×672', width: 100, height: 100 }),
      ],
      { a: { group: 'settings' }, b: { group: 'settings' } },
    ))
    expect(result[0]?.title).toBe('settings')
  })

  it('声明组标题：前缀被个别成员破坏时取覆盖过半的最高频分段，再退化声明键', () => {
    const pages = [
      frame({ id: 's1', name: 'Axiom — 会话 / 已完成', width: 100, height: 100 }),
      frame({ id: 's2', name: 'Axiom — 会话 / 失败', width: 100, height: 100 }),
      frame({ id: 's3', name: 'Axiom — 新任务', width: 100, height: 100 }),
      frame({ id: 's4', name: 'Axiom — 图片灯箱', width: 100, height: 100 }),
    ]
    const metadata = { s1: { group: 'session' }, s2: { group: 'session' }, s3: { group: 'session' }, s4: { group: 'session' } }
    // 「会话」覆盖 2/4 成员 → 用「会话」而不是裸键。
    expect(resolvePageGroups(doc(pages, metadata))[0]?.title).toBe('会话')
    // 面板组成员名互不相同（SSH 面板只占 2/5）→ 退化到声明键。
    const panelPages = [
      frame({ id: 'p1', name: '运行时面板', width: 100, height: 100 }),
      frame({ id: 'p2', name: '浏览器面板', width: 100, height: 100 }),
      frame({ id: 'p3', name: '电脑控制面板', width: 100, height: 100 }),
      frame({ id: 'p4', name: 'SSH 面板', width: 100, height: 100 }),
      frame({ id: 'p5', name: 'SSH 面板 · 主机下拉', width: 100, height: 100 }),
    ]
    const panelMetadata = Object.fromEntries(panelPages.map((page) => [page.id, { group: 'panel' }]))
    expect(resolvePageGroups(doc(panelPages, panelMetadata))[0]?.title).toBe('panel')
  })

  it('无声明时按名称分段分组：剥离文档公共前缀与尺寸后缀', () => {
    const result = resolvePageGroups(doc([
      frame({ id: 'a', name: 'Axiom — 会话 / 已完成 · 1180×780', width: 100, height: 100 }),
      frame({ id: 'b', name: 'Axiom — 会话 / 失败 · 1180×780', width: 100, height: 100 }),
      frame({ id: 'c', name: 'Axiom — 设置 / 模型 · 1180×780', width: 100, height: 100 }),
      frame({ id: 'd', name: 'Axiom — 新任务 · 1180×780', width: 100, height: 100 }),
      frame({ id: 'e', name: '组件库 · 导航与输入', width: 100, height: 100 }),
      frame({ id: 'f', name: '组件库 · 会话消息', width: 100, height: 100 }),
    ]))
    // 严格 LCP 被「组件库」页破坏 → 退化为覆盖过半的最高频首段「Axiom」。
    expect(result).toEqual([
      { key: 'name:会话', title: '会话', pageIds: ['a', 'b'] },
      { key: 'name:设置', title: null, pageIds: ['c'] },
      { key: 'name:新任务', title: null, pageIds: ['d'] },
      { key: 'name:组件库', title: '组件库', pageIds: ['e', 'f'] },
    ])
  })

  it('名称无信号（全员唯一分段）时按内容指纹聚类：同内容页聚合', () => {
    const result = resolvePageGroups(doc([
      frame({ id: 'p1', width: 100, height: 100, children: [text('t1', '你好'), text('t2', '世界')] }),
      frame({ id: 'p2', width: 100, height: 100, children: [text('t3', '你好'), text('t4', '世界')] }),
      frame({ id: 'p3', width: 100, height: 100, children: [text('t5', '完全不同'), text('t6', '别的内容')] }),
    ]))
    const first = result[0]
    expect(first?.pageIds).toEqual(['p1', 'p2'])
    expect(result[1]?.pageIds).toEqual(['p3'])
    // 无声明键且成员名（页 id）无信息 → 不展示标题。
    expect(first?.title).toBeNull()
  })

  it('组件名参与指纹：共享组件与大部分文案的同屏状态聚为一组', () => {
    const componentPage = (id: string, componentName: string, labels: string[]): PenNodeUnion => ({
      type: 'frame',
      id,
      width: 100,
      height: 100,
      children: [
        { type: 'component', id: `${id}-c`, name: componentName },
        ...labels.map((label, index) => text(`${id}-t${index}`, label)),
      ],
    })
    const result = resolvePageGroups(doc([
      componentPage('a', 'Sidebar', ['会话', '侧栏', '任务一']),
      componentPage('b', 'Sidebar', ['会话', '侧栏', '任务二']),
      componentPage('c', 'Composer', ['输入框', '发送']),
    ]))
    expect(result[0]?.pageIds).toEqual(['a', 'b'])
  })

  it('结果覆盖全部页各恰好一次（状态栏导航与排布共用，漏页两处同时坏）', () => {
    const pages = [
      frame({ id: 'a', name: 'Axiom — 会话', width: 100, height: 100 }),
      frame({ id: 'b', name: 'Axiom — 会话 / 失败', width: 100, height: 100 }),
      frame({ id: 'c', width: 100, height: 100 }),
      frame({ id: 'd', name: '', width: 100, height: 100 }),
    ]
    const result = resolvePageGroups(doc(pages))
    const ids = result.flatMap((group) => group.pageIds)
    expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('空文档返回空数组', () => {
    expect(resolvePageGroups(doc([]))).toEqual([])
  })
})

describe('buildPlacements 分组排布', () => {
  it('有坐标页原样保留，无坐标页排在既有内容下方', () => {
    const pages = [
      frame({ id: 'fixed', name: '固定页', x: 210, y: 0, width: 200, height: 120 }),
      frame({ id: 'auto-1', name: '会话', width: 200, height: 120 }),
      frame({ id: 'auto-2', name: '设置', width: 200, height: 120 }),
    ]
    const { placements, groupBands } = buildPlacements(pages, doc(pages))
    expect(groupBands).toEqual([])
    const fixed = placements.find((item) => item.page.id === 'fixed')
    expect(fixed).toMatchObject({ x: 210, y: 0 })
    // 两页无分组信号（内容互异）→ 并入同一行（连续无标题组合并）。
    const auto1 = placements.find((item) => item.page.id === 'auto-1')
    const auto2 = placements.find((item) => item.page.id === 'auto-2')
    expect(auto1).toMatchObject({ x: 210, y: 120 + AUTO_LAYOUT_GAP })
    expect(auto2).toMatchObject({ x: 210 + 200 + AUTO_LAYOUT_GAP, y: 120 + AUTO_LAYOUT_GAP })
  })

  it('声明分组排成多行，组头带描述整组（首行上方、跨行右缘）', () => {
    const pages = [
      frame({ id: 'p1', name: '会话 / 已完成', width: 1180, height: 780 }),
      frame({ id: 'p2', name: '会话 / 失败', width: 1180, height: 780 }),
      frame({ id: 'p3', name: '设置 / 模型', width: 1180, height: 780 }),
      frame({ id: 'p4', name: '设置 / 常规', width: 1180, height: 780 }),
    ]
    const document = doc(pages, {
      p1: { group: 'session' }, p2: { group: 'session' },
      p3: { group: 'settings' }, p4: { group: 'settings' },
    })
    const { placements, groupBands } = buildPlacements(pages, document)
    const at = (id: string) => {
      const found = placements.find((item) => item.page.id === id)
      expect(found).toBeDefined()
      return found!
    }
    expect(at('p1')).toMatchObject({ x: 0, y: AUTO_LAYOUT_GAP })
    expect(at('p2')).toMatchObject({ x: 1180 + AUTO_LAYOUT_GAP, y: AUTO_LAYOUT_GAP })
    // 第二组换行：首行高 780 + 间距。
    expect(at('p3')).toMatchObject({ x: 0, y: AUTO_LAYOUT_GAP + 780 + AUTO_LAYOUT_GAP })
    expect(at('p4')).toMatchObject({ x: 1180 + AUTO_LAYOUT_GAP, y: AUTO_LAYOUT_GAP + 780 + AUTO_LAYOUT_GAP })
    expect(groupBands).toEqual([
      { key: 'declared:session', title: '会话', count: 2, rowTop: AUTO_LAYOUT_GAP, left: 0, right: 1180 + AUTO_LAYOUT_GAP + 1180 },
      { key: 'declared:settings', title: '设置', count: 2, rowTop: AUTO_LAYOUT_GAP + 780 + AUTO_LAYOUT_GAP, left: 0, right: 1180 + AUTO_LAYOUT_GAP + 1180 },
    ])
  })

  it('行宽超过上限折行：组头带仍在首行、右缘覆盖最宽行', () => {
    const pages = Array.from({ length: 7 }, (_, index) =>
      frame({ id: `page-${index}`, name: `页面 ${index}`, width: 1180, height: 100 }))
    const metadata = Object.fromEntries(pages.map((page) => [page.id, { group: 'g' }]))
    const { placements, groupBands } = buildPlacements(pages, doc(pages, metadata))
    // 6 张 1180 宽页 + 5 个间距 = 7680 ≤ 7800；第 7 张越限折行。
    expect(AUTO_LAYOUT_ROW_MAX_WIDTH).toBe(7800)
    const ys = new Set(placements.map((item) => item.y))
    expect(ys.size).toBe(2)
    const firstRow = placements.filter((item) => item.y === AUTO_LAYOUT_GAP)
    expect(firstRow).toHaveLength(6)
    // 组头带右缘覆盖最宽行（首行 6 张：5×间距 + 6×1180 = 7680）。
    expect(groupBands).toEqual([
      { key: 'declared:g', title: 'g', count: 7, rowTop: AUTO_LAYOUT_GAP, left: 0, right: 5 * AUTO_LAYOUT_GAP + 6 * 1180 },
    ])
  })

  it('单张巨页独占一行（每行保底一页，不因超宽丢页）', () => {
    const pages = [
      frame({ id: 'big-1', name: '巨页 1', width: 9000, height: 100 }),
      frame({ id: 'big-2', name: '巨页 2', width: 9000, height: 100 }),
    ]
    const metadata = { 'big-1': { group: 'g' }, 'big-2': { group: 'g' } }
    const { placements, groupBands } = buildPlacements(pages, doc(pages, metadata))
    expect(placements.map((item) => item.y)).toEqual([AUTO_LAYOUT_GAP, AUTO_LAYOUT_GAP + 100 + AUTO_LAYOUT_GAP])
    expect(groupBands).toEqual([
      { key: 'declared:g', title: 'g', count: 2, rowTop: AUTO_LAYOUT_GAP, left: 0, right: 9000 },
    ])
  })

  it('无高度的组织性 frame 保留 hasHeight 标记与兜底尺寸', () => {
    const pages = [frame({ id: 'band', name: 'Section — 会话', width: 8980 })]
    const { placements } = buildPlacements(pages, doc(pages))
    expect(placements[0]).toMatchObject({ hasHeight: false, width: 8980, height: 240 })
  })

  it('全部页都有坐标时不产出自动块与组头带', () => {
    const pages = [
      frame({ id: 'a', name: 'A', x: 0, y: 0, width: 100, height: 100 }),
      frame({ id: 'b', name: 'B', x: 200, y: 0, width: 100, height: 100 }),
    ]
    const { placements, groupBands } = buildPlacements(pages, doc(pages))
    expect(placements.map((item) => item.page.id)).toEqual(['a', 'b'])
    expect(groupBands).toEqual([])
  })
})
