/**
 * 页面渲染扫描验证引擎测试（docs/ax-format.md §4.6 自校验回路）。
 *
 * 引擎是纯函数：渲染一步以回调注入——这里用受控 fake 覆盖全部判定路径
 * （渲染成功/失败/空白/无渲染环境），并用真实解析产物验证提取与诊断归属。
 */
import { describe, expect, it } from 'vitest'
import {
  extractScanPages,
  scanDesignDocument,
  scanDesignPages,
  scanDesignPagesBatch,
  type DesignScanIssue,
  type DesignScanPageInput,
  type DesignScanRenderPage,
} from './designScan'
import { parsePenDocument } from './penParser'
import type { PenDocument } from './penParser'
import { parseAxDocument } from './axParser'

const okRender = (width = 800, height = 600, topColorFraction = 0.4): DesignScanRenderPage =>
  async () => ({
    ok: true,
    width,
    height,
    samples: 16000,
    distinctColors: 512,
    topColorFraction,
  })

describe('extractScanPages（提取）', () => {
  it('提取页尺寸/名称/节点数，未知节点与缺失 ref 分别记账', () => {
    const source = JSON.stringify({
      version: '2.17',
      variables: {},
      children: [
        {
          type: 'frame', id: 'p1', name: '主页', width: 1180, height: 780,
          children: [
            { type: 'script', id: 'u1', name: '脚本节点' }, // 未知类型 → 占位框
            { type: 'ref', id: 'r1', ref: 'missing-component' }, // ref 目标缺失
            { type: 'text', id: 't1', content: 'x' },
          ],
        },
        { type: 'frame', id: 'p2', name: '次页', width: 400, height: 300, children: [] },
      ],
    })
    const doc = parsePenDocument(source, 'test.pen').document!
    const { pages, documentIssues } = extractScanPages(doc)

    expect(pages).toHaveLength(2)
    expect(pages[0]).toMatchObject({ index: 1, id: 'p1', name: '主页', width: 1180, height: 780 })
    expect(pages[0]!.nodeCount).toBe(4)
    expect(pages[0]!.textNodes).toBe(1)
    expect(pages[0]!.unknownNodes).toEqual(['脚本节点(script)'])
    expect(pages[0]!.refMissingIds).toEqual(['r1'])
    expect(pages[1]!.nodeCount).toBe(1)
    expect(pages[1]!.textNodes).toBe(0)
    // .pen 的文档级诊断（无路径）：ref 目标缺失 + 未知节点降级，各一条。
    expect(documentIssues).toHaveLength(2)
    expect(documentIssues.some((issue) => issue.message.includes('ref 指向未定义组件'))).toBe(true)
    expect(documentIssues.some((issue) => issue.message.includes('降级为占位框'))).toBe(true)
  })

  it('.ax 诊断按 pages[N] 前缀归属到页，无前缀的落文档级', () => {
    const source = JSON.stringify({
      ax: '1.0',
      name: 't',
      tokens: {},
      components: {},
      pages: [
        { id: 'a', name: 'A', width: 100, height: 100, tree: [] },
        { id: 'b', name: 'B', width: 100, height: 100, tree: [] },
      ],
    })
    const parsed = parseAxDocument(source)
    expect(parsed.document).not.toBeNull()
    // 只为 extractScanPages 造最小视图模型（它只消费 pages 与 diagnostics）。
    const doc = {
      ...parsed.document!,
      // 直接注入带路径的诊断（真实校验器对 pages[0]/pages[1]/文档级各产一条）。
      diagnostics: [
        { level: 'error' as const, message: '页 A 内错误', path: 'pages[0].tree[1]' },
        { level: 'warning' as const, message: '页 B 内警告', path: 'pages[1].tree[0]' },
        { level: 'warning' as const, message: '文档级警告' },
      ],
    } as unknown as PenDocument
    const { pages, documentIssues } = extractScanPages(doc)
    expect(pages[0]!.diagnostics).toHaveLength(1)
    expect(pages[0]!.diagnostics[0]!.message).toBe('页 A 内错误')
    expect(pages[1]!.diagnostics).toHaveLength(1)
    expect(pages[1]!.diagnostics[0]!.message).toBe('页 B 内警告')
    expect(documentIssues).toHaveLength(1)
    expect(documentIssues[0]!.message).toBe('文档级警告')
  })
})

