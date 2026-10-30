import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { testPlanExecutions } from '../runner/runTestPlan'
import { compileTestSpec } from './compileTestPlan'
import { parseTestSpec } from './parseTestSpec'

/**
 * 原生 E2E（`npm run test:e2e:native`）把 `scripts/e2e-fixtures/specs/` 下的 spec
 * 复制进工作区后真实运行。这里用同一套解析器与编译器校验它们：spec 与协议漂移在
 * 秒级门禁里暴露，而不是等一次十几分钟的原生运行才失败。
 */
const FIXTURE_DIR = path.resolve(__dirname, '../../../../../../scripts/e2e-fixtures/specs')
const DECLARED_ENVIRONMENT = new Set(['WEB_BASE_URL', 'API_BASE_URL'])

const loadSpec = (fileName: string) => {
  const content = readFileSync(path.join(FIXTURE_DIR, fileName), 'utf8')
  const parsed = parseTestSpec(content)
  if (!parsed.ok) throw new Error(`${fileName} 无法解析：${JSON.stringify(parsed.issues)}`)
  return parsed.spec
}

const compileFixture = async (fileName: string) => {
  const compiled = await compileTestSpec(loadSpec(fileName), {
    declaredEnvironmentNames: DECLARED_ENVIRONMENT,
  })
  if (!compiled.ok) throw new Error(`${fileName} 无法编译：${JSON.stringify(compiled.issues)}`)
  return compiled.plan
}

describe('原生 E2E spec fixture', () => {
  it('混合闭环 spec 可编译，且 hooks 与 case 步骤都进入执行序列', async () => {
    const plan = await compileFixture('mixed-native.json')
    expect(plan.environmentNames).toEqual(['API_BASE_URL', 'WEB_BASE_URL'])
    expect(testPlanExecutions(plan).map((execution) => [execution.scope.kind === 'hook' ? execution.scope.hook : 'case', execution.id])).toEqual([
      ['beforeAll', '$beforeAll'],
      ['beforeEach', '$beforeEach:api-to-ui'],
      ['case', 'api-to-ui'],
      ['afterEach', '$afterEach:api-to-ui'],
      ['beforeEach', '$beforeEach:ui-to-api'],
      ['case', 'ui-to-api'],
      ['afterEach', '$afterEach:ui-to-api'],
      ['afterAll', '$afterAll'],
    ])
  })

  it('混合闭环 spec 在两个方向上都跨 UI/API 传变量，且 Secret 只经引用进入请求头', async () => {
    const plan = await compileFixture('mixed-native.json')
    const apiToUi = plan.cases.find((testCase) => testCase.id === 'api-to-ui')
    // API 提取的订单号驱动 UI 导航，API 提取的金额驱动 UI 断言值。
    expect(apiToUi?.steps[0]).toMatchObject({ url: expect.stringContaining(`\${vars.orderId}`) })
    expect(apiToUi?.steps[2]).toMatchObject({ expect: { textEquals: `\${vars.orderTotal}` } })
    const uiToApi = plan.cases.find((testCase) => testCase.id === 'ui-to-api')
    // UI 提取的订单号驱动后续 API 查询。
    expect(uiToApi?.steps[4]).toMatchObject({ url: expect.stringContaining(`\${vars.uiOrderId}`) })
    for (const testCase of plan.cases) {
      for (const step of testCase.steps) {
        if (step.action !== 'api.request') continue
        for (const value of Object.values(step.headers ?? {})) {
          expect(value).toEqual({ secretId: 'apitest.native-token' })
        }
      }
    }
  })

  it('cleanup 失败 spec 可编译，cleanup 复用 case 作用域的订单变量', async () => {
    const plan = await compileFixture('mixed-cleanup-failure.json')
    expect(Object.keys(plan.hooks ?? {})).toEqual(['beforeAll', 'beforeEach', 'afterEach'])
    expect(plan.hooks?.afterEach?.[0]).toMatchObject({
      action: 'api.request',
      url: expect.stringContaining(`\${vars.orderId}/cancel-fail`),
    })
    expect(plan.cases[0]?.steps).toHaveLength(1)
  })

  it('所有 UI 步骤都留在 webBaseUrl 的 origin 内：越界导航会被 Rust 授权层拒绝', async () => {
    const plan = await compileFixture('mixed-native.json')
    const base = new URL(String(plan.target.webBaseUrl).replace(`\${env.WEB_BASE_URL}`, 'http://fixture.test'))
    for (const execution of testPlanExecutions(plan)) {
      for (const step of execution.steps) {
        if (step.action !== 'ui.navigate') continue
        const target = new URL(step.url.replace(/\$\{env\.WEB_BASE_URL\}/gu, base.origin))
        expect(target.origin).toBe(base.origin)
      }
    }
  })
})

