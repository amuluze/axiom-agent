// @vitest-environment jsdom
/**
 * 渲染回读的宿主实现测试（docs/ax-format.md §4.6）。
 *
 * 只覆盖**可离线验证**的部分：离屏挂载（页定位、尺寸、token 注入、真组件渲染）
 * 与用完即拆。光栅化本身（SVG foreignObject → canvas）在 jsdom 无 canvas/Image，
 * 与既有 `exportPagePng` 一样不在单测覆盖内——那一段靠浏览器实测（P4 收尾时的目检）。
 */
import { describe, expect, it } from 'vitest'
import { mountAxPageElement, mountPenPageElement, renderPenPageForScan } from './renderPageHost'
import { parseAxDocument, projectAxToPenDocument } from '@/agent/design/axParser'
import type { AxDocument } from '@/agent/design/axSchema'
import { parsePenDocument } from '@/agent/design/penParser'
import type { PenDocument } from '@/agent/design/penParser'

const SOURCE = JSON.stringify({
  ax: '1.0',
  tokens: {
    'bg-main': { $type: 'color', $value: { light: '#F8F7F3', dark: '#161514' } },
    'text-md': { $type: 'dimension', $value: '13px' },
  },
  components: { ResultChip: { props: { message: 'json' } } },
  pages: [
    {
      id: 'p-session',
      name: '会话',
      width: 400,
      height: 300,
      background: '$bg-main',
      tree: [
        { id: 't1', kind: 'text', text: { $mock: '离屏渲染内容' }, wrap: 'nowrap', fontSize: '$text-md' },
        { id: 'c1', kind: 'component', name: 'ResultChip', fixture: 'completed' },
      ],
    },
    { id: 'p-empty', name: '空页', width: 320, height: 240, tree: [] },
  ],
})

const document_ = parseAxDocument(SOURCE).document as AxDocument

describe('mountAxPageElement（离屏挂载）', () => {
  it('按页 id 与序号都能定位，尺寸取页声明值，token 注进舞台样式', async () => {
    const byId = (await mountAxPageElement(document_, 'p-session', 'dark')).mounted
    expect(byId).not.toBeNull()
    expect(byId?.pageName).toBe('会话')
    expect(byId?.width).toBe(400)
    expect(byId?.height).toBe(300)
    expect(byId?.element.style.getPropertyValue('--bg-main')).toBe('#161514')
    expect(byId?.element.textContent).toContain('离屏渲染内容')
    byId?.dispose()

    const byIndex = (await mountAxPageElement(document_, 2, 'light')).mounted
    expect(byIndex?.pageName).toBe('空页')
    expect(byIndex?.element.style.getPropertyValue('--bg-main')).toBe('#F8F7F3')
    byIndex?.dispose()
  })

  it('组件节点在离屏渲染里同样走真组件（与画布同一套渲染链）', async () => {
    const { mounted } = await mountAxPageElement(document_, 'p-session', 'dark')
    expect(mounted?.element.querySelector('[data-ax-component="ResultChip"]')).not.toBeNull()
    expect(mounted?.element.querySelector('.session__result-chip')).not.toBeNull()
    mounted?.dispose()
  })

  it('未知页返回 null，且不留残留容器', async () => {
    const missing = await mountAxPageElement(document_, 'nope', 'dark')
    expect(missing.mounted).toBeNull()
    expect(missing.error).toContain('页面不存在')
    expect(window.document.querySelector('[data-ax-render-host]')).toBeNull()
  })

  it('dispose 后容器从 DOM 移除（渲染是副作用，不能留在页面上）', async () => {
    const { mounted } = await mountAxPageElement(document_, 'p-session', 'dark')
    expect(window.document.querySelector('[data-ax-render-host]')).not.toBeNull()
    mounted?.dispose()
    expect(window.document.querySelector('[data-ax-render-host]')).toBeNull()
  })
})

