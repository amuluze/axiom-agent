import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import type { DesignDocumentContent } from '@/platform/designDocument'
import type { JsonValue } from '@/agent/core/types'
import { vi } from 'vitest'
import { createDesignQueryTool } from './designQueryTool'
import { setDesignPageRenderProvider, setPngDecodeProvider, setDesignScanPageRenderProvider } from '@/agent/design/designRenderHost'
import { setDesignComponentDetailProvider } from '@/agent/design/componentInventoryHost'
import { AX_FORMAT_VERSION } from '@/agent/design/axSchema'

const PEN_SOURCE = JSON.stringify({
  variables: {},
  children: [
    { type: 'frame', id: 'page-1', name: '首页', children: [
      { type: 'text', id: 't-1', content: 'hello', fontSize: 16 },
      { type: 'frame', id: 'f-1', children: [{ type: 'icon', id: 'i-1', icon: 'trash' }] },
    ] },
    { type: 'frame', id: 'page-2', name: '设置' },
    { type: 'frame', id: 'comp-1', name: 'Card', reusable: true, children: [{ type: 'text', id: 'ct-1', content: 'Card' }] },
  ],
})

const documentContent: DesignDocumentContent = {
  contentBase64: Buffer.from(PEN_SOURCE, 'utf-8').toString('base64'),
  sha256: 'a'.repeat(64),
  sizeBytes: PEN_SOURCE.length,
  modifiedMs: null,
  unchanged: false,
}

const environmentWith = (
  readDocument: (path: string) => Promise<DesignDocumentContent>,
): AgentEnvironment =>
  ({
    design: { readDocument },
  }) as unknown as AgentEnvironment

const tool = createDesignQueryTool(environmentWith((path) => {
  if (path === '.pen/axiom.pen') return Promise.resolve(documentContent)
  return Promise.reject(new Error('not found'))
}))

const AX_SOURCE = JSON.stringify({
  ax: '1.0',
  name: 'axiom',
  tokens: {
    'bg-main': { $type: 'color', $value: { light: '#F8F7F3', dark: '#161514' } },
    'space-6': { $type: 'dimension', $value: '6px' },
  },
  components: { ApprovalCard: { props: { command: 'string' } } },
  pages: [
    {
      id: 'p-session',
      name: '会话',
      group: 'session',
      state: { run: 'running' },
      width: 1180,
      height: 780,
      background: '$bg-main',
      tree: [
        { id: 'n1', kind: 'component', name: 'ApprovalCard', fixture: 'pending-command',
          props: { command: { $mock: 'npm test' } } },
        { id: 'n2', kind: 'frame', layout: 'vertical', gap: '$space-6', children: [
          { id: 'n3', kind: 'text', text: { $bind: 'session.title' }, wrap: 'nowrap',
            fontSize: '$space-6', fill: '$bg-main' },
        ] },
      ],
    },
    { id: 'p-empty', name: '空页', width: 320, height: 240, tree: [] },
  ],
})

const axDocumentContent: DesignDocumentContent = {
  contentBase64: Buffer.from(AX_SOURCE, 'utf-8').toString('base64'),
  sha256: 'b'.repeat(64),
  sizeBytes: AX_SOURCE.length,
  modifiedMs: null,
  unchanged: false,
}

const inventoryStub = () => [
  {
    name: 'ApprovalCard',
    kind: 'store-bound' as const,
    sourcePath: 'components/session/ApprovalCard.tsx',
    // AX_SOURCE 的 ApprovalCard 节点带 command prop：注册表核对要求 decl/节点键
    // 都在契约内（v4 起读取路径核对注册表）。
    props: [{ name: 'command', type: 'string', required: false, description: '示例命令' }],
    fixtures: ['pending-command'],
    fixtureProps: {},
  },
]

const axTool = createDesignQueryTool(
  environmentWith((path) => {
    if (path === '.pen/axiom.ax') return Promise.resolve(axDocumentContent)
    return Promise.reject(new Error('not found'))
  }),
  { componentInventory: inventoryStub },
)

const run = (input: JsonValue, tool = axTool, context: Record<string, unknown> = {}) =>
  tool.execute(input, { signal: new AbortController().signal, ...context } as never)

describe('design_query tool：.ax 三层读取', () => {
  it('摘要：页清单（含分组/状态/节点数/用到组件）+ 组件清单 + token 清单', async () => {
    const result = await run({ file: '.pen/axiom.ax' })
    const parsed = JSON.parse(result.content) as {
      format: string
      pages: Array<{ index: number; id: string; nodes: number; components: string[]; group?: string }>
      components: Array<{ name: string; sourcePath: string }>
      tokens: string[]
    }
    expect(parsed.format).toBe(`ax@${AX_FORMAT_VERSION}`)
    expect(parsed.pages[0]).toMatchObject({
      index: 1, id: 'p-session', group: 'session', nodes: 3, components: ['ApprovalCard'],
    })
    // 组件清单：模型据此把设计稿里的组件名对到真实源码（P3 的关键杠杆）。
    expect(parsed.components[0]).toMatchObject({
      name: 'ApprovalCard', sourcePath: 'components/session/ApprovalCard.tsx',
    })
    expect(parsed.tokens).toEqual(['bg-main', 'space-6'])
    expect((result.details as { truncated: boolean }).truncated).toBe(false)
  })

  it('页：token 解析为明暗两档字面值 + 作者视角的树 + 该页组件清单，且两次读取幂等', async () => {
    const first = await run({ file: '.pen/axiom.ax', page: '会话' })
    const second = await run({ file: '.pen/axiom.ax', page: 1 })
    expect(second.content).toBe(first.content)
    const parsed = JSON.parse(first.content) as {
      page: { id: string; width: number; height: number }
      tokens: Record<string, { light: string; dark: string }>
      tree: Array<{ id: string; kind: string }>
      components: Array<{ name: string }>
      counts: { nodes: number }
    }
    expect(parsed.page).toMatchObject({ id: 'p-session', width: 1180, height: 780 })
    expect(parsed.tokens['bg-main']).toEqual({ light: '#F8F7F3', dark: '#161514' })
    expect(parsed.tree[0]).toMatchObject({ id: 'n1', kind: 'component' })
    expect(parsed.components.map((entry) => entry.name)).toEqual(['ApprovalCard'])
    expect(parsed.counts.nodes).toBe(3)
  })

  it('未知页名/序号时列出可用页', async () => {
    const missing = await run({ file: '.pen/axiom.ax', page: '不存在' })
    expect(missing.content).toContain('1:会话')
    expect(missing.content).toContain('2:空页')
  })

  it('node 模式：定位子树并带上其组件清单', async () => {
    const found = await run({ file: '.pen/axiom.ax', nodeId: 'n3' })
    expect(found.content).toContain('"session.title"')
    const missing = await run({ file: '.pen/axiom.ax', nodeId: 'ghost' })
    expect(missing.content).toContain('not found')
  })

  it('超预算时按节点收口并显式标注省略数量（不静默收窄）', async () => {
    const result = await run({ file: '.pen/axiom.ax', page: 1, maxBytes: 60 })
    const parsed = JSON.parse(result.content) as {
      counts: { nodes: number; keptNodes?: number }
      truncated?: { omittedNodes: number }
      tree: unknown[]
    }
    expect(parsed.truncated).toBeDefined()
    expect(parsed.counts.nodes).toBe(3)
    expect((parsed.counts.keptNodes ?? 0) + (parsed.truncated?.omittedNodes ?? 0)).toBe(3)
    expect(parsed.tree.length).toBeLessThanOrEqual(parsed.counts.keptNodes ?? 0)
  })

  it('校验失败时 fail-closed 回传带节点路径的诊断', async () => {
    const badSource = JSON.stringify({
      ax: '1.0',
      tokens: {},
      pages: [{ id: 'p1', tree: [{ id: 'x', kind: 'component', name: 'Ghost' }] }],
    })
    const badTool = createDesignQueryTool(environmentWith(() => Promise.resolve({
      contentBase64: Buffer.from(badSource, 'utf-8').toString('base64'),
      sha256: 'c'.repeat(64),
      sizeBytes: badSource.length,
      modifiedMs: null,
      unchanged: false,
    })))
    const result = await run({ file: '.pen/bad.ax' }, badTool)
    expect(result.content).toContain('failed to validate')
    expect(result.content).toContain('pages[0].tree[0]')
    expect(result.content).toContain('Ghost')
  })
})

