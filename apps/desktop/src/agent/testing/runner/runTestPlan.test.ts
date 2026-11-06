import { describe, expect, it, vi } from 'vitest'
import type { CompiledTestPlan } from '../spec/compileTestPlan'
import type { ApiDriverStep, UiStepSpec } from '../spec/types'
import {
  runTestPlan,
  type ApiTestDriver,
  type StepExecutionContext,
  type StepOutcome,
  type StepStatusChange,
  type TestRunReport,
  type UiTestDriver,
} from './runTestPlan'

const plan: CompiledTestPlan = {
  specId: 'checkout',
  name: '结算流程',
  specVersion: 1,
  specHash: 'abc123',
  target: {},
  environmentNames: [],
  cases: [
    {
      id: 'coupon',
      name: '优惠券',
      steps: [
        { id: 'open', action: 'ui.navigate', url: 'https://shop.test/checkout' },
        { id: 'apply', action: 'ui.click', locator: { role: 'button', name: '应用' } },
      ],
    },
    {
      id: 'order',
      name: '下单',
      steps: [
        { id: 'create', action: 'api.request', method: 'POST', url: 'https://api.test/orders' },
        { id: 'verify', action: 'ui.assert', expect: { urlContains: '/orders' } },
      ],
    },
  ],
}

const passing = async (): Promise<StepOutcome> => ({ verdict: 'passed' })

const drivers = (
  uiRun: (step: UiStepSpec, context: StepExecutionContext) => Promise<StepOutcome> = passing,
  apiRun: (step: ApiDriverStep, context: StepExecutionContext) => Promise<StepOutcome> = passing,
) => {
  const ui: UiTestDriver = { runStep: vi.fn(uiRun) }
  const api: ApiTestDriver = { runStep: vi.fn(apiRun) }
  return { ui, api }
}

const runWith = (
  options: { ui: UiTestDriver; api: ApiTestDriver; signal?: AbortSignal },
  changes: StepStatusChange[] = [],
) =>
  runTestPlan({
    plan,
    signal: options.signal ?? new AbortController().signal,
    ui: options.ui,
    api: options.api,
    onStepStatusChange: (change) => changes.push(change),
  })

const statusesOf = (report: Awaited<ReturnType<typeof runTestPlan>>) =>
  report.cases.map((testCase) => [testCase.status, ...testCase.steps.map((step) => step.status)])

