import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

const mocks = vi.hoisted(() => ({
  providerReady: false,
  providerSetupRequired: false,
  messagesCount: 0,
  sidebarCollapsed: false,
  sidebarCompact: false,
  sidebarOverlayOpen: false,
  summaryRequest: null as null | { mode: 'compaction' } | { mode: 'branch'; messageId: string },
}))

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T => selector({
      ...original.useAgentStore.getState(),
      providerReady: mocks.providerReady,
      providerSetupRequired: mocks.providerSetupRequired,
      messages: Array.from({ length: mocks.messagesCount }, (_, index) => ({
        id: `m-${index}`,
        createdAt: index,
        role: 'user',
        content: `user ${index}`,
      })),
    }),
  }
})

vi.mock('@/stores/uiStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/uiStore')>()
  type UiState = ReturnType<typeof original.useUiStore.getState>
  return {
    ...original,
    useUiStore: <T,>(selector: (state: UiState) => T): T => selector({
      ...original.useUiStore.getState(),
      view: 'new-task',
      settingsSection: 'general',
      sidebarCollapsed: mocks.sidebarCollapsed,
      sidebarUserOverride: mocks.sidebarCollapsed,
      sidebarCompact: mocks.sidebarCompact,
      sidebarOverlayOpen: mocks.sidebarOverlayOpen,
      runtimeRailOpen: false,
      accessMode: 'standard',
      summaryRequest: mocks.summaryRequest,
    }),
  }
})

beforeEach(() => {
  mocks.providerReady = false
  mocks.providerSetupRequired = false
  mocks.messagesCount = 0
  mocks.sidebarCollapsed = false
  mocks.sidebarCompact = false
  mocks.sidebarOverlayOpen = false
  mocks.summaryRequest = null
})

describe('App shell integration', () => {
  it('renders the new-task composer when the provider is ready and no messages exist', () => {
    mocks.providerReady = true
    const html = renderToStaticMarkup(createElement(App))
    expect(html).toContain('在 Axiom 中开始新任务')
    expect(html).toContain('composer')
    expect(html).toContain('new-task__drag-region')
    expect(html).toContain('data-tauri-drag-region')
  })

  it('renders the new-task composer on default session (mocked store resolves view on hydrate)', () => {
    mocks.providerReady = true
    mocks.providerSetupRequired = true
    const html = renderToStaticMarkup(createElement(App))
    expect(html).toContain('composer')
  })

  it('renders only the reopen button when the desktop sidebar is collapsed', () => {
    mocks.providerReady = true
    mocks.sidebarCollapsed = true
    const html = renderToStaticMarkup(createElement(App))
    expect(html).toContain('app-shell--no-sidebar')
    expect(html).toContain('app-main--sidebar-hidden')
    expect(html).toContain('aria-label="打开侧边栏"')
    expect(html).toContain('在 Axiom 中开始新任务')
    expect(html).toContain('composer')
    expect(html).not.toContain('aria-label="侧边栏"')
    expect(html).not.toContain('sidebar__overlay')
  })

  it('renders the overlay only when the compact drawer is explicitly open', () => {
    mocks.providerReady = true
    mocks.sidebarCompact = true
    mocks.sidebarOverlayOpen = true
    const html = renderToStaticMarkup(createElement(App))
    expect(html).toContain('app-shell--no-sidebar')
    expect(html).toContain('sidebar__overlay')
  })

  it('renders summary instructions as a global modal', () => {
    mocks.providerReady = true
    mocks.summaryRequest = { mode: 'compaction' }
    const html = renderToStaticMarkup(createElement(App))
    expect(html).toContain('summary-instructions-dialog')
    expect(html).toContain('压缩上下文')
  })
})
