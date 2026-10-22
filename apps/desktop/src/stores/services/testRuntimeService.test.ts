import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), calls: [] as Array<{ command: string; args: Record<string, unknown> }> }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { compileTestSpec } from '@/agent/testing/spec/compileTestPlan'
import { validateTestSpec } from '@/agent/testing/spec/parseTestSpec'
import { createTestStepApprover } from '@/agent/testing/approval/testStepApprover'
import { startUiTestRun } from './testRuntimeService'

const compiled = async () => {
  const parsed = validateTestSpec({
    kind: 'axiom.test',
    version: 1,
    id: 'checkout',
    name: '结算',
    target: { webBaseUrl: `\${env.WEB_BASE_URL}`, viewport: { width: 1280, height: 800 } },
    cases: [
      {
        id: 'coupon',
        name: '优惠券',
        steps: [
          { id: 'assert-total', action: 'ui.assert', locator: { testId: 'payable' }, expect: { textContains: '¥240.00' } },
          { id: 'click-apply', action: 'ui.click', locator: { role: 'button', name: '应用' } },
        ],
      },
    ],
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  const result = await compileTestSpec(parsed.spec, { declaredEnvironmentNames: new Set(['WEB_BASE_URL']) })
  if (!result.ok) throw new Error(JSON.stringify(result.issues))
  return result.plan
}

const recordedStatuses = (command: string) =>
  mocks.calls.filter((call) => call.command === command).map((call) => call.args)

describe('startUiTestRun', () => {
  beforeEach(() => {
    mocks.calls.length = 0
    mocks.invoke.mockReset()
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      mocks.calls.push({ command, args })
      if (command === 'write_artifact') return { contentHash: 'plan-hash' }
      if (command === 'issue_test_target_grant') {
        return { runId: args.runId, tabId: 'tab-1', origin: 'https://shop.test', workspaceGeneration: 1 }
      }
      if (command === 'revoke_test_target_grant') return true
      if (command === 'run_ui_read_step') return { verdict: 'passed' }
      if (command === 'issue_test_step_lease') return { leaseId: 'lease-1', ttlMs: 120000 }
      if (command === 'run_ui_write_step') return { verdict: 'passed' }
      return undefined
    })
  })

  it('persists the run, every transition in order, and the final status when the plan passes', async () => {
    const approver = createTestStepApprover()
    const plan = await compiled()
    const onStepStatusChange = vi.fn()
    const pending = startUiTestRun({
      runId: 'run-1',
      specPath: 'tests/checkout.testspec.json',
      plan,
      target: { runId: 'run-1', tabId: 'tab-1', origin: 'https://shop.test' },
      approver,
      signal: new AbortController().signal,
      now: () => 1000,
      environmentId: 'env-local',
      sourceSessionId: 'session-1',
      onStepStatusChange,
    })
    await vi.waitFor(() => expect(approver.list()).toHaveLength(1))
    approver.respond('run-1:click-apply', true)
    const report = await pending
    expect(report.status).toBe('passed')

    const commands = mocks.calls.map((call) => call.command).filter((command) => command.includes('record'))
    expect(commands[0]).toBe('create_test_run_record')
    expect(commands.at(-1)).toBe('transition_test_run_record')
    expect(mocks.calls.find((call) => call.command === 'create_test_run_record')?.args).toMatchObject({
      run: { planContentHash: 'plan-hash', environmentId: 'env-local', sourceSessionId: 'session-1' },
    })
    expect(mocks.calls.find((call) => call.command === 'issue_test_target_grant')?.args).toMatchObject({
      request: { viewport: { width: 1280, height: 800 } },
    })
    expect(recordedStatuses('transition_test_run_record').map((args) => args.status)).toEqual(['running', 'passed'])
    expect(recordedStatuses('transition_test_case_record').map((args) => args.status)).toEqual(['running', 'passed'])
    expect(recordedStatuses('transition_test_step_record').map((args) => args.status)).toEqual([
      'running', 'passed', 'running', 'waiting_approval', 'running', 'passed',
    ])
    expect(mocks.calls.filter((call) => call.command === 'revoke_test_target_grant')).toHaveLength(1)
    expect(recordedStatuses('transition_test_step_record').find((args) => args.status === 'passed')).toMatchObject({
      detailsJson: expect.stringContaining('textContains'),
    })
    expect(onStepStatusChange).toHaveBeenCalledWith(expect.objectContaining({
      caseId: 'coupon',
      stepId: 'click-apply',
      status: 'waiting_approval',
    }))
  })

  it('stops at a denied write step: the run is rejected and the step is recorded as rejected', async () => {
    const approver = createTestStepApprover()
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      mocks.calls.push({ command, args })
      if (command === 'write_artifact') return { contentHash: 'plan-hash' }
      if (command === 'issue_test_target_grant') {
        return { runId: args.runId, tabId: 'tab-1', origin: 'https://shop.test', workspaceGeneration: 1 }
      }
      if (command === 'revoke_test_target_grant') return true
      if (command === 'run_ui_read_step') return { verdict: 'passed' }
      return undefined
    })
    const pending = startUiTestRun({
      runId: 'run-2',
      specPath: 'tests/checkout.testspec.json',
      plan: await compiled(),
      target: { runId: 'run-2', tabId: 'tab-1', origin: 'https://shop.test' },
      approver,
      signal: new AbortController().signal,
      now: () => 2000,
    })
    await vi.waitFor(() => expect(approver.list()).toHaveLength(1))
    approver.respond('run-2:click-apply', false)
    const report = await pending

    expect(report.status).toBe('rejected')
    expect(recordedStatuses('transition_test_run_record').map((args) => args.status)).toEqual(['running', 'rejected'])
    expect(recordedStatuses('transition_test_case_record').at(-1)).toMatchObject({ failureKind: 'approval' })
    // 归因随首个未通过步骤落库（拒绝 → approval），修复方据此决定先修环境还是改断言。
    expect(recordedStatuses('transition_test_case_record').at(-1)).toMatchObject({ failureOrigin: 'approval' })
    const stepStatuses = recordedStatuses('transition_test_step_record').map((args) => args.status)
    expect(stepStatuses.at(-1)).toBe('rejected')
    expect(mocks.calls.some((call) => call.command === 'issue_test_step_lease')).toBe(false)
    expect(mocks.calls.filter((call) => call.command === 'revoke_test_target_grant')).toHaveLength(1)
  })

  it('revokes the target grant when plan artifact persistence fails', async () => {
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      mocks.calls.push({ command, args })
      if (command === 'issue_test_target_grant') {
        return { runId: args.runId, tabId: 'tab-1', origin: 'https://shop.test', workspaceGeneration: 1 }
      }
      if (command === 'write_artifact') throw new Error('artifact unavailable')
      if (command === 'revoke_test_target_grant') return true
      return undefined
    })

    await expect(startUiTestRun({
      runId: 'run-3',
      specPath: 'tests/checkout.testspec.json',
      plan: await compiled(),
      target: { runId: 'run-3', tabId: 'tab-1', origin: 'https://shop.test' },
      approver: createTestStepApprover(),
      signal: new AbortController().signal,
    })).rejects.toThrow('artifact unavailable')

    expect(mocks.calls.filter((call) => call.command === 'revoke_test_target_grant')).toHaveLength(1)
    expect(mocks.calls.some((call) => call.command === 'create_test_run_record')).toBe(false)
  })

  it('marks a started run as error when step persistence fails', async () => {
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      mocks.calls.push({ command, args })
      if (command === 'write_artifact') return { contentHash: 'plan-hash' }
      if (command === 'issue_test_target_grant') {
        return { runId: args.runId, tabId: 'tab-1', origin: 'https://shop.test', workspaceGeneration: 1 }
      }
      if (command === 'revoke_test_target_grant') return true
      if (command === 'run_ui_read_step') return { verdict: 'passed' }
      if (command === 'issue_test_step_lease') return { leaseId: 'lease-1', ttlMs: 120000 }
      if (command === 'run_ui_write_step') return { verdict: 'passed' }
      if (command === 'transition_test_step_record' && args.status === 'passed') {
        throw new Error('db down')
      }
      return undefined
    })
    const approver = createTestStepApprover()
    const pending = startUiTestRun({
      runId: 'run-persist-fail',
      specPath: 'tests/checkout.testspec.json',
      plan: await compiled(),
      target: { runId: 'run-persist-fail', tabId: 'tab-1', origin: 'https://shop.test' },
      approver,
      signal: new AbortController().signal,
      now: () => 3000,
    })
    await vi.waitFor(() => expect(approver.list()).toHaveLength(1))
    approver.respond('run-persist-fail:click-apply', true)

    await expect(pending).rejects.toThrow('db down')
    expect(recordedStatuses('transition_test_run_record').map((args) => args.status)).toEqual(['running', 'error'])
    expect(mocks.calls.filter((call) => call.command === 'revoke_test_target_grant')).toHaveLength(1)
  })

  it('runs an API-only plan without creating a browser target grant', async () => {
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      mocks.calls.push({ command, args })
      if (command === 'write_artifact') return { contentHash: 'plan-hash' }
      if (command === 'issue_api_test_step_lease') return { leaseId: 'api-lease-1', ttlMs: 120000 }
      if (command === 'run_api_test_step') {
        return {
          verdict: 'passed',
          runnerVerdict: 'passed',
          transport: 'received',
          message: 'HTTP 200 · 12 ms',
          evidenceContentHash: 'a'.repeat(64),
          statusCode: 200,
          elapsedMs: 12,
        }
      }
      return undefined
    })
    const approver = createTestStepApprover()
    const pending = startUiTestRun({
      runId: 'run-api-1',
      specPath: 'tests/orders.testspec.json',
      plan: {
        specId: 'orders',
        name: '订单 API',
        specVersion: 1,
        specHash: 'api-hash',
        target: { apiBaseUrl: 'https://api.example.test' },
        environmentNames: [],
        cases: [{
          id: 'orders',
          name: '读取订单',
          steps: [{
            id: 'load-orders',
            action: 'api.request',
            method: 'GET',
            url: 'https://api.example.test/orders',
            expect: [{ status: 200 }],
          }],
        }],
      },
      approver,
      signal: new AbortController().signal,
      environmentId: 'staging',
    })
    await vi.waitFor(() => expect(approver.list()).toHaveLength(1))
    approver.respond('run-api-1:load-orders', true)
    await expect(pending).resolves.toMatchObject({ status: 'passed' })
    expect(mocks.calls.some((call) => call.command === 'issue_test_target_grant')).toBe(false)
    expect(mocks.calls.some((call) => call.command === 'revoke_test_target_grant')).toBe(false)
    expect(mocks.calls).toContainEqual(expect.objectContaining({ command: 'run_api_test_step' }))
    expect(recordedStatuses('transition_test_step_record').at(-1)).toMatchObject({
      status: 'passed',
      evidenceContentHash: 'a'.repeat(64),
    })
  })
})
