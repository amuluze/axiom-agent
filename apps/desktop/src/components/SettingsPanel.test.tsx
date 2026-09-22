import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from './SettingsPanel'

vi.mock('@/config/runtimePolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/runtimePolicy')>()
  return {
    ...actual,
    RUNTIME_POLICY: { ...actual.RUNTIME_POLICY, allowDemoProvider: false },
  }
})

const renderPanel = (inline = true, overrides: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(SettingsPanel, {
    open: true,
    onClose: () => undefined,
    inline,
    ...overrides,
  }))

describe('SettingsPanel — ProviderSection', () => {
  it('renders the provider section with the model catalog datalist', () => {
    const html = renderPanel()
    expect(html).toContain('id="settings-provider"')
    expect(html).toContain('list="provider-model-catalog"')
    expect(html).toContain('API 格式')
    expect(html).toContain('Endpoint')
    expect(html).toContain('模型 ID')
  })
})

describe('SettingsPanel — ContextPolicySection', () => {
  it('renders the context policy section with the token reserve control', () => {
    const html = renderPanel()
    expect(html).toContain('id="settings-context-policy"')
    expect(html).toContain('输出预留 token')
    expect(html).toContain('上下文高级策略')
  })
})

describe('SettingsPanel — GeneralSection', () => {
  it('renders language and theme preferences without authorization controls', () => {
    const html = renderPanel(true, { section: 'general' })
    expect(html).toContain('id="settings-general"')
    expect(html).toContain('界面语言')
    expect(html).toContain('界面主题')
    expect(html).not.toContain('工作区读写授权')
    expect(html).not.toContain('单文件读取授权')
  })
})

describe('SettingsPanel — QueueModesSection', () => {
  it('renders the queue modes section with steering/follow-up selects', () => {
    const html = renderPanel()
    expect(html).toContain('id="settings-queue-modes"')
    expect(html).toContain('Steering 投递')
  })
})

describe('SettingsPanel — SessionsSection', () => {
  it('renders the sessions section with session management actions', () => {
    const html = renderPanel()
    expect(html).toContain('id="settings-sessions"')
    expect(html).toContain('会话与 SQLite')
    expect(html).toContain('新建会话')
  })
})

describe('SettingsPanel — dialog mode', () => {
  it('wraps the content in the settings-backdrop and settings-panel shell when inline is false', () => {
    const html = renderPanel(false)
    expect(html).toContain('settings-backdrop')
    expect(html).toContain('settings-panel')
    expect(html).toContain('role="dialog"')
  })

  it('omits the backdrop and dialog wrapper when inline is true', () => {
    const html = renderPanel(true)
    expect(html).not.toContain('settings-backdrop')
    expect(html).not.toContain('role="dialog"')
    expect(html).toContain('id="settings-provider"')
  })
})

describe('SettingsPanel — section routing', () => {
  it('moves context and queue controls into the model service section', () => {
    const html = renderPanel(true, { section: 'models' })
    expect(html).toContain('id="settings-provider"')
    expect(html).toContain('id="settings-context-policy"')
    expect(html).toContain('id="settings-queue-modes"')
  })

  it('renders only the selected settings group when section is provided', () => {
    const html = renderPanel(true, { section: 'general' })
    expect(html).toContain('id="settings-general"')
    expect(html).not.toContain('id="settings-provider"')
    expect(html).not.toContain('id="settings-sessions"')
  })

  it('routes the browser section with its config anchors', () => {
    const html = renderPanel(true, { section: 'browser' })
    expect(html).toContain('id="settings-browser"')
    expect(html).toContain('aria-label="启用浏览器能力"')
    expect(html).not.toContain('id="settings-general"')
  })

})

describe('SettingsPanel — full integration', () => {
  it('renders every desktop section through the shared form scaffold', () => {
    const html = renderPanel()
    const anchors = [
      'settings-provider',
      'settings-context-policy', 'settings-queue-modes', 'settings-sessions',
      'settings-general', 'settings-browser', 'settings-subagents',
    ]
    for (const anchor of anchors) {
      expect(html).toContain(`id="${anchor}"`)
    }
    expect(html).toContain('list="provider-model-catalog"')
  })
})
