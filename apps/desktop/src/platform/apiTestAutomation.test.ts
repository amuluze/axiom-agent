import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStepApprover } from '@/agent/testing/approval/testStepApprover'
import type { StepExecutionContext } from '@/agent/testing/runner/runTestPlan'
import type { ApiStepSpec } from '@/agent/testing/spec/types'

const mockedInvoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockedInvoke }))

import { createApiTestDriver, runApiTestStepWithLease } from './apiTestAutomation'

const step: ApiStepSpec = {
  id: 'load-orders',
  action: 'api.request',
  method: 'GET',
  url: 'https://api.example.test/v1/orders?view=full',
  headers: { Authorization: { secretId: 'apitest.orders-token' } },
  expect: [{ status: 200 }],
}

const context = (controller = new AbortController()): StepExecutionContext => ({
  signal: controller.signal,
  markWaitingApproval: vi.fn(),
  markRunning: vi.fn(),
})

describe('createApiTestDriver', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('approves, leases and executes a request without exposing secret values', async () => {
    mockedInvoke.mockImplementation(async (command: string) => {
      if (command === 'issue_api_test_step_lease') return { leaseId: 'lease-1', ttlMs: 120000 }
      if (command === 'run_api_test_step') {
        return {
          verdict: 'passed',
          runnerVerdict: 'passed',
          transport: 'received',
          message: 'HTTP 200 · 18 ms',
          evidenceContentHash: 'a'.repeat(64),
          statusCode: 200,
          elapsedMs: 18,
          extracted: { orderId: { value: 42, sensitive: false } },
        }
      }
      return false
    })
    const approver = createTestStepApprover()
    const execution = context()
    const pending = createApiTestDriver({ runId: 'run-1', environmentId: 'staging' }, approver)
      .runStep(step, execution)
    await vi.waitFor(() => expect(approver.list()).toHaveLength(1))
    expect(approver.list()[0]?.card).toEqual({
      actionLabel: 'GET /v1/orders',
      origin: 'https://api.example.test',
      target: 'api.example.test',
    })
    approver.respond('run-1:load-orders', true)
    await expect(pending).resolves.toMatchObject({
      verdict: 'passed',
      evidenceContentHash: 'a'.repeat(64),
      extractedVariables: { orderId: { value: 42, sensitive: false } },
    })
    expect(mockedInvoke).toHaveBeenNthCalledWith(1, 'issue_api_test_step_lease', {
      request: expect.objectContaining({
        runId: 'run-1',
        environmentId: 'staging',
        action: step,
      }),
    })
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, 'run_api_test_step', {
      request: expect.objectContaining({ leaseId: 'lease-1', action: step }),
    })
    expect(execution.markWaitingApproval).toHaveBeenCalledOnce()
    expect(execution.markRunning).toHaveBeenCalledOnce()
  })

  it('does not issue a lease when the user rejects the step', async () => {
    const approver = createTestStepApprover()
    const pending = createApiTestDriver({ runId: 'run-2' }, approver).runStep(step, context())
    await vi.waitFor(() => expect(approver.list()).toHaveLength(1))
    approver.respond('run-2:load-orders', false)
    await expect(pending).resolves.toEqual({ verdict: 'rejected', message: '用户拒绝了本步骤' })
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('maps a canceled native confirmation to rejected without running the request', async () => {
    mockedInvoke.mockResolvedValue(null)
    const approver = createTestStepApprover()
    const pending = createApiTestDriver({ runId: 'run-native' }, approver).runStep(step, context())
    await vi.waitFor(() => expect(approver.list()).toHaveLength(1))
    approver.respond('run-native:load-orders', true)

    await expect(pending).resolves.toEqual({
      verdict: 'rejected',
      message: '用户在原生确认中取消了本步骤',
    })
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
    expect(mockedInvoke).toHaveBeenCalledWith('issue_api_test_step_lease', expect.anything())
  })

  it('marks a transport-layer failure as an environment problem', async () => {
    mockedInvoke.mockImplementation((command: string) => {
      if (command === 'issue_api_test_step_lease') return Promise.resolve({ leaseId: 'lease-1', ttlMs: 120000 })
      return Promise.resolve({
        verdict: 'not_evaluated',
        runnerVerdict: 'error',
        transport: 'timeout',
        message: '请求超时',
        evidenceContentHash: null,
        statusCode: null,
        elapsedMs: 30000,
        extracted: {},
      })
    })
    const approver = createTestStepApprover()
    const pending = createApiTestDriver({ runId: 'run-8' }, approver).runStep(step, context(new AbortController()))
    await vi.waitFor(() => expect(approver.list()).toHaveLength(1))
    approver.respond('run-8:load-orders', true)

    // 超时/连接失败是环境问题，不是断言不成立——归因来自 Rust 的 transport 事实。
    await expect(pending).resolves.toMatchObject({ verdict: 'error', origin: 'environment' })
  })

  it('forwards abort to the native request', async () => {
    let finish: ((value: unknown) => void) | undefined
    mockedInvoke.mockImplementation((command: string) => {
      if (command === 'issue_api_test_step_lease') return Promise.resolve({ leaseId: 'lease-1', ttlMs: 120000 })
      if (command === 'cancel_api_test_run') return Promise.resolve(true)
      return new Promise((resolve) => { finish = resolve })
    })
    const controller = new AbortController()
    const approver = createTestStepApprover()
    const pending = createApiTestDriver({ runId: 'run-3' }, approver).runStep(step, context(controller))
    await vi.waitFor(() => expect(approver.list()).toHaveLength(1))
    approver.respond('run-3:load-orders', true)
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith('run_api_test_step', expect.anything()))
    controller.abort()
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith('cancel_api_test_run', { runId: 'run-3' }))
    finish?.({
      verdict: 'canceled',
      runnerVerdict: 'canceled',
      transport: 'canceled',
      message: '运行已停止',
      evidenceContentHash: 'b'.repeat(64),
      statusCode: null,
      elapsedMs: 10,
      extracted: {},
    })
    await expect(pending).resolves.toMatchObject({ verdict: 'canceled' })
  })
})

