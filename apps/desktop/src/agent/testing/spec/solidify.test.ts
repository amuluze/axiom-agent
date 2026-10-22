import { describe, expect, it } from 'vitest'
import { compileTestSpec } from './compileTestPlan'
import { solidifyDraft } from './solidify'
import type { ExplorerStep, ExplorerToolName } from './trajectory'
import type { JsonValue } from '../../core/types'
import type { TestTargetSpec } from './types'

const target: TestTargetSpec = {
  webBaseUrl: 'https://shop.test',
  apiBaseUrl: 'https://api.shop.test',
}

const step = (
  toolName: ExplorerToolName,
  input: JsonValue,
  result?: ExplorerStep['result'],
): ExplorerStep => ({
  toolCallId: `${toolName}-call`,
  toolName,
  input,
  ...(result ? { result } : {}),
})

const okResult = (details: JsonValue, content = 'ok'): ExplorerStep['result'] =>
  ({ isError: false, content, details })

const draft = (steps: ExplorerStep[], environmentNames?: string[]) =>
  solidifyDraft(steps, { id: 'explore', name: '探索', target, ...(environmentNames ? { environmentNames } : {}) })

describe('solidifyDraft · ui_navigate', () => {
  it('maps url and drops tabId', async () => {
    const result = await draft([
      step('ui_navigate', { tabId: 'tab-9', url: 'https://shop.test/cart' }, okResult({ url: 'https://shop.test/cart', title: 'Cart' })),
    ])

    expect(result.spec.cases[0]?.steps).toEqual([
      { id: 'step-1-ui-navigate', action: 'ui.navigate', url: 'https://shop.test/cart' },
    ])
    expect(result.issues).toEqual([])
  })
})

describe('solidifyDraft · write actions', () => {
  it('maps a structured locator directly without a review issue', async () => {
    const result = await draft([
      step('ui_click', { tabId: 't', ref: 4, locator: { role: 'button', name: '结算', exact: true } }, okResult({ applied: true })),
      step('ui_input', { locator: { testId: 'coupon' }, text: 'SHOPAIM10' }, okResult({ applied: true })),
      step('ui_select', { locator: { label: '城市' }, text: '上海' }, okResult({ applied: true })),
    ])

    expect(result.spec.cases[0]?.steps).toEqual([
      { id: 'step-1-ui-click', action: 'ui.click', locator: { role: 'button', name: '结算', exact: true } },
      { id: 'step-2-ui-input', action: 'ui.input', locator: { testId: 'coupon' }, value: 'SHOPAIM10' },
      { id: 'step-3-ui-select', action: 'ui.select', locator: { label: '城市' }, value: '上海' },
    ])
    expect(result.issues.map((issue) => issue.code)).not.toContain('locator-unavailable')
  })

  it('emits a placeholder locator and locator-unavailable for a ref-only write', async () => {
    const result = await draft([
      step('ui_click', { tabId: 't', ref: 7 }, okResult({ applied: true })),
    ])

    const mapped = result.spec.cases[0]?.steps[0]
    expect(mapped).toEqual({
      id: 'step-1-ui-click',
      action: 'ui.click',
      locator: { role: 'unknown', name: '待补充定位器' },
    })
    const issues = result.issues.filter((issue) => issue.code === 'locator-unavailable')
    expect(issues).toHaveLength(1)
    expect(issues[0]?.stepIndex).toBe(0)
  })

  it('maps ui_press key and drops ref', async () => {
    const result = await draft([step('ui_press', { tabId: 't', ref: 2, key: 'Enter' }, okResult({ applied: true }))])

    expect(result.spec.cases[0]?.steps).toEqual([
      { id: 'step-1-ui-press', action: 'ui.press', key: 'Enter' },
    ])
  })
})