/** `.pen` 原文：两页（一页有内容，一页空），用于 PenDocument 直挂与扫描渲染测试。 */
const PEN_SOURCE = JSON.stringify({
  version: '2.17',
  variables: {
    'bg-main': { value: '#F8F7F3', theme: { mode: 'light' } },
  },
  children: [
    {
      type: 'frame', id: 'pen-page-1', name: '首页', width: 480, height: 360,
      layout: 'vertical',
      children: [{ type: 'text', id: 'pen-t1', content: '直挂内容', fontSize: 14 }],
    },
    { type: 'frame', id: 'pen-page-2', name: '次页', width: 320, height: 240, children: [] },
  ],
})

const penDocument_: PenDocument = parsePenDocument(PEN_SOURCE, 'test.pen').document as PenDocument

describe('mountPenPageElement（PenDocument 直挂）', () => {
  it('从解析产物直接挂载：页定位、尺寸、token 注入与内容渲染', async () => {
    const { mounted } = await mountPenPageElement(penDocument_, 'pen-page-1', 'light')
    expect(mounted).not.toBeNull()
    expect(mounted?.pageName).toBe('首页')
    expect(mounted?.width).toBe(480)
    expect(mounted?.height).toBe(360)
    expect(mounted?.element.style.getPropertyValue('--bg-main')).toBe('#F8F7F3')
    expect(mounted?.element.textContent).toContain('直挂内容')
    mounted?.dispose()
    expect(window.document.querySelector('[data-ax-render-host]')).toBeNull()
  })

  it('按序号定位；未知页返回 null 且不留容器', async () => {
    const byIndex = (await mountPenPageElement(penDocument_, 2, 'light')).mounted
    expect(byIndex?.pageName).toBe('次页')
    byIndex?.dispose()
    const missing = await mountPenPageElement(penDocument_, 'nope', 'light')
    expect(missing.mounted).toBeNull()
    expect(missing.error).toContain('页面不存在')
    expect(window.document.querySelector('[data-ax-render-host]')).toBeNull()
  })
})

describe('renderPenPageForScan（扫描渲染）', () => {
  it('jsdom 无 canvas：已知页返回 ok:false 带原因（不是静默 null）', async () => {
    // 页存在、尺寸合法，但光栅化需要 canvas/Image——jsdom 缺失时归因为
    // ok:false，扫描引擎据此记「渲染失败」并给出可读原因。
    const result = await renderPenPageForScan({ doc: penDocument_, pageIdOrIndex: 'pen-page-1', maxBytes: 16384 })
    expect(result).not.toBeNull()
    expect(result?.ok).toBe(false)
    if (result && !result.ok) expect(result.reason.length).toBeGreaterThan(0)
    expect(window.document.querySelector('[data-ax-render-host]')).toBeNull()
  })

  it('页面不存在与无尺寸页返回 ok:false 的具体原因', async () => {
    const missing = await renderPenPageForScan({ doc: penDocument_, pageIdOrIndex: 'nope', maxBytes: 16384 })
    expect(missing?.ok).toBe(false)
    if (!missing?.ok) expect(missing?.reason).toContain('页面不存在')

    const sizeless: PenDocument = {
      ...penDocument_,
      pages: [{ type: 'frame', id: 'band', name: 'Section — 组织带' }],
    }
    const noSize = await renderPenPageForScan({ doc: sizeless, pageIdOrIndex: 'band', maxBytes: 16384 })
    expect(noSize?.ok).toBe(false)
    if (!noSize?.ok) expect(noSize?.reason).toContain('没有有效尺寸')
  })
})

describe('mountAxPageElement 复用 PenDocument 直挂', () => {
  it('.ax 投影走同一条 mountPenPageElement 路径（回归：投影后仍可按名字定位）', async () => {
    const projection = projectAxToPenDocument(document_, 'test.ax').document as PenDocument
    const { mounted } = await mountPenPageElement(projection, 'p-session', 'dark')
    expect(mounted?.pageName).toBe('会话')
    expect(mounted?.element.querySelector('.session__result-chip')).not.toBeNull()
    mounted?.dispose()
  })
})