describe('design_query tool：render 模式（渲染回读）', () => {
  it('有渲染能力时返回图像内容块 + 文本摘要', async () => {
    const renderStub = vi.fn(async () => ({
      base64: 'iVBORw0KGgo=',
      mediaType: 'image/png' as const,
      width: 590,
      height: 390,
      scale: 0.5,
      pageName: '会话',
    }))
    setDesignPageRenderProvider(renderStub)
    try {
      const result = await run({ file: '.pen/axiom.ax', mode: 'render', page: '会话' })
      const parsed = JSON.parse(result.content) as { render: { available: boolean; scale: number } }
      expect(parsed.render).toMatchObject({ available: true, scale: 0.5 })
      const blocks = result.contentBlocks as Array<{ type: string }>
      expect(blocks.map((block) => block.type)).toEqual(['text', 'image'])
      expect(renderStub).toHaveBeenCalledWith(expect.objectContaining({
        fileName: '.pen/axiom.ax',
        pageIdOrIndex: 'p-session',
      }))
    } finally {
      setDesignPageRenderProvider(null)
    }
  })

  it('无渲染能力时显式降级（说明原因，不假装成功）', async () => {
    setDesignPageRenderProvider(null)
    const result = await run({ file: '.pen/axiom.ax', mode: 'render', page: '会话' })
    const parsed = JSON.parse(result.content) as { render: { available: boolean; reason?: string } }
    expect(parsed.render.available).toBe(false)
    expect(parsed.render.reason).toContain('renderer')
    expect(result.contentBlocks).toBeUndefined()
  })

  it('渲染失败（ok:false）→ available:false 携带具体原因（不再一律归 no renderer）', async () => {
    setDesignPageRenderProvider(async () => ({
      ok: false as const,
      reason: '页面挂载失败：渲染树为空（React 未捕获错误：boom）',
    }))
    try {
      const result = await run({ file: '.pen/axiom.ax', mode: 'render', page: '会话' })
      const parsed = JSON.parse(result.content) as { render: { available: boolean; reason?: string } }
      expect(parsed.render.available).toBe(false)
      expect(parsed.render.reason).toContain('渲染树为空')
      expect(parsed.render.reason).not.toContain('no renderer')
      expect(result.contentBlocks).toBeUndefined()
      expect((result.details as { rendered: boolean }).rendered).toBe(false)
    } finally {
      setDesignPageRenderProvider(null)
    }
  })

  it('渲染器抛错 → 归一为 ok:false + 原因（异常不冒泡给模型循环）', async () => {
    setDesignPageRenderProvider(async () => {
      throw new Error('WebView 截图超时（15s）')
    })
    try {
      const result = await run({ file: '.pen/axiom.ax', mode: 'render', page: '会话' })
      const parsed = JSON.parse(result.content) as { render: { available: boolean; reason?: string } }
      expect(parsed.render.available).toBe(false)
      expect(parsed.render.reason).toContain('WebView 截图超时')
    } finally {
      setDesignPageRenderProvider(null)
    }
  })

  it('当前模型不支持图片 → 不光栅化、不产 image 块，并说明是模型能力所限', async () => {
    const renderStub = vi.fn(async () => ({
      base64: 'iVBORw0KGgo=',
      mediaType: 'image/png' as const,
      width: 590,
      height: 390,
      scale: 0.5,
      pageName: '会话',
    }))
    setDesignPageRenderProvider(renderStub)
    try {
      const result = await run(
        { file: '.pen/axiom.ax', mode: 'render', page: '会话' },
        axTool,
        { modelAcceptsImage: false },
      )
      const parsed = JSON.parse(result.content) as { render: { available: boolean; reason?: string } }
      expect(parsed.render.available).toBe(false)
      expect(parsed.render.reason).toContain('[图片已省略：当前模型不支持图片输入]')
      expect(result.contentBlocks).toBeUndefined()
      expect((result.details as { modelAcceptsImage?: boolean }).modelAcceptsImage).toBe(false)
      expect(renderStub).not.toHaveBeenCalled()
    } finally {
      setDesignPageRenderProvider(null)
    }
  })

  it('render 模式必须指定 page', () => {
    const check = axTool.validate?.({ file: '.pen/axiom.ax', mode: 'render' } as never)
    expect(check?.ok).toBe(false)
  })

  it('mode=scan 合法且不需要 page（可整稿扫描）', () => {
    expect(axTool.validate?.({ file: '.pen/axiom.ax', mode: 'scan' } as never)?.ok).toBe(true)
    expect(axTool.validate?.({ file: '.pen/axiom.ax', mode: 'scan', page: '会话' } as never)?.ok).toBe(true)
    expect(axTool.validate?.({ file: '.pen/axiom.ax', mode: 'scan', page: 1 } as never)?.ok).toBe(true)
  })
})

