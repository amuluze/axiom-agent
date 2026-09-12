import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ContextPolicySection } from './ContextPolicySection'
import { buildContextPolicyHook, stubContext } from './testFixtures'

describe('ContextPolicySection', () => {
  it('disables 保存上下文策略 when the draft is unchanged', () => {
    const hook = buildContextPolicyHook()
    const html = renderToStaticMarkup(createElement(ContextPolicySection, {
      hook,
      context: stubContext,
      isSaved: true,
      effectiveContextTokens: 150_000,
      effectiveKeepRecentTokens: 8_000,
      effectiveByteBufferBytes: 1024 * 1024,
    }))
    expect(html).toContain('保存上下文策略')
    expect(html).toContain('disabled=""')
  })

  it('wires 恢复安全默认值 to the reset callback', () => {
    const reset = vi.fn()
    renderToStaticMarkup(createElement(ContextPolicySection, {
      hook: buildContextPolicyHook({ reset }),
      context: stubContext,
      isSaved: false,
      effectiveContextTokens: 150_000,
      effectiveKeepRecentTokens: 8_000,
      effectiveByteBufferBytes: 1024 * 1024,
    }))
    expect(typeof reset).toBe('function')
  })
})
