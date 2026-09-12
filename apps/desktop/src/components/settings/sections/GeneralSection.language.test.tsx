// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useUiStore } from '@/stores/uiStore'
import { GeneralSection } from './GeneralSection'

afterEach(() => {
  // 还原共享 store，避免语言偏好泄漏到其它用例。
  useUiStore.setState({ language: 'system' })
})

describe('GeneralSection 语言切换', () => {
  it('提供 English 选项', () => {
    render(<GeneralSection />)
    const select = screen.getByLabelText('界面语言') as HTMLSelectElement
    const options = Array.from(select.options).map((option) => option.value)
    expect(options).toContain('en')
    expect(options).toContain('zh-CN')
    expect(options).toContain('system')
  })

  it('language=en 时常规分区文案切换为英文', () => {
    useUiStore.setState({ language: 'en' })
    render(<GeneralSection />)
    expect(screen.getByLabelText('Interface language')).toBeTruthy()
    expect(screen.getByText('Interface')).toBeTruthy()
    expect(screen.getByText('Branch prefix')).toBeTruthy()
    expect(screen.queryByText('界面语言')).toBeNull()
  })

  it('language=zh-CN 时保持中文文案', () => {
    useUiStore.setState({ language: 'zh-CN' })
    render(<GeneralSection />)
    expect(screen.getByLabelText('界面语言')).toBeTruthy()
    expect(screen.queryByLabelText('Interface language')).toBeNull()
  })
})
