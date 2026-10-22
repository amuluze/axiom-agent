import { describe, expect, it } from 'vitest'
import { parseTestSpec, validateTestSpec } from './parseTestSpec'

const head = {
  kind: 'axiom.test',
  version: 1,
  id: 'checkout',
  name: '结算流程',
  target: {
    webBaseUrl: `\${env.WEB_BASE_URL}`,
    apiBaseUrl: `\${env.API_BASE_URL}`,
    viewport: { width: 1280, height: 800 },
  },
}

const fillCoupon = () => ({
  id: 'fill-coupon',
  action: 'ui.input',
  locator: { role: 'textbox', name: '优惠券代码', exact: true },
  value: 'SHOPAIM10',
})

const assertTotal = () => ({
  id: 'assert-total',
  action: 'ui.assert',
  locator: { testId: 'payable-amount' },
  expect: { textContains: '¥240.00' },
})

const createOrder = () => ({
  id: 'create-order',
  action: 'api.request',
  method: 'POST',
  url: `\${env.API_BASE_URL}/orders`,
  headers: { Authorization: { secretId: 'apitest.checkout-token' } },
  body: { coupon: 'SHOPAIM10' },
  expect: [{ status: 201 }, { jsonPointerExists: '/id' }],
})

const caseWith = (steps: unknown[], id = 'coupon') => ({
  id,
  name: '优惠券更新应付金额',
  steps,
})

const specWith = (steps: unknown[], overrides: Record<string, unknown> = {}) => ({
  ...head,
  cases: [caseWith(steps)],
  ...overrides,
})

const issuesOf = (raw: unknown) => {
  const result = validateTestSpec(raw)
  if (result.ok) throw new Error('预期解析失败')
  return result.issues
}