describe('runTestPlan', () => {
  it('runs every step serially and reports passed when all verdicts pass', async () => {
    const { ui, api } = drivers()
    const report = await runWith({ ui, api })
    expect(report.status).toBe('passed')
    expect(report.specHash).toBe('abc123')
    expect(statusesOf(report)).toEqual([
      ['passed', 'passed', 'passed'],
      ['passed', 'passed', 'passed'],
    ])
    expect(ui.runStep).toHaveBeenCalledTimes(3)
    expect(api.runStep).toHaveBeenCalledTimes(1)
  })

  it('routes api.request steps to the API driver and ui.* steps to the UI driver', async () => {
    const { ui, api } = drivers()
    await runWith({ ui, api })
    const apiCall = vi.mocked(api.runStep).mock.calls[0]
    expect(apiCall?.[0]).toMatchObject({ action: 'api.request', method: 'POST' })
    expect(vi.mocked(ui.runStep).mock.calls.map(([step]) => step.action)).toEqual([
      'ui.navigate',
      'ui.click',
      'ui.assert',
    ])
  })

  it('fails fast: a failed assertion skips the rest of the run without retrying', async () => {
    const { ui, api } = drivers(async (step) =>
      step.id === 'apply' ? { verdict: 'failed', message: '金额不匹配' } : { verdict: 'passed' })
    const report = await runWith({ ui, api })
    expect(report.status).toBe('failed')
    expect(statusesOf(report)).toEqual([
      ['failed', 'passed', 'failed'],
      ['skipped', 'skipped', 'skipped'],
    ])
    expect(report.cases[0]?.steps[1]?.message).toBe('金额不匹配')
    expect(vi.mocked(ui.runStep).mock.calls.filter(([step]) => step.id === 'apply')).toHaveLength(1)
    expect(api.runStep).not.toHaveBeenCalled()
  })

  it('records a driver exception as error with a fixed message that does not echo the cause', async () => {
    const { ui, api } = drivers(async (step) => {
      if (step.id === 'open') throw new Error('Authorization: Bearer sk-secret')
      return { verdict: 'passed' }
    })
    const report = await runWith({ ui, api })
    expect(report.status).toBe('error')
    expect(report.cases[0]?.steps[0]).toMatchObject({ status: 'error' })
    expect(JSON.stringify(report)).not.toContain('sk-secret')
  })

  it('marks the step rejected after an approval rejection and skips the remaining steps', async () => {
    const changes: StepStatusChange[] = []
    const { ui, api } = drivers(async (step, context) => {
      if (step.id !== 'apply') return { verdict: 'passed' }
      context.markWaitingApproval()
      return { verdict: 'rejected', message: '用户拒绝了本次点击' }
    })
    const report = await runWith({ ui, api }, changes)
    expect(report.status).toBe('rejected')
    expect(statusesOf(report)).toEqual([
      ['rejected', 'passed', 'rejected'],
      ['skipped', 'skipped', 'skipped'],
    ])
    expect(changes.filter((change) => change.stepId === 'apply').map((change) => change.status)).toEqual([
      'running',
      'waiting_approval',
      'rejected',
    ])
  })

  it('returns from waiting_approval to running before the approved verdict is settled', async () => {
    const changes: StepStatusChange[] = []
    const { ui, api } = drivers(async (step, context) => {
      if (step.id !== 'apply') return { verdict: 'passed' }
      context.markWaitingApproval()
      context.markRunning()
      return { verdict: 'passed' }
    })
    const report = await runWith({ ui, api }, changes)
    expect(report.status).toBe('passed')
    expect(changes.filter((change) => change.stepId === 'apply').map((change) => change.status)).toEqual([
      'running',
      'waiting_approval',
      'running',
      'passed',
    ])
  })

  it('cancels directly from waiting approval and cancels the remaining steps', async () => {
    const changes: StepStatusChange[] = []
    const { ui, api } = drivers(async (step, context) => {
      if (step.id !== 'apply') return { verdict: 'passed' }
      context.markWaitingApproval()
      return { verdict: 'canceled', message: '运行已停止' }
    })
    const report = await runWith({ ui, api }, changes)
    expect(report.status).toBe('canceled')
    expect(statusesOf(report)).toEqual([
      ['canceled', 'passed', 'canceled'],
      ['canceled', 'canceled', 'canceled'],
    ])
    expect(changes.filter((change) => change.stepId === 'apply').map((change) => change.status)).toEqual([
      'running',
      'waiting_approval',
      'canceled',
    ])
  })

  it('stops with canceled when the signal fires during an atomic step', async () => {
    const controller = new AbortController()
    const { ui, api } = drivers(async (step) => {
      if (step.id === 'open') controller.abort()
      return { verdict: 'passed' }
    })
    const report = await runWith({ ui, api, signal: controller.signal })
    expect(report.status).toBe('canceled')
    expect(statusesOf(report)).toEqual([
      ['canceled', 'passed', 'canceled'],
      ['canceled', 'canceled', 'canceled'],
    ])
    expect(api.runStep).not.toHaveBeenCalled()
  })

  it('classifies a driver rejection after abort as canceled', async () => {
    const controller = new AbortController()
    const { ui, api } = drivers(async (step) => {
      if (step.id === 'open') {
        controller.abort()
        throw new Error('native cancellation')
      }
      return { verdict: 'passed' }
    })
    const report = await runWith({ ui, api, signal: controller.signal })
    expect(report.status).toBe('canceled')
    expect(report.cases[0]?.steps[0]).toMatchObject({ status: 'canceled', message: '运行已停止' })
  })

  it('does not execute anything when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { ui, api } = drivers()
    const report = await runWith({ ui, api, signal: controller.signal })
    expect(report.status).toBe('canceled')
    expect(ui.runStep).not.toHaveBeenCalled()
    expect(api.runStep).not.toHaveBeenCalled()
  })

  it('passes extracted scalar variables to later steps and redacts sensitive report values', async () => {
    const variablePlan: CompiledTestPlan = {
      ...plan,
      cases: [{
        id: 'variable-flow',
        name: '变量流',
        steps: [
          {
            id: 'create',
            action: 'api.request',
            method: 'POST',
            url: 'https://api.test/orders',
            extract: {
              orderId: { jsonPointer: '/id' },
              tokenHint: { header: 'x-token-hint', sensitive: true },
            },
          },
          {
            id: 'fill',
            action: 'ui.input',
            locator: { testId: 'order-id' },
            value: `order-\${vars.orderId}-\${vars.tokenHint}`,
          },
        ],
      }],
    }
    const ui = vi.fn(async (_step: UiStepSpec, _context: StepExecutionContext): Promise<StepOutcome> => ({ verdict: 'passed' }))
    const api = vi.fn(async (_step: ApiDriverStep, _context: StepExecutionContext): Promise<StepOutcome> => ({
      verdict: 'passed',
      extractedVariables: {
        orderId: { value: 42, sensitive: false },
        tokenHint: { value: 'secret-fragment', sensitive: true },
      },
    }))
    const changes: StepStatusChange[] = []
    const report = await runTestPlan({
      plan: variablePlan,
      ui: { runStep: ui },
      api: { runStep: api },
      signal: new AbortController().signal,
      onStepStatusChange: (change) => changes.push(change),
    })
    expect(ui.mock.calls[0]?.[0]).toMatchObject({ value: 'order-42-secret-fragment' })
    expect(ui.mock.calls[0]?.[1]).toMatchObject({ sensitiveValues: ['secret-fragment'] })
    expect(report.cases[0]?.steps[0]?.variables).toEqual({
      orderId: { sourceStepId: 'create', value: 42, sensitive: false },
      tokenHint: { sourceStepId: 'create', value: '[REDACTED]', sensitive: true },
    })
    expect(JSON.stringify(changes)).not.toContain('secret-fragment')
  })

  it('fails closed when a driver returns undeclared variables', async () => {
    const variablePlan: CompiledTestPlan = {
      ...plan,
      cases: [{
        id: 'invalid-extraction',
        name: '非法提取',
        steps: [{
          id: 'create',
          action: 'api.request',
          method: 'POST',
          url: 'https://api.test/orders',
          extract: { orderId: { jsonPointer: '/id' } },
        }],
      }],
    }
    const report = await runTestPlan({
      plan: variablePlan,
      ui: { runStep: passing },
      api: {
        runStep: async () => ({
          verdict: 'passed',
          extractedVariables: { order: { value: 'wrong-name', sensitive: false } },
        }),
      },
      signal: new AbortController().signal,
    })
    expect(report.status).toBe('error')
    expect(report.cases[0]?.steps[0]?.message).toBe('驱动返回的变量提取结果与测试计划不一致')
  })
})

