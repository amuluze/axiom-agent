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
    expect(issuesOf({ ...specWith([fillCoupon()]), version: 10 })[0]?.path).toBe('$.version')
    expect(issuesOf({ ...specWith([fillCoupon()]), version: 0 })[0]?.message).toBe('不支持的版本，当前支持 1 / 2 / 3 / 4 / 5 / 6 / 7 / 8 / 9')
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
    expect(issuesOf({ ...head, version: 10, cases: [caseWith([fillCoupon()])] }))
      .toEqual([{ path: '$.version', message: '不支持的版本，当前支持 1 / 2 / 3 / 4 / 5 / 6 / 7 / 8 / 9' }])
    expect(issuesOf({ ...head, version: '2', cases: [caseWith([fillCoupon()])] }))
      .toEqual([{ path: '$.version', message: '不支持的版本，当前支持 1 / 2 / 3 / 4 / 5 / 6 / 7 / 8 / 9' }])
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

describe('parseTestSpec v4 增量（多服务拓扑）', () => {
  const v4Spec = (steps: unknown[]) => ({
    ...head,
    version: 4,
    testPoints: [{ id: 'tp-probe', kind: 'new_feature', title: '探测', acceptance: '可客观判定的预期' }],
    cases: [{ id: 'probe', name: '探测用例', verifies: ['tp-probe'], steps }],
  })

  it('accepts api.poll / api.delay / virtualHost in v4', () => {
    const result = validateTestSpec(v4Spec([
      {
        id: 's-poll',
        action: 'api.poll',
        method: 'GET',
        url: `\${env.DATA_PLANE_URL}/`,
        virtualHost: `site-\${run.slug}.example.test`,
        intervalMs: 2000,
        timeoutMs: 60_000,
        expect: [{ status: 200 }],
      },
      { id: 's-delay', action: 'api.delay', durationMs: 1500 },
      {
        id: 's-host',
        action: 'api.request',
        method: 'GET',
        url: 'http://127.0.0.1:8081/',
        virtualHost: 'api.example.test:8443',
        expect: [{ status: 200 }],
      },
    ]))
    expect(result.ok).toBe(true)
  })

  it('keeps poll idempotent: GET/HEAD only, expectations required, interval bounded', () => {
    expect(issuesOf(v4Spec([{ id: 's', action: 'api.poll', method: 'POST', url: '/x', expect: [{ status: 200 }] }]))[0]?.message)
      .toContain('GET 或 HEAD')
    expect(issuesOf(v4Spec([{ id: 's', action: 'api.poll', method: 'GET', url: '/x', expect: [] }]))
      .some((issue) => issue.path === '$.cases[0].steps[0].expect')).toBe(true)
    expect(issuesOf(v4Spec([{ id: 's', action: 'api.poll', method: 'GET', url: '/x', intervalMs: 100, expect: [{ status: 200 }] }]))[0]?.message)
      .toContain('500')
    expect(issuesOf(v4Spec([{ id: 's', action: 'api.poll', method: 'GET', url: '/x', body: { a: 1 }, expect: [{ status: 200 }] }]))[0]?.message)
      .toContain('未知字段「body」')
  })

  it('validates virtualHost as host[:port] without scheme/path/credentials', () => {
    const badValues = [
      'https://api.example.test',
      'api.example.test/path',
      'user:pass@host',
      'host:99999',
      'host:0x10',
      '-lead.example.test',
      'a:1:2',
    ]
    for (const value of badValues) {
      expect(issuesOf(v4Spec([{ id: 's', action: 'api.request', method: 'GET', url: 'http://127.0.0.1:1/', virtualHost: value }]))[0]?.path)
        .toBe('$.cases[0].steps[0].virtualHost')
    }
  })

  it('rejects v4 fields in v3 files with actionable upgrade messages', () => {
    const poll = issuesOf({ ...v4Spec([{ id: 's', action: 'api.poll', method: 'GET', url: '/x', expect: [{ status: 200 }] }]), version: 3 })
    expect(poll[0]?.message).toContain('v4 增量')
    const host = issuesOf({ ...v4Spec([{ id: 's', action: 'api.request', method: 'GET', url: 'http://127.0.0.1:1/', virtualHost: 'a.test' }]), version: 3 })
    expect(host[0]?.message).toContain('v4 增量')
    const delay = issuesOf({ ...v4Spec([{ id: 's', action: 'api.delay', durationMs: 100 }]), version: 3 })
    expect(delay[0]?.message).toContain('v4 增量')
  })

  it('accepts the v4 expectation variants only from v4 and keeps sensitive headers rejected', () => {
    const variants = [
      { headerExists: { name: 'x-security-block' } },
      { headerAbsent: { name: 'x-security-block' } },
      { jsonPointerLengthEquals: { pointer: '/data/items', value: 200 } },
      { jsonPointerNumberAtLeast: { pointer: '/data/total', value: 0 } },
      { jsonPointerNumberAtMost: { pointer: '/data/total', value: 200 } },
    ]
    for (const variant of variants) {
      const step = { id: 's', action: 'api.request', method: 'GET', url: '/x', expect: [variant] }
      expect(validateTestSpec(v4Spec([step])).ok).toBe(true)
      const v3 = issuesOf({ ...v4Spec([step]), version: 3 })
      expect(v3[0]?.message).toContain('v4 增量')
    }
    expect(issuesOf(v4Spec([{ id: 's', action: 'api.request', method: 'GET', url: '/x', expect: [{ headerExists: { name: 'set-cookie' } }] }]))[0]?.message)
      .toContain('敏感响应头')
  })
})