describe('runApiTestStepWithLease', () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
  })

  it('签发一次性租约并按租约运行，abort 时取消宿主请求', async () => {
    let finish: ((value: unknown) => void) | undefined
    mockedInvoke.mockImplementation((command: string) => {
      if (command === 'issue_api_test_step_lease') return Promise.resolve({ leaseId: 'lease-9', ttlMs: 120000 })
      if (command === 'cancel_api_test_run') return Promise.resolve(true)
      return new Promise((resolve) => { finish = resolve })
    })
    const controller = new AbortController()
    const pending = runApiTestStepWithLease({ runId: 'run-9' }, step, controller.signal)
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith('run_api_test_step', expect.anything()))
    expect(mockedInvoke).toHaveBeenNthCalledWith(1, 'issue_api_test_step_lease', {
      request: expect.objectContaining({ runId: 'run-9', stepId: 'load-orders', action: step }),
    })
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, 'run_api_test_step', {
      request: expect.objectContaining({ leaseId: 'lease-9' }),
    })
    controller.abort()
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith('cancel_api_test_run', { runId: 'run-9' }))
    finish?.({
      verdict: 'not_evaluated',
      runnerVerdict: 'canceled',
      transport: 'canceled',
      message: '运行已停止',
      evidenceContentHash: 'c'.repeat(64),
      statusCode: null,
      elapsedMs: 5,
      extracted: {},
    })
    await expect(pending).resolves.toMatchObject({ transport: 'canceled' })
  })

  it('已 abort 的信号不签发租约', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runApiTestStepWithLease({ runId: 'run-10' }, step, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('租约签发期间 abort 时取消运行且不发起请求', async () => {
    let finishLease: ((value: unknown) => void) | undefined
    mockedInvoke.mockImplementation((command: string) => {
      if (command === 'issue_api_test_step_lease') {
        return new Promise((resolve) => { finishLease = resolve })
      }
      if (command === 'cancel_api_test_run') return Promise.resolve(false)
      return Promise.reject(new Error(`unexpected command: ${command}`))
    })
    const controller = new AbortController()
    const pending = runApiTestStepWithLease({ runId: 'run-11' }, step, controller.signal)
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith('issue_api_test_step_lease', expect.anything()))
    controller.abort()
    await vi.waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith('cancel_api_test_run', { runId: 'run-11' }))
    finishLease?.({ leaseId: 'lease-late', ttlMs: 120000 })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(mockedInvoke).not.toHaveBeenCalledWith('run_api_test_step', expect.anything())
  })
})