describe('design_query tool：scan 模式（逐页渲染扫描验证）', () => {
  it('逐页扫描：逐页判定 + 汇总；空页 warn 附缩略图内容块', async () => {
    const scanStub = vi.fn(async (request: { pageIdOrIndex: string | number }) => ({
      ok: true as const,
      base64: 'dGh1bWI=',
      mediaType: 'image/png' as const,
      width: 400,
      height: 300,
      scale: 1,
      pageName: String(request.pageIdOrIndex),
      samples: 16000,
      distinctColors: 256,
      topColorFraction: 0.4,
    }))
    setDesignScanPageRenderProvider(scanStub)
    try {
      const result = await run({ file: '.pen/axiom.ax', mode: 'scan' })
      const parsed = JSON.parse(result.content) as {
        mode: string
        rendered: boolean
        summary: { total: number; ok: number; warn: number; fail: number }
        pages: Array<{ id: string; status: string; render: string; issues: Array<{ check: string }> }>
      }
      expect(parsed.mode).toBe('scan')
      expect(parsed.rendered).toBe(true)
      // p-session 渲染正常；p-empty 是空页（只有页根）→ warn。
      expect(parsed.summary).toEqual({ total: 2, ok: 1, warn: 1, fail: 0 })
      expect(parsed.pages[0]).toMatchObject({ id: 'p-session', status: 'ok', render: 'ok' })
      expect(parsed.pages[1]!.status).toBe('warn')
      expect(parsed.pages[1]!.issues.some((issue) => issue.check === 'empty')).toBe(true)
      // warn 页回传缩略图（text 块在前）。
      const blocks = result.contentBlocks as Array<{ type: string }>
      expect(blocks[0]!.type).toBe('text')
      expect(blocks).toHaveLength(2)
      expect(blocks[1]!.type).toBe('image')
    } finally {
      setDesignScanPageRenderProvider(null)
    }
  })

  it('当前模型不支持图片 → 保留逐页判定与空白检测，但丢缩略图 + 给出 imageNote', async () => {
    setDesignScanPageRenderProvider(async (request: { pageIdOrIndex: string | number }) => ({
      ok: true as const,
      base64: 'dGh1bWI=',
      mediaType: 'image/png' as const,
      width: 400,
      height: 300,
      scale: 1,
      pageName: String(request.pageIdOrIndex),
      samples: 16000,
      distinctColors: 256,
      topColorFraction: 0.4,
    }))
    try {
      const result = await run({ file: '.pen/axiom.ax', mode: 'scan' }, axTool, { modelAcceptsImage: false })
      const parsed = JSON.parse(result.content) as {
        rendered: boolean
        imageNote?: string
        summary: { total: number; ok: number; warn: number; fail: number }
        pages: Array<{ id: string; status: string; render: string }>
      }
      // 渲染与空白检测仍然执行（scan 的核心价值与模型能力无关）。
      expect(parsed.rendered).toBe(true)
      expect(parsed.summary).toEqual({ total: 2, ok: 1, warn: 1, fail: 0 })
      expect(parsed.pages[1]).toMatchObject({ id: 'p-empty', status: 'warn', render: 'ok' })
      expect(parsed.imageNote).toContain('[图片已省略：当前模型不支持图片输入]')
      expect(result.contentBlocks).toBeUndefined()
      expect(result.details).toMatchObject({ thumbnails: 0 })
    } finally {
      setDesignScanPageRenderProvider(null)
    }
  })

  it('视觉模型 → 保留缩略图、不带 imageNote（正向对照：降级是有条件的）', async () => {
    setDesignScanPageRenderProvider(async (request: { pageIdOrIndex: string | number }) => ({
      ok: true as const,
      base64: 'dGh1bWI=',
      mediaType: 'image/png' as const,
      width: 400,
      height: 300,
      scale: 1,
      pageName: String(request.pageIdOrIndex),
      samples: 16000,
      distinctColors: 256,
      topColorFraction: 0.4,
    }))
    try {
      const result = await run({ file: '.pen/axiom.ax', mode: 'scan' }, axTool, { modelAcceptsImage: true })
      expect((result.details as { thumbnails: number }).thumbnails).toBeGreaterThan(0)
      const parsed = JSON.parse(result.content) as { imageNote?: string }
      expect(parsed.imageNote).toBeUndefined()
    } finally {
      setDesignScanPageRenderProvider(null)
    }
  })

  it('渲染失败页（ok:false）→ fail + 可读原因，不产缩略图', async () => {
    setDesignScanPageRenderProvider(async () => ({ ok: false as const, reason: '光栅化失败：无法创建画布上下文' }))
    try {
      const result = await run({ file: '.pen/axiom.ax', mode: 'scan' })
      const parsed = JSON.parse(result.content) as {
        summary: { fail: number }
        pages: Array<{ status: string; issues: Array<{ check: string; message: string }> }>
      }
      expect(parsed.summary.fail).toBe(2)
      const messages = JSON.stringify(parsed.pages.map((page) => page.issues))
      expect(messages).toContain('光栅化失败')
      expect(result.contentBlocks).toBeUndefined()
    } finally {
      setDesignScanPageRenderProvider(null)
    }
  })

  it('无渲染能力时 rendered=false（渲染检查 skipped，不假装通过）', async () => {
    setDesignScanPageRenderProvider(null)
    const result = await run({ file: '.pen/axiom.ax', mode: 'scan' })
    const parsed = JSON.parse(result.content) as {
      rendered: boolean
      pages: Array<{ render: string; status: string }>
    }
    expect(parsed.rendered).toBe(false)
    expect(parsed.pages.every((page) => page.render === 'skipped')).toBe(true)
    expect(result.contentBlocks).toBeUndefined()
  })

  it('渲染器抛错 → fail + 可读原因（不是笼统的不可用）', async () => {
    setDesignScanPageRenderProvider(async () => {
      throw new Error('canvas boom')
    })
    try {
      const result = await run({ file: '.pen/axiom.ax', mode: 'scan' })
      const parsed = JSON.parse(result.content) as {
        summary: { fail: number }
        pages: Array<{ status: string; issues: Array<{ message: string }> }>
      }
      expect(parsed.summary.fail).toBe(2)
      expect(JSON.stringify(parsed.pages.map((page) => page.issues))).toContain('canvas boom')
    } finally {
      setDesignScanPageRenderProvider(null)
    }
  })

  it('单页扫描（page 参数按页名/序号定位）', async () => {
    setDesignScanPageRenderProvider(async () => ({
      ok: true as const,
      width: 400,
      height: 300,
      scale: 1,
      pageName: '空页',
      samples: 16000,
      distinctColors: 1,
      topColorFraction: 1,
    }))
    try {
      const result = await run({ file: '.pen/axiom.ax', mode: 'scan', page: '空页' })
      const parsed = JSON.parse(result.content) as {
        summary: { total: number }
        pages: Array<{ id: string; issues: Array<{ check: string }> }>
      }
      expect(parsed.summary.total).toBe(1)
      expect(parsed.pages[0]!.id).toBe('p-empty')
      // 空页 + 渲染结果 100% 单色 → blank 警告叠加。
      expect(parsed.pages[0]!.issues.some((issue) => issue.check === 'blank')).toBe(true)
    } finally {
      setDesignScanPageRenderProvider(null)
    }
  })

  it('.pen 扫描：无高度顶层 frame 按组织性 frame 跳过渲染（不发起渲染调用）', async () => {
    const scanStub = vi.fn(async () => {
      throw new Error('组织性 frame 不应触发渲染')
    })
    setDesignScanPageRenderProvider(scanStub)
    try {
      const result = await run({ file: '.pen/axiom.pen', mode: 'scan' }, tool)
      const parsed = JSON.parse(result.content) as {
        rendered: boolean
        pages: Array<{ render: string; status: string; issues: Array<{ check: string }> }>
      }
      expect(scanStub).not.toHaveBeenCalled()
      expect(parsed.pages).toHaveLength(2)
      expect(parsed.pages.every((page) => page.render === 'skipped' && page.status === 'warn')).toBe(true)
      expect(parsed.pages.every((page) => page.issues.some((issue) => issue.check === 'size'))).toBe(true)
    } finally {
      setDesignScanPageRenderProvider(null)
    }
  })
})