/** hook 步骤一律走 API driver：判定来源单一，同时让执行顺序可直接断言。 */
const hookStep = (id: string) => ({
  id,
  action: 'api.request' as const,
  method: 'GET' as const,
  url: `https://api.test/${id}`,
})

const hookPlan = (cases = [{ id: 'checkout', name: '结算', steps: [hookStep('case-step')] }]): CompiledTestPlan => ({
  ...plan,
  cases,
  hooks: {
    beforeAll: [hookStep('before-all')],
    beforeEach: [hookStep('before-each')],
    afterEach: [hookStep('after-each')],
    afterAll: [hookStep('after-all')],
  },
})

const runHooks = async (
  hookTestPlan: CompiledTestPlan,
  run: (step: ApiDriverStep, context: StepExecutionContext) => Promise<StepOutcome>,
  signal = new AbortController().signal,
): Promise<{ report: TestRunReport; executed: string[]; signals: AbortSignal[] }> => {
  const executed: string[] = []
  const signals: AbortSignal[] = []
  const report = await runTestPlan({
    plan: hookTestPlan,
    ui: { runStep: passing },
    api: {
      runStep: async (step, context) => {
        executed.push(step.id)
        signals.push(context.signal)
        return run(step, context)
      },
    },
    signal,
  })
  return { report, executed, signals }
}

const stepStatuses = (report: TestRunReport) =>
  report.cases.flatMap((testCase) => [testCase.caseId, ...testCase.steps.map((step) => step.status)])