/**
 * quoin 型项目（控制面 + 数据面 + 管理面 + mock 上游）的 v4 表达力冒烟：
 * 多服务变量、Host 路由轮询、时序小睡与新断言在同一份 spec 里编译并物化。
 * 这不是 quoin 的运行时依赖——纯本地解析/编译/物化，验证协议能表达这类旅程。
 */
describe('多服务拓扑（quoin 型项目）v4–v7 表达力', () => {
  const quoinSpec = {
    kind: 'axiom.test',
    version: 7,
    id: 'quoin-config-push',
    name: '配置下发旅程',
    target: {
      webBaseUrl: `\${env.WEB_BASE_URL}`,
      apiBaseUrl: `\${env.API_BASE_URL}`,
      viewport: { width: 1280, height: 800 },
    },
    hooks: {
      // 共享条件清理：只有真的产出了 siteId 的 case 才执行删除；主流程已删除时 404 被容忍。
      afterEach: [{
        id: 'cleanup-site',
        whenProduced: 'siteId',
        action: 'api.request',
        method: 'DELETE',
        url: `\${env.API_BASE_URL}/api/v1/websites/\${vars.siteId}`,
        headers: { Authorization: { variable: 'token', prefix: 'Bearer ' } },
        expect: [{ statusIn: [200, 404] }],
      }],
      beforeAll: [{
        id: 'login',
        action: 'api.request',
        method: 'POST',
        url: `\${env.API_BASE_URL}/api/v1/auth/login`,
        // quoin 本地栈的已知缺口：登录策略拒绝空来源 IP，直连必须带 XFF（quoin e2e 同款适配）。
        headers: { 'X-Forwarded-For': '127.0.0.1' },
        body: { username: 'admin', password: 'e2e-admin-pass-123' },
        expect: [{ status: 200 }, { jsonPointerExists: '/data/access_token' }],
        extract: { token: { jsonPointer: '/data/access_token', sensitive: true } },
      }],
    },
    testPoints: [
      {
        id: 'tp-config-push',
        kind: 'new_feature',
        title: '站点创建经配置面下发到数据面',
        acceptance: '创建站点后数据面按 Host 命中该站点并返回上游响应',
      },
      {
        id: 'tp-rate-limit',
        kind: 'regression',
        title: '批量上报条数上限仍被强制',
        acceptance: '超过 200 条的 access-logs 批量请求被拒',
      },
    ],
    cases: [
      {
        id: 'push-site',
        name: '创建站点并等待路由生效',
        verifies: ['tp-config-push'],
        steps: [
          {
            id: 'create-site',
            action: 'api.request',
            method: 'POST',
            url: `\${env.API_BASE_URL}/api/v1/websites`,
            headers: { Authorization: { variable: 'token', prefix: 'Bearer ' } },
            body: {
              name: `apitest-\${run.slug}-site`,
              domain: `\${run.slug}.e2e.example.test`,
              status: 1,
              ports: [{ port: '8081', protocol: 'http' }],
              routes: [{ path: '/', upstreams: [{ address: '127.0.0.1:9001', weight: 100 }] }],
            },
            // 真实契约：创建成功返回 200 且不回传 data；ID 需经列表反查。
            expect: [{ status: 200 }],
          },
          {
            id: 'list-site',
            action: 'api.request',
            method: 'GET',
            url: `\${env.API_BASE_URL}/api/v1/websites?page=1&size=100`,
            headers: { Authorization: { variable: 'token', prefix: 'Bearer ' } },
            expect: [
              { status: 200 },
              { bodyContains: `"domain":"\${run.slug}.e2e.example.test"` },
            ],
            // 列表按 id 倒序（真实栈实测）：刚创建的站点位于首位。
            extract: { siteId: { jsonPointer: '/data/data/0/id' } },
          },
          {
            id: 'wait-route',
            action: 'api.poll',
            method: 'GET',
            url: `\${env.DATA_PLANE_URL}/`,
            virtualHost: `\${run.slug}.e2e.example.test`,
            intervalMs: 2000,
            timeoutMs: 60_000,
            expect: [{ status: 200 }, { bodyContains: '"upstream"' }],
          },
          {
            id: 'management-ready',
            action: 'api.request',
            method: 'GET',
            url: `\${env.DETECTOR_MGMT_URL}/config`,
            headers: { 'X-Quoin-Secret': { secretId: 'apitest.quoin-detector' } },
            expect: [
              { status: 200 },
              { jsonPointerExists: '/Version' },
              { jsonPointerLengthEquals: { pointer: '/Listeners', value: 1 } },
              { headerAbsent: { name: 'x-internal-error' } },
            ],
          },
          { id: 'cross-second', action: 'api.delay', durationMs: 1500 },
          {
            id: 'remove-site',
            action: 'api.request',
            method: 'DELETE',
            url: `\${env.API_BASE_URL}/api/v1/websites/\${vars.siteId}`,
            headers: { Authorization: { variable: 'token', prefix: 'Bearer ' } },
            expect: [{ status: 200 }],
          },
          {
            id: 'wait-removed',
            action: 'api.poll',
            method: 'GET',
            url: `\${env.DATA_PLANE_URL}/`,
            virtualHost: `\${run.slug}.e2e.example.test`,
            intervalMs: 2000,
            timeoutMs: 30_000,
            expect: [{ status: 404 }],
          },
        ],
      },
      {
        id: 'validation-rejects',
        name: '站点创建校验拒绝',
        verifies: ['tp-rate-limit'],
        inputs: [
          { domain: 'bad domain', expected: 400 },
          { domain: '', expected: 400 },
        ],
        steps: [
          {
            id: 'create-invalid',
            action: 'api.request',
            method: 'POST',
            url: `\${env.API_BASE_URL}/api/v1/websites`,
            body: {
              name: `apitest-\${run.slug}`,
              domain: `\${vars.domain}`,
              status: 1,
            },
            expect: [{ status: 400 }, { jsonPointerExists: '/err' }],
          },
        ],
      },
      {
        id: 'batch-cap',
        name: '访问日志批量上限',
        verifies: ['tp-rate-limit'],
        steps: [
          {
            id: 'oversized-batch',
            action: 'api.request',
            method: 'POST',
            url: `\${env.API_BASE_URL}/api/v1/access-logs/batch`,
            body: { items: [] },
            expect: [{ status: 400 }, { jsonPointerNumberAtMost: { pointer: '/data/accepted', value: 0 } }],
          },
        ],
      },
    ],
  }
  const environment = {
    WEB_BASE_URL: 'http://127.0.0.1:5173',
    API_BASE_URL: 'http://127.0.0.1:8090',
    DETECTOR_MGMT_URL: 'http://127.0.0.1:18081',
    DATA_PLANE_URL: 'http://127.0.0.1:8081',
  }

  it('parses, compiles and materializes the whole journey without model involvement', async () => {
    const parsed = parseTestSpec(JSON.stringify(quoinSpec))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const compiled = await compileTestSpec(parsed.spec, {
      declaredEnvironmentNames: new Set(Object.keys(environment)),
    })
    expect(compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.issues)).toBe(true)
    if (!compiled.ok) return
    expect(compiled.plan.environmentNames).toEqual([
      'API_BASE_URL', 'DATA_PLANE_URL', 'DETECTOR_MGMT_URL', 'WEB_BASE_URL',
    ])
    const { materializeTestPlan, deriveRunPlaceholders } = await import('./compileTestPlan')
    const materialized = materializeTestPlan(compiled.plan, environment, {
      run: deriveRunPlaceholders('run-quoin-1'),
    })
    expect(materialized.ok).toBe(true)
    if (!materialized.ok) return
    const steps = materialized.plan.cases[0]?.steps ?? []
    const createSite = steps[0]
    expect(createSite).toMatchObject({
      action: 'api.request',
      headers: { Authorization: { variable: 'token', prefix: 'Bearer ' } },
    })
    const listSite = steps[1]
    expect(listSite).toMatchObject({
      action: 'api.request',
      url: 'http://127.0.0.1:8090/api/v1/websites?page=1&size=100',
      extract: { siteId: { jsonPointer: '/data/data/0/id' } },
    })
    const waitRoute = steps[2]
    expect(waitRoute).toMatchObject({
      action: 'api.poll',
      method: 'GET',
      url: 'http://127.0.0.1:8081/',
      intervalMs: 2000,
      timeoutMs: 60_000,
      expect: [{ status: 200 }, { bodyContains: '"upstream"' }],
    })
    // 运行占位符把唯一域名/名称物化进请求体与 Host 覆盖（同一 run 稳定）。
    expect(waitRoute && 'virtualHost' in waitRoute ? waitRoute.virtualHost : null)
      .toMatch(/^axiomrun-.+\.e2e\.example\.test$/)
    expect(steps[4]).toMatchObject({ action: 'api.delay', durationMs: 1500 })
    // 变量与 Virtual Host 在同一 case 内相安无事：删除步骤用前序提取的 siteId。
    expect((steps[5] as { url?: string }).url)
      .toMatch(/\$\{vars\.siteId\}/)
    // JWT 由 beforeAll 登录的 sensitive 抽取生产，跨 case 共享给运行时凭据头。
    expect(materialized.plan.hooks?.beforeAll?.[0]).toMatchObject({
      id: 'login',
      extract: { token: { sensitive: true } },
    })
    // v7 条件清理：共享 afterEach 引用只有部分 case 产出的 siteId，主流程已删除时容忍 404。
    expect(materialized.plan.hooks?.afterEach?.[0]).toMatchObject({
      whenProduced: 'siteId',
      expect: [{ statusIn: [200, 404] }],
    })
    // v5 数据行：校验拒绝用例按两行数据展开成独立 case，行值进 seeds（步骤里的
    // ${vars.domain} 在运行时从 seeds 解析）。
    const expanded = materialized.plan.cases
      .filter((testCase) => testCase.id.startsWith('validation-rejects'))
    expect(expanded.map((testCase) => testCase.id)).toEqual([
      'validation-rejects-v1',
      'validation-rejects-v2',
    ])
    expect(expanded.map((testCase) => testCase.seeds)).toEqual([
      { domain: 'bad domain', expected: 400 },
      { domain: '', expected: 400 },
    ])
    expect(expanded[0]?.name).toBe('站点创建校验拒绝 · 1/2')
    const firstExpanded = expanded[0]
    expect(firstExpanded).toBeDefined()
    if (!firstExpanded) return
    expect(firstExpanded.steps[0]).toMatchObject({ body: { domain: `\${vars.domain}` } })
  })
})