describe('parseTestSpec', () => {
  it('accepts a mixed UI and API v1 file', () => {
    const result = parseTestSpec(JSON.stringify(specWith([fillCoupon(), assertTotal(), createOrder()])))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec.cases[0]?.steps.map((step) => step.action)).toEqual([
      'ui.input',
      'ui.assert',
      'api.request',
    ])
  })

  it('reports malformed JSON at the root path', () => {
    expect(parseTestSpec('{ not json')).toEqual({
      ok: false,
      issues: [{ path: '$', message: 'JSON 解析失败' }],
    })
  })

  it('rejects other axiom documents by discriminator before reading fields', () => {
    expect(issuesOf({ ...specWith([fillCoupon()]), kind: 'axiom.design' })).toEqual([
      { path: '$.kind', message: '必须为 "axiom.test"' },
    ])
  })

  it('rejects unknown schema versions', () => {
    expect(issuesOf({ ...specWith([fillCoupon()]), version: 4 })[0]?.path).toBe('$.version')
    expect(issuesOf({ ...specWith([fillCoupon()]), version: 0 })[0]?.message).toBe('不支持的版本，当前支持 1 / 2 / 3')
  })

  it('fails closed on unknown fields such as tabId or ref', () => {
    const issues = issuesOf(specWith([{ ...fillCoupon(), tabId: 'tab-1' }]))
    expect(issues).toEqual([
      { path: '$.cases[0].steps[0].tabId', message: '未知字段「tabId」' },
    ])
  })

  it('rejects duplicate case and step identifiers with a stable order', () => {
    const duplicateCase = { ...head, cases: [caseWith([fillCoupon()]), caseWith([assertTotal()])] }
    expect(issuesOf(duplicateCase)).toEqual([{ path: '$.cases[1].id', message: 'ID「coupon」重复' }])

    const duplicateStep = specWith([fillCoupon(), { ...assertTotal(), id: 'fill-coupon' }])
    expect(issuesOf(duplicateStep)).toEqual([
      { path: '$.cases[0].steps[1].id', message: 'ID「fill-coupon」重复' },
    ])
  })

  it('rejects unknown actions and expression placeholders', () => {
    const unknownAction = specWith([{ id: 'x', action: 'ui.eval', locator: { role: 'button' } }])
    expect(issuesOf(unknownAction)[0]?.path).toBe('$.cases[0].steps[0].action')

    const expression = specWith([{ ...createOrder(), url: `\${vars.orderId + 1}` }])
    expect(issuesOf(expression)[0]?.message)
      .toBe(`只允许 \${env.NAME}、\${vars.name} 或 \${run.id} / \${run.slug} 形式的占位符`)
  })

  it('accepts scalar API/UI extraction and variable references', () => {
    const result = validateTestSpec(specWith([
      {
        ...createOrder(),
        extract: {
          orderId: { jsonPointer: '/id' },
          traceId: { header: 'x-trace-id', sensitive: true },
        },
      },
      {
        id: 'fill-order',
        action: 'ui.input',
        locator: { testId: 'order-id' },
        value: `\${vars.orderId}`,
      },
      {
        id: 'read-total',
        action: 'ui.assert',
        locator: { testId: 'total' },
        expect: { visible: true },
        extract: { totalText: { source: 'text' } },
      },
    ]))
    expect(result.ok).toBe(true)
  })

  it('rejects object extraction descriptors and sensitive response headers', () => {
    expect(issuesOf(specWith([{
      ...createOrder(),
      extract: { order: { jsonPointer: '/order', extra: true } },
    }]))[0]).toMatchObject({ path: '$.cases[0].steps[0].extract.order.extra' })
    expect(issuesOf(specWith([{
      ...createOrder(),
      extract: { token: { header: 'set-cookie' } },
    }]))[0]).toMatchObject({ message: '敏感响应头不能进入运行变量表' })
  })

  it('keeps Secret references confined to request headers', () => {
    const inBody = specWith([{ ...createOrder(), body: { token: { secretId: 'apitest.checkout-token' } } }])
    expect(issuesOf(inBody)).toEqual([
      { path: '$.cases[0].steps[0].body.token', message: 'Secret 引用只能用于请求头' },
    ])

    const badPrefix = specWith([
      { ...createOrder(), headers: { Authorization: { secretId: 'openai.key' } } },
    ])
    expect(issuesOf(badPrefix)).toEqual([
      {
        path: '$.cases[0].steps[0].headers.Authorization.secretId',
        message: 'Secret ID 必须以 apitest. 开头',
      },
    ])

    const plaintext = specWith([
      { ...createOrder(), headers: { Authorization: 'Bearer leaked' } },
    ])
    expect(issuesOf(plaintext)).toEqual([
      {
        path: '$.cases[0].steps[0].headers.Authorization',
        message: '敏感请求头必须使用 apitest.* Secret 引用',
      },
    ])
  })

  it('rejects URLs with embedded credentials', () => {
    const spec = specWith([fillCoupon()], {
      target: { ...head.target, apiBaseUrl: 'https://user:pass@api.example.test' },
    })
    expect(issuesOf(spec)).toEqual([{ path: '$.target.apiBaseUrl', message: '地址不能内嵌用户名或密码' }])
  })

  it('accepts scalar form bodies and rejects nested form values', () => {
    const valid = validateTestSpec(specWith([{
      ...createOrder(),
      bodyMode: 'form',
      body: { coupon: 'SHOPAIM10', active: true },
    }]))
    expect(valid.ok).toBe(true)
    expect(issuesOf(specWith([{
      ...createOrder(),
      bodyMode: 'form',
      body: { nested: { value: 1 } },
    }]))[0]).toMatchObject({ path: '$.cases[0].steps[0].body.nested' })
  })

  it('rejects assertions whose expectation has zero or several keys', () => {
    const spec = specWith([{ ...assertTotal(), expect: { textContains: 'a', visible: true } }])
    expect(issuesOf(spec)[0]?.message).toBe('每个断言必须且只能包含一个断言字段')
  })

  it('parses every hook as a step list isomorphic to case steps', () => {
    const result = parseTestSpec(JSON.stringify(specWith([fillCoupon()], {
      hooks: {
        beforeAll: [createOrder()],
        beforeEach: [fillCoupon()],
        afterEach: [{ ...assertTotal(), id: 'cleanup' }],
        afterAll: [{ ...createOrder(), id: 'teardown' }],
      },
    })))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec.hooks).toEqual({
      beforeAll: [createOrder()],
      beforeEach: [fillCoupon()],
      afterEach: [{ ...assertTotal(), id: 'cleanup' }],
      afterAll: [{ ...createOrder(), id: 'teardown' }],
    })
  })

  it('accepts an empty hooks object and omits the key when hooks are absent', () => {
    const empty = validateTestSpec(specWith([fillCoupon()], { hooks: {} }))
    expect(empty.ok).toBe(true)
    if (!empty.ok) return
    expect(empty.spec.hooks).toEqual({})

    const absent = validateTestSpec(specWith([fillCoupon()]))
    if (!absent.ok) throw new Error('预期解析成功')
    expect('hooks' in absent.spec).toBe(false)
  })

  it('rejects unknown hook names and duplicate hook step identifiers', () => {
    expect(issuesOf(specWith([fillCoupon()], { hooks: { beforAll: [fillCoupon()] } }))).toEqual([
      { path: '$.hooks.beforAll', message: '未知字段「beforAll」' },
    ])

    expect(issuesOf(specWith([fillCoupon()], {
      hooks: { beforeEach: [fillCoupon(), { ...assertTotal(), id: 'fill-coupon' }] },
    }))).toEqual([
      { path: '$.hooks.beforeEach[1].id', message: 'ID「fill-coupon」重复' },
    ])
  })

  it('does not mutate the input object', () => {
    const spec = specWith([fillCoupon(), createOrder()])
    const snapshot = JSON.stringify(spec)
    validateTestSpec(spec)
    expect(JSON.stringify(spec)).toBe(snapshot)
  })
})