describe('runTestPlan hooks', () => {
  it('runs beforeAll, per-case hooks and afterAll in order and reports hook scope', async () => {
    const { report, executed } = await runHooks(hookPlan(), passing)
    expect(executed).toEqual([
      'before-all', 'before-each', 'case-step', 'after-each', 'after-all',
    ])
    expect(report.status).toBe('passed')
    expect(report.cases.map((testCase) => testCase.scope)).toEqual([
      { kind: 'hook', hook: 'beforeAll' },
      { kind: 'hook', hook: 'beforeEach', targetCaseId: 'checkout' },
      undefined,
      { kind: 'hook', hook: 'afterEach', targetCaseId: 'checkout' },
      { kind: 'hook', hook: 'afterAll' },
    ])
  })

  it('still runs afterEach and afterAll after the main steps fail', async () => {
    const { report, executed } = await runHooks(
      hookPlan(),
      async (step) => step.id === 'case-step'
        ? { verdict: 'failed', message: '断言失败' }
        : { verdict: 'passed' },
    )
    expect(executed).toEqual(['before-all', 'before-each', 'case-step', 'after-each', 'after-all'])
    expect(report.status).toBe('failed')
    expect(stepStatuses(report)).toEqual([
      '$beforeAll', 'passed',
      '$beforeEach:checkout', 'passed',
      'checkout', 'failed',
      '$afterEach:checkout', 'passed',
      '$afterAll', 'passed',
    ])
  })

  it('skips the case body but still cleans up when beforeEach fails', async () => {
    const { report, executed } = await runHooks(
      hookPlan(),
      async (step) => step.id === 'before-each'
        ? { verdict: 'failed', message: '准备失败' }
        : { verdict: 'passed' },
    )
    expect(executed).toEqual(['before-all', 'before-each', 'after-each', 'after-all'])
    expect(stepStatuses(report)).toEqual([
      '$beforeAll', 'passed',
      '$beforeEach:checkout', 'failed',
      'checkout', 'skipped',
      '$afterEach:checkout', 'passed',
      '$afterAll', 'passed',
    ])
    expect(report.status).toBe('failed')
  })

  it('skips every case and its hooks after beforeAll fails but still runs afterAll', async () => {
    const { report, executed } = await runHooks(
      hookPlan([
        { id: 'checkout', name: '结算', steps: [hookStep('case-step')] },
        { id: 'refund', name: '退款', steps: [hookStep('refund-step')] },
      ]),
      async (step) => step.id === 'before-all'
        ? { verdict: 'failed', message: '环境初始化失败' }
        : { verdict: 'passed' },
    )
    expect(executed).toEqual(['before-all', 'after-all'])
    expect(stepStatuses(report)).toEqual([
      '$beforeAll', 'failed',
      '$beforeEach:checkout', 'skipped',
      'checkout', 'skipped',
      '$afterEach:checkout', 'skipped',
      '$beforeEach:refund', 'skipped',
      'refund', 'skipped',
      '$afterEach:refund', 'skipped',
      '$afterAll', 'passed',
    ])
  })

  it('gives a rejected cleanup step its own rejected status and stops the remaining cases', async () => {
    const { report, executed } = await runHooks(
      hookPlan([
        { id: 'checkout', name: '结算', steps: [hookStep('case-step')] },
        { id: 'refund', name: '退款', steps: [hookStep('refund-step')] },
      ]),
      async (step, context) => {
        if (step.id !== 'after-each') return { verdict: 'passed' }
        context.markWaitingApproval()
        return { verdict: 'rejected', message: '用户拒绝了 cleanup' }
      },
    )
    expect(executed).toEqual(['before-all', 'before-each', 'case-step', 'after-each', 'after-all'])
    expect(stepStatuses(report)).toEqual([
      '$beforeAll', 'passed',
      '$beforeEach:checkout', 'passed',
      'checkout', 'passed',
      '$afterEach:checkout', 'rejected',
      '$beforeEach:refund', 'skipped',
      'refund', 'skipped',
      '$afterEach:refund', 'skipped',
      '$afterAll', 'passed',
    ])
    expect(report.cases[3]?.steps[0]?.message).toBe('用户拒绝了 cleanup')
    expect(report.status).toBe('rejected')
  })

  it('keeps a failing cleanup step distinguishable from the main case result', async () => {
    const { report } = await runHooks(
      hookPlan(),
      async (step) => {
        if (step.id === 'case-step') return { verdict: 'failed', message: '断言失败' }
        if (step.id === 'after-each') return { verdict: 'error', message: '清理端点 500' }
        return { verdict: 'passed' }
      },
    )
    const mainCase = report.cases.find((testCase) => testCase.caseId === 'checkout')
    const cleanupCase = report.cases.find((testCase) => testCase.caseId === '$afterEach:checkout')
    expect(mainCase?.status).toBe('failed')
    expect(cleanupCase?.status).toBe('error')
    expect(cleanupCase?.steps[0]?.message).toBe('清理端点 500')
    expect(report.status).toBe('error')
  })

  it('does not run cleanup after the run is stopped and marks it canceled', async () => {
    const controller = new AbortController()
    const { report, executed } = await runHooks(
      hookPlan(),
      async (step) => {
        if (step.id === 'case-step') {
          controller.abort()
          return { verdict: 'passed' }
        }
        return { verdict: 'passed' }
      },
      controller.signal,
    )
    expect(executed).toEqual(['before-all', 'before-each', 'case-step'])
    expect(stepStatuses(report)).toEqual([
      '$beforeAll', 'passed',
      '$beforeEach:checkout', 'passed',
      'checkout', 'passed',
      '$afterEach:checkout', 'canceled',
      '$afterAll', 'canceled',
    ])
    expect(report.status).toBe('canceled')
  })

  it('shares suite variables with cases and cleanup but not case variables with afterAll', async () => {
    const planWithExtraction: CompiledTestPlan = {
      ...hookPlan(),
      hooks: {
        beforeAll: [{
          id: 'seed',
          action: 'api.request',
          method: 'POST',
          url: 'https://api.test/seed',
          extract: { suiteToken: { jsonPointer: '/token' } },
        }],
        afterEach: [{
          id: 'after-each',
          action: 'api.request',
          method: 'POST',
          url: `https://api.test/\${vars.suiteToken}/after-each`,
        }],
        afterAll: [{
          id: 'after-all',
          action: 'api.request',
          method: 'POST',
          url: `https://api.test/\${vars.suiteToken}/after-all`,
        }],
      },
      cases: [{
        id: 'checkout',
        name: '结算',
        steps: [{
          id: 'case-step',
          action: 'api.request',
          method: 'POST',
          url: `https://api.test/\${vars.suiteToken}/orders`,
          extract: { orderId: { jsonPointer: '/id' } },
        }],
      }],
    }
    const seen = new Map<string, string>()
    const recordingApi: ApiTestDriver = {
      runStep: async (step): Promise<StepOutcome> => {
        seen.set(step.id, step.url)
        if (step.id === 'seed') {
          return { verdict: 'passed', extractedVariables: { suiteToken: { value: 'suite-1', sensitive: false } } }
        }
        if (step.id === 'case-step') {
          return { verdict: 'passed', extractedVariables: { orderId: { value: 7, sensitive: false } } }
        }
        return { verdict: 'passed' }
      },
    }
    const report = await runTestPlan({
      plan: planWithExtraction,
      ui: { runStep: passing },
      api: recordingApi,
      signal: new AbortController().signal,
    })
    expect(report.status).toBe('passed')
    expect(seen.get('case-step')).toBe('https://api.test/suite-1/orders')
    expect(seen.get('after-each')).toBe('https://api.test/suite-1/after-each')
    // afterAll 只拿到 suite 变量：case 内产出的变量不得泄漏出 case 作用域。
    expect(seen.get('after-all')).toBe('https://api.test/suite-1/after-all')
  })

  it('passes the same abort signal into setup and cleanup steps', async () => {
    const controller = new AbortController()
    const { signals } = await runHooks(hookPlan(), passing, controller.signal)
    expect(signals.every((signal) => signal === controller.signal)).toBe(true)
  })

  it('freezes test points and case verifies into the report for later coverage', async () => {
    const withPoints: CompiledTestPlan = {
      ...plan,
      testPoints: [{ id: 'tp-checkout', kind: 'new_feature', title: '结算', acceptance: '可客观判定' }],
      cases: plan.cases.map((testCase, index) => ({
        ...testCase,
        ...(index === 0 ? { verifies: ['tp-checkout'] } : {}),
      })),
    }
    const { ui, api } = drivers()
    const report = await runTestPlan({
      plan: withPoints,
      ui,
      api,
      signal: new AbortController().signal,
    })
    expect(report.testPoints).toEqual(withPoints.testPoints)
    expect(report.caseIds).toEqual(['coupon', 'order'])
    expect(report.caseVerifies).toEqual([['tp-checkout'], []])
  })
})

