import { describe, expect, it } from 'vitest'
import { compileTestSpec, canonicalJson, deriveRunPlaceholders, materializeTestPlan, materializeTestStepVariables } from './compileTestPlan'
import { validateTestSpec } from './parseTestSpec'
import type { TestSpec } from './types'

const declared = new Set(['WEB_BASE_URL', 'API_BASE_URL'])

const target = {
  webBaseUrl: `\${env.WEB_BASE_URL}`,
  apiBaseUrl: `\${env.API_BASE_URL}`,
  viewport: { width: 1280, height: 800 },
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
  expect: [{ status: 201 }],
})

const specWith = (steps: unknown[], overrides: Record<string, unknown> = {}) => ({
  kind: 'axiom.test',
  version: 1,
  id: 'checkout',
  name: '结算流程',
  target,
  cases: [{ id: 'coupon', name: '优惠券', steps }],
  ...overrides,
})

const parseOrThrow = (raw: unknown): TestSpec => {
  const result = validateTestSpec(raw)
  if (!result.ok) throw new Error(`fixture 解析失败：${JSON.stringify(result.issues)}`)
  return result.spec
}

const compileWith = (raw: unknown, names: ReadonlySet<string> = declared) =>
  compileTestSpec(parseOrThrow(raw), { declaredEnvironmentNames: names })

const compileOk = async (raw: unknown, names: ReadonlySet<string> = declared) => {
  const result = await compileWith(raw, names)
  if (!result.ok) throw new Error(`预期编译成功：${JSON.stringify(result.issues)}`)
  return result.plan
}

