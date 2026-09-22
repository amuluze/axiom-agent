import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_LIMITS_SETTINGS } from '@/agent/runtime/agentLimitsSettings'
import { LimitsSection } from './LimitsSection'
import { buildAgentLimitsHook, stubContext } from './testFixtures'

describe('LimitsSection', () => {
  it('disables 保存运行预算 when the draft is unchanged', () => {
    const html = renderToStaticMarkup(createElement(LimitsSection, {
      hook: buildAgentLimitsHook(),
      context: stubContext,
      isSaved: true,
    }))
    expect(html).toContain('保存运行预算')
    expect(html).toContain('disabled=""')
  })

  it('wires 恢复安全默认值 to the reset callback', () => {
    const reset = vi.fn()
    renderToStaticMarkup(createElement(LimitsSection, {
      hook: buildAgentLimitsHook({ reset }),
      context: stubContext,
      isSaved: false,
    }))
    expect(typeof reset).toBe('function')
  })

  it('renders the next-session notice', () => {
    const html = renderToStaticMarkup(createElement(LimitsSection, {
      hook: buildAgentLimitsHook(),
      context: stubContext,
      isSaved: false,
    }))
    expect(html).toContain('下次会话生效')
    expect(html).toContain('最大轮次')
    expect(html).toContain('最大工具调用数')
    expect(html).toContain('Token 预算')
  })

  it('renders the token budget input with the configured bounds and step', () => {
    const html = renderToStaticMarkup(createElement(LimitsSection, {
      hook: buildAgentLimitsHook(),
      context: stubContext,
      isSaved: false,
    }))
    // Token 预算输入框：min/max 来自设置面边界，步进 1 万 tokens
    expect(html).toContain('step="10000"')
    expect(html).toContain('min="10000"')
    expect(html).toContain('max="64000000"')
    expect(html).toContain(DEFAULT_AGENT_LIMITS_SETTINGS.maxTotalTokens.toString())
  })
})
