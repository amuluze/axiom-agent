// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHorizontalMenuClamp } from './useHorizontalMenuClamp'

/** jsdom 无布局：以可编程 rect 桩替换 getBoundingClientRect。 */
const stubRects = (mapping: (el: Element) => { left: number }) => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return { ...mapping(this) } as DOMRect
  })
}

const mount = (menu: HTMLElement, open: boolean) => renderHook(
  ({ open: o }) => useHorizontalMenuClamp({ current: menu }, o),
  { initialProps: { open } },
)

describe('useHorizontalMenuClamp', () => {
  let composer: HTMLElement
  let menu: HTMLElement

  beforeEach(() => {
    document.body.innerHTML = '<div class="composer"><div class="composer__budget-menu"></div></div>'
    composer = document.querySelector('.composer') as HTMLElement
    menu = document.querySelector('.composer__budget-menu') as HTMLElement
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('窄宿主左溢出：写入正的平移量把弹层带回宿主内', () => {
    stubRects((el) => ({ left: el === composer ? 8 : -128 }))
    mount(menu, true)
    expect(menu.style.getPropertyValue('--composer-menu-shift')).toBe('136px')
  })

  it('宽宿主未溢出：不写入变量，既有定位不变', () => {
    stubRects((el) => ({ left: el === composer ? 200 : 480 }))
    mount(menu, true)
    expect(menu.style.getPropertyValue('--composer-menu-shift')).toBe('')
  })

  it('关闭时清理平移量', () => {
    stubRects((el) => ({ left: el === composer ? 8 : -128 }))
    const { rerender, unmount } = mount(menu, true)
    expect(menu.style.getPropertyValue('--composer-menu-shift')).toBe('136px')
    act(() => rerender({ open: false }))
    expect(menu.style.getPropertyValue('--composer-menu-shift')).toBe('')
    // 卸载路径同样清理（重复清理无害）。
    unmount()
    expect(menu.style.getPropertyValue('--composer-menu-shift')).toBe('')
  })
})