describe('design_query tool：code 模式（生成骨架）', () => {
  it('返回 TSX 骨架 + 未映射清单；组件导入来源由清单给出', async () => {
    const result = await run({ file: '.pen/axiom.ax', mode: 'code', page: '会话' })
    expect(result.content).toContain('```tsx')
    expect(result.content).toContain('<ApprovalCard')
    // 导入来源来自组件清单的 sourcePath（模型不用猜路径）。
    expect(result.content).toContain("from '@/components/session/ApprovalCard'")
    // 该页有一条 $bind 文本 → 未映射清单必须列出「需接线数据源」（不静默）。
    expect(result.content).toContain('未映射（需人工接线）：')
    expect(result.content).toContain('session.title')
    expect(result.content).toContain('{/* $bind: session.title */}')
    const details = result.details as { componentName: string; counts: { nodes: number } }
    // 非 ASCII 页名加 Page 前缀（中文标识符合法，但前缀更易读、不与宿主标签混淆）。
    expect(details.componentName).toBe('Page会话')
    expect(details.counts.nodes).toBe(3)
  })

  it('code 模式必须指定 page', () => {
    const check = axTool.validate?.({ file: '.pen/axiom.ax', mode: 'code' } as never)
    expect(check?.ok).toBe(false)
  })
})

