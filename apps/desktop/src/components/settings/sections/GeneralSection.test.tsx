// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { GeneralSection } from './GeneralSection'
import { useUiStore } from '@/stores/uiStore'

const STORAGE_KEY = 'axiom.power.preventIdleSleep.v1'
const FONT_SIZE_STORAGE_KEY = 'axiom.ui.fontSizePx.v1'
const MONO_FONT_STORAGE_KEY = 'axiom.ui.monoFontFamily.v1'

afterEach(() => {
  // 还原共享 store 与 localStorage，避免泄漏到同文件其它用例。
  useUiStore.setState({ preventIdleSleep: false, fontSizePx: 13, monoFontFamily: 'jetbrains' })
  window.localStorage.removeItem(STORAGE_KEY)
  window.localStorage.removeItem(FONT_SIZE_STORAGE_KEY)
  window.localStorage.removeItem(MONO_FONT_STORAGE_KEY)
  // 还原根元素内联变量（字号/字体偏好用例经 documentElement.style 应用）。
  document.documentElement.style.removeProperty('--ui-font-size')
  document.documentElement.style.removeProperty('--font-mono')
})

describe('GeneralSection 保持电脑运行开关', () => {
  it('默认关闭，开启后勾选态即时生效并持久化', () => {
    render(<GeneralSection />)
    const toggle = screen.getByRole('checkbox', { name: '保持电脑运行' }) as HTMLInputElement
    expect(toggle.checked).toBe(false)

    fireEvent.click(toggle)
    expect(toggle.checked).toBe(true)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true')

    // 再次点击关闭：勾选态与持久化同步回退。
    fireEvent.click(toggle)
    expect(toggle.checked).toBe(false)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('false')
  })

  it('开启前向用户说明作用范围（仅阻止空闲休眠）', () => {
    render(<GeneralSection />)
    expect(screen.getByText(/手动睡眠与合盖休眠不受影响/)).toBeTruthy()
    expect(screen.getByText(/Axiom 运行期间全局生效/)).toBeTruthy()
  })
})

describe('GeneralSection 字体偏好', () => {
  it('界面字号默认 13px，切换后写入存储并经根元素 --ui-font-size 生效', () => {
    render(<GeneralSection />)
    const select = screen.getByLabelText('界面字号') as HTMLSelectElement
    expect(select.value).toBe('13')

    fireEvent.change(select, { target: { value: '16' } })
    expect(select.value).toBe('16')
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBe('16')
    expect(document.documentElement.style.getPropertyValue('--ui-font-size')).toBe('16px')
  })

  it('等宽字体默认 JetBrains Mono，切换后覆盖 --font-mono 并持久化', () => {
    render(<GeneralSection />)
    const select = screen.getByLabelText('等宽字体') as HTMLSelectElement
    expect(select.value).toBe('jetbrains')

    fireEvent.change(select, { target: { value: 'sf-mono' } })
    expect(select.value).toBe('sf-mono')
    expect(window.localStorage.getItem(MONO_FONT_STORAGE_KEY)).toBe('sf-mono')
    expect(document.documentElement.style.getPropertyValue('--font-mono')).toContain('SFMono-Regular')
  })

  it('字号切换说明文案声明只缩放文字不缩图标布局', () => {
    render(<GeneralSection />)
    expect(screen.getByText(/只缩放文字/)).toBeTruthy()
  })
})
