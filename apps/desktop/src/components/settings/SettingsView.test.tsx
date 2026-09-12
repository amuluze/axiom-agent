import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from './SettingsView'

const mocks = vi.hoisted(() => ({
  settingsSection: 'general',
  view: 'settings',
  providerSetupRequired: false,
  providerReady: true,
}))

vi.mock('@/stores/uiStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/uiStore')>()
  type UiState = ReturnType<typeof original.useUiStore.getState>
  return {
    ...original,
    useUiStore: <T,>(selector: (state: UiState) => T): T => selector({
      ...original.useUiStore.getState(),
      view: mocks.view,
      settingsSection: mocks.settingsSection,
      setSettingsSection: (section: typeof mocks.settingsSection) => { mocks.settingsSection = section },
      setView: (view: typeof mocks.view) => { mocks.view = view },
    } as UiState),
  }
})

vi.mock('@/stores/agentStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/stores/agentStore')>()
  type StoreState = ReturnType<typeof original.useAgentStore.getState>
  return {
    ...original,
    useAgentStore: <T,>(selector: (state: StoreState) => T): T => selector({
      ...original.useAgentStore.getState(),
      providerSetupRequired: mocks.providerSetupRequired,
      providerReady: mocks.providerReady,
    } as StoreState),
  }
})

afterEach(() => {
  mocks.settingsSection = 'general'
  mocks.view = 'settings'
  mocks.providerSetupRequired = false
  mocks.providerReady = true
})

describe('SettingsView SSR', () => {
  it('renders a draggable topbar and the back button in the left navigation', () => {
    const html = renderToStaticMarkup(createElement(SettingsView))
    expect(html).toContain('aria-label="设置"')
    expect(html).toContain('settings__topbar-title')
    expect(html).toContain('data-tauri-drag-region')
    expect(html).toContain('aria-label="返回"')
    expect(html).toMatch(/<nav[^>]*settings__nav[\s\S]*aria-label="返回"/u)
    expect(html).toContain('设置')
  })

  it('renders every nav item with the correct label', () => {
    const html = renderToStaticMarkup(createElement(SettingsView))
    expect(html).toContain('常规')
    expect(html).toContain('模型')
    expect(html).not.toContain('上下文与队列</span>')
    expect(html).toContain('子智能体')
    expect(html).toContain('会话与存储')
    expect(html).toContain('统计')
    // 「关于 & 更新」随自更新接入回归导航（SSR 下 & 转义为 &amp;）。
    expect(html).toContain('关于 &amp; 更新')
  })

  it('orders 基础设置 with 浏览器/电脑控制 after 已归档 and mounts 版本与统计 group as 统计/会话与存储/关于 & 更新', () => {
    const html = renderToStaticMarkup(createElement(SettingsView))
    const general = html.indexOf('常规')
    const models = html.indexOf('模型')
    const archived = html.indexOf('已归档')
    const browser = html.indexOf('浏览器')
    const computer = html.indexOf('电脑控制')
    const versionGroup = html.indexOf('版本与统计')
    const usage = html.indexOf('统计')
    const sessions = html.indexOf('会话与存储')
    const about = html.indexOf('关于 &amp; 更新')
    expect(general).toBeGreaterThan(-1)
    expect(models).toBeGreaterThan(general)
    expect(archived).toBeGreaterThan(models)
    expect(browser).toBeGreaterThan(archived)
    expect(computer).toBeGreaterThan(browser)
    expect(versionGroup).toBeGreaterThan(computer)
    expect(usage).toBeGreaterThan(versionGroup)
    expect(sessions).toBeGreaterThan(usage)
    expect(about).toBeGreaterThan(sessions)
  })

  it('marks exactly one nav item as active', () => {
    const html = renderToStaticMarkup(createElement(SettingsView))
    const activeCount = (html.match(/settings__nav-item--active/g) ?? []).length
    expect(activeCount).toBe(1)
  })

  it('reflects the active section from the store in the panel title', () => {
    mocks.settingsSection = 'sessions'
    const html = renderToStaticMarkup(createElement(SettingsView))
    expect(html).toMatch(/<h2 class="settings__panel-title">[^<]*会话与存储[^<]*<\/h2>/u)
  })

  it('shows the standard subtitle when the provider is ready', () => {
    const html = renderToStaticMarkup(createElement(SettingsView))
    expect(html).toContain('Axiom 默认所有配置本地优先')
    expect(html).not.toContain('生产模式不会使用模拟回答')
  })

  it('switches the subtitle when providerSetupRequired is true', () => {
    mocks.providerSetupRequired = true
    const html = renderToStaticMarkup(createElement(SettingsView))
    expect(html).toContain('生产模式不会使用模拟回答')
    expect(html).not.toContain('Axiom 默认所有配置本地优先')
  })

  it('disables the back button when blocking is true', () => {
    mocks.providerSetupRequired = true
    const html = renderToStaticMarkup(createElement(SettingsView, { blocking: true }))
    const backMatch = html.match(/<button[^>]*aria-label="返回"[^>]*>/u)
    expect(backMatch?.[0]).toContain('disabled')
  })

  it('does not disable the back button when not blocking', () => {
    const html = renderToStaticMarkup(createElement(SettingsView))
    const backMatch = html.match(/<button[^>]*aria-label="返回"[^>]*>/u)
    expect(backMatch?.[0]).toBeDefined()
    expect(backMatch?.[0]).not.toContain('disabled')
  })

  it('keeps the non-models section when blocking is false', () => {
    mocks.settingsSection = 'general'
    renderToStaticMarkup(createElement(SettingsView))
    expect(mocks.settingsSection).toBe('general')
  })
})
