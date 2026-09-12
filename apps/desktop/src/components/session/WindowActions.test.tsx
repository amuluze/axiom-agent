import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WindowActions } from './WindowActions'

const mocks = vi.hoisted(() => ({
  runtimeRailOpen: false,
  toggleRuntimeRail: vi.fn(),
  terminalPanelOpen: false,
  toggleTerminalPanel: vi.fn(),
}))

vi.mock('@/stores/uiStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/uiStore')>()
  type UiState = ReturnType<typeof original.useUiStore.getState>
  return {
    ...original,
    useUiStore: <T,>(selector: (state: UiState) => T): T => selector({
      ...original.useUiStore.getState(),
      runtimeRailOpen: mocks.runtimeRailOpen,
      toggleRuntimeRail: mocks.toggleRuntimeRail,
      terminalPanelOpen: mocks.terminalPanelOpen,
      toggleTerminalPanel: mocks.toggleTerminalPanel,
    } as UiState),
  }
})

afterEach(() => {
  mocks.runtimeRailOpen = false
  mocks.toggleRuntimeRail.mockClear()
  mocks.terminalPanelOpen = false
  mocks.toggleTerminalPanel.mockClear()
})

describe('WindowActions', () => {
  it('renders three buttons in a session__window-actions container', () => {
    const html = renderToStaticMarkup(createElement(WindowActions))
    expect(html).toContain('session__window-actions')
    expect(html).toContain('aria-label="帮助"')
    expect(html).toContain('aria-label="切换终端面板"')
    expect(html).toContain('aria-label="切换运行时面板"')
  })

  it('uses session__window-action class for buttons', () => {
    const html = renderToStaticMarkup(createElement(WindowActions))
    expect(html).toContain('session__window-action')
    expect(html).not.toContain('rail__toggle')
  })

  it('keeps help button as a menu trigger, closed by default', () => {
    const html = renderToStaticMarkup(createElement(WindowActions))
    expect(html).toMatch(/<button[^>]*aria-label="帮助"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/u)
    expect(html).not.toContain('window-help__menu')
  })

  it('marks the terminal button as pressed when the terminal panel is open', () => {
    mocks.terminalPanelOpen = true
    const html = renderToStaticMarkup(createElement(WindowActions))
    expect(html).toMatch(/aria-label="切换终端面板"[^>]*aria-pressed="true"/u)
    expect(html).toContain('session__window-action--active')
  })

  it('marks the runtime rail button as pressed when the rail is open', () => {
    mocks.runtimeRailOpen = true
    const html = renderToStaticMarkup(createElement(WindowActions))
    expect(html).toMatch(/aria-label="切换运行时面板"[^>]*aria-pressed="true"/u)
    expect(html).toContain('session__window-action--active')
  })
})
