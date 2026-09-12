import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
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
  })
})
