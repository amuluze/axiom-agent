import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { compileTestSpec } from '@/agent/testing/spec/compileTestPlan'
import { validateTestSpec } from '@/agent/testing/spec/parseTestSpec'
import { runTestPlan, type StepExecutionContext } from '@/agent/testing/runner/runTestPlan'
import type { UiStepSpec } from '@/agent/testing/spec/types'
import { createUiTestDriver } from './testAutomation'

const target = { runId: 'run-1', tabId: 'tab-1', origin: 'https://shop.test' }
const context: StepExecutionContext = {
  signal: new AbortController().signal,
  markWaitingApproval: () => {},
  markRunning: () => {},
}

const compiledPlan = async () => {
  const parsed = validateTestSpec({
    kind: 'axiom.test',
    version: 1,
    id: 'checkout',
    name: '结算',
    target: { webBaseUrl: `\${env.WEB_BASE_URL}` },
    cases: [
      {
        id: 'coupon',
        name: '优惠券',
        steps: [
          { id: 'assert-total', action: 'ui.assert', locator: { testId: 'payable' }, expect: { textContains: '¥240.00' } },
          { id: 'wait-banner', action: 'ui.wait', locator: { role: 'status' }, expect: { exists: true }, timeoutMs: 3000 },
          { id: 'shot', action: 'ui.screenshot', name: 'after-coupon' },
          { id: 'click-apply', action: 'ui.click', locator: { role: 'button', name: '应用' } },
        ],
      },
    ],
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  const compiled = await compileTestSpec(parsed.spec, { declaredEnvironmentNames: new Set(['WEB_BASE_URL']) })
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues))
  return compiled.plan
}

const clickStep: UiStepSpec = { id: 'click-apply', action: 'ui.click', locator: { role: 'button', name: '应用' } }

describe('createUiTestDriver read steps', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
  })

  it('forwards ui.assert to Rust in assert mode with the spec expectation unchanged', async () => {
    mocks.invoke.mockResolvedValue({ verdict: 'passed' })
    const outcome = await createUiTestDriver(target).runStep(
      { id: 'a', action: 'ui.assert', locator: { testId: 'payable' }, expect: { textContains: '¥240.00' } },
      context,
    )
    expect(outcome).toEqual({ verdict: 'passed' })
    expect(mocks.invoke).toHaveBeenCalledWith('run_ui_read_step', {
      request: {
        runId: 'run-1',
        tabId: 'tab-1',
        locator: { testId: 'payable' },
        expect: { textContains: '¥240.00' },
        mode: 'assert',
      },
    })
  })

  it('maps Rust error verdicts without rewriting the message', async () => {
    mocks.invoke.mockResolvedValue({ verdict: 'error', message: '定位歧义：2 个候选' })
    const outcome = await createUiTestDriver(target).runStep(
      { id: 'a', action: 'ui.assert', locator: { role: 'button' }, expect: { visible: true } },
      context,
    )
    expect(outcome).toEqual({ verdict: 'error', message: '定位歧义：2 个候选' })
  })

  it('forwards UI extraction and returns typed variables', async () => {
    mocks.invoke.mockResolvedValue({
      verdict: 'passed',
      extracted: { totalText: { value: '¥240.00', sensitive: false } },
    })
    const outcome = await createUiTestDriver(target).runStep(
      {
        id: 'a',
        action: 'ui.assert',
        locator: { testId: 'payable' },
        expect: { visible: true },
        extract: { totalText: { source: 'text' } },
      },
      context,
    )
    expect(outcome).toEqual({
      verdict: 'passed',
      extractedVariables: { totalText: { value: '¥240.00', sensitive: false } },
    })
    expect(mocks.invoke).toHaveBeenCalledWith('run_ui_read_step', {
      request: expect.objectContaining({ extract: { totalText: { source: 'text' } } }),
    })
  })

  it('returns the evidence reference for screenshots instead of image content', async () => {
    mocks.invoke.mockResolvedValue({
      artifact: { contentHash: 'abc', mediaType: 'image/png', sizeBytes: 10 },
      width: 1280,
      height: 800,
    })
    const outcome = await createUiTestDriver(target).runStep({ id: 's', action: 'ui.screenshot', name: 'x' }, context)
    expect(outcome).toEqual({ verdict: 'passed', evidenceContentHash: 'abc' })
  })

  it('revokes the target and settles a pending wait as canceled', async () => {
    let finish: ((value: unknown) => void) | undefined
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'run_ui_read_step') return new Promise((resolve) => { finish = resolve })
      if (command === 'revoke_test_target_grant') return Promise.resolve(true)
      return Promise.reject(new Error(`unexpected command: ${command}`))
    })
    const controller = new AbortController()
    const pending = createUiTestDriver(target).runStep(
      { id: 'wait', action: 'ui.wait', expect: { exists: true }, timeoutMs: 120000 },
      { ...context, signal: controller.signal },
    )
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('run_ui_read_step', expect.anything()))
    controller.abort()
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('revoke_test_target_grant', { runId: 'run-1' }))
    finish?.({ verdict: 'error', message: '没有有效的测试目标授权' })
    await expect(pending).resolves.toEqual({ verdict: 'canceled', message: '运行已停止' })
  })
})