describe('solidifyDraft · ui_wait', () => {
  it('maps durationMs to timeoutMs with a page-text review issue', async () => {
    const result = await draft([
      step('ui_wait', { tabId: 't', text: '订单已提交', durationMs: 4000 }, okResult({ waitedMs: 4000, textMatched: true })),
    ])

    const mapped = result.spec.cases[0]?.steps[0]
    expect(mapped).toEqual({
      id: 'step-1-ui-wait',
      action: 'ui.wait',
      locator: { role: 'unknown', name: '待补充定位器' },
      expect: { textContains: '订单已提交' },
      timeoutMs: 4000,
    })
    expect(result.issues.map((issue) => issue.code)).toContain('page-text-assertion')
  })

  it('flags a duration-only wait as needing a real condition', async () => {
    const result = await draft([step('ui_wait', { durationMs: 800 }, okResult({ waitedMs: 800, textMatched: false }))])

    expect(result.spec.cases[0]?.steps[0]).toEqual({
      id: 'step-1-ui-wait',
      action: 'ui.wait',
      locator: { role: 'unknown', name: '待补充定位器' },
      expect: { exists: true },
      timeoutMs: 800,
    })
    expect(result.issues.map((issue) => issue.code)).toContain('locator-unavailable')
  })
})

describe('solidifyDraft · ui_assert', () => {
  it('maps supported element and page assertions', async () => {
    const result = await draft([
      step('ui_assert', { locator: { testId: 'total' }, expect: { exists: true } }, okResult({ verdict: 'passed' })),
      step('ui_assert', { locator: { testId: 'total' }, expect: { count: 1 } }, okResult({ verdict: 'passed' })),
      step('ui_assert', { locator: { testId: 'submit' }, expect: { enabled: false } }, okResult({ verdict: 'passed' })),
      step('ui_assert', { locator: { testId: 'coupon' }, expect: { valueEquals: 'SHOPAIM10' } }, okResult({ verdict: 'passed' })),
      step('ui_assert', { expect: { urlContains: '/orders' } }, okResult({ verdict: 'passed' })),
    ])

    expect(result.spec.cases[0]?.steps).toEqual([
      { id: 'step-1-ui-assert', action: 'ui.assert', locator: { testId: 'total' }, expect: { exists: true } },
      { id: 'step-2-ui-assert', action: 'ui.assert', locator: { testId: 'total' }, expect: { count: 1 } },
      { id: 'step-3-ui-assert', action: 'ui.assert', locator: { testId: 'submit' }, expect: { enabled: false } },
      { id: 'step-4-ui-assert', action: 'ui.assert', locator: { testId: 'coupon' }, expect: { valueEquals: 'SHOPAIM10' } },
      { id: 'step-5-ui-assert', action: 'ui.assert', expect: { urlContains: '/orders' } },
    ])
    expect(result.issues).toEqual([])
  })

  it('flags nameContains and pageTextContains as unsupported assertions', async () => {
    const result = await draft([
      step('ui_assert', { locator: { testId: 'submit' }, expect: { nameContains: '提交' } }, okResult({ verdict: 'failed' })),
      step('ui_assert', { expect: { pageTextContains: '订单已提交' } }, okResult({ verdict: 'passed' })),
    ])

    const unsupported = result.issues.filter((issue) => issue.code === 'unsupported-assertion')
    expect(unsupported).toHaveLength(2)
    expect(result.spec.cases[0]?.steps[0]).toEqual({
      id: 'step-1-ui-assert',
      action: 'ui.assert',
      locator: { testId: 'submit' },
      expect: { textContains: '提交' },
    })
  })
})

describe('solidifyDraft · ui_screenshot', () => {
  it('drops tabId and ref', async () => {
    const result = await draft([
      step('ui_screenshot', { tabId: 't', ref: 5 }, okResult({ width: 800, height: 600, resized: false, mimeType: 'image/png', imageDelivered: true })),
    ])

    expect(result.spec.cases[0]?.steps).toEqual([{ id: 'step-1-ui-screenshot', action: 'ui.screenshot' }])
  })
})