describe('overlay scrim 的画布渲染（1.2）', () => {
  it('scrim 投影为铺满页面的遮罩层：fill 渲染为背景，内容帧锚定其上', async () => {
    const source = JSON.stringify({
      ax: '1.2',
      tokens: {},
      components: {},
      pages: [{ id: 'p-modal', name: '弹窗', width: 400, height: 300, tree: [
        { id: 'o1', kind: 'overlay', anchor: 'center', scrim: { fill: 'rgba(0, 0, 0, 0.5)' }, children: [
          { id: 'd1', kind: 'frame', width: 320, height: 200, fill: '#ffffff', children: [
            { id: 't1', kind: 'text', text: { $mock: '对话框内容' }, wrap: 'nowrap' },
          ] },
        ] },
      ] }],
    })
    const parsed = parseAxDocument(source).document as AxDocument
    const { mounted } = await mountAxPageElement(parsed, 'p-modal', 'light')
    expect(mounted).not.toBeNull()
    // 遮罩层：整页尺寸 + 半透明背景（投影合成帧带 ~scrim 后缀 id）。
    const scrim = mounted?.element.querySelector('[data-pen-id="o1~scrim"]') as HTMLElement
    expect(scrim).not.toBeNull()
    expect(scrim.style.background).toContain('rgba(0, 0, 0, 0.5)')
    expect(scrim.style.width).toBe('400px')
    expect(scrim.style.height).toBe('300px')
    // 内容帧（overlay 本 id）锚定遮罩之上（正中），对话框是它的流内子节点。
    const content = mounted?.element.querySelector('[data-pen-id="o1"]') as HTMLElement
    expect(content.style.left).toBe('40px')
    expect(content.style.top).toBe('50px')
    expect(content.querySelector('[data-pen-id="d1"]')).not.toBeNull()
    expect(mounted?.element.textContent).toContain('对话框内容')
    mounted?.dispose()
  })
})

describe('mountPenPageElement capture 模式（原生截图的可见挂载）', () => {
  it('可见挂载：容器铺满视口 + 内容照常渲染；视口大于页面时 fitScale 为 1', async () => {
    const { mounted, error } = await mountPenPageElement(penDocument_, 'pen-page-1', 'light', { mode: 'capture' })
    expect(error).toBeUndefined()
    expect(mounted).not.toBeNull()
    // jsdom 视口（1024×768）大于页（480×360）：不缩放。
    expect(mounted?.fitScale).toBe(1)
    expect(mounted?.element.textContent).toContain('直挂内容')
    const host = window.document.querySelector('[data-ax-render-host]') as HTMLElement
    expect(host.style.position).toBe('fixed')
    expect(host.style.zIndex).toBe('2147483000')
    expect(host.style.background).not.toBe('')
    mounted?.dispose()
    expect(window.document.querySelector('[data-ax-render-host]')).toBeNull()
  })

  it('大页等比缩放适配视口（fitScale < 1，transform 落在页面根上）', async () => {
    const big: PenDocument = {
      ...penDocument_,
      pages: [{
        type: 'frame', id: 'big-page', name: '大页', width: 4096, height: 3072,
        children: [{ type: 'text', id: 'big-t1', content: '大页内容', fontSize: 14 }],
      }],
    }
    const { mounted } = await mountPenPageElement(big, 'big-page', 'light', { mode: 'capture' })
    expect(mounted).not.toBeNull()
    // 1024/4096 = 0.25；768/3072 = 0.25 → fitScale 0.25。
    expect(mounted?.fitScale).toBeCloseTo(0.25)
    expect(mounted?.element.style.transform).toContain('scale(0.25)')
    mounted?.dispose()
  })
})