describe('parseTestSpec v5（数据驱动 case）', () => {
  const v5Spec = (steps: unknown[], inputs?: unknown) => ({
    ...head,
    version: 5,
    testPoints: [{ id: 'tp-probe', kind: 'new_feature', title: '探测', acceptance: '可客观判定的预期' }],
    cases: [{
      id: 'probe',
      name: '探测用例',
      verifies: ['tp-probe'],
      steps,
      ...(inputs === undefined ? {} : { inputs }),
    }],
  })
  const step = (value: string) => ({
    id: 's',
    action: 'api.request',
    method: 'POST',
    url: '/x',
    body: { value },
    expect: [{ status: 200 }],
  })

  it(`accepts data rows referencing \${vars.*} and env/run placeholders inside row values`, () => {
    const result = validateTestSpec(v5Spec(
      [step(`\${vars.code}`)],
      [
        { code: 'A1', count: 1, tenant: 'acme' },
        { code: 'B2', count: 2, tenant: 'acme' },
        { code: `\${run.slug}`, count: 3, tenant: `\${env.API_BASE_URL}` },
      ],
    ))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec.cases[0]?.inputs).toHaveLength(3)
    expect(result.spec.cases[0]?.inputs?.[2]).toMatchObject({ tenant: `\${env.API_BASE_URL}` })
  })

  it('rejects inputs in v4 files and malformed rows', () => {
    const v4 = issuesOf({ ...v5Spec([step(`\${vars.code}`)], [{ code: 'A1' }]), version: 4 })
    expect(v4[0]).toEqual({ path: '$.cases[0].inputs', message: '案例输入表是 v5 增量；请把 version 升到 5' })

    expect(issuesOf(v5Spec([step(`\${vars.code}`)], [{ code: 'A1' }, { other: 'B2' }])))
      .toContainEqual({ path: '$.cases[0].inputs[1]', message: '数据行的键必须一致（首行为 code）' })
    expect(issuesOf(v5Spec([step(`\${vars.code}`)], [{ code: `\${vars.other}` }])))
      .toContainEqual({ path: '$.cases[0].inputs[0].code', message: `数据行值不能引用运行变量（只允许 \${env.*} / \${run.*}）` })
    expect(issuesOf(v5Spec([step(`\${vars.code}`)], [{}])))
      .toContainEqual({ path: '$.cases[0].inputs[0]', message: '每条数据行至少需要一个键' })
    expect(issuesOf(v5Spec([step(`\${vars.code}`)], [])))
      .toContainEqual({ path: '$.cases[0].inputs', message: '至少需要 1 项' })
  })

  it('caps multi-row case ids so the -vN suffix stays valid', () => {
    const longId = `c${'x'.repeat(62)}`
    const raw = {
      ...v5Spec([step(`\${vars.code}`)], [{ code: 'A1' }, { code: 'B2' }]),
      cases: [{
        id: longId,
        name: '长 ID 用例',
        verifies: ['tp-probe'],
        steps: [step(`\${vars.code}`)],
        inputs: [{ code: 'A1' }, { code: 'B2' }],
      }],
    }
    expect(issuesOf(raw)).toContainEqual({
      path: '$.cases[0].id',
      message: '数据驱动用例的 id 最多 60 字符（展开时会追加 -vN 后缀）',
    })
  })
})