describe('design_query tool', () => {
  it('lists pages when no page or nodeId is given', async () => {
    const result = await tool.execute({ file: '.pen/axiom.pen' }, { signal: new AbortController().signal } as never)
    const parsed = JSON.parse(result.content) as { pages: Array<{ index: number; name: string }> }
    expect(parsed.pages).toEqual([
      { index: 1, name: '首页' },
      { index: 2, name: '设置' },
    ])
  })

  it('returns a page subtree by 1-based index', async () => {
    const result = await tool.execute({ file: '.pen/axiom.pen', page: 1 }, { signal: new AbortController().signal } as never)
    expect(result.content).toContain('"page-1"')
    expect(result.content).toContain('hello')
    expect((result.details as { pageIndex: number }).pageIndex).toBe(1)
  })

  it('returns a page subtree by name and rejects unknown names', async () => {
    const byName = await tool.execute({ file: '.pen/axiom.pen', page: '设置' }, { signal: new AbortController().signal } as never)
    expect(byName.content).toContain('"page-2"')
    const missing = await tool.execute({ file: '.pen/axiom.pen', page: '不存在' }, { signal: new AbortController().signal } as never)
    expect(missing.content).toContain('not found')
    expect(missing.content).toContain('1:首页')
  })

  it('locates a node by id across pages and reusable components', async () => {
    const byId = await tool.execute({ file: '.pen/axiom.pen', nodeId: 'i-1' }, { signal: new AbortController().signal } as never)
    expect(byId.content).toContain('"i-1"')
    expect((byId.details as { found: boolean }).found).toBe(true)
    const byComp = await tool.execute({ file: '.pen/axiom.pen', nodeId: 'comp-1' }, { signal: new AbortController().signal } as never)
    expect(byComp.content).toContain('"Card"')
    const missing = await tool.execute({ file: '.pen/axiom.pen', nodeId: 'nope' }, { signal: new AbortController().signal } as never)
    expect(missing.content).toContain('node "nope" not found')
  })

  it('nodeId 查询不走原型链（constructor 等 id 不命中 Object.prototype）', async () => {
    const result = await tool.execute(
      { file: '.pen/axiom.pen', nodeId: 'constructor' },
      { signal: new AbortController().signal } as never,
    )
    expect(result.content).toContain('node "constructor" not found')
    expect((result.details as { found: boolean }).found).toBe(false)
  })

  it('截断按 UTF-8 字节预算且在码点边界（CJK 不超预算、无替换符）', async () => {
    const cjk = createDesignQueryTool(environmentWith(() => Promise.resolve({
      ...documentContent,
      contentBase64: Buffer.from(JSON.stringify({
        children: [{ type: 'frame', id: 'page-cjk', name: '界面', children: [
          { type: 'text', id: 't-cjk', content: '界面设计稿内容界面设计稿内容界面设计稿内容' },
        ] }],
      }), 'utf-8').toString('base64'),
    })))
    const result = await cjk.execute(
      { file: '.pen/axiom.pen', page: 1, maxBytes: 64 },
      { signal: new AbortController().signal } as never,
    )
    expect((result.details as { truncated: boolean }).truncated).toBe(true)
    const suffix = '\n...[truncated at 64 bytes]'
    expect(result.content.endsWith(suffix)).toBe(true)
    const body = result.content.slice(0, -suffix.length)
    // 正文不超过字节预算，且截断点不切断多字节字符（无 U+FFFD）。
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(64)
    expect(body).not.toContain('�')
  })

  it('returns parser diagnostics when the document is malformed', async () => {
    const bad = createDesignQueryTool(environmentWith(() => Promise.resolve({
      ...documentContent,
      contentBase64: Buffer.from('{ broken json', 'utf-8').toString('base64'),
    })))
    const result = await bad.execute({ file: '.pen/axiom.pen' }, { signal: new AbortController().signal } as never)
    expect(result.content).toContain('failed to parse')
    expect((result.details as { parsed: boolean }).parsed).toBe(false)
  })

  it('truncates oversized output to the byte budget', async () => {
    const result = await tool.execute(
      { file: '.pen/axiom.pen', page: 1, maxBytes: 64 },
      { signal: new AbortController().signal } as never,
    )
    expect(result.content).toContain('[truncated at 64 bytes]')
    expect((result.details as { truncated: boolean }).truncated).toBe(true)
  })

  it('validates the input schema', () => {
    expect(tool.validate({ file: 'notes.txt' }).ok).toBe(false)
    expect(tool.validate({ file: '../escape.pen' }).ok).toBe(false)
    expect(tool.validate({ file: '.pen/axiom.pen', extra: 1 }).ok).toBe(false)
    expect(tool.validate({ file: '.pen/axiom.pen', maxBytes: 100000 }).ok).toBe(false)
    expect(tool.validate({ file: '.pen/axiom.pen', page: '首页' }).ok).toBe(true)
  })

  it('computes a deterministic idempotency key', () => {
    // v3 起键里带 mode 段：同一 file+page 的 scan/render/page 结果形状不同，
    // 不能互为幂等回放。v4 追加 component 段（mode=component 的载荷随组件名变化）。
    // v6 追加 implementation 段（reconcile 的对账结果随实现文件集变化）。
    expect(tool.idempotencyKey?.({ file: '.pen/axiom.pen', page: 1 }))
      .toBe('design_query:.pen/axiom.pen::1:::')
    expect(tool.idempotencyKey?.({ file: '.pen/axiom.pen', nodeId: 'f-1' }))
      .toBe('design_query:.pen/axiom.pen:::f-1::')
    expect(tool.idempotencyKey?.({ file: '.pen/axiom.pen', mode: 'scan', page: 1 }))
      .toBe('design_query:.pen/axiom.pen:scan:1:::')
    expect(tool.idempotencyKey?.({ file: '.pen/axiom.pen', mode: 'render', page: 1 }))
      .toBe('design_query:.pen/axiom.pen:render:1:::')
    expect(tool.idempotencyKey?.({ mode: 'component', component: 'ApprovalCard' }))
      .toBe('design_query::component:::ApprovalCard:')
  })

  it('propagates environment read failures', async () => {
    await expect(tool.execute(
      { file: 'other.pen' },
      { signal: new AbortController().signal } as never,
    )).rejects.toThrow('not found')
  })
})

describe('design_query tool：mode=component（组件契约详单，v4）', () => {
  it('有详单接缝时返回 props 契约 + statics + fixture 数据形状（file 可省）', async () => {
    setDesignComponentDetailProvider((name: string) => name === 'ApprovalCard'
      ? {
        summary: {
          name: 'ApprovalCard',
          kind: 'store-bound',
          sourcePath: 'components/session/ApprovalCard.tsx',
          props: [],
          fixtures: ['pending-command'],
          fixtureProps: {},
        },
        statics: ['onApprove', 'onReject'],
        fixtures: { 'pending-command': { pendingApproval: { toolName: 'bash' } } },
      }
      : null)
    try {
      expect(axTool.validate?.({ mode: 'component', component: 'ApprovalCard' } as never)?.ok).toBe(true)
      const result = await run({ mode: 'component', component: 'ApprovalCard' })
      const parsed = JSON.parse(result.content) as {
        mode: string
        component: {
          summary: { name: string; sourcePath: string }
          statics: string[]
          fixtures: Record<string, { pendingApproval: { toolName: string } }>
        }
      }
      expect(parsed.mode).toBe('component')
      expect(parsed.component.summary).toMatchObject({ name: 'ApprovalCard', sourcePath: 'components/session/ApprovalCard.tsx' })
      // statics 与 fixture 形状是详单的价值所在：json 型 props 的结构化 $mock 照此编写。
      expect(parsed.component.statics).toEqual(['onApprove', 'onReject'])
      expect(parsed.component.fixtures['pending-command']?.pendingApproval?.toolName).toBe('bash')
    } finally {
      setDesignComponentDetailProvider(null)
    }
  })

  it('详单接缝未注入但清单命中：回落清单摘要并显式说明（不假装完整）', async () => {
    const result = await run({ mode: 'component', component: 'ApprovalCard' })
    const parsed = JSON.parse(result.content) as {
      component: { summary: { name: string }; statics: unknown; fixtures: unknown; note: string }
    }
    expect(parsed.component.summary.name).toBe('ApprovalCard')
    expect(parsed.component.note).toContain('详单接缝未注入')
  })

  it('未知组件：报错并列出可用组件名', async () => {
    const result = await run({ mode: 'component', component: 'Ghost' })
    expect(result.content).toContain('Ghost')
    expect(result.content).toContain('ApprovalCard')
    expect((result.details as { found: boolean }).found).toBe(false)
  })

  it('component 参数只在 mode=component 下合法；mode=component 必须带 component', () => {
    expect(axTool.validate?.({ file: '.pen/axiom.ax', component: 'ApprovalCard' } as never)?.ok).toBe(false)
    expect(axTool.validate?.({ mode: 'component' } as never)?.ok).toBe(false)
    expect(axTool.validate?.({ mode: 'component', component: 'ApprovalCard', page: 1 } as never)?.ok).toBe(false)
  })
})