describe('compileTestSpec', () => {
  it('produces a frozen plan with the referenced environment names', async () => {
    const plan = await compileOk(specWith([fillCoupon(), assertTotal(), createOrder()]))
    expect(plan.environmentNames).toEqual(['API_BASE_URL', 'WEB_BASE_URL'])
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.cases[0]?.steps[0])).toBe(true)
  })

  it('isolates the plan from later mutations of the source spec', async () => {
    const spec = parseOrThrow(specWith([fillCoupon()]))
    const result = await compileTestSpec(spec, { declaredEnvironmentNames: declared })
    if (!result.ok) throw new Error('预期编译成功')
    const firstStep = spec.cases[0]?.steps[0]
    if (firstStep?.action === 'ui.input') firstStep.value = 'MUTATED'
    expect(result.plan.cases[0]?.steps[0]).toMatchObject({ value: 'SHOPAIM10' })
  })

  it('computes the same hash regardless of key order', async () => {
    const reordered = {
      cases: [{ steps: [fillCoupon()], name: '优惠券', id: 'coupon' }],
      target,
      name: '结算流程',
      id: 'checkout',
      version: 1,
      kind: 'axiom.test',
    }
    const left = await compileOk(specWith([fillCoupon()]))
    const right = await compileOk(reordered)
    expect(right.specHash).toBe(left.specHash)
    expect(left.specHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes the hash when the semantic content changes', async () => {
    const left = await compileOk(specWith([fillCoupon()]))
    const right = await compileOk(specWith([{ ...fillCoupon(), value: 'OTHER' }]))
    expect(right.specHash).not.toBe(left.specHash)
  })

  it('rejects environment references that the run does not declare', async () => {
    const result = await compileWith(specWith([fillCoupon()]), new Set(['WEB_BASE_URL']))
    expect(result).toEqual({
      ok: false,
      issues: [{ path: '$', message: '引用了未声明的环境变量「API_BASE_URL」' }],
    })
  })

  it('requires a locator for element assertions but not for URL assertions', async () => {
    const missing = await compileWith(specWith([
      { id: 'assert-total', action: 'ui.assert', expect: { textContains: '¥240.00' } },
    ]))
    expect(missing).toEqual({
      ok: false,
      issues: [{ path: '$.cases[0].steps[0].locator', message: '该断言作用于元素，必须提供定位器' }],
    })

    await compileOk(specWith([
      { id: 'assert-url', action: 'ui.assert', expect: { urlContains: '/checkout' } },
    ]))
  })

  it('rejects site-relative URLs when the matching base URL is absent', async () => {
    const result = await compileWith(specWith(
      [{ id: 'open', action: 'ui.navigate', url: '/checkout' }],
      { target: { viewport: { width: 1280, height: 800 } } },
    ))
    expect(result).toEqual({
      ok: false,
      issues: [{ path: '$.cases[0].steps[0].url', message: '站内相对路径需要在 target.webBaseUrl 中声明基址' }],
    })
  })

  it('canonicalJson sorts keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}')
  })

  it('materializes environment references and resolves relative step URLs', async () => {
    const compiled = await compileOk(specWith([
      { id: 'open', action: 'ui.navigate', url: '/checkout' },
      { id: 'assert-host', action: 'ui.assert', expect: { urlContains: `\${env.WEB_BASE_URL}` } },
      { id: 'load', action: 'api.request', method: 'GET', url: '/orders' },
    ]))
    const result = materializeTestPlan(compiled, {
      WEB_BASE_URL: 'https://shop.test/root',
      API_BASE_URL: 'https://api.test/v1',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.cases[0]?.steps).toEqual([
      { id: 'open', action: 'ui.navigate', url: 'https://shop.test/checkout' },
      { id: 'assert-host', action: 'ui.assert', expect: { urlContains: 'https://shop.test/root' } },
      { id: 'load', action: 'api.request', method: 'GET', url: 'https://api.test/orders' },
    ])
    expect(Object.isFrozen(result.plan.cases[0]?.steps[0])).toBe(true)
  })

  it('applies local target overrides before resolving relative URLs', async () => {
    const compiled = await compileOk(specWith([{ id: 'open', action: 'ui.navigate', url: '/checkout' }]))
    const result = materializeTestPlan(compiled, {
      WEB_BASE_URL: 'https://committed.test',
      API_BASE_URL: 'https://api.test',
    }, {
      targetOverrides: {
        webBaseUrl: 'http://localhost:5173',
        viewport: { width: 1440, height: 900 },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.target).toMatchObject({
      webBaseUrl: 'http://localhost:5173',
      viewport: { width: 1440, height: 900 },
    })
    expect(result.plan.cases[0]?.steps[0]).toMatchObject({ url: 'http://localhost:5173/checkout' })
  })

  it('rejects materialization when an environment value is absent', async () => {
    const compiled = await compileOk(specWith([fillCoupon()]))
    expect(materializeTestPlan(compiled, { WEB_BASE_URL: 'https://shop.test' })).toEqual({
      ok: false,
      issues: [{ path: '$', message: '运行环境缺少变量「API_BASE_URL」' }],
    })
  })

  it('validates variable production order and duplicate producers per case', async () => {
    const unproduced = await compileWith(specWith([
      { id: 'use-order', action: 'ui.input', locator: { testId: 'order-id' }, value: `\${vars.orderId}` },
    ]))
    expect(unproduced).toEqual({
      ok: false,
      issues: [{ path: '$.cases[0].steps[0]', message: '变量「orderId」必须由当前作用域中的前序步骤生产' }],
    })

    const duplicate = await compileWith(specWith([
      { ...createOrder(), extract: { orderId: { jsonPointer: '/id' } } },
      { ...createOrder(), id: 'create-again', extract: { orderId: { jsonPointer: '/id' } } },
    ]))
    expect(duplicate).toEqual({
      ok: false,
      issues: [{ path: '$.cases[0].steps[1].extract.orderId', message: '变量「orderId」已由当前作用域的前序步骤生产' }],
    })
  })

  it('rejects self-references and runtime variables in target configuration', async () => {
    const result = await compileWith(specWith([{
      ...createOrder(),
      url: `/orders/\${vars.orderId}`,
      extract: { orderId: { jsonPointer: '/id' } },
    }], {
      target: { ...target, webBaseUrl: `\${vars.origin}` },
    }))
    expect(result).toEqual({
      ok: false,
      issues: [
        { path: '$.cases[0].steps[0]', message: '变量「orderId」必须由当前作用域中的前序步骤生产' },
        { path: '$.target', message: '目标配置不能引用运行变量「origin」' },
      ],
    })
  })

  it('interpolates environment references in hook steps and records their names', async () => {
    const plan = await compileOk(specWith([fillCoupon()], {
      hooks: {
        beforeAll: [{
          id: 'seed',
          action: 'api.request',
          method: 'POST',
          url: `${`\${env.EXTRA_BASE}`}/sessions`,
          expect: [{ status: 201 }],
        }],
      },
    }), new Set([...declared, 'EXTRA_BASE']))
    expect(plan.environmentNames).toEqual(['API_BASE_URL', 'EXTRA_BASE', 'WEB_BASE_URL'])
    expect(plan.hooks?.beforeAll?.[0]).toMatchObject({ url: `${`\${env.EXTRA_BASE}`}/sessions` })

    const missing = await compileWith(specWith([fillCoupon()], {
      hooks: {
        beforeAll: [{
          id: 'seed',
          action: 'api.request',
          method: 'POST',
          url: `${`\${env.EXTRA_BASE}`}/sessions`,
          expect: [{ status: 201 }],
        }],
      },
    }))
    expect(missing).toEqual({
      ok: false,
      issues: [{ path: '$', message: '引用了未声明的环境变量「EXTRA_BASE」' }],
    })
  })

  it('reports missing base URLs for hook-relative URLs under the hook path', async () => {
    const result = await compileWith(specWith([fillCoupon()], {
      target: { viewport: { width: 1280, height: 800 } },
      hooks: {
        beforeAll: [
          { id: 'open-shop', action: 'ui.navigate', url: '/setup' },
          { id: 'load-orders', action: 'api.request', method: 'GET', url: '/orders' },
        ],
      },
    }))
    expect(result).toEqual({
      ok: false,
      issues: [
        { path: '$.hooks.beforeAll[0].url', message: '站内相对路径需要在 target.webBaseUrl 中声明基址' },
        { path: '$.hooks.beforeAll[1].url', message: '站内相对路径需要在 target.apiBaseUrl 中声明基址' },
      ],
    })
  })

  it('exposes beforeAll variables to every case and beforeEach', async () => {
    const seed = () => ({
      id: 'seed',
      action: 'api.request' as const,
      method: 'POST' as const,
      url: `${`\${env.API_BASE_URL}`}/sessions`,
      extract: { sessionId: { jsonPointer: '/id' } },
      expect: [{ status: 201 }],
    })
    const plan = await compileOk(specWith([{
      id: 'read-session',
      action: 'ui.input',
      locator: { testId: 'session-id' },
      value: `${`\${vars.sessionId}`}`,
    }], {
      hooks: {
        beforeAll: [seed()],
        beforeEach: [{
          id: 'open-session',
          action: 'api.request',
          method: 'GET',
          url: `${`\${env.API_BASE_URL}`}/sessions/${`\${vars.sessionId}`}`,
          expect: [{ status: 200 }],
        }],
      },
    }))
    expect(plan.hooks?.beforeAll).toHaveLength(1)
    expect(plan.hooks?.beforeEach?.[0]).toMatchObject({
      url: `${`\${env.API_BASE_URL}`}/sessions/${`\${vars.sessionId}`}`,
    })
  })

  it('lets afterEach read case variables without leaking what it produces', async () => {
    const create = () => ({
      ...createOrder(),
      extract: { orderId: { jsonPointer: '/id' } },
    })
    const cleanup = (id: string) => ({
      id,
      action: 'api.request' as const,
      method: 'DELETE' as const,
      url: `${`\${env.API_BASE_URL}`}/orders/${`\${vars.orderId}`}`,
      extract: { cleanupFlag: { jsonPointer: '/flag' } },
      expect: [{ status: 204 }],
    })

    await compileOk(specWith([create()], { hooks: { afterEach: [cleanup('cleanup-a')] } }))

    const leaked = await compileWith(specWith([create(), {
      id: 'read-cleanup',
      action: 'ui.input',
      locator: { testId: 'cleanup-flag' },
      value: `${`\${vars.cleanupFlag}`}`,
    }], { hooks: { afterEach: [cleanup('cleanup-a')] } }))
    expect(leaked).toEqual({
      ok: false,
      issues: [{
        path: '$.cases[0].steps[1]',
        message: '变量「cleanupFlag」必须由当前作用域中的前序步骤生产',
      }],
    })
  })

  it('rejects afterAll references to case variables', async () => {
    const result = await compileWith(specWith([{
      ...createOrder(),
      extract: { orderId: { jsonPointer: '/id' } },
    }], {
      hooks: {
        afterAll: [{
          id: 'teardown',
          action: 'api.request',
          method: 'POST',
          url: `${`\${env.API_BASE_URL}`}/orders/${`\${vars.orderId}`}/archive`,
          expect: [{ status: 200 }],
        }],
      },
    }))
    expect(result).toEqual({
      ok: false,
      issues: [{ path: '$.hooks.afterAll[0]', message: '变量「orderId」必须由当前作用域中的前序步骤生产' }],
    })
  })

  it('materializes hook steps and freezes the materialized plan', async () => {
    const compiled = await compileOk(specWith([fillCoupon()], {
      hooks: {
        beforeAll: [{ id: 'open-shop', action: 'ui.navigate', url: '/setup' }],
        afterAll: [{ id: 'ping', action: 'api.request', method: 'GET', url: '/ping' }],
      },
    }))
    const result = materializeTestPlan(compiled, {
      WEB_BASE_URL: 'https://shop.test/root',
      API_BASE_URL: 'https://api.test/v1',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.hooks?.beforeAll).toEqual([
      { id: 'open-shop', action: 'ui.navigate', url: 'https://shop.test/setup' },
    ])
    expect(result.plan.hooks?.afterAll).toEqual([
      { id: 'ping', action: 'api.request', method: 'GET', url: 'https://api.test/ping' },
    ])
    expect(Object.isFrozen(result.plan)).toBe(true)
    expect(Object.isFrozen(result.plan.hooks)).toBe(true)
    expect(Object.isFrozen(result.plan.hooks?.beforeAll?.[0])).toBe(true)
    expect(compiled.hooks?.beforeAll?.[0]).toMatchObject({ url: '/setup' })
  })

  it('materializes scalar variables without coercing typed API values', () => {
    const api = materializeTestStepVariables({
      id: 'update-order',
      action: 'api.request',
      method: 'POST',
      url: `https://api.test/orders/\${vars.orderId}`,
      query: { active: `\${vars.active}` },
      headers: { 'x-order': `\${vars.orderId}` },
      body: { total: `\${vars.total}` },
      expect: [{ jsonPointerEquals: { pointer: '/total', value: `\${vars.total}` } }],
    }, { orderId: 42, active: true, total: 19.5 })
    expect(api).toMatchObject({
      url: 'https://api.test/orders/42',
      query: { active: true },
      headers: { 'x-order': '42' },
      body: { total: 19.5 },
      expect: [{ jsonPointerEquals: { pointer: '/total', value: 19.5 } }],
    })
  })
})

describe('compileTestSpec v2 计划与运行占位符', () => {
  const environment = { WEB_BASE_URL: 'http://localhost:8080', API_BASE_URL: 'http://127.0.0.1:9/api' }
  const couponWithRunSlug = () => ({ ...fillCoupon(), value: `coupon-\${run.slug}` })
  const orderWithRunId = () => ({ ...createOrder(), url: `\${env.API_BASE_URL}/orders/\${run.id}` })
  const runRefSpec = () => specWith([couponWithRunSlug(), orderWithRunId()], { version: 2 })

  it('carries the source version and test points into the frozen plan', async () => {
    const testPoints = [{ id: 'tp-coupon', kind: 'new_feature', title: '优惠券', acceptance: '金额变化' }]
    const plan = await compileOk(specWith([fillCoupon()], {
      version: 2,
      testPoints,
      cases: [{ id: 'coupon', name: '优惠券', verifies: ['tp-coupon'], steps: [fillCoupon()] }],
    }))
    expect(plan.specVersion).toBe(2)
    expect(plan.testPoints).toEqual(testPoints)
    expect(plan.cases[0]?.verifies).toEqual(['tp-coupon'])
    expect(Object.isFrozen(plan.testPoints)).toBe(true)
    expect(Object.isFrozen(plan.testPoints?.[0])).toBe(true)
  })

  it('keeps v1 plans at version 1 without test points', async () => {
    const plan = await compileOk(specWith([fillCoupon()]))
    expect(plan.specVersion).toBe(1)
    expect('testPoints' in plan).toBe(false)
  })

  it('rejects run placeholders in the target', async () => {
    const result = await compileWith(specWith([fillCoupon()], {
      version: 2,
      target: { ...target, webBaseUrl: `\${env.WEB_BASE_URL}/\${run.slug}` },
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toEqual([{ path: '$.target', message: `目标配置不能引用运行占位符（\${run.slug}）` }])
  })

  it('materializes run placeholders injected by the host', async () => {
    const plan = await compileOk(runRefSpec())
    const materialized = materializeTestPlan(plan, environment, { run: deriveRunPlaceholders('test-run-abc') })
    expect(materialized.ok).toBe(true)
    if (!materialized.ok) return
    const steps = materialized.plan.cases[0]?.steps ?? []
    expect(steps[0]).toMatchObject({ value: 'coupon-axiomrun-test-run-abc' })
    expect(steps[1]).toMatchObject({ url: 'http://127.0.0.1:9/api/orders/test-run-abc' })
    expect(Object.isFrozen(materialized.plan)).toBe(true)
  })

  it('fails closed when run values are missing', async () => {
    const plan = await compileOk(runRefSpec())
    const result = materializeTestPlan(plan, environment)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toEqual([
      { path: '$', message: `运行占位符 \${run.slug}、\${run.id} 缺少取值：宿主未提供 run 标记` },
    ])
  })

  it('derives run placeholders deterministically and ignores them in specHash', async () => {
    expect(deriveRunPlaceholders('test-run-abc')).toEqual(deriveRunPlaceholders('test-run-abc'))
    expect(deriveRunPlaceholders('test-run-abc').slug).toMatch(/^axiomrun-[a-z0-9-]+$/)
    expect(deriveRunPlaceholders('test-run-a').slug).not.toBe(deriveRunPlaceholders('test-run-b').slug)

    const first = await compileOk(runRefSpec())
    const second = await compileOk(runRefSpec())
    expect(second.specHash).toBe(first.specHash)
  })

  it('resolves relative urlEquals against webBaseUrl and rejects it without a base', async () => {
    const raw = {
      ...specWith([{ id: 'assert-url', action: 'ui.assert', expect: { urlEquals: '/checkout' } }]),
      target: { webBaseUrl: 'https://shop.test' },
    }
    const compiled = await compileWith(raw)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const materialized = materializeTestPlan(compiled.plan, {})
    expect(materialized.ok).toBe(true)
    if (!materialized.ok) return
    const step = materialized.plan.cases[0]?.steps[0]
    expect(step?.action).toBe('ui.assert')
    if (!step) return
    const runtimeStep = materializeTestStepVariables(step, {}, materialized.plan.target)
    expect(runtimeStep.action).toBe('ui.assert')
    if (runtimeStep.action !== 'ui.assert') return
    expect(runtimeStep.expect).toEqual({ urlEquals: 'https://shop.test/checkout' })

    const withoutBase = await compileWith({ ...raw, target: {} })
    expect(withoutBase.ok).toBe(false)
    if (withoutBase.ok) return
    expect(withoutBase.issues).toContainEqual({
      path: '$.cases[0].steps[0].expect.urlEquals',
      message: '站内相对 URL 断言需要在 target.webBaseUrl 中声明基址',
    })
  })
})

describe('compileTestPlan v4（poll/delay 与多服务环境变量）', () => {
  const points = [{ id: 'tp-probe', kind: 'new_feature' as const, title: '探测', acceptance: '可客观判定的预期' }]
  const v4Spec = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
    ...specWith(steps),
    version: 4,
    testPoints: points,
    cases: [{ id: 'probe', name: '探测用例', verifies: ['tp-probe'], steps }],
    ...extra,
  })
  const multiServiceDeclared = new Set(['WEB_BASE_URL', 'API_BASE_URL', 'DETECTOR_MGMT_URL', 'DATA_PLANE_URL'])

  it(`collects custom service env names so \${env.DATA_PLANE_URL} compiles against a multi-service topology`, async () => {
    const plan = await compileOk(v4Spec([{
      id: 's',
      action: 'api.poll',
      method: 'GET',
      url: `\${env.DATA_PLANE_URL}/`,
      virtualHost: `site-\${run.slug}.example.test`,
      expect: [{ status: 200 }],
    }]), multiServiceDeclared)
    expect(plan.environmentNames).toContain('DATA_PLANE_URL')
    const materialized = materializeTestPlan(plan, {
      WEB_BASE_URL: 'http://127.0.0.1:5173',
      API_BASE_URL: 'http://127.0.0.1:8090',
      DETECTOR_MGMT_URL: 'http://127.0.0.1:18081',
      DATA_PLANE_URL: 'http://127.0.0.1:8081',
    }, { run: deriveRunPlaceholders('run-abc') })
    expect(materialized.ok).toBe(true)
  })

  it('fails closed when a custom service variable is not declared by the environment', async () => {
    const result = await compileWith(v4Spec([{
      id: 's',
      action: 'api.request',
      method: 'GET',
      url: `\${env.DETECTOR_MGMT_URL}/healthz`,
      expect: [{ status: 200 }],
    }]), multiServiceDeclared)
    expect(result.ok).toBe(true)
    const narrow = await compileWith(v4Spec([{
      id: 's',
      action: 'api.request',
      method: 'GET',
      url: `\${env.DETECTOR_MGMT_URL}/healthz`,
      expect: [{ status: 200 }],
    }]), declared)
    expect(narrow.ok).toBe(false)
    if (narrow.ok) return
    expect(narrow.issues[0]?.message).toContain('未声明的环境变量「DETECTOR_MGMT_URL」')
  })

  it('resolves relative poll urls against target.apiBaseUrl and materializes poll variables', async () => {
    const plan = await compileOk(v4Spec([{
      id: 's',
      action: 'api.poll',
      method: 'GET',
      url: `\${env.API_BASE_URL}/ready`,
      headers: { 'X-Quoin-Secret': { secretId: 'apitest.detector' } },
      expect: [{ status: 200 }],
      extract: { version: { jsonPointer: '/data/version' } },
    }]), multiServiceDeclared)
    const materialized = materializeTestPlan(plan, {
      WEB_BASE_URL: 'http://127.0.0.1:5173',
      API_BASE_URL: 'http://127.0.0.1:8090',
    }, { run: deriveRunPlaceholders('run-abc') })
    expect(materialized.ok).toBe(true)
    if (!materialized.ok) return
    const step = materialized.plan.cases[0]?.steps[0]
    expect(step).toMatchObject({ action: 'api.poll', url: 'http://127.0.0.1:8090/ready' })

    const runtimeStep = materializeTestStepVariables(step!, { version: 3 }, materialized.plan.target)
    expect(runtimeStep).toMatchObject({
      action: 'api.poll',
      url: 'http://127.0.0.1:8090/ready',
      expect: [{ status: 200 }],
    })
  })

  it('requires apiBaseUrl for relative poll urls and leaves delay steps untouched', async () => {
    const noBase = await compileTestSpec(parseOrThrow({
      ...v4Spec([{ id: 's', action: 'api.poll', method: 'GET', url: '/ready', expect: [{ status: 200 }] }]),
      target: {},
    }), { declaredEnvironmentNames: declared })
    expect(noBase.ok).toBe(false)
    if (noBase.ok) return
    expect(noBase.issues[0]?.message).toContain('target.apiBaseUrl')

    const plan = await compileOk(v4Spec([
      { id: 'd', action: 'api.delay', durationMs: 1500 },
      { id: 's', action: 'api.request', method: 'GET', url: `\${env.API_BASE_URL}/x`, expect: [{ status: 200 }] },
    ]))
    const materialized = materializeTestPlan(plan, {
      WEB_BASE_URL: 'http://127.0.0.1:5173',
      API_BASE_URL: 'http://127.0.0.1:8090',
    }, { run: deriveRunPlaceholders('run-abc') })
    expect(materialized.ok).toBe(true)
    if (!materialized.ok) return
    expect(materialized.plan.cases[0]?.steps[0]).toMatchObject({ action: 'api.delay', durationMs: 1500 })
  })
})

describe('compileTestPlan v5（数据驱动 case 展开）', () => {
  const points = [{ id: 'tp-probe', kind: 'new_feature' as const, title: '探测', acceptance: '可客观判定的预期' }]
  const v5Spec = (cases: unknown[], extra: Record<string, unknown> = {}) => ({
    ...specWith([]),
    version: 5,
    testPoints: points,
    cases,
    ...extra,
  })
  const rowStep = () => ({
    id: 's',
    action: 'api.request',
    method: 'POST',
    url: `\${env.API_BASE_URL}/x`,
    headers: { 'X-Code': `\${vars.code}` },
    body: { code: `\${vars.code}` },
    expect: [{ status: 200 }],
  })
  const dataCase = (id = 'probe') => ({
    id,
    name: '探测用例',
    verifies: ['tp-probe'],
    steps: [rowStep()],
    inputs: [{ code: 'A1' }, { code: 'B2' }],
  })

  it('expands rows into independent cases with -vN ids, copied verifies and seeds', async () => {
    const plan = await compileOk(v5Spec([dataCase()]))
    expect(plan.cases.map((testCase) => testCase.id)).toEqual(['probe-v1', 'probe-v2'])
    expect(plan.cases.map((testCase) => testCase.seeds)).toEqual([{ code: 'A1' }, { code: 'B2' }])
    expect(plan.cases[0]?.verifies).toEqual(['tp-probe'])
    expect(plan.cases[0]?.name).toBe('探测用例 · 1/2')
    expect(plan.cases[0]).not.toHaveProperty('inputs')
    // 计划哈希仍取源文件（改输入行会改变哈希，展开只是编译产物）。
    expect(plan.specHash).toHaveLength(64)
  })

  it('keeps the declared id for a single-row case', async () => {
    const plan = await compileOk(v5Spec([{ ...dataCase(), inputs: [{ code: 'A1' }], name: '探测用例' }]))
    expect(plan.cases.map((testCase) => testCase.id)).toEqual(['probe'])
    expect(plan.cases[0]?.seeds).toEqual({ code: 'A1' })
  })

  it('rejects extraction that collides with a seed key in the same case', async () => {
    const clashing = {
      ...dataCase(),
      steps: [
        { ...rowStep(), extract: { code: { jsonPointer: '/code' } } },
      ],
    }
    const result = await compileWith(v5Spec([clashing]))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toContainEqual({
      path: '$.cases[0].steps[0].extract.code',
      message: '变量「code」已由当前作用域的前序步骤生产',
    })
  })

  it('rejects expanded id collisions with hand-written cases', async () => {
    const result = await compileWith(v5Spec([
      dataCase('probe'),
      {
        id: 'probe-v2',
        name: '手写用例',
        verifies: ['tp-probe'],
        steps: [{
          id: 's',
          action: 'api.request',
          method: 'GET',
          url: `\${env.API_BASE_URL}/y`,
          expect: [{ status: 200 }],
        }],
      },
    ]))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toContainEqual({
      path: '$.cases[1].id',
      message: '展开后的用例 ID「probe-v2」重复',
    })
  })

  it('materializes env and run placeholders inside seed values', async () => {
    const plan = await compileOk(v5Spec([{
      ...dataCase(),
      inputs: [{ code: `\${run.slug}`, host: `\${env.API_BASE_URL}` }],
    }]))
    const materialized = materializeTestPlan(plan, {
      WEB_BASE_URL: 'http://127.0.0.1:5173',
      API_BASE_URL: 'http://127.0.0.1:8090',
    }, { run: deriveRunPlaceholders('run-abc') })
    expect(materialized.ok).toBe(true)
    if (!materialized.ok) return
    expect(materialized.plan.cases[0]?.seeds).toEqual({
      code: expect.stringMatching(/^axiomrun-/),
      host: 'http://127.0.0.1:8090',
    })
  })
})

describe('compileTestPlan v6（运行时凭据来源）', () => {
  const points = [{ id: 'tp-probe', kind: 'new_feature' as const, title: '探测', acceptance: '可客观判定的预期' }]
  const loginStep = (sensitive: boolean | undefined) => ({
    id: 'login',
    action: 'api.request',
    method: 'POST',
    url: `\${env.API_BASE_URL}/login`,
    expect: [{ status: 200 }],
    extract: { token: { jsonPointer: '/data/access_token', ...(sensitive === undefined ? {} : { sensitive }) } },
  })
  const callStep = {
    id: 'call',
    action: 'api.request',
    method: 'GET',
    url: `\${env.API_BASE_URL}/me`,
    headers: { Authorization: { variable: 'token', prefix: 'Bearer ' } },
    expect: [{ status: 200 }],
  }
  const v6Spec = (steps: unknown[], hooks: Record<string, unknown> = {}) => ({
    ...specWith([]),
    version: 6,
    testPoints: points,
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
    cases: [{ id: 'probe', name: '登录后调用', verifies: ['tp-probe'], steps }],
  })

  it('accepts variable headers backed by a sensitive extraction in the same case', async () => {
    const plan = await compileOk(v6Spec([loginStep(true), callStep]))
    expect(plan.cases[0]?.steps[1]).toMatchObject({
      headers: { Authorization: { variable: 'token', prefix: 'Bearer ' } },
    })
  })

  it('accepts a sensitive extraction produced by beforeAll', async () => {
    const plan = await compileOk(v6Spec([callStep], { beforeAll: [loginStep(true)] }))
    expect(plan.cases[0]?.steps[0]).toMatchObject({ id: 'call' })
  })

  it('rejects variable headers backed by non-sensitive or unknown extractions', async () => {
    const nonSensitive = await compileWith(v6Spec([loginStep(false), callStep]))
    expect(nonSensitive.ok).toBe(false)
    if (nonSensitive.ok) return
    expect(nonSensitive.issues).toContainEqual({
      path: '$.cases[0].steps[1]',
      message: '请求头变量「token」必须来自 sensitive 抽取（extract.token.sensitive = true）',
    })

    const unknown = await compileWith(v6Spec([callStep]))
    expect(unknown.ok).toBe(false)
    if (unknown.ok) return
    expect(unknown.issues).toContainEqual({
      path: '$.cases[0].steps[0]',
      message: '请求头变量「token」必须来自 sensitive 抽取（extract.token.sensitive = true）',
    })
  })
})

describe('compileTestPlan v7（条件清理）', () => {
  const points = [{ id: 'tp-probe', kind: 'new_feature' as const, title: '探测', acceptance: '可客观判定的预期' }]
  const createStep = {
    id: 'create',
    action: 'api.request',
    method: 'POST',
    url: `\${env.API_BASE_URL}/x`,
    expect: [{ status: 200 }],
    extract: { siteId: { jsonPointer: '/id' } },
  }
  const cleanupStep = {
    id: 'cleanup',
    action: 'api.request',
    method: 'DELETE',
    url: `\${env.API_BASE_URL}/x/\${vars.siteId}`,
    whenProduced: 'siteId',
    expect: [{ statusIn: [200, 404] }],
  }
  const v7Spec = (cases: unknown[], extra: Record<string, unknown> = {}) => ({
    ...specWith([]),
    version: 7,
    testPoints: points,
    ...extra,
    cases,
  })

  it('lets a shared cleanup hook guard a variable produced by only some cases', async () => {
    const plan = await compileOk(v7Spec([
      { id: 'with-create', name: '创建后清理', verifies: ['tp-probe'], steps: [createStep] },
      { id: 'without-create', name: '无资源', verifies: ['tp-probe'], steps: [{
        id: 'noop',
        action: 'api.request',
        method: 'GET',
        url: `\${env.API_BASE_URL}/ping`,
        expect: [{ status: 200 }],
      }] },
    ], { hooks: { afterEach: [cleanupStep] } }))
    expect(plan.hooks?.afterEach?.[0]).toMatchObject({
      whenProduced: 'siteId',
      expect: [{ statusIn: [200, 404] }],
    })
  })

  it('rejects guards for variables the file never produces', async () => {
    const result = await compileWith(v7Spec([
      { id: 'case-1', name: '无产出', verifies: ['tp-probe'], steps: [{
        id: 's',
        action: 'api.request',
        method: 'GET',
        url: `\${env.API_BASE_URL}/ping`,
        whenProduced: 'ghost',
        expect: [{ status: 200 }],
      }] },
    ]))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toContainEqual({
      path: '$.cases[0].steps[0]',
      message: 'whenProduced 变量「ghost」在本文件中没有任何步骤生产（条件永远不成立）',
    })
  })

  it('keeps unguarded references strict', async () => {
    const result = await compileWith(v7Spec([
      { id: 'case-1', name: '无产出', verifies: ['tp-probe'], steps: [{
        id: 's',
        action: 'api.request',
        method: 'GET',
        url: `\${env.API_BASE_URL}/x/\${vars.siteId}`,
        expect: [{ status: 200 }],
      }] },
    ]))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toContainEqual({
      path: '$.cases[0].steps[0]',
      message: '变量「siteId」必须由当前作用域中的前序步骤生产',
    })
  })

  it('requires a matching guard for consumers of conditional products', async () => {
    const conditionalCreate = { ...createStep, whenProduced: 'siteId' }
    const guarded = await compileOk(v7Spec([
      { id: 'case-1', name: '条件创建', verifies: ['tp-probe'], steps: [conditionalCreate, cleanupStep] },
    ]))
    expect(guarded.cases[0]?.steps[1]).toMatchObject({ whenProduced: 'siteId' })

    const unguardedConsumer = {
      id: 'consume',
      action: 'api.request',
      method: 'GET',
      url: `\${env.API_BASE_URL}/x/\${vars.siteId}`,
      expect: [{ status: 200 }],
    }
    const result = await compileWith(v7Spec([
      { id: 'case-1', name: '条件创建', verifies: ['tp-probe'], steps: [conditionalCreate, unguardedConsumer] },
    ]))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toContainEqual({
      path: '$.cases[0].steps[1]',
      message: '变量「siteId」由条件步骤生产；引用它的步骤必须声明 whenProduced: "siteId"',
    })
  })
})