describe('runTestPlan v4（api.poll 分派与 api.delay 本地等待）', () => {
  const passing = async (): Promise<StepOutcome> => ({ verdict: 'passed' })

  it('routes api.poll through the API driver and api.delay locally without approval', async () => {
    const pollPlan: CompiledTestPlan = {
      specId: 'quoin',
      name: '配置下发',
      specVersion: 4,
      specHash: 'poll123',
      target: {},
      environmentNames: [],
      cases: [{
        id: 'push',
        name: '下发',
        steps: [
          { id: 'create-site', action: 'api.request', method: 'POST', url: 'http://127.0.0.1:8090/api/v1/websites' },
          { id: 'wait-route', action: 'api.poll', method: 'GET', url: 'http://127.0.0.1:8081/', virtualHost: 'site.example.test', intervalMs: 500, timeoutMs: 60_000, expect: [{ status: 200 }] },
          { id: 'cross-second', action: 'api.delay', durationMs: 20 },
        ],
      }],
    }
    const seen: string[] = []
    const api: ApiTestDriver = {
      runStep: async (step) => {
        seen.push(step.action)
        return { verdict: 'passed' }
      },
    }
    const ui: UiTestDriver = { runStep: vi.fn(passing) }
    const changes: StepStatusChange[] = []
    const report = await runTestPlan({
      plan: pollPlan,
      ui,
      api,
      signal: new AbortController().signal,
      onStepStatusChange: (change) => changes.push(change),
    })
    expect(seen).toEqual(['api.request', 'api.poll'])
    expect(ui.runStep).not.toHaveBeenCalled()
    expect(report.status).toBe('passed')
    expect(report.cases[0]?.steps.map((step) => step.status)).toEqual(['passed', 'passed', 'passed'])
    expect(report.cases[0]?.steps[2]?.message).toBe('等待 20 ms')
  })

  it('cancels an in-flight delay when the run is aborted', async () => {
    const controller = new AbortController()
    const delayPlan: CompiledTestPlan = {
      specId: 'quoin',
      name: '跨秒边界',
      specVersion: 4,
      specHash: 'delay123',
      target: {},
      environmentNames: [],
      cases: [{
        id: 'token',
        name: '令牌撤销',
        steps: [
          { id: 'login', action: 'api.request', method: 'POST', url: 'http://127.0.0.1:8090/api/v1/auth/login' },
          { id: 'wait-boundary', action: 'api.delay', durationMs: 30_000 },
          { id: 'disable', action: 'api.request', method: 'POST', url: 'http://127.0.0.1:8090/api/v1/account/users/1/disable' },
        ],
      }],
    }
    const api: ApiTestDriver = {
      runStep: async (_step, context) => {
        // 第一个请求完成后立刻停止：delay 必须被打断，后续步骤记 canceled。
        controller.abort()
        expect(context.signal.aborted).toBe(true)
        return { verdict: 'passed' }
      },
    }
    const report = await runTestPlan({
      plan: delayPlan,
      ui: { runStep: vi.fn(passing) },
      api,
      signal: controller.signal,
    })
    expect(report.cases[0]?.steps.map((step) => step.status)).toEqual(['passed', 'canceled', 'canceled'])
  })
})

