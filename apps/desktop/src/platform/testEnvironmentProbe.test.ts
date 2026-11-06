import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TestStepApprover } from '@/agent/testing/approval/testStepApprover'
import type { ApiTestStepResult } from './apiTestAutomation'

const mocks = vi.hoisted(() => ({ runApiTestStepWithLease: vi.fn() }))
vi.mock('./apiTestAutomation', () => ({ runApiTestStepWithLease: mocks.runApiTestStepWithLease }))

import { probeEnvironmentReadiness } from './testEnvironmentProbe'
import type { TestEnvironmentRecord } from './testEnvironments'

const environment = (overrides: Partial<TestEnvironmentRecord> = {}): TestEnvironmentRecord => ({
  id: 'local-shop',
  name: '本地开发环境',
  kind: 'local',
  recipeJson: JSON.stringify({
    start: ['docker compose up -d'],
    stop: [],
    readiness: ['curl -fsS http://127.0.0.1:9/api/health'],
    timeoutMs: 90_000,
    probe: { method: 'GET', path: '/api/health', expectStatus: [200, 204] },
  }),
  webBaseUrl: 'http://127.0.0.1:5173',
  apiBaseUrl: 'http://127.0.0.1:9',
  viewportWidth: null,
  viewportHeight: null,
  allowPrivateNetwork: true,
  headersJson: '{}',
  secretIdsJson: '[]',
  extraVarsJson: '{}',
  secretOriginsJson: '[]',
  tlsTrust: 'system',
  approvalMode: 'per_step',
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
})

const approver = (approved: boolean): TestStepApprover => ({
  approve: async () => approved,
  respond: () => false,
  list: () => [],
  subscribe: () => () => undefined,
})

/** 记录是否弹过审批卡的 approver。 */
const trackingApprover = (approved: boolean): TestStepApprover & { calls: number } => {
  const calls = { value: 0 }
  return {
    approve: async () => {
      calls.value += 1
      return approved
    },
    respond: () => false,
    list: () => [],
    subscribe: () => () => undefined,
    get calls() {
      return calls.value
    },
  }
}

const result = (overrides: Partial<ApiTestStepResult> = {}): ApiTestStepResult => ({
  verdict: 'passed',
  runnerVerdict: 'passed',
  transport: 'received',
  message: '',
  evidenceContentHash: 'hash-1',
  statusCode: 200,
  elapsedMs: 21,
  extracted: {},
  ...overrides,
})

const probe = (options: { approved?: boolean; record?: TestEnvironmentRecord } = {}) =>
  probeEnvironmentReadiness({
    environment: options.record ?? environment(),
    runId: 'run-1',
    approver: approver(options.approved ?? true),
    signal: new AbortController().signal,
  })

describe('probeEnvironmentReadiness', () => {
  beforeEach(() => mocks.runApiTestStepWithLease.mockReset())

  it('runs the declared probe through the shared lease path and reports ready', async () => {
    mocks.runApiTestStepWithLease.mockResolvedValue(result())

    const { readiness } = await probe()

    expect(readiness).toMatchObject({ ready: true, verdict: 'ready', status: 200 })
    const [target, step] = mocks.runApiTestStepWithLease.mock.calls[0] ?? []
    expect(target).toEqual({ runId: 'run-1', environmentId: 'local-shop' })
    expect(step).toMatchObject({
      id: 'env-probe:local-shop',
      action: 'api.request',
      method: 'GET',
      url: 'http://127.0.0.1:9/api/health',
      timeoutMs: 90_000,
    })
    // 探针不带 Runner 的断言：判定按 expectStatus 做，不混用两种语义。
    expect(step).not.toHaveProperty('expect')
  })

  it('does not spend a lease when the user refuses the probe', async () => {
    const { readiness } = await probe({ approved: false })
    expect(readiness).toMatchObject({ ready: false, verdict: 'rejected' })
    expect(mocks.runApiTestStepWithLease).not.toHaveBeenCalled()
  })

  it('skips the approval card for a trusted environment probing its own address', async () => {
    mocks.runApiTestStepWithLease.mockResolvedValue(result())
    const trustedApprover = trackingApprover(true)
    const { readiness } = await probeEnvironmentReadiness({
      environment: environment({ approvalMode: 'trusted' }),
      runId: 'run-trusted',
      approver: trustedApprover,
      signal: new AbortController().signal,
    })
    expect(readiness).toMatchObject({ ready: true, verdict: 'ready' })
    expect(trustedApprover.calls).toBe(0)
    expect(mocks.runApiTestStepWithLease).toHaveBeenCalledTimes(1)
  })

  it('still asks for approval when a trusted environment probes outside its scope', async () => {
    mocks.runApiTestStepWithLease.mockResolvedValue(result())
    const trustedApprover = trackingApprover(true)
    await probeEnvironmentReadiness({
      // 探针指向自定义服务变量（另一个 origin），不在环境声明的 origin 集合内。
      environment: environment({
        approvalMode: 'trusted',
        recipeJson: JSON.stringify({
          start: [],
          stop: [],
          readiness: [],
          timeoutMs: 90_000,
          probes: [{ var: 'DETECTOR_MGMT_URL', path: '/ready', expectStatus: [200] }],
        }),
        extraVarsJson: JSON.stringify({ DETECTOR_MGMT_URL: 'http://10.9.35.6:18081' }),
      }),
      vars: { DETECTOR_MGMT_URL: 'http://10.9.35.6:18081' },
      runId: 'run-outside',
      approver: trustedApprover,
      signal: new AbortController().signal,
    })
    expect(trustedApprover.calls).toBe(1)
  })

  it('reports a stop as canceled instead of rejected', async () => {
    const controller = new AbortController()
    controller.abort()
    const { readiness } = await probeEnvironmentReadiness({
      environment: environment(),
      runId: 'run-canceled',
      approver: approver(false),
      signal: controller.signal,
    })
    expect(readiness).toMatchObject({ ready: false, verdict: 'canceled' })
    expect(readiness.reason).toContain('已取消')
    expect(mocks.runApiTestStepWithLease).not.toHaveBeenCalled()
  })

  it('surfaces policy blocks as their own verdict instead of blaming the environment', async () => {
    mocks.runApiTestStepWithLease.mockResolvedValue(result({
      transport: 'blocked',
      statusCode: null,
      message: '未授权访问回环或私网地址',
    }))

    const { readiness } = await probe()
    expect(readiness).toMatchObject({ ready: false, verdict: 'blocked' })
    expect(readiness.reason).toContain('未授权访问回环或私网地址')
    expect(readiness.reason).toContain('不代表环境不存在')
  })

  it('reports an unusable environment without asking for approval', async () => {
    const { readiness } = await probe({ record: environment({ apiBaseUrl: null, recipeJson: null }) })
    expect(readiness).toMatchObject({ ready: false, verdict: 'unusable' })
    expect(readiness.reason).toContain('没有 API Base URL')
    expect(mocks.runApiTestStepWithLease).not.toHaveBeenCalled()
  })

  it('classifies a reachable but not-ready service', async () => {
    mocks.runApiTestStepWithLease.mockResolvedValue(result({ statusCode: 503, runnerVerdict: 'failed' }))
    const { readiness } = await probe()
    expect(readiness).toMatchObject({ ready: false, verdict: 'not_ready', status: 503 })
    expect(readiness.reason).toContain('期望 200/204')
  })
})
