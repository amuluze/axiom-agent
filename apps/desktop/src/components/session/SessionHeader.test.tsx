import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionHeader } from './SessionHeader'

const mocks = vi.hoisted(() => ({
  running: false,
  sessionBusy: false,
  endReason: null as string | null,
  error: null as string | null,
  runtimeRailOpen: false,
  toggleRuntimeRail: vi.fn(),
  terminalPanelOpen: false,
  toggleTerminalPanel: vi.fn(),
  messages: [] as Array<{ role: string; content: string }>,
}))

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T => selector({
      ...original.useAgentStore.getState(),
      running: mocks.running,
      sessionBusy: mocks.sessionBusy,
      endReason: mocks.endReason,
      error: mocks.error,
      messages: mocks.messages as StoreState['messages'],
    } as StoreState),
  }
})

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
  mocks.running = false
  mocks.sessionBusy = false
  mocks.endReason = null
  mocks.error = null
  mocks.runtimeRailOpen = false
  mocks.toggleRuntimeRail.mockClear()
  mocks.terminalPanelOpen = false
  mocks.toggleTerminalPanel.mockClear()
  mocks.messages = []
})

describe('SessionHeader', () => {
  it('shows the default Axiom title when no messages exist', () => {
    const html = renderToStaticMarkup(createElement(SessionHeader))
    expect(html).toContain('Axiom')
    expect(html).toContain('session__header')
    expect(html).toContain('data-tauri-drag-region')
  })

  it('derives the title from the last user message (truncated to 80 chars)', () => {
    mocks.messages = [
      { role: 'user', content: 'Read the sparse attention notes in docs/ and draft an implementation plan for the desktop agent loop.' },
    ]
    const html = renderToStaticMarkup(createElement(SessionHeader))
    expect(html).toContain('Read the sparse attention notes in docs/')
    expect(html).not.toContain('desktop agent loop.')
  })

  it('shows 就绪 when the session is idle', () => {
    const html = renderToStaticMarkup(createElement(SessionHeader))
    expect(html).toContain('就绪')
    expect(html).toContain('session__status-tag--idle')
  })

  it('shows 运行中 when the agent is actively running', () => {
    mocks.running = true
    const html = renderToStaticMarkup(createElement(SessionHeader))
    expect(html).toContain('运行中')
    expect(html).toContain('session__status-tag--running')
  })

  it('shows 已暂停 when the session was stopped or aborted', () => {
    mocks.endReason = 'stopped'
    const html = renderToStaticMarkup(createElement(SessionHeader))
    expect(html).toContain('已暂停')
    expect(html).toContain('session__status-tag--paused')
  })

  it('shows 已完成 when the session completed normally', () => {
    mocks.endReason = 'completed'
    const html = renderToStaticMarkup(createElement(SessionHeader))
    expect(html).toContain('已完成')
    expect(html).toContain('session__status-tag--completed')
  })

  it('shows 失败 when the session has an error', () => {
    mocks.error = 'runtime error'
    const html = renderToStaticMarkup(createElement(SessionHeader))
    expect(html).toContain('失败')
    expect(html).toContain('session__status-tag--error')
  })
})

describe('SessionHeader statusTag', () => {
  it('prioritises running over error when both are true', () => {
    mocks.running = true
    mocks.error = 'some error'
    const html = renderToStaticMarkup(createElement(SessionHeader))
    expect(html).toContain('运行中')
    expect(html).not.toContain('失败')
  })
})

describe('SessionHeader window actions', () => {
  it('renders the help, terminal, and runtime rail toggle buttons when rail is closed', () => {
    mocks.runtimeRailOpen = false
    const html = renderToStaticMarkup(createElement(SessionHeader))
    expect(html).toContain('aria-label="帮助"')
    expect(html).toContain('aria-label="切换终端面板"')
    expect(html).toContain('aria-label="切换运行时面板"')
    expect(html).toContain('session__window-actions')
  })

  it('keeps the window actions rendered when the runtime rail is open (toggle stays in place)', () => {
    mocks.runtimeRailOpen = true
    const html = renderToStaticMarkup(createElement(SessionHeader))
    expect(html).toContain('session__window-actions')
    expect(html).toContain('aria-label="帮助"')
    // 展开态在按钮上体现为 aria-pressed + active 修饰，而不是隐藏。
    expect(html).toMatch(/aria-label="切换运行时面板"[^>]*aria-pressed="true"/u)
    expect(html).toContain('session__window-action--active')
  })

  it('renders the help button as a menu trigger with the menu closed', () => {
    const html = renderToStaticMarkup(createElement(SessionHeader))
    const helpButton = html.match(/<button[^>]*aria-label="帮助"[^>]*>/u)?.[0]
    expect(helpButton).toBeDefined()
    expect(helpButton).toContain('aria-haspopup="menu"')
    expect(helpButton).toContain('aria-expanded="false"')
    expect(html).not.toContain('window-help__menu')
  })
})