describe('runTestPlan v5（数据行 seeds 的作用域）', () => {
  it('seeds case variables before beforeEach and does not leak them into other cases', async () => {
    const seededPlan: CompiledTestPlan = {
      specId: 'quoin',
      name: '数据驱动',
      specVersion: 7,
      specHash: 'v5seed',
      target: {},
      environmentNames: [],
      hooks: {
        beforeEach: [{
          id: 'hook',
          action: 'api.request',
          method: 'POST',
          url: 'http://127.0.0.1:8090/hook',
          body: { code: `\${vars.code}` },
          whenProduced: 'code',
          expect: [{ status: 200 }],
        }],
      },
      cases: [
        {
          id: 'probe-v1',
          name: '探测 · 1/2',
          steps: [{
            id: 's',
            action: 'api.request',
            method: 'POST',
            url: 'http://127.0.0.1:8090/x',
            body: { code: `\${vars.code}` },
            expect: [{ status: 200 }],
          }],
          seeds: { code: 'A1' },
        },
        {
          id: 'plain',
          name: '无数据行',
          steps: [{ id: 's2', action: 'api.request', method: 'GET', url: 'http://127.0.0.1:8090/y', expect: [{ status: 200 }] }],
        },
      ],
    }
    const seen: unknown[] = []
    const api: ApiTestDriver = {
      runStep: async (step) => {
        seen.push(step)
        return { verdict: 'passed' }
      },
    }
    const report = await runTestPlan({
      plan: seededPlan,
      ui: { runStep: vi.fn() },
      api,
      signal: new AbortController().signal,
    })
    expect(report.status).toBe('passed')
    // beforeEach 与 case 步骤都看到同一行输入值。
    expect((seen[0] as { body?: unknown }).body).toEqual({ code: 'A1' })
    expect((seen[1] as { body?: unknown }).body).toEqual({ code: 'A1' })
    // 第二个 case 没有数据行：输入值不会泄漏（变量表按 case 隔离）。
    expect(JSON.stringify(seen[2])).not.toContain('A1')
    expect(report.cases.map((testCase) => testCase.caseId)).toEqual([
      '$beforeEach:probe-v1', 'probe-v1',
      '$beforeEach:plain', 'plain',
    ])
    // 第二个 case 没有数据行：守卫让引用缺失种子的 hook 跳过，而不是发出 undefined。
    expect(report.cases.map((testCase) => testCase.status)).toEqual([
      'passed', 'passed',
      'skipped', 'passed',
    ])
  })
})

