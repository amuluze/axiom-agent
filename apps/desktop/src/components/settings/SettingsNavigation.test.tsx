// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useUiStore } from '@/stores/uiStore'
import { SettingsNavigation } from './SettingsNavigation'

afterEach(() => {
  cleanup()
  useUiStore.setState({ operatingSystem: 'macos' })
})

describe('设置导航入口', () => {
  it.each(['macos', 'linux', 'windows'])('全平台显示浏览器入口（电脑控制入口已移除）：%s', (operatingSystem) => {
    useUiStore.setState({ operatingSystem })
    render(<SettingsNavigation section="general" onSelect={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: '电脑控制' })).toBeNull()
    expect(screen.getByRole('button', { name: '浏览器' })).toBeTruthy()
  })
})
