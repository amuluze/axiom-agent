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
      id: 'poll',
      action: 'api.poll',
      method: 'GET',
      url: 'https://api.test/orders',
      expect: [{ status: 200 }, { jsonPointerExists: '/id' }],
    })).toBe(2)
    expect(assertionCountOf({
      id: 'delay',
      action: 'api.delay',
      durationMs: 10,
    })).toBe(0)
    expect(assertionCountOf({
      id: 'click',
      action: 'ui.click',
      locator: { testId: 'go' },
    })).toBe(0)
  })

  it('classifies a polling-only file as API instead of UI', async () => {
    mocks.readWorkspaceText.mockResolvedValue({
      content: JSON.stringify({
        kind: 'axiom.test',
        version: 9,
        id: 'poll',
        name: '轮询',
        target: {},
        testPoints: [{ id: 'tp', kind: 'regression', title: '轮询', acceptance: '最终一致' }],
        cases: [{
          id: 'case-one',
          name: '轮询',
          verifies: ['tp'],
          steps: [
            { id: 'delay', action: 'api.delay', durationMs: 10 },
            {
              id: 'poll',
              action: 'api.poll',
              method: 'GET',
              url: 'https://api.test/ready',
              expect: [{ status: 200 }],
            },
          ],
        }],
      }),
      truncated: false,
    })

    const detail = await loadSpecDetail('tests/poll.testspec.json', '/repo')
    expect(detail?.cases[0]).toMatchObject({
      type: 'api',
      assertCount: 1,
      assertSummary: 'GET https://api.test/ready → 200（1 项断言）',
    })
    expect(detail?.apiCaseCount).toBe(1)
    expect(detail?.uiCaseCount).toBe(0)
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
    // 副行取**最后一个**断言：多个用例共享同一前置请求时，首个断言会退化成同一行字。
    expect(detail?.cases[0]?.assertSummary).toBe('POST https://api.test/orders → 201（2 项断言）')
  })

  it('projects the test point titles a case verifies', async () => {
    mocks.readWorkspaceText.mockResolvedValue({
      content: JSON.stringify({
        kind: 'axiom.test',
        version: 3,
        id: 'checkout',
        name: '结算',
        target: {},
        testPoints: [
          { id: 'tp-coupon', kind: 'new_feature', title: '优惠券叠加规则', acceptance: '总额按叠加规则计算' },
          { id: 'tp-order', kind: 'regression', title: '下单回归', acceptance: '下单成功' },
        ],
        cases: [
          {
            id: 'coupon',
            name: '优惠券',
            verifies: ['tp-coupon', 'tp-order'],
            steps: [
              { id: 'assert', action: 'ui.assert', locator: { testId: 'total' }, expect: { textContains: '¥240' } },
            ],
          },
          {
            id: 'legacy',
            name: '无追溯',
            steps: [
              { id: 'assert', action: 'ui.assert', locator: { testId: 'total' }, expect: { textContains: '¥0' } },
            ],
          },
        ],
      }),
      truncated: false,
    })

    const detail = await loadSpecDetail('tests/checkout.testspec.json', '/repo')
    expect(detail?.cases[0]?.testPointTitles).toEqual(['优惠券叠加规则', '下单回归'])
    // v1/v3 文件都可能有用例不带 verifies：副行回落到断言摘要。
    expect(detail?.cases[1]?.testPointTitles).toEqual([])
    expect(detail?.cases[1]?.assertSummary).toBe('文本包含「¥0」')
  })
})