describe('parseTestSpec v2/v3 增量', () => {
  const testPoints = [
    { id: 'tp-coupon', kind: 'new_feature', title: '优惠券影响应付金额', acceptance: '输入有效券码后应付金额等于折后价' },
    { id: 'tp-order', kind: 'regression', title: '下单链路回归', acceptance: '下单成功且订单可按 id 查询' },
  ]

  it('requires test points from v3 while v2 remains readable without them', () => {
    const v2 = validateTestSpec({ ...head, version: 2, cases: [caseWith([fillCoupon()])] })
    expect(v2.ok).toBe(true)

    expect(issuesOf({ ...head, version: 3, cases: [caseWith([fillCoupon()])] })).toEqual([
      { path: '$.testPoints', message: 'v3 文件必须声明至少一个测试点' },
    ])

    const v3 = validateTestSpec({
      ...head,
      version: 3,
      testPoints,
      cases: [
        { id: 'coupon', name: '优惠券', verifies: ['tp-coupon'], steps: [fillCoupon()] },
        { id: 'order', name: '下单', verifies: ['tp-order'], steps: [createOrder()] },
      ],
    })
    expect(v3.ok).toBe(true)
    if (!v3.ok) return
    expect(v3.spec.version).toBe(3)
    expect(v3.spec.testPoints).toEqual(testPoints)
  })

  it('accepts test points claimed by cases', () => {
    const result = validateTestSpec({
      ...head,
      version: 2,
      testPoints,
      cases: [
        { id: 'coupon', name: '优惠券', verifies: ['tp-coupon'], steps: [fillCoupon(), assertTotal()] },
        { id: 'order', name: '下单', verifies: ['tp-order'], steps: [createOrder()] },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec.version).toBe(2)
    expect(result.spec.testPoints).toEqual(testPoints)
    expect(result.spec.cases[0]?.verifies).toEqual(['tp-coupon'])
  })

  it('preserves the source version and rejects v2 fields on v1 files', () => {
    const v1 = validateTestSpec(specWith([fillCoupon()]))
    expect(v1.ok).toBe(true)
    if (!v1.ok) return
    expect(v1.spec.version).toBe(1)

    expect(issuesOf({ ...head, testPoints, cases: [caseWith([fillCoupon()])] })).toEqual([
      { path: '$.testPoints', message: 'v1 文件不支持测试点；请把 version 升到 2' },
    ])
    expect(issuesOf(specWith([fillCoupon()], { cases: [{ ...caseWith([fillCoupon()]), verifies: ['tp-coupon'] }] })))
      .toEqual([{ path: '$.cases[0].verifies', message: 'v1 文件不支持测试点追溯；请把 version 升到 2' }])
  })

  it('rejects unsupported versions and lists the supported ones', () => {
    expect(issuesOf({ ...head, version: 4, cases: [caseWith([fillCoupon()])] }))
      .toEqual([{ path: '$.version', message: '不支持的版本，当前支持 1 / 2 / 3' }])
    expect(issuesOf({ ...head, version: '2', cases: [caseWith([fillCoupon()])] }))
      .toEqual([{ path: '$.version', message: '不支持的版本，当前支持 1 / 2 / 3' }])
  })

  it('rejects dangling verifies and orphan test points', () => {
    expect(issuesOf({
      ...head,
      version: 2,
      testPoints,
      cases: [{ id: 'coupon', name: '优惠券', verifies: ['tp-coupon', 'tp-missing'], steps: [fillCoupon()] }],
    })).toEqual([
      { path: '$.cases[0].verifies', message: '引用了不存在的测试点「tp-missing」' },
      { path: '$.testPoints[1]', message: '测试点「tp-order」没有任何用例认领' },
    ])
  })

  it('validates test point shape', () => {
    expect(issuesOf({
      ...head,
      version: 2,
      testPoints: [{ id: 'tp-coupon', kind: 'smoke', title: '优惠券', acceptance: '金额变化' }],
      cases: [{ id: 'coupon', name: '优惠券', verifies: ['tp-coupon'], steps: [fillCoupon()] }],
    })).toEqual([
      { path: '$.testPoints[0].kind', message: '只允许 new_feature 或 regression' },
      { path: '$.cases[0].verifies', message: '引用了不存在的测试点「tp-coupon」' },
    ])
  })

  it('accepts run placeholders on v2 and rejects them on v1', () => {
    const withRunRef = { ...createOrder(), url: `\${env.API_BASE_URL}/orders/\${run.id}` }
    const accepted = validateTestSpec({ ...head, version: 2, cases: [caseWith([withRunRef])] })
    expect(accepted.ok).toBe(true)

    expect(issuesOf(specWith([{ ...createOrder(), url: `\${env.API_BASE_URL}/orders/\${run.slug}` }]))).toEqual([
      { path: '$.cases[0].steps[0].url', message: `v1 文件不支持 \${run.id} / \${run.slug} 运行占位符；请把 version 升到 2` },
    ])
    expect(issuesOf(specWith([{ ...createOrder(), url: `\${env.API_BASE_URL}/orders/\${run.other}` }]))).toEqual([
      { path: '$.cases[0].steps[0].url', message: `只允许 \${env.NAME}、\${vars.name} 或 \${run.id} / \${run.slug} 形式的占位符` },
    ])
  })
})

describe('parseTestSpec secret boundary', () => {
  it('rejects plaintext credentials in url/query/body/custom header/expect', () => {
    const cases = [
      [{ ...createOrder(), url: 'https://api.example.test/orders?token=ghp_leaked' }],
      [{ ...createOrder(), query: { token: 'ghp_leaked' } }],
      [{ ...createOrder(), body: { token: 'ghp_leaked' } }],
      [{ ...createOrder(), headers: { 'X-Auth-Token': 'ghp_leaked' } }],
      [{ ...createOrder(), expect: [{ headerEquals: { name: 'x-trace', value: 'Bearer leaked' } }] }],
    ]
    for (const steps of cases) {
      expect(issuesOf(specWith(steps)).some((issue) => issue.message.includes('明文凭据'))).toBe(true)
    }
  })

  it('rejects sensitive response header assertions instead of leaking their actual values', () => {
    expect(issuesOf(specWith([
      { ...createOrder(), expect: [{ headerEquals: { name: 'set-cookie', value: 'session=abc' } }] },
    ]))).toContainEqual({
      path: '$.cases[0].steps[0].expect[0].headerEquals.name',
      message: '敏感响应头不能用于断言（避免实际值进入证据）',
    })
  })

  it('rejects API url fragments at parse time (Rust execution already does)', () => {
    expect(issuesOf(specWith([
      { ...createOrder(), url: 'https://api.example.test/orders#section' },
    ]))).toEqual([
      { path: '$.cases[0].steps[0].url', message: 'API 地址不能包含 fragment（#...）' },
    ])
  })
})