describe('design_query tool：组件节点注册表核对（v4 读取路径）', () => {
  it('组件不在注册表时读取 fail-closed（写稿当场暴露，不必等画布红框）', async () => {
    const badSource = JSON.stringify({
      ax: '1.2',
      tokens: {},
      components: { Ghost: { props: {} } },
      pages: [{ id: 'p1', width: 400, height: 300, tree: [{ id: 'n1', kind: 'component', name: 'Ghost' }] }],
    })
    const badTool = createDesignQueryTool(environmentWith(() => Promise.resolve({
      contentBase64: Buffer.from(badSource, 'utf-8').toString('base64'),
      sha256: 'd'.repeat(64),
      sizeBytes: badSource.length,
      modifiedMs: null,
      unchanged: false,
    })), { componentInventory: inventoryStub })
    const result = await run({ file: '.pen/bad.ax' }, badTool)
    expect(result.content).toContain('failed to validate')
    expect(result.content).toContain('Ghost')
  })

  it('props 键不在契约内同样报错（decl 与节点两级各有路径）', async () => {
    const badSource = JSON.stringify({
      ax: '1.2',
      tokens: {},
      components: { ApprovalCard: { props: { bogus: 'string' } } },
      pages: [{ id: 'p1', width: 400, height: 300, tree: [{ id: 'n1', kind: 'component', name: 'ApprovalCard' }] }],
    })
    const badTool = createDesignQueryTool(environmentWith(() => Promise.resolve({
      contentBase64: Buffer.from(badSource, 'utf-8').toString('base64'),
      sha256: 'e'.repeat(64),
      sizeBytes: badSource.length,
      modifiedMs: null,
      unchanged: false,
    })), { componentInventory: inventoryStub })
    const result = await run({ file: '.pen/bad.ax' }, badTool)
    expect(result.content).toContain('bogus')
  })
})

describe('design_query tool：scan 的 token ↔ tokens.css 一致性（v4，建议性）', () => {
  const environmentWithCss = (css: string | null): AgentEnvironment => ({
    design: { readDocument: (path: string) => path === '.pen/axiom.ax'
      ? Promise.resolve(axDocumentContent)
      : Promise.reject(new Error('not found')) },
    workspace: {
      readText: () => css === null
        ? Promise.reject(new Error('未授权或不存在'))
        : Promise.resolve({ content: css, truncated: false }),
    },
  }) as unknown as AgentEnvironment

  const cssTool = (css: string | null) => createDesignQueryTool(environmentWithCss(css), { componentInventory: inventoryStub })

  it('tokensCss 命中的变量不计、缺失的 token 逐个列出（建议性报告，不影响页判定）', async () => {
    setDesignScanPageRenderProvider(null)
    const result = await run(
      { file: '.pen/axiom.ax', mode: 'scan', tokensCss: 'apps/desktop/src/styles/tokens.css' },
      cssTool(':root { --bg-main: #fff; --other: #000; }\n'),
    )
    const parsed = JSON.parse(result.content) as {
      tokenParity: { cssFile: string; cssVariables: number; tokens: number; missingCount: number; missingInCss: string[] }
      summary: { total: number; ok: number; warn: number; fail: number }
    }
    expect(parsed.tokenParity).toMatchObject({
      cssFile: 'apps/desktop/src/styles/tokens.css',
      cssVariables: 2,
      tokens: 2,
      missingCount: 1,
    })
    expect(parsed.tokenParity.missingInCss).toEqual(['space-6'])
    // 建议性核对：页判定不受影响（p-empty 仍是唯一的 warn）。
    expect(parsed.summary).toEqual({ total: 2, ok: 1, warn: 1, fail: 0 })
  })

  it('样式表读取失败：tokenParity 显式带原因，不假装核对成功', async () => {
    setDesignScanPageRenderProvider(null)
    const result = await run(
      { file: '.pen/axiom.ax', mode: 'scan', tokensCss: 'missing/tokens.css' },
      cssTool(null),
    )
    const parsed = JSON.parse(result.content) as {
      tokenParity: { available: boolean; reason: string }
    }
    expect(parsed.tokenParity.available).toBe(false)
    expect(parsed.tokenParity.reason).toContain('未授权或不存在')
  })

  it('tokensCss 只在 mode=scan 下合法', () => {
    expect(axTool.validate?.({ file: '.pen/axiom.ax', mode: 'summary', tokensCss: 'a.css' } as never)?.ok).toBe(false)
    expect(axTool.validate?.({ file: '.pen/axiom.ax', mode: 'scan', tokensCss: '../escape.css' } as never)?.ok).toBe(false)
  })
})

