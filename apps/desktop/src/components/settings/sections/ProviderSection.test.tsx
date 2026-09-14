import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ProviderSection } from './ProviderSection'
import type { ProviderDraftHook, SettingsSectionContext } from './types'
import { TEST_ANTHROPIC_PROFILE } from './testFixtures'

const baseDraft = {
  ...TEST_ANTHROPIC_PROFILE,
  modelId: 'claude-test',
  modelName: 'Claude 测试助手',
} as const

const noopAsync = async () => true
const noopSetter = () => undefined

interface HookOverrides {
  apiKey?: string
  setApiKey?: (value: string) => void
  modelCatalog?: ProviderDraftHook['modelCatalog']
}

const buildHook = (overrides: HookOverrides = {}): ProviderDraftHook => ({
  profiles: [TEST_ANTHROPIC_PROFILE],
  creatingProfile: false,
  draft: baseDraft,
  apiKey: overrides.apiKey ?? '',
  providerRequiresApiKey: false,
  draftIsSaved: true,
  modelCatalog: overrides.modelCatalog ?? [
    {
      providerId: 'generic-anthropic-compatible',
      modelId: 'claude-test',
      label: 'Claude Test',
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      supportsReasoning: true,
    },
  ],
  setDraft: noopSetter,
  setApiKey: overrides.setApiKey ?? noopSetter,
  updateKind: noopSetter,
  selectProfile: noopAsync,
  createProfile: noopSetter,
  deleteProfile: noopAsync,
  saveProvider: async (_apiKey: string) => ({ saved: true }),
  testProvider: noopAsync,
  deleteProviderKey: noopAsync,
})

const baseContext: SettingsSectionContext = {
  busy: false,
  providerMessage: null,
  settingsError: null,
  style: undefined,
}