describe('solidifyDraft · api_request', () => {
  it('maps the request, passes Secret references through, and drops environmentId', async () => {
    const result = await draft([
      step('api_request', {
        method: 'POST',
        url: 'https://api.shop.test/orders',
        query: { limit: 10 },
        headers: { Authorization: { secretId: 'apitest.checkout-token' }, 'X-Trace': 'abc' },
        body: { coupon: 'SHOPAIM10' },
        bodyMode: 'json',
        timeoutMs: 30000,
        redirect: 'manual',
        environmentId: 'staging',
      }, okResult({ statusCode: 201, verdict: 'passed' })),
    ])

    expect(result.spec.cases[0]?.steps[0]).toEqual({
      id: 'step-1-api-request',
      action: 'api.request',
      method: 'POST',
      url: 'https://api.shop.test/orders',
      query: { limit: 10 },
      headers: { Authorization: { secretId: 'apitest.checkout-token' }, 'X-Trace': 'abc' },
      body: { coupon: 'SHOPAIM10' },
      bodyMode: 'json',
      timeoutMs: 30000,
      redirect: 'manual',
      expect: [{ status: 201 }],
    })
    expect(result.issues.map((issue) => issue.code)).toContain('api-assertion-missing')
  })

  it('does not derive an assertion from a failed API step', async () => {
    const result = await draft([
      step('api_request', { method: 'GET', url: 'https://api.shop.test/orders' },
        { isError: true, content: '请求失败', details: { statusCode: 500, verdict: 'failed' } }),
    ])

    expect(result.spec.cases[0]?.steps[0]).not.toHaveProperty('expect')
    expect(result.issues.map((issue) => issue.code)).toContain('step-failed')
    expect(result.issues.map((issue) => issue.code)).toContain('api-assertion-missing')
  })
})

describe('solidifyDraft · failure and truncation', () => {
  it('flags failed exploration steps without inventing a passing assertion', async () => {
    const result = await draft([
      step('ui_assert', { locator: { testId: 'ghost' }, expect: { exists: true } },
        { isError: true, content: '定位零匹配（ambiguous）' }),
    ])

    expect(result.issues.map((issue) => issue.code)).toContain('step-failed')
    expect(result.spec.cases[0]?.steps).toHaveLength(1)
  })

  it('flags a step without a paired result', async () => {
    const result = await draft([step('ui_press', { key: 'Escape' })])

    expect(result.issues.map((issue) => issue.code)).toContain('result-missing')
  })
})

describe('solidifyDraft · compilation and determinism', () => {
  const happyPath = (): ExplorerStep[] => [
    step('ui_navigate', { url: 'https://shop.test/cart' }, okResult({ url: 'https://shop.test/cart' })),
    step('ui_input', { locator: { testId: 'coupon' }, text: 'SHOPAIM10' }, okResult({ applied: true })),
    step('ui_click', { locator: { role: 'button', name: '应用' } }, okResult({ applied: true })),
    step('ui_assert', { locator: { testId: 'total' }, expect: { exists: true } }, okResult({ verdict: 'passed' })),
    step('ui_screenshot', {}, okResult({ width: 800, height: 600, resized: false, mimeType: 'image/png', imageDelivered: true })),
    step('api_request', { method: 'GET', url: 'https://api.shop.test/orders' }, okResult({ statusCode: 200 })),
  ]

  it('produces a spec that passes compileTestSpec', async () => {
    const result = await draft(happyPath())
    const compiled = await compileTestSpec(result.spec, { declaredEnvironmentNames: new Set() })

    expect(compiled.ok).toBe(true)
    expect(result.issues.map((issue) => issue.code)).not.toContain('compile-failed')
  })

  it('reports a compile-failed issue for an undeclared environment reference', async () => {
    const steps = [
      step('api_request', { method: 'GET', url: `\${env.API_BASE_URL}/orders` }, okResult({ statusCode: 200 })),
    ]
    const missing = await draft(steps)
    expect(missing.issues.map((issue) => issue.code)).toContain('compile-failed')

    const declared = await draft(steps, ['API_BASE_URL'])
    expect(declared.issues.map((issue) => issue.code)).not.toContain('compile-failed')
  })

  it('is deterministic for identical input', async () => {
    const first = await draft(happyPath())
    const second = await draft(happyPath())

    expect(JSON.stringify(second.spec)).toBe(JSON.stringify(first.spec))
    expect(second.issues).toEqual(first.issues)
  })
})