describe('runTestPlan v6（运行时凭据注入）', () => {
  it('passes only the referenced sensitive variable to the API driver', async () => {
    const credentialPlan: CompiledTestPlan = {
      specId: 'quoin',
      name: 'JWT 流程',
      specVersion: 6,
      specHash: 'v6cred',
      target: {},
      environmentNames: [],
      cases: [{
        id: 'login-flow',
        name: '登录后调用',
        steps: [
          {
            id: 'login',
            action: 'api.request',
            method: 'POST',
            url: 'http://127.0.0.1:8090/login',
            expect: [{ status: 200 }],
            extract: { token: { jsonPointer: '/data/access_token', sensitive: true } },
          },
          {
            id: 'call',
            action: 'api.request',
            method: 'GET',
            url: 'http://127.0.0.1:8090/me',
            headers: { Authorization: { variable: 'token', prefix: 'Bearer ' } },
            expect: [{ status: 200 }],
          },
        ],
      }],
    }
    const calls: Array<{ step: unknown; context: { credentialVariables?: unknown } }> = []
    const api: ApiTestDriver = {
      runStep: async (step, context) => {
        calls.push({ step, context })
        return calls.length === 1
          ? { verdict: 'passed', extractedVariables: { token: { value: 'jwt-from-login', sensitive: true } } }
          : { verdict: 'passed' }
      },
    }
    const report = await runTestPlan({
      plan: credentialPlan,
      ui: { runStep: vi.fn() },
      api,
      signal: new AbortController().signal,
    })
    expect(report.status).toBe('passed')
    // 步骤里的引用保持对象形态（宿主据此注入）；值只传被引用的变量。
    expect(calls[1]?.step).toMatchObject({
      headers: { Authorization: { variable: 'token', prefix: 'Bearer ' } },
    })
    expect(calls[1]?.context.credentialVariables).toEqual({ token: 'jwt-from-login' })
    // 未引用变量的步骤不携带凭据表。
    expect(calls[0]?.context.credentialVariables).toBeUndefined()
    // 敏感值仍进入脱敏名单。
    expect(calls[1]?.context).toMatchObject({ sensitiveValues: ['jwt-from-login'] })
  })
  it('surfaces the concrete message when a plan references an unproduced credential variable', async () => {
    // 绕过编译期校验的非法计划（headers 引用了从未产出的敏感变量）：Runner 是最后
    // 一道防线，错误必须带出具体变量名，而不是折叠成驱动固定文案。
    const brokenPlan: CompiledTestPlan = {
      specId: 'quoin',
      name: '凭据缺失',
      specVersion: 6,
      specHash: 'v6missing',
      target: {},
      environmentNames: [],
      cases: [{
        id: 'broken',
        name: '引用未产出凭据',
        steps: [
          {
            id: 'call',
            action: 'api.request',
            method: 'GET',
            url: 'http://127.0.0.1:8090/me',
            headers: { Authorization: { variable: 'token', prefix: 'Bearer ' } },
            expect: [{ status: 200 }],
          },
          { id: 'after', action: 'api.delay', durationMs: 1 },
        ],
      }],
    }
    const apiRunStep = vi.fn(async (): Promise<StepOutcome> => ({ verdict: 'passed' }))
    const report = await runTestPlan({
      plan: brokenPlan,
      ui: { runStep: vi.fn() },
      api: { runStep: apiRunStep },
      signal: new AbortController().signal,
    })
    expect(report.status).toBe('error')
    expect(report.cases[0]?.steps[0]).toMatchObject({
      status: 'error',
      message: '运行时凭据变量「token」未产出',
    })
    // 失败后后续步骤记 skipped，驱动从未被调用。
    expect(report.cases[0]?.steps[1]?.status).toBe('skipped')
    expect(apiRunStep).not.toHaveBeenCalled()
  })
})

