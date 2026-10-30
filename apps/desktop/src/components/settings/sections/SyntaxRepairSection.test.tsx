import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DEMO_PROVIDER_CONFIG } from '@/agent/transport/provider'
import { SyntaxRepairSection } from './SyntaxRepairSection'

const profile = {
  ...DEMO_PROVIDER_CONFIG,
  profileId: 'repair-profile',
  modelId: 'repair-model',
  modelName: 'Repair Model',
}

describe('SyntaxRepairSection', () => {
  it('renders saved profiles and the current-session fallback', () => {
    const html = renderToStaticMarkup(createElement(SyntaxRepairSection, {
      hook: {
        profiles: [profile],
        settings: { profileId: profile.profileId },
        save: vi.fn(),
      },
      context: {
        busy: false,
        providerMessage: null,
        settingsError: null,
      },
    }))

    expect(html).toContain('当前会话模型（自动跟随）')
    expect(html).toContain('Repair Model')
    expect(html).toContain('value="repair-profile" selected=""')
  })

  it('falls back to the current-session option when a profile was deleted', () => {
    const html = renderToStaticMarkup(createElement(SyntaxRepairSection, {
      hook: {
        profiles: [profile],
        settings: { profileId: 'deleted-profile' },
        save: vi.fn(),
      },
      context: {
        busy: false,
        providerMessage: null,
        settingsError: null,
      },
    }))

    expect(html).toContain('value="" selected=""')
  })
})