describe('parseTestSpec v6（运行时凭据引用）', () => {
  const v6Spec = (headerValue: unknown, version = 6) => ({
    ...head,
    version,
    testPoints: [{ id: 'tp-probe', kind: 'new_feature', title: '探测', acceptance: '可客观判定的预期' }],
    cases: [{
      id: 'probe',
      name: '登录后调用',
      verifies: ['tp-probe'],
      steps: [
        {
          id: 'login',
          action: 'api.request',
          method: 'POST',
          url: '/login',
          expect: [{ status: 200 }],
          extract: { token: { jsonPointer: '/data/access_token', sensitive: true } },
        },
        {
          id: 'call',
          action: 'api.request',
          method: 'GET',
          url: '/me',
          headers: { Authorization: headerValue },
          expect: [{ status: 200 }],
        },
      ],
    }],
  })

  it('accepts variable references with an auth-scheme prefix', () => {
    const result = validateTestSpec(v6Spec({ variable: 'token', prefix: 'Bearer ' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec.cases[0]?.steps[1]).toMatchObject({
      headers: { Authorization: { variable: 'token', prefix: 'Bearer ' } },
    })
    expect(validateTestSpec(v6Spec({ variable: 'token' })).ok).toBe(true)
  })

  it('gates variable references on version 6', () => {
    const rejected = issuesOf(v6Spec({ variable: 'token', prefix: 'Bearer ' }, 5))
    expect(rejected.some((issue) => issue.message.includes('v6 增量'))).toBe(true)
  })

  it('keeps plaintext sensitive headers rejected and refuses mixed reference shapes', () => {
    expect(issuesOf(v6Spec('Bearer hardcoded-token')).some((issue) => issue.message.includes('Secret')))
      .toBe(true)
    const mixed = issuesOf(v6Spec({ secretId: 'apitest.token', variable: 'token' }))
    expect(mixed[0]).toEqual({
      path: '$.cases[0].steps[1].headers.Authorization',
      message: '请求头值不能同时是 Secret 与运行时变量引用',
    })
  })

  it('validates the auth-scheme prefix shape and variable name', () => {
    for (const prefix of ['Bearer', 'Bearer  ', 'Bea rer ', '1Bearer ', 'Bearer\n']) {
      expect(issuesOf(v6Spec({ variable: 'token', prefix }))[0]?.message)
        .toBe('运行时凭据前缀必须是「Scheme 」形式（如 Bearer ）')
    }
    expect(issuesOf(v6Spec({ variable: '1bad', prefix: 'Bearer ' }))[0]?.message)
      .toContain('变量名必须以字母开头')
    expect(issuesOf(v6Spec({ variable: 'token', prefix: 'Bearer ', extra: true }))[0]?.message)
      .toContain('未知字段「extra」')
  })
})

describe('parseTestSpec v7（条件清理与多状态断言）', () => {
  const v7Spec = (steps: unknown[], version = 7) => ({
    ...head,
    version,
    testPoints: [{ id: 'tp-probe', kind: 'new_feature', title: '探测', acceptance: '可客观判定的预期' }],
    cases: [{ id: 'probe', name: '探测用例', verifies: ['tp-probe'], steps }],
  })
  const request = (overrides: Record<string, unknown> = {}) => ({
    id: 's',
    action: 'api.request',
    method: 'DELETE',
    url: '/x',
    expect: [{ status: 200 }],
    ...overrides,
  })

  it('accepts statusIn arrays and stores them on the step', () => {
    const result = validateTestSpec(v7Spec([
      {
        ...request(),
        expect: [{ statusIn: [200, 204, 404, 404] }],
      },
    ]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec.cases[0]?.steps[0]).toMatchObject({
      expect: [{ statusIn: [200, 204, 404] }],
    })
  })

  it('rejects statusIn before v7 and malformed status lists', () => {
    const v6 = issuesOf({ ...v7Spec([{ ...request(), expect: [{ statusIn: [200, 404] }] }]), version: 6 })
    expect(v6[0]).toEqual({
      path: '$.cases[0].steps[0].expect[0]',
      message: '断言「statusIn」是 v7 增量；请把 version 升到 7',
    })
    for (const value of [[], ['200'], [99], [600], Array.from({ length: 9 }, (_, i) => 200 + i)]) {
      expect(issuesOf(v7Spec([{ ...request(), expect: [{ statusIn: value }] }])).length)
        .toBeGreaterThan(0)
    }
  })

  it('accepts whenProduced guards and rejects them before v7', () => {
    const result = validateTestSpec(v7Spec([
      request({ whenProduced: 'siteId' }),
    ]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec.cases[0]?.steps[0]).toMatchObject({ whenProduced: 'siteId' })
    expect(issuesOf({ ...v7Spec([request({ whenProduced: 'siteId' })]), version: 6 })[0]).toEqual({
      path: '$.cases[0].steps[0].whenProduced',
      message: '条件执行（whenProduced）是 v7 增量；请把 version 升到 7',
    })
    expect(issuesOf(v7Spec([request({ whenProduced: '1bad' })]))[0]?.message)
      .toContain('变量名必须以字母开头')
  })
})

describe('parseTestSpec v8（负断言）', () => {
  const v8Spec = (expectValue: unknown, version = 8) => ({
    ...head,
    version,
    testPoints: [{ id: 'tp-probe', kind: 'new_feature', title: '探测', acceptance: '可客观判定的预期' }],
    cases: [{
      id: 'probe', name: '探测用例', verifies: ['tp-probe'],
      steps: [{
        id: 's', action: 'api.request', method: 'GET', url: '/x',
        expect: [expectValue],
      }],
    }],
  })

  it('accepts bodyNotContains from v8', () => {
    const result = validateTestSpec(v8Spec({ bodyNotContains: 'e2e-secret' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec.cases[0]?.steps[0]).toMatchObject({ expect: [{ bodyNotContains: 'e2e-secret' }] })
  })

  it('gates bodyNotContains on v8 and rejects empty text', () => {
    expect(issuesOf({ ...v8Spec({ bodyNotContains: 'x' }), version: 7 })[0]).toEqual({
      path: '$.cases[0].steps[0].expect[0]',
      message: '断言「bodyNotContains」是 v8 增量；请把 version 升到 8',
    })
    expect(issuesOf(v8Spec({ bodyNotContains: '' }))[0]?.message).toContain('不能为空')
  })
})

describe('parseTestSpec v9（fixture 文件引用）', () => {
  const v9Spec = (body: unknown, version = 9) => ({
    ...head,
    version,
    testPoints: [{ id: 'tp-probe', kind: 'new_feature', title: '探测', acceptance: '可客观判定的预期' }],
    cases: [{
      id: 'probe', name: '探测用例', verifies: ['tp-probe'],
      steps: [{
        id: 's', action: 'api.request', method: 'POST', url: '/x',
        body, expect: [{ status: 200 }],
      }],
    }],
  })

  it('accepts fixture references in JSON bodies from v9', () => {
    const result = validateTestSpec(v9Spec({
      name: 'cert',
      certificate_content: { file: 'tests/fixtures/cert.pem' },
      nested: [{ key_content: { file: 'tests/fixtures/key.pem' } }],
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec.cases[0]?.steps[0]).toMatchObject({
      body: { certificate_content: { file: 'tests/fixtures/cert.pem' } },
    })
  })

  it('gates fixture references on v9', () => {
    expect(issuesOf({ ...v9Spec({ file: { file: 'tests/fixtures/cert.pem' } }), version: 8 })[0]?.message)
      .toContain('v9 增量')
  })

  it('rejects absolute paths, traversal and mixed objects', () => {
    const badPaths = [
      { file: '/etc/passwd' },
      { file: 'tests/fixtures/../secret.pem' },
      { file: 'tests/fixtures/./cert.pem' },
      { file: 'fixtures/cert.pem' },
    ]
    for (const reference of badPaths) {
      expect(issuesOf(v9Spec({ certificate_content: reference }))[0]?.message)
        .toContain('文件引用必须是 tests/fixtures/ 下的工作区相对路径')
    }
    expect(issuesOf(v9Spec({ certificate_content: { file: 'tests/fixtures/cert.pem', sensitive: true } }))[0]?.message)
      .toContain('文件引用对象只能包含 file 字段')
  })
})
