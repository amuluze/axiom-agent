// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildSvgMarkup, renderPageToPngBase64, serializeWithInlineStyles } from './exportPagePng'

describe('buildSvgMarkup', () => {
  it('拼装带尺寸与背景的 foreignObject 容器', () => {
    const markup = buildSvgMarkup({
      serializedHtml: '<div class="page">hi</div>',
      width: 320,
      height: 640,
      background: '#ffffff',
    })
    expect(markup).toContain('width="320" height="640"')
    expect(markup).toContain('viewBox="0 0 320 640"')
    expect(markup).toContain('<foreignObject width="100%" height="100%">')
    expect(markup).toContain('xmlns="http://www.w3.org/1999/xhtml"')
    expect(markup).toContain('background:#ffffff')
    expect(markup).toContain('<div class="page">hi</div>')
  })
})

describe('serializeWithInlineStyles', () => {
  it('把内联样式固化进快照，剥掉画布自身的 transform 与选中标记', () => {
    const host = document.createElement('div')
    host.innerHTML = '<div data-selected-id="page-1" data-pen-id="page-1" '
      + 'style="color: rgb(17, 17, 17); transform: scale(2)">内容</div>'
    const page = host.firstElementChild as HTMLElement

    const serialized = serializeWithInlineStyles(page)
    expect(serialized).toContain('data-pen-id="page-1"')
    // 选中标记与测试标识不进入导出。
    expect(serialized).not.toContain('data-selected-id')
    // 样式已固化（jsdom 的 computed style 会回传内联值）。
    expect(serialized).toContain('color')
    expect(serialized).toContain('内容')
  })

  it('子节点同样获得内联样式（外部样式表在 foreignObject 里不生效）', () => {
    const host = document.createElement('div')
    host.innerHTML = '<div style="display:flex"><span style="color: rgb(1, 2, 3)">子</span></div>'
    const page = host.firstElementChild as HTMLElement
    const serialized = serializeWithInlineStyles(page)
    expect(serialized).toContain('rgb(1, 2, 3)')
  })
})

describe('renderPageToPngBase64', () => {
  it('无尺寸或缺少 canvas 实现时显式报错（不静默返回空图）', async () => {
    const element = document.createElement('div')
    // jsdom 下 offsetWidth 恒为 0，且没有 2D 上下文：两种情况都必须抛错。
    await expect(renderPageToPngBase64(element, { background: '#ffffff' })).rejects.toThrow(
      /可导出|画布上下文/,
    )
  })
})
