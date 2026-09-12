// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProviderSection } from './ProviderSection'
import { buildProviderHook, stubContext } from './testFixtures'
import type { ProviderProfileDraft } from '@/agent/transport/provider'

const builtinCatalog = [
  {
    providerId: 'generic-anthropic-compatible',
    modelId: 'claude-sonnet-4',
    label: 'Claude Sonnet 4',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsReasoning: true,
  },
]

describe('ProviderSection 模型自动填充', () => {
  it('选择内置模型时自动填充上下文窗口与最大输出 token', () => {
    const setDraft = vi.fn()
    const hook = buildProviderHook({ setDraft, modelCatalog: builtinCatalog })
    render(
      <ProviderSection
        hook={hook}
        context={stubContext}
        providerLabel_="Anthropic-compatible"
        providerHasKey={false}
        desktop
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('由你的 Provider 提供'), {
      target: { value: 'claude-sonnet-4' },
    })
    expect(setDraft).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'claude-sonnet-4',
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
    }))
  })

  it('输入 catalog 之外的自定义模型时保持草稿原窗口与 token', () => {
    const setDraft = vi.fn()
    const hook = buildProviderHook({ setDraft, modelCatalog: builtinCatalog })
    render(
      <ProviderSection
        hook={hook}
        context={stubContext}
        providerLabel_="Anthropic-compatible"
        providerHasKey={false}
        desktop
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('由你的 Provider 提供'), {
      target: { value: 'custom-model' },
    })
    const called = setDraft.mock.calls[0][0] as ProviderProfileDraft
    expect(called.modelId).toBe('custom-model')
    expect(called.contextWindow).toBe(hook.draft.contextWindow)
    expect(called.maxOutputTokens).toBe(hook.draft.maxOutputTokens)
  })
})