describe('createUiTestDriver write steps (U1-5 approval gate)', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockResolvedValue({ leaseId: 'lease-1', ttlMs: 120000 })
  })

  it('refuses to execute a write step when no approval entry is configured', async () => {
    const outcome = await createUiTestDriver(target).runStep(clickStep, context)
    expect(outcome).toEqual({ verdict: 'error', message: '未配置审批入口，写步骤已拒绝执行' })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('reports rejection when the user denies the step, without issuing any lease', async () => {
    const approve = vi.fn().mockResolvedValue(false)
    const outcome = await createUiTestDriver(target, { approve }).runStep(clickStep, context)
    expect(outcome).toEqual({ verdict: 'rejected', message: '用户拒绝了本步骤' })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('reports cancellation instead of rejection when the run stops during approval', async () => {
    const controller = new AbortController()
    const approve = vi.fn().mockImplementation(async () => {
      controller.abort()
      return false
    })
    const outcome = await createUiTestDriver(target, { approve }).runStep(clickStep, {
      ...context,
      signal: controller.signal,
    })
    expect(outcome).toEqual({ verdict: 'canceled', message: '运行已停止' })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('binds the approval actor to the test run and step, and shows a card without typed content', async () => {
    const approve = vi.fn().mockResolvedValue(true)
    await createUiTestDriver(target, { approve }).runStep(
      { id: 'type-coupon', action: 'ui.input', locator: { role: 'textbox', name: '优惠券' }, value: 'SHOPAIM10' },
      context,
    )
    expect(approve).toHaveBeenCalledWith(
      {
        actor: { kind: 'testStep', testRunId: 'run-1', stepId: 'type-coupon' },
        card: {
          actionLabel: '在 role=textbox 名称「优惠券」 输入 9 个字符',
          origin: 'https://shop.test',
          target: 'role=textbox 名称「优惠券」',
        },
      },
      expect.any(AbortSignal),
    )
    expect(JSON.stringify(approve.mock.calls[0])).not.toContain('SHOPAIM10')
  })

  it('issues a Rust lease with the exact action, then executes through the Rust writer with that lease', async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === 'issue_test_step_lease' ? { leaseId: 'lease-1', ttlMs: 120000 } : { verdict: 'passed' })
    const approve = vi.fn().mockResolvedValue(true)
    const outcome = await createUiTestDriver(target, { approve }).runStep(clickStep, context)
    expect(outcome).toEqual({ verdict: 'passed' })
    expect(mocks.invoke).toHaveBeenCalledWith('issue_test_step_lease', {
      request: {
        runId: 'run-1',
        stepId: 'click-apply',
        tabId: 'tab-1',
        origin: 'https://shop.test',
        locator: { role: 'button', name: '应用' },
        action: clickStep,
      },
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('run_ui_write_step', {
      request: {
        runId: 'run-1',
        stepId: 'click-apply',
        tabId: 'tab-1',
        origin: 'https://shop.test',
        locator: { role: 'button', name: '应用' },
        action: clickStep,
        leaseId: 'lease-1',
      },
    })
  })

  it('maps a Rust writer error (for example a post-action origin escape) without hiding it', async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === 'issue_test_step_lease'
        ? { leaseId: 'lease-1', ttlMs: 120000 }
        : { verdict: 'error', message: '动作已执行，但页面随后越出授权' })
    const outcome = await createUiTestDriver(target, { approve: async () => true }).runStep(clickStep, context)
    expect(outcome).toEqual({ verdict: 'error', message: '动作已执行，但页面随后越出授权' })
  })

  it('租约签发期间停止时撤销目标且不执行写动作', async () => {
    let finishLease: ((value: unknown) => void) | undefined
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'issue_test_step_lease') return new Promise((resolve) => { finishLease = resolve })
      if (command === 'revoke_test_target_grant') return Promise.resolve(true)
      return Promise.reject(new Error(`unexpected command: ${command}`))
    })
    const controller = new AbortController()
    const pending = createUiTestDriver(target, { approve: async () => true }).runStep(clickStep, {
      ...context,
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('issue_test_step_lease', expect.anything()))
    controller.abort()
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('revoke_test_target_grant', { runId: 'run-1' }))
    finishLease?.({ leaseId: 'lease-late', ttlMs: 120000 })
    await expect(pending).resolves.toEqual({ verdict: 'canceled', message: '运行已停止' })
    expect(mocks.invoke).not.toHaveBeenCalledWith('run_ui_write_step', expect.anything())
  })

  it('moves waiting → running → settled through the Runner: an approved step runs, a denied one stops the run', async () => {
    mocks.invoke.mockImplementation(async (command: string) =>
      command === 'capture_ui_evidence'
        ? { artifact: { contentHash: 'shot-hash', mediaType: 'image/png', sizeBytes: 1 }, width: 1, height: 1 }
        : { verdict: 'passed' })
    const plan = await compiledPlan()
    const approve = vi.fn().mockResolvedValue(false)
    const report = await runTestPlan({
      plan,
      ui: createUiTestDriver(target, { approve }),
      api: { runStep: async () => ({ verdict: 'error', message: 'API 未接入' }) },
      signal: new AbortController().signal,
    })
    expect(report.cases[0]?.steps.map((step) => step.status)).toEqual(['passed', 'passed', 'passed', 'rejected'])
    expect(report.status).toBe('rejected')
  })

  it('drives a compiled plan: read steps pass, evidence is referenced, and the approved write executes', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'capture_ui_evidence') {
        return { artifact: { contentHash: 'shot-hash', mediaType: 'image/png', sizeBytes: 1 }, width: 1, height: 1 }
      }
      if (command === 'issue_test_step_lease') return { leaseId: 'lease-1', ttlMs: 120000 }
      return { verdict: 'passed' }
    })
    const report = await runTestPlan({
      plan: await compiledPlan(),
      ui: createUiTestDriver(target, { approve: async () => true }),
      api: { runStep: async () => ({ verdict: 'error', message: 'API 未接入' }) },
      signal: new AbortController().signal,
    })
    expect(report.cases[0]?.steps.map((step) => step.status)).toEqual(['passed', 'passed', 'passed', 'passed'])
    expect(report.cases[0]?.steps[2]?.evidenceContentHash).toBe('shot-hash')
    expect(report.status).toBe('passed')
  })
})
