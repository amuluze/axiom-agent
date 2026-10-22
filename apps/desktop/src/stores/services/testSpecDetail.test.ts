import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readWorkspaceText: vi.fn(),
}))

vi.mock('@/platform/workspace', () => ({ readWorkspaceText: mocks.readWorkspaceText }))

import { assertionCountOf, loadSpecDetail } from './testSpecDetail'

describe('testSpecDetail assertion counts', () => {
  beforeEach(() => {
    mocks.readWorkspaceText.mockReset()
  })

  it('counts UI assert/wait and every API expectation', () => {
    expect(assertionCountOf({
      id: 'a',
      action: 'ui.assert',
      locator: { testId: 'x' },
      expect: { visible: true },
    })).toBe(1)
    expect(assertionCountOf({
      id: 'w',
      action: 'ui.wait',
      expect: { urlContains: '/checkout' },
    })).toBe(1)
    expect(assertionCountOf({
      id: 'api',
      action: 'api.request',
      method: 'GET',
      url: 'https://api.test/orders',
      expect: [{ status: 200 }, { jsonPointerExists: '/id' }],
    })).toBe(2)
    expect(assertionCountOf({
      id: 'click',
      action: 'ui.click',
      locator: { testId: 'go' },
    })).toBe(0)
  })

  it('projects the total into the case detail KPI source', async () => {
    mocks.readWorkspaceText.mockResolvedValue({
      content: JSON.stringify({
        kind: 'axiom.test',
        version: 1,
        id: 'checkout',
        name: '结算',
        target: {},
        cases: [{
          id: 'coupon',
          name: '优惠券',
          steps: [
            { id: 'assert', action: 'ui.assert', locator: { testId: 'total' }, expect: { textContains: '¥240' } },
            { id: 'wait', action: 'ui.wait', expect: { urlContains: '/checkout' } },
            {
              id: 'create',
              action: 'api.request',
              method: 'POST',
              url: 'https://api.test/orders',
              expect: [{ status: 201 }, { jsonPointerExists: '/id' }],
            },
          ],
        }],
      }),
      truncated: false,
    })

    const detail = await loadSpecDetail('tests/checkout.testspec.json', '/repo')
    expect(detail?.cases[0]?.assertCount).toBe(4)
    expect(detail?.assertCount).toBe(4)
    expect(detail?.cases[0]?.assertSummary).toBe('文本包含「¥240」')
  })
})
