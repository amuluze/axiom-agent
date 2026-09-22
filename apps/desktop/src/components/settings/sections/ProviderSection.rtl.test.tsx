// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProviderSection } from './ProviderSection'
import { baseProviderDraft, buildProviderHook, stubContext } from './testFixtures'
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

describe('ProviderSection 官网与邀请链接', () => {
  it('订阅型 provider 渲染官网与邀请链接，并把点击交给系统浏览器', () => {
    // opencode-go 在 providers.json 里声明了 website/inviteUrl：设置页据此展示官方入口与
    // 新用户优惠链接（数据驱动，未声明的 provider 不渲染）。
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const hook = buildProviderHook({
      draft: { ...baseProviderDraft, providerId: 'opencode-go' },
    })
    render(
      <ProviderSection
        hook={hook}
        context={stubContext}
        providerLabel_="OpenCode Go"
        providerHasKey={false}
        desktop
      />,
    )
    const website = screen.getByRole('link', { name: '官网' })
    const invite = screen.getByRole('link', { name: '邀请链接（新用户优惠）' })
    expect(website).toHaveAttribute('href', 'https://opencode.ai/go')
    expect(invite).toHaveAttribute('href', 'https://opencode.ai/go?ref=QQ1BKKXRTV')
    expect(screen.getByText('OpenCode Go 为独立订阅服务，Axiom 不代理其计费：')).toBeInTheDocument()

    // 点击不走应用内跳转（preventDefault + openExternalUrl；jsdom 下回退 window.open）。
    fireEvent.click(website)
    expect(open).toHaveBeenCalledWith(
      'https://opencode.ai/go',
      '_blank',
      'noopener,noreferrer',
    )
    open.mockRestore()
  })

  it('未声明链接的 provider 不渲染该提示块', () => {
    const hook = buildProviderHook()
    render(
      <ProviderSection
        hook={hook}
        context={stubContext}
        providerLabel_="Anthropic-compatible"
        providerHasKey={false}
        desktop
      />,
    )
    expect(screen.queryByRole('link', { name: '官网' })).not.toBeInTheDocument()
  })
})

