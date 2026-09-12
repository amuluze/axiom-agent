import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ReasoningSection } from './ReasoningSection'
import { buildReasoningHook, stubContext } from './testFixtures'
import type { ReasoningDraftHook, SettingsSectionContext } from './types'
import type { ReasoningSettings } from '@/agent/runtime/reasoningSettings'

const offDraft: ReasoningSettings = { level: 'off', mode: 'effort', budgetTokens: 4_096 }

const renderSection = (
  hook: ReasoningDraftHook,
  context: SettingsSectionContext = stubContext,
  isSaved = false,
): string => renderToStaticMarkup(createElement(ReasoningSection, { hook, context, isSaved }))

/** 提取「推理强度」label 到其 </select> 的片段，避免匹配到模式/预算控件的属性。 */
const levelSelectFragment = (hook: ReasoningDraftHook, context?: SettingsSectionContext): string => {
  const fragment = renderSection(hook, context).match(/推理强度[\s\S]*?<\/select>/)?.[0] ?? ''
  expect(fragment).toContain('推理强度<select')
  return fragment
}

describe('ReasoningSection', () => {
  it('disables Save Reasoning when the draft is unchanged', () => {
    const hook = buildReasoningHook()
    const html = renderSection(hook, stubContext, true)
    expect(html).toContain('保存 Reasoning')
    expect(html).toContain('disabled=""')
  })

  it('forwards setDraft when the level select changes', () => {
    const setDraft = vi.fn()
    renderSection(buildReasoningHook({ setDraft }))
    expect(typeof setDraft).toBe('function')
  })

  it('keeps the level select usable for openai-compatible at the off default', () => {
    const html = levelSelectFragment(buildReasoningHook({
      apiFormat: 'openai-compatible',
      draft: { ...offDraft },
    }))
    expect(html).not.toContain('disabled')
  })

  it('keeps the level select usable for openai-responses at the off default', () => {
    const html = levelSelectFragment(buildReasoningHook({
      apiFormat: 'openai-responses',
      draft: { ...offDraft },
    }))
    expect(html).not.toContain('disabled')
  })

  it('disables the level select only while the settings context is busy', () => {
    const html = levelSelectFragment(buildReasoningHook(), { ...stubContext, busy: true })
    expect(html).toContain('disabled=""')
  })

  it('caps the budget input at the normalized ceiling derived from maxOutputTokens', () => {
    const html = renderSection(buildReasoningHook({
      apiFormat: 'anthropic-compatible',
      draft: { level: 'high', mode: 'enabled', budgetTokens: 4_096 },
    }))
    // fixture maxOutputTokens=8192 → ceiling 8191（与 normalizeReasoningSettings 的收敛上限同源）
    expect(html).toContain('max="8191"')
  })

  it('explains why Demo cannot save reasoning settings', () => {
    const html = renderSection(buildReasoningHook({ apiFormat: 'demo' }))
    expect(html).toContain('Demo 提供方不发送推理参数')
  })

  it('warns when the draft model does not declare reasoning support', () => {
    const html = renderSection(buildReasoningHook({ supportsReasoning: false }))
    expect(html).toContain('当前模型未声明支持推理')
  })

  it('stays silent when the draft model declares reasoning support', () => {
    const html = renderSection(buildReasoningHook({ supportsReasoning: true }))
    expect(html).not.toContain('未声明支持推理')
  })
})