describe('design_query tool：mode=reconcile（设计 ↔ 实现结构对账，v6）', () => {
  // 实现文件集：SessionView 用 ApprovalCard（稿内组件）+ ResultChip（稿外组件）。
  const IMPL_SOURCE = [
    "import { ApprovalCard, ResultChip } from '@/components/session'",
    'export const SessionView = () => (',
    '  <main>',
    '    <ApprovalCard command="npm test" />',
    '    <ResultChip message="done" />',
    '  </main>',
    ')',
  ].join('\n')

  const reconcileEnvironment = (): AgentEnvironment => ({
    design: { readDocument: (path: string) => path === '.pen/axiom.ax'
      ? Promise.resolve(axDocumentContent)
      : Promise.reject(new Error('not found')) },
    workspace: {
      // 目录递归：src/components 一个目录 → SessionView.tsx + README.md（非 ts 跳过）。
      list: (path?: string) => path === 'src/components'
        ? Promise.resolve({
          entries: [
            { path: 'src/components/SessionView.tsx', name: 'SessionView.tsx', kind: 'file' as const, sizeBytes: 1 },
            { path: 'src/components/README.md', name: 'README.md', kind: 'file' as const, sizeBytes: 1 },
          ],
          truncated: false,
        })
        : Promise.reject(new Error('not found')),
      readText: (path: string) => path === 'src/components/SessionView.tsx'
        ? Promise.resolve({ content: IMPL_SOURCE, truncated: false })
        : Promise.reject(new Error('not found')),
    },
  }) as unknown as AgentEnvironment

  const reconcileTool = () =>
    createDesignQueryTool(reconcileEnvironment(), {
      componentInventory: () => [
        ...inventoryStub(),
        { name: 'ResultChip', kind: 'presentational' as const, sourcePath: 'components/session/ResultChip.tsx', props: [], fixtures: [], fixtureProps: {} },
        { name: 'Sidebar', kind: 'store-bound' as const, sourcePath: 'components/Sidebar.tsx', props: [], fixtures: [], fixtureProps: {} },
      ],
    })

  it('双向 diff：稿有实无（漏实现）与实有稿无（设计外）各自列出', async () => {
    const result = await run(
      { file: '.pen/axiom.ax', mode: 'reconcile', implementation: 'src/components' },
      reconcileTool(),
    )
    const parsed = JSON.parse(result.content) as {
      implementation: { filesScanned: number; fileCapReached: boolean }
      design: { componentsUsed: string[] }
      missingInImplementation: { component: string; pages: string[] }[]
      extraInImplementation: { component: string; jsxUses: number; files: string[] }[]
      matched: { component: string; jsxUses: number }[]
    }
    expect(parsed.implementation.filesScanned).toBe(1)
    expect(parsed.design.componentsUsed).toEqual(['ApprovalCard'])
    // ApprovalCard 双方都有 → matched；ResultChip 实有稿无 → extra。
    expect(parsed.matched).toEqual([{ component: 'ApprovalCard', pages: 1, files: 1, jsxUses: 1, imports: 1 }])
    expect(parsed.extraInImplementation).toEqual([
      { component: 'ResultChip', jsxUses: 1, files: ['src/components/SessionView.tsx'] },
    ])
    expect(parsed.missingInImplementation).toEqual([])
  })

  it('稿内组件在实现里零 JSX 使用时报 missing（含用到它的页名）', async () => {
    // 空实现目录：稿里的 ApprovalCard 全部落 missing。
    const emptyEnv = {
      design: { readDocument: () => Promise.resolve(axDocumentContent) },
      workspace: {
        list: () => Promise.resolve({ entries: [], truncated: false }),
        readText: () => Promise.reject(new Error('not found')),
      },
    } as unknown as AgentEnvironment
    const tool = createDesignQueryTool(emptyEnv, { componentInventory: inventoryStub })
    const result = await run({ file: '.pen/axiom.ax', mode: 'reconcile', implementation: 'src/empty' }, tool)
    const parsed = JSON.parse(result.content) as {
      missingInImplementation: { component: string; pages: string[] }[]
    }
    expect(parsed.missingInImplementation).toEqual([{ component: 'ApprovalCard', pages: ['会话'] }])
  })

  it('implementation 数组与目录/文件混合都合法；string[] 之外的形态被拒', () => {
    expect(axTool.validate?.({ file: '.pen/axiom.ax', mode: 'reconcile', implementation: ['src/a.tsx', 'src/b'] } as never)?.ok).toBe(true)
    expect(axTool.validate?.({ file: '.pen/axiom.ax', mode: 'reconcile', implementation: [] } as never)?.ok).toBe(false)
    expect(axTool.validate?.({ file: '.pen/axiom.ax', mode: 'reconcile', implementation: '../escape' } as never)?.ok).toBe(false)
    // implementation 只在 reconcile 下合法；reconcile 要求 .ax 稿。
    expect(axTool.validate?.({ file: '.pen/axiom.ax', mode: 'summary', implementation: 'src' } as never)?.ok).toBe(false)
    expect(axTool.validate?.({ file: '.pen/axiom.pen', mode: 'reconcile', implementation: 'src' } as never)?.ok).toBe(false)
    // reconcile 不接受 page/nodeId/tokensCss/component 混入。
    expect(axTool.validate?.({ file: '.pen/axiom.ax', mode: 'reconcile', implementation: 'src', page: 1 } as never)?.ok).toBe(false)
  })

  it('幂等键包含归一后的 implementation（不同实现集不互为回放）', () => {
    const keyOf = (input: Record<string, unknown>) => axTool.idempotencyKey?.(input as never) ?? ''
    expect(keyOf({ file: '.pen/axiom.ax', mode: 'reconcile', implementation: ['b', 'a'] }))
      .toBe(keyOf({ file: '.pen/axiom.ax', mode: 'reconcile', implementation: ['a', 'b'] }))
    expect(keyOf({ file: '.pen/axiom.ax', mode: 'reconcile', implementation: 'a' }))
      .not.toBe(keyOf({ file: '.pen/axiom.ax', mode: 'reconcile', implementation: 'b' }))
  })

  it('读失败的实现文件显式进 readFailures，不阻断其余文件的对账', async () => {
    const env = {
      design: { readDocument: () => Promise.resolve(axDocumentContent) },
      workspace: {
        list: () => Promise.resolve({
          entries: [
            { path: 'src/ok.tsx', name: 'ok.tsx', kind: 'file' as const, sizeBytes: 1 },
            { path: 'src/bad.tsx', name: 'bad.tsx', kind: 'file' as const, sizeBytes: 1 },
          ],
          truncated: false,
        }),
        readText: (path: string) => path === 'src/ok.tsx'
          ? Promise.resolve({ content: '<ApprovalCard />', truncated: false })
          : Promise.reject(new Error('权限不足')),
      },
    } as unknown as AgentEnvironment
    const tool = createDesignQueryTool(env, { componentInventory: inventoryStub })
    const result = await run({ file: '.pen/axiom.ax', mode: 'reconcile', implementation: 'src' }, tool)
    const parsed = JSON.parse(result.content) as {
      implementation: { readFailures: string[] }
      matched: { component: string }[]
    }
    expect(parsed.implementation.readFailures).toHaveLength(1)
    expect(parsed.implementation.readFailures[0]).toContain('src/bad.tsx')
    expect(parsed.matched.map((item) => item.component)).toEqual(['ApprovalCard'])
  })
})

