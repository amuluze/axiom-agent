/**
 * 导出内联样式覆盖契约（不变量 4 的导出侧补充）。
 *
 * 局限要写清楚：这份白名单无法自动发现「画布新增了一条渲染样式而导出没跟上」——
 * 属性名在渲染侧是内联 style 对象，在导出侧是 computed style 的快照子集，两者不是
 * 一一映射（导出需要 flex-direction/padding-top 这类派生值）。所以这里锁的是
 * **每类视觉语义至少有一条必需属性在册**：删掉 `box-shadow`、`mask-image`、
 * `background-image` 这类易丢项会立刻红，而新增语义则应在同一次改动里显式补进来。
 */
import { describe, expect, it } from 'vitest'
import { INLINED_PROPERTIES } from './exportPagePng'

const PROPERTIES = new Set<string>(INLINED_PROPERTIES)

const expectAllPresent = (names: readonly string[], reason: string): void => {
  const missing = names.filter((name) => !PROPERTIES.has(name))
  expect(missing, reason).toEqual([])
}

describe('导出内联样式白名单', () => {
  it('无重复项，且都是 kebab-case 的 CSS 属性名', () => {
    expect(new Set(INLINED_PROPERTIES).size).toBe(INLINED_PROPERTIES.length)
    for (const property of INLINED_PROPERTIES) {
      expect(property, `${property} 不是 kebab-case`).toMatch(/^-?[a-z]+(-[a-z0-9]+)*$/)
    }
  })

  it('覆盖布局语义（flex 树是画布的唯一布局通道）', () => {
    expectAllPresent(
      ['display', 'flex-direction', 'flex-wrap', 'gap', 'align-items', 'justify-content',
        'width', 'height', 'padding-top', 'margin-top', 'position', 'overflow'],
      '布局属性缺失会让导出图排版塌陷',
    )
  })

  it('覆盖绘制语义（填充/描边/圆角/阴影/遮罩/图片填充）', () => {
    expectAllPresent(
      ['background-color', 'background-image', 'background-size', 'background-position',
        'box-shadow', 'opacity',
        'border-top-width', 'border-top-style', 'border-top-color',
        'border-top-left-radius', 'border-bottom-right-radius',
        'mask-image', 'mask-size'],
      '绘制属性缺失会让导出图静默丢样式（含 ellipse 内圈的 radial mask）',
    )
    // WebKit 需要 -webkit- 前缀才会应用 mask（画布侧已按该形态写入）。
    expectAllPresent(['-webkit-mask-image'], 'WebKit 前缀 mask 缺失会让环形导出成实心盘')
  })

  it('覆盖文本语义（字体/字距/行高/换行）', () => {
    expectAllPresent(
      ['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
        'letter-spacing', 'text-align', 'white-space'],
      '文本属性缺失会让导出图与画布字面不一致',
    )
  })
})