describe('scanDesignPages（判定）', () => {
  const page = (overrides: Partial<DesignScanPageInput>): DesignScanPageInput => ({
    index: 1,
    id: 'p1',
    name: 'P1',
    width: 1180,
    height: 780,
    nodeCount: 5,
    textNodes: 0,
    unknownNodes: [],
    refMissingIds: [],
    diagnostics: [],
    ...overrides,
  })

  it('渲染成功且像素丰富 → ok', async () => {
    const report = await scanDesignPages([page({})], [], okRender())
    expect(report.pages[0]!.status).toBe('ok')
    expect(report.pages[0]!.render).toBe('ok')
    expect(report.pages[0]!.renderWidth).toBe(800)
    expect(report.summary).toEqual({ total: 1, ok: 1, warn: 0, fail: 0 })
    expect(report.rendered).toBe(true)
  })

  it('渲染成功但近乎空白（无文本节点的图形页）→ blank 警告', async () => {
    const report = await scanDesignPages([page({})], [], okRender(800, 600, 0.999))
    expect(report.pages[0]!.status).toBe('warn')
    expect(report.pages[0]!.issues.some((issue) => issue.check === 'blank')).toBe(true)
  })

  it('近乎空白但有文本节点（稀疏文本页）→ blankSparse 降为 info，页状态 ok 不阻断全绿门禁', async () => {
    const report = await scanDesignPages([page({ textNodes: 2 })], [], okRender(800, 600, 0.999))
    const issue = report.pages[0]!.issues.find((item) => item.check === 'blankSparse')
    expect(issue?.level).toBe('info')
    expect(issue?.message).toContain('疑似误报')
    expect(report.pages[0]!.status).toBe('ok')
    expect(report.summary).toEqual({ total: 1, ok: 1, warn: 0, fail: 0 })
  })

  it('info 级问题不影响页状态：与 warning 并存时仍按 warning 判 warn', async () => {
    const report = await scanDesignPages(
      [page({ textNodes: 2, unknownNodes: ['脚本(script)'] })],
      [],
      okRender(800, 600, 0.999),
    )
    expect(report.pages[0]!.issues.some((issue) => issue.level === 'info')).toBe(true)
    expect(report.pages[0]!.status).toBe('warn')
  })

  it('渲染失败（ok:false）→ fail 并带原因；回调抛错同样 fail', async () => {
    const failing: DesignScanRenderPage = async () => ({ ok: false, reason: '光栅化失败：无法创建画布上下文' })
    const report = await scanDesignPages([page({})], [], failing)
    expect(report.pages[0]!.status).toBe('fail')
    expect(report.pages[0]!.render).toBe('fail')
    expect(report.pages[0]!.issues[0]!.message).toContain('光栅化失败')

    const throwing: DesignScanRenderPage = async () => {
      throw new Error('boom')
    }
    const thrown = await scanDesignPages([page({})], [], throwing)
    expect(thrown.pages[0]!.status).toBe('fail')
  })

  it('无渲染环境 → 渲染检查 skipped，状态只由结构检查决定', async () => {
    const report = await scanDesignPages([page({})], [], undefined)
    expect(report.rendered).toBe(false)
    expect(report.pages[0]!.render).toBe('skipped')
    expect(report.pages[0]!.status).toBe('ok')
  })

  it('requireSize=true（.ax）：缺尺寸 → fail；requireSize=false（.pen）：组织性 frame → 警告并跳过渲染', async () => {
    const sizeless = [page({ width: null, height: null })]
    const axReport = await scanDesignPages(sizeless, [], okRender(), { requireSize: true })
    expect(axReport.pages[0]!.status).toBe('fail')
    expect(axReport.pages[0]!.render).toBe('skipped')

    const penReport = await scanDesignPages(sizeless, [], okRender(), { requireSize: false })
    expect(penReport.pages[0]!.status).toBe('warn')
    expect(penReport.pages[0]!.issues[0]!.level).toBe('warning')
    // 组织性 frame 不发起渲染调用（渲染回调不该被触发）。
  })

  it('空页 / 占位框 / 缺失 ref / 页级诊断各自产生对应问题', async () => {
    const report = await scanDesignPages(
      [
        page({
          nodeCount: 1,
          unknownNodes: ['脚本(script)'],
          refMissingIds: ['r1'],
          diagnostics: [{ level: 'warning', message: '页内诊断' }],
        }),
      ],
      [],
      okRender(),
    )
    const checks = report.pages[0]!.issues.map((issue) => issue.check)
    expect(checks).toEqual(expect.arrayContaining(['empty', 'placeholder', 'refMissing', 'diagnostic']))
    expect(report.pages[0]!.status).toBe('warn')
  })

  it('onProgress 逐页带回判定（画布逐页点亮的数据源）；fail 优先计入 summary', async () => {
    const progress: { done: number; total: number; verdictId: string; status: string }[] = []
    const pages = [page({ id: 'a', index: 1 }), page({ id: 'b', index: 2, width: null, height: null })]
    const report = await scanDesignPages(pages, [], okRender(), {
      requireSize: true,
      onProgress: ({ done, total, verdict }) =>
        progress.push({ done, total, verdictId: verdict.id, status: verdict.status }),
    })
    expect(progress).toEqual([
      { done: 1, total: 2, verdictId: 'a', status: 'ok' },
      { done: 2, total: 2, verdictId: 'b', status: 'fail' },
    ])
    expect(report.summary).toEqual({ total: 2, ok: 1, fail: 1, warn: 0 })
  })

  it('串行路径 onActive 显式回报在途页（单元素集合），结束回报 null', async () => {
    const active: (readonly string[] | null)[] = []
    const pages = [page({ id: 'a', index: 1 }), page({ id: 'b', index: 2 })]
    await scanDesignPages(pages, [], okRender(), {
      onActive: (ids) => active.push(ids),
    })
    expect(active).toEqual([['a'], ['b'], null])
  })

  it('renderConcurrency>1：渲染乱序完成时判定与进度仍按页序产出，onActive 为在途集合', async () => {
    // 第 1 页慢、第 2/3 页快：lane=3 同时开工，完成序 2,3,1——进度必须仍按页序。
    const delays = [30, 5, 5]
    const slowRender: DesignScanRenderPage = async (target) => {
      await new Promise((resolve) => setTimeout(resolve, delays[target.index - 1]))
      return { ok: true, width: 800, height: 600, samples: 100, distinctColors: 8, topColorFraction: 0.5 }
    }
    const progress: string[] = []
    const activeSizes = new Set<number>()
    const pages = [
      page({ id: 'a', index: 1 }),
      page({ id: 'b', index: 2 }),
      page({ id: 'c', index: 3 }),
    ]
    const report = await scanDesignPages(pages, [], slowRender, {
      renderConcurrency: 3,
      onProgress: ({ verdict }) => progress.push(verdict.id),
      onActive: (ids) => activeSizes.add(ids?.length ?? 0),
    })
    expect(progress).toEqual(['a', 'b', 'c'])
    expect(report.pages.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(activeSizes.has(3)).toBe(true)
  })

  it('文档级诊断原样进入报告', async () => {
    const documentIssues: DesignScanIssue[] = [{ check: 'diagnostic', level: 'warning', message: 'token 未使用' }]
    const report = await scanDesignPages([page({})], documentIssues, okRender())
    expect(report.documentIssues).toEqual(documentIssues)
  })
})

describe('scanDesignDocument（端到端，真实解析产物）', () => {
  it('.pen 全链路：正常页 ok、组织带跳过渲染、渲染失败页 fail', async () => {
    const source = JSON.stringify({
      version: '2.17',
      variables: {},
      children: [
        {
          type: 'frame', id: 'good', name: '正常页', width: 800, height: 600,
          children: [{ type: 'text', id: 't', content: '内容' }],
        },
        { type: 'frame', id: 'band', name: 'Section — 组织带' }, // 无高度
        { type: 'frame', id: 'bad', name: '坏页', width: 800, height: 600, children: [] },
      ],
    })
    const doc = parsePenDocument(source, 't.pen').document!
    const report = await scanDesignDocument(
      doc,
      async (page) => (page.id === 'bad' ? { ok: false, reason: '光栅化失败' } : okRender()(page)),
      { requireSize: false },
    )
    expect(report.pages.map((page) => page.status)).toEqual(['ok', 'warn', 'fail'])
    expect(report.pages[1]!.issues[0]!.check).toBe('size')
    expect(report.pages[1]!.render).toBe('skipped')
    expect(report.pages[2]!.render).toBe('fail')
    // 坏页同时是空页（warn）+ 渲染失败（error）——error 优先决定整页 fail。
    expect(report.pages[2]!.issues.some((issue) => issue.check === 'render' && issue.level === 'error')).toBe(true)
  })

  it('.ax 缺尺寸页直接 fail（requireSize=true）', async () => {
    const source = JSON.stringify({
      ax: '1.0',
      name: 't',
      tokens: {},
      components: {},
      pages: [{ id: 'a', name: 'A', tree: [] }],
    })
    const parsed = parseAxDocument(source)
    const doc = { ...parsed.document!, diagnostics: [] } as unknown as PenDocument
    const report = await scanDesignDocument(doc, okRender(), { requireSize: true })
    expect(report.pages[0]!.status).toBe('fail')
  })
})

describe('scanDesignPagesBatch（画布原位扫描引擎）', () => {
  const pageInput = (id: string, overrides: Partial<DesignScanPageInput> = {}): DesignScanPageInput => ({
    index: 1,
    id,
    name: id,
    width: 200,
    height: 120,
    nodeCount: 2,
    textNodes: 0,
    unknownNodes: [],
    refMissingIds: [],
    diagnostics: [],
    ...overrides,
  })

  it('批量回报：判定与进度逐页产出（不等整批结束）', async () => {
    const progress: number[] = []
    const pages = [pageInput('a'), pageInput('b'), pageInput('c')]
    const report = await scanDesignPagesBatch(pages, [], async (_renderable, onPageDone) => {
      onPageDone('b', { ok: true, width: 2, height: 1, samples: 10, distinctColors: 4, topColorFraction: 0.5 })
      onPageDone('a', { ok: true, width: 2, height: 1, samples: 10, distinctColors: 4, topColorFraction: 0.5 })
      onPageDone('c', { ok: false, reason: '截图失败' })
    }, { onProgress: (update) => progress.push(update.done) })
    expect(progress).toEqual([1, 2, 3])
    expect(report.summary).toEqual({ total: 3, ok: 2, fail: 1, warn: 0 })
    expect(report.pages.map((page) => page.id)).toEqual(['a', 'b', 'c'])
    expect(report.pages.find((page) => page.id === 'c')?.issues.some((issue) => issue.check === 'render')).toBe(true)
    expect(report.rendered).toBe(true)
  })

  it('未回报页（扫描中断）记 skipped + warning，不伪装成通过或失败', async () => {
    const report = await scanDesignPagesBatch([pageInput('a'), pageInput('b')], [], async (_r, onPageDone) => {
      onPageDone('a', { ok: true, width: 2, height: 1, samples: 10, distinctColors: 4, topColorFraction: 0.5 })
      // b 未回报（用户中断）。
    })
    const b = report.pages.find((page) => page.id === 'b')!
    expect(b.render).toBe('skipped')
    expect(b.status).toBe('warn')
    expect(b.issues.some((issue) => issue.message.includes('渲染检查未完成'))).toBe(true)
  })

  it('近乎空白：批量路径同样触发 blank 警告', async () => {
    const report = await scanDesignPagesBatch([pageInput('a')], [], async (_r, onPageDone) => {
      onPageDone('a', { ok: true, width: 2, height: 1, samples: 16000, distinctColors: 1, topColorFraction: 0.999 })
    })
    expect(report.pages[0]?.issues.some((issue) => issue.check === 'blank')).toBe(true)
    expect(report.pages[0]?.status).toBe('warn')
  })

  it('结构检查先行：无尺寸页不进批量渲染器（requireSize 口径）', async () => {
    const seen: string[] = []
    await scanDesignPagesBatch(
      [pageInput('sized'), pageInput('band', { width: null, height: null })],
      [],
      async (renderable) => {
        seen.push(...renderable.map((page) => page.id))
      },
      { requireSize: true },
    )
    expect(seen).toEqual(['sized'])
  })
})
