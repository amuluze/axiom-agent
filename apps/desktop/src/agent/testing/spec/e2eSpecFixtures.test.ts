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