describe('ProviderSection', () => {
  it('renders a profile selector and profile management actions', () => {
    const html = renderToStaticMarkup(createElement(ProviderSection, {
      hook: buildHook(),
      context: baseContext,
      providerLabel_: 'Anthropic Compatible',
      providerHasKey: false,
      desktop: true,
    }))
    expect(html).toContain('模型配置')
    expect(html).toContain('添加配置')
    expect(html).toContain('删除配置')
    expect(html).not.toContain('使用 MiniMax M3 配置')
    expect(html).not.toContain('原生延迟工具')
  })

  it('renders the configured defaults as an unsaved draft when no profile exists', () => {
    const html = renderToStaticMarkup(createElement(ProviderSection, {
      hook: {
        ...buildHook(),
        profiles: [],
        creatingProfile: true,
        draftIsSaved: false,
      },
      context: baseContext,
      providerLabel_: 'Anthropic Compatible',
      providerHasKey: false,
      desktop: true,
    }))

    expect(html).toContain('新模型配置（尚未保存）')
    expect(html).toContain('value="claude-test"')
    expect(html).toContain('https://api.anthropic.com/v1/messages')
    expect(html).not.toContain('使用 MiniMax M3 配置')
  })

  it('binds the model catalog to a datalist keyed on modelId', () => {
    const html = renderToStaticMarkup(createElement(ProviderSection, {
      hook: buildHook(),
      context: baseContext,
      providerLabel_: 'Anthropic Compatible',
      providerHasKey: false,
      desktop: true,
    }))
    expect(html).toContain('list="provider-model-catalog"')
    expect(html).toContain('value="claude-test"')
    expect(html).toContain('Claude Test')
  })

  it('renders an optional model name input and prefers it in the profile selector', () => {
    const html = renderToStaticMarkup(createElement(ProviderSection, {
      hook: {
        ...buildHook(),
        profiles: [{ ...TEST_ANTHROPIC_PROFILE, modelName: 'Claude 测试助手' }],
      },
      context: baseContext,
      providerLabel_: 'Anthropic Compatible',
      providerHasKey: false,
      desktop: true,
    }))
    expect(html).toContain('模型名称')
    expect(html).toContain('value="Claude 测试助手"')
    expect(html).toContain('placeholder="可选，模型的显示名称"')
    expect(html).toContain('Anthropic Compatible · Claude 测试助手')
  })

  it('renders an optional website input for the provider homepage', () => {
    const html = renderToStaticMarkup(createElement(ProviderSection, {
      hook: {
        ...buildHook(),
        draft: { ...baseDraft, website: 'https://anthropic.com' },
      },
      context: baseContext,
      providerLabel_: 'Anthropic Compatible',
      providerHasKey: false,
      desktop: true,
    }))
    expect(html).toContain('官网地址')
    expect(html).toContain('value="https://anthropic.com"')
    expect(html).toContain('placeholder="可选，Provider 官网或文档地址"')
  })

  it('falls back to the model id in the profile selector when no model name is set', () => {
    const html = renderToStaticMarkup(createElement(ProviderSection, {
      hook: buildHook(),
      context: baseContext,
      providerLabel_: 'Anthropic Compatible',
      providerHasKey: false,
      desktop: true,
    }))
    expect(html).toContain('Anthropic Compatible · claude-test')
  })

  it('renders the optional API Key placeholder when no key is stored', () => {
    const html = renderToStaticMarkup(createElement(ProviderSection, {
      hook: buildHook({ apiKey: '' }),
      context: baseContext,
      providerLabel_: 'Anthropic Compatible',
      providerHasKey: false,
      desktop: true,
    }))
    expect(html).toContain('可选，仅写入 Axiom 本地密钥库')
  })

  it('switches the API Key placeholder when the Provider already has a key', () => {
    const html = renderToStaticMarkup(createElement(ProviderSection, {
      hook: buildHook(),
      context: baseContext,
      providerLabel_: 'Anthropic Compatible',
      providerHasKey: true,
      desktop: true,
    }))
    expect(html).toContain('已存入 Axiom 本地密钥库；留空保持不变')
  })

  it('forwards the API Key input to the hook setApiKey callback', () => {
    const setApiKey = vi.fn()
    const hook = buildHook({ setApiKey })
    const element = createElement(ProviderSection, {
      hook,
      context: baseContext,
      providerLabel_: 'Anthropic Compatible',
      providerHasKey: false,
      desktop: true,
    })
    const html = renderToStaticMarkup(element)
    expect(html).toContain('type="password"')
    expect(typeof hook.setApiKey).toBe('function')
    expect(setApiKey).not.toHaveBeenCalled()
  })

  it('renders the custom transit provider options in the API format select', () => {
    const html = renderToStaticMarkup(createElement(ProviderSection, {
      hook: buildHook(),
      context: baseContext,
      providerLabel_: 'Anthropic Compatible',
      providerHasKey: false,
      desktop: true,
    }))
    expect(html).toContain('自定义（OpenAI）')
    expect(html).toContain('自定义（Anthropic）')
  })

  it('renders a security note for custom transit providers', () => {
    const html = renderToStaticMarkup(createElement(ProviderSection, {
      hook: {
        ...buildHook(),
        draft: {
          ...baseDraft,
          providerId: 'custom-anthropic-compatible',
          endpoint: 'https://transit.example.com/v1/messages',
        },
      },
      context: baseContext,
      providerLabel_: '自定义（Anthropic）',
      providerHasKey: false,
      desktop: true,
    }))
    expect(html).toContain('自定义（中转站）的 API Key 仅用于该中转站')
  })

  it('renders localized custom provider labels under the English UI', () => {
    // SSR 渲染下 zustand 读 getInitialState（setState 不可见），改经 system 偏好
    // 的系统语言解析切换到英文；结束恢复 zh-CN，避免污染同文件其它用例。
    Object.defineProperty(globalThis.navigator, 'language', { value: 'en-US', configurable: true })
    try {
      const html = renderToStaticMarkup(createElement(ProviderSection, {
        hook: buildHook(),
        context: baseContext,
        providerLabel_: 'Anthropic Compatible',
        providerHasKey: false,
        desktop: true,
      }))
      expect(html).toContain('Custom (OpenAI)')
      expect(html).toContain('Custom (Anthropic)')
      expect(html).not.toContain('自定义（OpenAI）')
      expect(html).not.toContain('自定义（Anthropic）')
    } finally {
      Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
    }
  })
})
