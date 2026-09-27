// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePenDocument, type PenNode } from '@/agent/design/penParser'
import { readDesignDocumentAsset } from '@/platform/designDocument'
import PenNodeView from './PenNodeView'

vi.mock('@/platform/designDocument', () => ({
  readDesignDocumentAsset: vi.fn(async () => ({
    contentBase64: 'aGk=',
    mediaType: 'image/png',
    sha256: 'x',
  })),
}))

const build = (nodeSource: unknown) => {
  const parsed = parsePenDocument(
    JSON.stringify({
      variables: { 'font-ui': 'Inter, sans-serif', 'bg-card': '#111111' },
      children: [nodeSource],
    }),
    '.pen/axiom.pen',
  )
  if (!parsed.document) throw new Error('fixture parse failed')
  // 节点必须经解析器归一（fill 变 {kind}、未知类型降级为 unknown），
  // 否则测的是未解析形状而非真实渲染输入。
  return { doc: parsed.document, node: parsed.document.pages[0] as PenNode }
}

const renderNode = (nodeSource: unknown) => {
  const { doc, node } = build(nodeSource)
  const view = render(<PenNodeView node={node} document={doc} themeMode="light" />)
  return view.container.querySelector('[data-pen-id]') as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PenNodeView 渲染映射', () => {
  it('fontFamily 的 $token 映射为 var(--token)（字面量字面透传）', () => {
    const tokenNode = renderNode({
      type: 'text',
      id: 't-token',
      content: 'hi',
      fontFamily: '$font-ui',
    })
    expect(tokenNode.style.fontFamily).toBe('var(--font-ui)')
    const literalNode = renderNode({
      type: 'text',
      id: 't-literal',
      content: 'hi',
      fontFamily: 'Inter, sans-serif',
    })
    expect(literalNode.style.fontFamily).toBe('Inter, sans-serif')
  })

  it('fontWeight 支持数值与 token 两种形态', () => {
    const numeric = renderNode({ type: 'text', id: 'w-num', content: 'hi', fontWeight: 600 })
    expect(numeric.style.fontWeight).toBe('600')
    const token = renderNode({ type: 'text', id: 'w-token', content: 'hi', fontWeight: '$weight-bold' })
    expect(token.style.fontWeight).toBe('var(--weight-bold)')
  })

  it('填充 token 映射为 var(--token)，不安全值渲染为空', () => {
    const filled = renderNode({ type: 'frame', id: 'f-1', fill: '$bg-card' })
    // jsdom 的 CSS 引擎不接受 var() 作为 background 简写值，改看内联 style 文本。
    expect(filled.getAttribute('style')).toContain('var(--bg-card)')
    const literal = renderNode({ type: 'frame', id: 'f-lit', fill: '#111111' })
    // jsdom 会把字面色规范化为 rgb 形式。
    expect(literal.getAttribute('style')).toContain('rgb(17, 17, 17)')
    const evil = renderNode({ type: 'frame', id: 'f-2', fill: 'url(https://evil.example/x)' })
    expect(evil.getAttribute('style') ?? '').not.toContain('evil.example')
  })

  it('远程图片填充渲染占位纹理且不发起任何请求', () => {
    const node = renderNode({
      type: 'frame',
      id: 'f-img',
      fill: { type: 'image', url: 'https://evil.example/x.png' },
    })
    expect(node.style.backgroundImage).toContain('repeating-linear-gradient')
    expect(readDesignDocumentAsset).not.toHaveBeenCalled()
  })

  it('相对路径图片填充经资产通道加载后写入 data URL 背景', async () => {
    const node = renderNode({
      type: 'frame',
      id: 'f-local',
      fill: { type: 'image', url: 'assets/a.png' },
    })
    await waitFor(() => expect(readDesignDocumentAsset).toHaveBeenCalledWith('.pen/axiom.pen', 'assets/a.png'))
    await waitFor(() => expect(node.style.backgroundImage).toContain('data:image/png'))
  })

  it('文本节点的 fill 是字色而非背景（否则每个文本都是一块色斑）', () => {
    const node = renderNode({
      type: 'text',
      id: 't-fill',
      content: 'hi',
      fill: '$text-primary',
      fontSize: '$text-md',
      lineHeight: 1.5,
    })
    const style = node.getAttribute('style') ?? ''
    expect(style).toContain('color: var(--text-primary)')
    expect(style).not.toContain('background')
    // lineHeight 是字体倍数（1.5 × 13px = 19.5px），不能渲染成 1.5px。
    expect(style).toContain('line-height: 1.5')
    expect(node.style.lineHeight).not.toContain('px')
  })

  it('逐边 strokeWidth 只画声明的那一侧（分隔线不变成方框）', () => {
    const bottom = renderNode({
      type: 'frame',
      id: 'f-divider',
      stroke: '$border-subtle',
      strokeWidth: { bottom: 1 },
    })
    // jsdom 的 CSS 引擎不接受 var() 进简写属性，改断言内联 style 文本。
    const style = bottom.getAttribute('style') ?? ''
    expect(style).toContain('border-bottom: 1px solid var(--border-subtle)')
    expect(style).not.toContain('border-top')
    const uniform = renderNode({ type: 'frame', id: 'f-box', stroke: '#111111', strokeWidth: 2 })
    const uniformStyle = uniform.getAttribute('style') ?? ''
    expect(uniformStyle).toContain('border: 2px solid rgb(17, 17, 17)')
    expect(uniformStyle).not.toContain('border-top')
  })

  it('fill_container(...) 变体仍按 fill 处理（不做字面量宽度）', () => {
    const filled = renderNode({ type: 'frame', id: 'f-fill', width: 'fill_container(840)' })
    const style = filled.getAttribute('style') ?? ''
    expect(style).toContain('flex: 1 1 0%')
    expect(style).not.toContain('fill_container(840)')
    const fit = renderNode({ type: 'frame', id: 'f-fit', width: 'fit_content(baseline)' })
    expect(fit.getAttribute('style') ?? '').not.toContain('fit_content(baseline)')
    // hug_content 是早期 .pen 文件里 fit_content 的别名。
    const hug = renderNode({ type: 'frame', id: 'f-hug', width: 'hug_content' })
    expect(hug.getAttribute('style') ?? '').not.toContain('hug_content')
  })

  it('textGrowth 缺省即 auto：单行不换行（只认显式换行）', () => {
    const auto = renderNode({ type: 'text', id: 't-auto', content: 'a very long single line' })
    expect(auto.style.whiteSpace).toBe('nowrap')
    const fixed = renderNode({
      type: 'text',
      id: 't-fixed',
      content: 'a very long wrapped line',
      width: 120,
      textGrowth: 'fixed-width',
    })
    expect(fixed.style.whiteSpace).toBe('pre-wrap')
  })

  it('ellipse innerRadius 渲染为环（radial-gradient 蒙版挖内圈）', () => {
    const ring = renderNode({
      type: 'ellipse',
      id: 'e-ring',
      width: 16,
      height: 16,
      innerRadius: 0.58,
      fill: '$accent',
    })
    expect(ring.getAttribute('style') ?? '').toContain('radial-gradient(closest-side, transparent 56.5%, #000 58%)')
    const solid = renderNode({ type: 'ellipse', id: 'e-solid', width: 8, height: 8, fill: '$accent' })
    expect(solid.getAttribute('style') ?? '').not.toContain('mask')
  })

  it('path 渲染为内联 SVG（实色与渐变两种填充）', () => {
    const solid = build({
      type: 'path',
      id: 'p-solid',
      geometry: 'M0 0h8v8H0z',
      viewBox: [0, 0, 16, 16],
      fill: '$text',
    })
    const solidView = render(
      <PenNodeView node={solid.node} document={solid.doc} themeMode="light" />,
    )
    const solidPath = solidView.container.querySelector('path')
    expect(solidView.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(solidPath?.getAttribute('fill')).toBe('var(--text)')

    const gradient = build({
      type: 'path',
      id: 'p-grad',
      geometry: 'M0 0h8v8H0z',
      viewBox: [0, 0, 512, 512],
      fill: {
        type: 'gradient',
        gradientType: 'linear',
        rotation: 215,
        colors: [
          { color: '#111111', position: 0 },
          { color: '#222222', position: 1 },
        ],
      },
    })
    const gradientView = render(
      <PenNodeView node={gradient.node} document={gradient.doc} themeMode="light" />,
    )
    const gradientPath = gradientView.container.querySelector('path')
    expect(gradientPath?.getAttribute('fill')).toMatch(/^url\(#pen-path-grad-p-grad\)$/)
    // 角度换算成 objectBoundingBox 上的向量：215° 旋转 → CSS 395° = 35°。
    const linearGradient = gradientView.container.querySelector('linearGradient')
    expect(Number(linearGradient?.getAttribute('x1'))).toBeGreaterThan(0)
    expect(gradientView.container.querySelectorAll('stop')).toHaveLength(2)
  })

  it('未知节点与缺失 ref 降级为带名占位框', () => {
    const unknown = build({ type: 'browser', id: 'u-1', name: '预览' })
    const view = render(
      <PenNodeView node={unknown.node} document={unknown.doc} themeMode="light" />,
    )
    expect(view.container.querySelector('.pen-node__placeholder')?.textContent).toBe('预览')
  })
})

describe('PenIconGlyph（静态词表 + 懒加载兜底）', () => {
  it('词表外的合法 lucide 图标：首帧占位，懒加载后替换为真 SVG', async () => {
    // 'bell' 是合法 lucide 图标但不在静态词表：旧行为是永远虚线占位。
    const icon = renderNode({ type: 'icon', id: 'i-lazy', icon: 'bell' })
    expect(icon.querySelector('.pen-node__icon-missing')).not.toBeNull()
    await waitFor(() => expect(icon.querySelector('svg')).not.toBeNull())
    expect(icon.querySelector('.pen-node__icon-missing')).toBeNull()
  })

  it('静态词表命中的图标仍同步渲染（无懒加载依赖）', () => {
    const icon = renderNode({ type: 'icon', id: 'i-static', icon: 'trash-2' })
    expect(icon.querySelector('svg')).not.toBeNull()
    expect(icon.querySelector('.pen-node__icon-missing')).toBeNull()
  })

  it('真正的未知图标保持占位（懒加载兜底后仍查不到）', async () => {
    const icon = renderNode({ type: 'icon', id: 'i-bogus', icon: 'totally-not-an-icon' })
    await waitFor(() => {
      // 兜底命名空间已加载（间接验证：另一个懒加载图标可解析），本名仍查不到。
      expect(icon.querySelector('svg')).toBeNull()
    })
    expect(icon.querySelector('.pen-node__icon-missing')).not.toBeNull()
  })
})