describe('runTestPlan v7（条件执行守卫）', () => {
  const guardedPlan = (guarded: string): CompiledTestPlan => ({
    specId: 'quoin',
    name: '条件清理',
    specVersion: 7,
    specHash: 'v7guard',
    target: {},
    environmentNames: [],
    cases: [{
      id: 'cleanup',
      name: '条件清理',
      steps: [
        {
          id: 'cleanup-delete',
          action: 'api.request',
          method: 'DELETE',
          url: 'http://127.0.0.1:8090/x/1',
          whenProduced: guarded,
          expect: [{ statusIn: [200, 404] }],
        } as never,
      ],
    }],
  })

  it('skips a guarded step when the variable was never produced and keeps the run passing', async () => {
    const api: ApiTestDriver = { runStep: vi.fn(async () => ({ verdict: 'passed' as const })) }
    const report = await runTestPlan({
      plan: guardedPlan('siteId'),
      ui: { runStep: vi.fn() },
      api,
      signal: new AbortController().signal,
    })
    expect(api.runStep).not.toHaveBeenCalled()
    expect(report.cases[0]?.steps[0]).toMatchObject({
      status: 'skipped',
      message: '条件未满足：变量「siteId」未产出',
    })
    expect(report.status).toBe('skipped')
  })

  it('executes the guarded step when an earlier extraction produced the variable', async () => {
    const plan: CompiledTestPlan = {
      ...guardedPlan('siteId'),
      cases: [{
        id: 'cleanup',
        name: '条件清理',
        steps: [
          {
            id: 'create',
            action: 'api.request',
            method: 'POST',
            url: 'http://127.0.0.1:8090/x',
            expect: [{ status: 200 }],
            extract: { siteId: { jsonPointer: '/id' } },
          },
          {
            id: 'cleanup-delete',
            action: 'api.request',
            method: 'DELETE',
            url: `http://127.0.0.1:8090/x/\${vars.siteId}`,
            whenProduced: 'siteId',
            expect: [{ statusIn: [200, 404] }],
          } as never,
        ],
      }],
    }
    const steps: unknown[] = []
    const api: ApiTestDriver = {
      runStep: async (step) => {
        steps.push(step)
        return steps.length === 1
          ? { verdict: 'passed', extractedVariables: { siteId: { value: 7, sensitive: false } } }
          : { verdict: 'passed' }
      },
    }
    const report = await runTestPlan({
      plan,
      ui: { runStep: vi.fn() },
      api,
      signal: new AbortController().signal,
    })
    expect(report.status).toBe('passed')
    expect(steps[1]).toMatchObject({ url: 'http://127.0.0.1:8090/x/7' })
  })

  it('fails closed instead of sending an undefined consumer variable', async () => {
    const plan: CompiledTestPlan = {
      specId: 'conditional',
      name: '条件产物',
      specVersion: 7,
      specHash: 'v7-undefined',
      target: {},
      environmentNames: [],
      cases: [{
        id: 'conditional',
        name: '条件产物',
        steps: [
          {
            id: 'optional-create',
            action: 'api.request',
            method: 'POST',
            url: 'http://127.0.0.1:8090/x',
            whenProduced: 'siteId',
            expect: [{ status: 200 }],
            extract: { siteId: { jsonPointer: '/id' } },
          },
          {
            id: 'consume',
            action: 'api.request',
            method: 'GET',
            url: `http://127.0.0.1:8090/x/\${vars.siteId}`,
            expect: [{ status: 200 }],
          },
        ],
      }],
    }
    const api: ApiTestDriver = { runStep: vi.fn(async () => ({ verdict: 'passed' as const })) }
    const report = await runTestPlan({
      plan,
      ui: { runStep: vi.fn() },
      api,
      signal: new AbortController().signal,
    })

    expect(api.runStep).not.toHaveBeenCalled()
    expect(report.cases[0]?.steps).toMatchObject([
      { stepId: 'optional-create', status: 'skipped' },
      { stepId: 'consume', status: 'error' },
    ])
    expect(report.status).toBe('error')
  })
})