describe('design_query tool：compare 模式（设计 ↔ 实现像素对拍）', () => {
  const white2x2 = { width: 2, height: 2, data: buildCompareSolid(2, 2, [255, 255, 255]) }
  const oneRed2x2 = { width: 2, height: 2, data: buildCompareSolid(2, 2, [255, 255, 255]) }
  oneRed2x2.data[0] = 0
  oneRed2x2.data[1] = 0
  oneRed2x2.data[2] = 255

  const browserEnv = (
    browserCommand: AgentEnvironment['browser']['command'],
  ): AgentEnvironment =>
    ({
      design: { readDocument: () => Promise.resolve(axDocumentContent) },
      browser: { command: browserCommand },
    }) as unknown as AgentEnvironment

  const goodBrowser: AgentEnvironment['browser']['command'] = async (request) => {
    if (request.action === 'newTab') {
      return { type: 'tabOpened', tab: { tabId: 't-1', url: request.url ?? '', title: '会话实现', active: true, hasDialog: false } }
    }
    if (request.action === 'screenshot') {
      return { type: 'screenshot', imageBase64: 'IMPL', mimeType: 'image/png', width: 2, height: 2, resized: false }
    }
    if (request.action === 'setViewport') {
      return { type: 'viewportApplied', width: request.width, height: request.height }
    }
    return { type: 'done' }
  }

  afterEach(() => {
    setDesignPageRenderProvider(null)
    setPngDecodeProvider(null)
  })

  it('成功路径：浏览器按设计页尺寸截屏，输出差异占比与包围盒（advisory）', async () => {
    setDesignPageRenderProvider(async () => ({
      base64: 'DESIGN',
      mediaType: 'image/png' as const,
      width: 2,
      height: 2,
      scale: 1,
      pageName: '会话',
    }))
    setPngDecodeProvider(async (base64) => (base64 === 'DESIGN' ? white2x2 : oneRed2x2))
    const calls: string[] = []
    const browser = goodBrowser
    const env = browserEnv(async (request) => {
      calls.push(request.action)
      return browser(request)
    })
    const tool = createDesignQueryTool(env)
    const result = await run(
      { file: '.pen/axiom.ax', mode: 'compare', page: '会话', url: 'http://localhost:5173/session' },
      tool,
    )
    const parsed = JSON.parse(result.content) as {
      verdict: string
      diff: { mismatchedPixels: number; ratio: number }
      bounds: { x: number; width: number }
      implementation: { viewport: number[]; waitMs: number }
    }
    // 浏览器编排：开页 → 设视口（设计页 1180x780）→ 等待 → 截图 → 关页。
    expect(calls).toEqual(['newTab', 'setViewport', 'wait', 'screenshot', 'closeTab'])
    expect(parsed.implementation.viewport).toEqual([1180, 780])
    expect(parsed.verdict).toBe('warn')
    expect(parsed.diff.mismatchedPixels).toBe(1)
    expect(parsed.diff.ratio).toBe(25)
    expect(parsed.bounds).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect((result.details as { mode: string }).mode).toBe('compare')
  })

  it('浏览器不可用（未启用/子 Agent 封死）→ available:false 带设置与前置指引', async () => {
    setDesignPageRenderProvider(async () => ({
      base64: 'DESIGN',
      mediaType: 'image/png' as const,
      width: 2,
      height: 2,
      scale: 1,
      pageName: '会话',
    }))
    const env = browserEnv(async () => {
      throw new Error('浏览器能力未启用：请在 设置 → 浏览器 打开开关并保存')
    })
    const tool = createDesignQueryTool(env)
    const result = await run(
      { file: '.pen/axiom.ax', mode: 'compare', page: '会话', url: 'http://localhost:5173/session' },
      tool,
    )
    const parsed = JSON.parse(result.content) as { available: boolean; stage: string; reason: string }
    expect(parsed.available).toBe(false)
    expect(parsed.stage).toBe('browser')
    expect(parsed.reason).toContain('设置 → 浏览器')
    expect(parsed.reason).toContain('dev server')
  })

  it('无 PNG 解码能力（Node/接缝未注入）→ available:false 而非假装成功', async () => {
    setDesignPageRenderProvider(async () => ({
      base64: 'DESIGN',
      mediaType: 'image/png' as const,
      width: 2,
      height: 2,
      scale: 1,
      pageName: '会话',
    }))
    setPngDecodeProvider(null)
    const tool = createDesignQueryTool(browserEnv(goodBrowser))
    const result = await run(
      { file: '.pen/axiom.ax', mode: 'compare', page: '会话', url: 'http://localhost:5173/session' },
      tool,
    )
    const parsed = JSON.parse(result.content) as { available: boolean; stage: string }
    expect(parsed.available).toBe(false)
    expect(parsed.stage).toBe('decode')
  })

  it('校验：compare 必填 url+page+.ax，url/waitMs 不得与其它模式混用', () => {
    expect(axTool.validate?.({ file: '.pen/axiom.ax', mode: 'compare', page: 1 } as never)?.ok).toBe(false)
    expect(axTool.validate?.({ file: '.pen/axiom.ax', mode: 'compare', url: 'http://localhost:5173' } as never)?.ok).toBe(false)
    expect(axTool.validate?.({ file: '.pen/axiom.pen', mode: 'compare', page: 1, url: 'http://localhost:5173' } as never)?.ok).toBe(false)
    expect(axTool.validate?.({ file: '.pen/axiom.ax', mode: 'scan', url: 'http://localhost:5173' } as never)?.ok).toBe(false)
    expect(axTool.validate?.({ file: '.pen/axiom.ax', mode: 'compare', page: 1, url: 'ftp://x' } as never)?.ok).toBe(false)
    expect(axTool.validate?.({ file: '.pen/axiom.ax', mode: 'compare', page: 1, url: 'http://localhost:5173', waitMs: 0 } as never)?.ok).toBe(false)
    expect(axTool.validate?.({ file: '.pen/axiom.ax', mode: 'compare', page: 1, url: 'http://localhost:5173', waitMs: 800 } as never)?.ok).toBe(true)
  })

  it('幂等键：compare 的 url/waitMs 进键，既有键形状不变', () => {
    expect(axTool.idempotencyKey?.({ file: '.pen/axiom.ax', mode: 'compare', page: 1, url: 'http://l:1/a' } as never))
      .toBe('design_query:.pen/axiom.ax:compare:1::::http://l:1/a')
    expect(axTool.idempotencyKey?.({ file: '.pen/axiom.ax', mode: 'compare', page: 1, url: 'http://l:1/a', waitMs: 1500 } as never))
      .toBe('design_query:.pen/axiom.ax:compare:1::::http://l:1/a:1500')
    expect(axTool.idempotencyKey?.({ file: '.pen/axiom.pen', page: 1 } as never))
      .toBe('design_query:.pen/axiom.pen::1:::')
  })
})

function buildCompareSolid(width: number, height: number, color: [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = color[0]
    data[i * 4 + 1] = color[1]
    data[i * 4 + 2] = color[2]
    data[i * 4 + 3] = 255
  }
  return data
}
