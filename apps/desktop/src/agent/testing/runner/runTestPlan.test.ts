import { describe, expect, it, vi } from 'vitest'
import type { CompiledTestPlan } from '../spec/compileTestPlan'
import type { ApiStepSpec, UiStepSpec } from '../spec/types'
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
  apiRun: (step: ApiStepSpec, context: StepExecutionContext) => Promise<StepOutcome> = passing,
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
    const api = vi.fn(async (_step: ApiStepSpec, _context: StepExecutionContext): Promise<StepOutcome> => ({
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
  run: (step: ApiStepSpec, context: StepExecutionContext) => Promise<StepOutcome>,
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
