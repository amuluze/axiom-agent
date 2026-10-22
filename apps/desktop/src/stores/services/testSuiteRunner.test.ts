import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompiledTestPlan } from '@/agent/testing/spec/compileTestPlan'

const mocks = vi.hoisted(() => ({
  prepareUiTestRun: vi.fn(),
  browserTargetOrigin: vi.fn((url: string) => new URL(url).origin),
  ensureEnvironmentReady: vi.fn(),
  startUiTestRun: vi.fn(),
}))

vi.mock('./testRunPreparation', () => ({
  prepareUiTestRun: mocks.prepareUiTestRun,
  browserTargetOrigin: mocks.browserTargetOrigin,
}))
vi.mock('./testEnvironmentReadiness', () => ({ ensureEnvironmentReady: mocks.ensureEnvironmentReady }))
vi.mock('./testRuntimeService', () => ({ startUiTestRun: mocks.startUiTestRun }))

import { runTestSuite, type TestSuiteRunInput } from './testSuiteRunner'
import type { TestEnvironmentRecord } from '@/platform/testEnvironments'

const plan = (options: { ui?: boolean; webBaseUrl?: string } = {}): CompiledTestPlan => ({
  specId: 'spec',
  name: 'Spec',
  specVersion: 2,
  specHash: 'hash',
  target: options.webBaseUrl === undefined ? {} : { webBaseUrl: options.webBaseUrl },
  environmentNames: [],
  cases: [{
    id: 'case-1',
    name: 'Case',
    steps: [options.ui === true
      ? { id: 'click', action: 'ui.click', locator: { testId: 'go' } }
      : { id: 'ping', action: 'api.request', method: 'GET', url: 'https://api.test/ping' }],
  }],
})

const environment: TestEnvironmentRecord = {
  id: 'env-1',
  name: '本地',
  kind: 'remote',
  recipeJson: null,
  webBaseUrl: 'https://shop.test',
  apiBaseUrl: 'https://api.test',
  viewportWidth: null,
  viewportHeight: null,
  allowPrivateNetwork: false,
  headersJson: '{}',
  secretIdsJson: '[]',
  createdAt: 1,
  updatedAt: 2,
}

const approver = () => ({
  approve: async () => true,
  respond: () => false,
  list: () => [],
  subscribe: () => () => undefined,
})

const run = (overrides: Partial<TestSuiteRunInput> = {}) => runTestSuite({
  workspacePath: '/repo',
  specs: [
    { path: 'tests/a.testspec.json', uiStepCount: 0 },
    { path: 'tests/b.testspec.json', uiStepCount: 0 },
    { path: 'tests/c.testspec.json', uiStepCount: 0 },
  ],
  approver: approver(),
  signal: new AbortController().signal,
  ...overrides,
})

describe('runTestSuite', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prepareUiTestRun.mockResolvedValue(plan())
    mocks.startUiTestRun.mockImplementation(async ({ runId }: { runId: string }) => ({ status: 'passed', id: runId, cases: [] }))
    mocks.ensureEnvironmentReady.mockResolvedValue({
      readiness: { ready: true, verdict: 'ready', reason: '环境就绪', status: 200, elapsedMs: 3 },
      facts: { environmentId: 'env-1', name: '本地', kind: 'remote', probe: { method: 'GET', url: 'https://api.test/' }, verdict: 'ready', status: 200, elapsedMs: 3, preparedBy: 'probe' },
    })
  })

  it('runs every spec serially under one batch id', async () => {
    const started: string[] = []
    const result = await run({ onRunStarted: ({ index, total, path }) => started.push(`${index}/${total}:${path}`) })

    expect(result.blockedReason).toBeNull()
    expect(result.entries.map((entry) => [entry.path, entry.status])).toEqual([
      ['tests/a.testspec.json', 'passed'],
      ['tests/b.testspec.json', 'passed'],
      ['tests/c.testspec.json', 'passed'],
    ])
    expect(started).toEqual(['1/3:tests/a.testspec.json', '2/3:tests/b.testspec.json', '3/3:tests/c.testspec.json'])
    const batchIds = new Set(mocks.startUiTestRun.mock.calls.map(([input]) => input.batchId))
    expect(batchIds.size).toBe(1)
    expect([...batchIds][0]).toMatch(/^test-batch-/)
    expect(result.batchId).toBe([...batchIds][0])
    // 逐文件各一个 runId，且顺序与 specs 一致。
    const runIds = mocks.startUiTestRun.mock.calls.map(([input]) => input.runId)
    expect(new Set(runIds).size).toBe(3)
    expect(runIds).toEqual(result.entries.map((entry) => entry.runId))
  })

  it('keeps going when one spec fails an assertion or fails to prepare', async () => {
    mocks.startUiTestRun
      .mockResolvedValueOnce({ status: 'passed', cases: [] })
      .mockResolvedValueOnce({ status: 'failed', cases: [{ caseId: 'case-1', steps: [{ stepId: 'ping', status: 'failed', origin: 'assertion' }] }] })
      .mockResolvedValueOnce({ status: 'passed', cases: [] })
    const result = await run()

    expect(result.entries.map((entry) => entry.status)).toEqual(['passed', 'failed', 'passed'])
    expect(mocks.startUiTestRun).toHaveBeenCalledTimes(3)

    vi.clearAllMocks()
    mocks.prepareUiTestRun
      .mockResolvedValueOnce(plan())
      .mockRejectedValueOnce(new Error('测试文件超过运行读取上限'))
      .mockResolvedValueOnce(plan())
    mocks.startUiTestRun.mockResolvedValue({ status: 'passed', cases: [] })
    const withPrepareFailure = await run()
    expect(withPrepareFailure.entries.map((entry) => entry.status)).toEqual(['passed', 'error', 'passed'])
    expect(withPrepareFailure.entries[1]).toMatchObject({
      runId: null,
      reason: '测试文件超过运行读取上限',
    })
    expect(mocks.startUiTestRun).toHaveBeenCalledTimes(2)
  })

  it('gates the environment once for the whole batch and shares the facts', async () => {
    const result = await run({ environment })

    expect(mocks.ensureEnvironmentReady).toHaveBeenCalledTimes(1)
    expect(mocks.ensureEnvironmentReady.mock.calls[0]?.[0]).toMatchObject({ environment, runId: result.batchId })
    for (const [input] of mocks.startUiTestRun.mock.calls) {
      expect(input.environmentId).toBe('env-1')
      expect(input.environmentFacts).toMatchObject({ environmentId: 'env-1', preparedBy: 'probe' })
    }
  })

  it('skips the API probe for a UI-only suite when the environment has no API base', async () => {
    mocks.prepareUiTestRun.mockResolvedValue(plan({ ui: true, webBaseUrl: 'https://shop.test' }))
    const result = await run({
      specs: [{ path: 'tests/ui.testspec.json', uiStepCount: 1, apiStepCount: 0 }],
      environment: { ...environment, apiBaseUrl: null },
      tab: { tabId: 'tab-1', url: 'https://shop.test/' },
    })

    expect(mocks.ensureEnvironmentReady).not.toHaveBeenCalled()
    expect(result.entries[0]?.status).toBe('passed')
    expect(mocks.startUiTestRun.mock.calls[0]?.[0]).toMatchObject({ environmentId: 'env-1' })
    expect(mocks.startUiTestRun.mock.calls[0]?.[0].environmentFacts).toBeUndefined()
  })

  it('creates no run at all when the environment is not ready', async () => {
    mocks.ensureEnvironmentReady.mockResolvedValue({
      readiness: { ready: false, verdict: 'blocked', reason: '宿主拒绝了这次探测请求：未授权访问回环或私网地址。', status: null, elapsedMs: 0 },
      facts: { environmentId: 'env-1', name: '本地', kind: 'remote', probe: { method: 'GET', url: 'https://api.test/' }, verdict: 'blocked', status: null, elapsedMs: 0, preparedBy: 'probe' },
    })

    const result = await run({ environment })
    expect(result.blockedReason).toContain('未授权访问回环或私网地址')
    expect(result.entries).toEqual([])
    expect(mocks.prepareUiTestRun).not.toHaveBeenCalled()
    expect(mocks.startUiTestRun).not.toHaveBeenCalled()
  })

  it('marks the remaining specs canceled when the run is stopped', async () => {
    const controller = new AbortController()
    mocks.startUiTestRun
      .mockResolvedValueOnce({ status: 'passed', cases: [] })
      .mockImplementationOnce(async () => {
        controller.abort()
        return { status: 'canceled', cases: [] }
      })
      .mockResolvedValue({ status: 'passed', cases: [] })

    const result = await run({ signal: controller.signal })
    expect(result.entries.map((entry) => entry.status)).toEqual(['passed', 'canceled', 'canceled'])
    expect(result.entries[2]?.reason).toContain('已停止')
    expect(mocks.startUiTestRun).toHaveBeenCalledTimes(2)
  })

  it('requires a matching browser tab for specs with UI steps', async () => {
    mocks.prepareUiTestRun.mockResolvedValue(plan({ ui: true, webBaseUrl: 'https://shop.test' }))

    const withoutTab = await run({ specs: [{ path: 'tests/ui.testspec.json', uiStepCount: 1 }] })
    expect(withoutTab.entries[0]).toMatchObject({ status: 'error', runId: null })
    expect(withoutTab.entries[0]?.reason).toContain('需要先选择一个已打开对应站点的 Browser Tab')
    expect(mocks.startUiTestRun).not.toHaveBeenCalled()

    const mismatched = await run({
      specs: [{ path: 'tests/ui.testspec.json', uiStepCount: 1 }],
      tab: { tabId: 'tab-1', url: 'https://other.test/' },
    })
    expect(mismatched.entries[0]?.reason).toContain('目标标签页与用例站点不一致')

    vi.clearAllMocks()
    mocks.prepareUiTestRun.mockResolvedValue(plan({ ui: true, webBaseUrl: 'https://shop.test' }))
    mocks.startUiTestRun.mockResolvedValue({ status: 'passed', cases: [] })
    const matched = await run({
      specs: [{ path: 'tests/ui.testspec.json', uiStepCount: 1 }],
      tab: { tabId: 'tab-1', url: 'https://shop.test/checkout' },
    })
    expect(matched.entries[0]?.status).toBe('passed')
    expect(mocks.startUiTestRun.mock.calls[0]?.[0]).toMatchObject({
      target: { tabId: 'tab-1', origin: 'https://shop.test' },
    })
  })
  it('carries the report case statuses so the coverage KPI needs no extra host read', async () => {
    mocks.startUiTestRun.mockResolvedValue({
      status: 'failed',
      cases: [
        { caseId: 'case-1', status: 'passed' },
        { caseId: 'case-2', status: 'failed' },
      ],
    })
    const result = await run()

    expect(result.entries[0]?.caseStatuses).toEqual([
      { caseId: 'case-1', status: 'passed' },
      { caseId: 'case-2', status: 'failed' },
    ])
  })

  it('stops the batch on environment or approval origins but not on assertion failures', async () => {
    const failing = (origin: string) => ({
      status: 'error',
      cases: [{ caseId: 'case-1', steps: [{ stepId: 'ping', status: 'error', origin }] }],
    })
    mocks.startUiTestRun
      .mockResolvedValueOnce({ status: 'passed', cases: [] })
      .mockResolvedValueOnce(failing('environment'))
      .mockResolvedValue({ status: 'passed', cases: [] })
    const stopped = await run({ specs: [
      { path: 'tests/a.testspec.json', uiStepCount: 0 },
      { path: 'tests/b.testspec.json', uiStepCount: 0 },
      { path: 'tests/c.testspec.json', uiStepCount: 0 },
    ] })

    // 环境坏了就别给坏环境刷屏：剩余用例不再发起运行。
    expect(mocks.startUiTestRun).toHaveBeenCalledTimes(2)
    expect(stopped.entries.map((entry) => entry.status)).toEqual(['passed', 'error', 'skipped'])
    expect(stopped.entries[2]).toMatchObject({ runId: null })
    expect(stopped.entries[2]?.reason).toContain('环境不可用')

    vi.clearAllMocks()
    mocks.prepareUiTestRun.mockResolvedValue(plan())
    mocks.ensureEnvironmentReady.mockResolvedValue({
      readiness: { ready: true, verdict: 'ready', reason: '环境就绪', status: 200, elapsedMs: 3 },
      facts: { environmentId: 'env-1', name: '本地', kind: 'remote', probe: { method: 'GET', url: 'https://api.test/' }, verdict: 'ready', status: 200, elapsedMs: 3, preparedBy: 'probe' },
    })
    mocks.startUiTestRun
      .mockResolvedValueOnce({ status: 'failed', cases: [{ caseId: 'case-1', steps: [{ stepId: 'ping', status: 'failed', origin: 'assertion' }] }] })
      .mockResolvedValue({ status: 'passed', cases: [] })
    const asserted = await run()

    // 断言失败是产品/测试问题，后续用例仍有价值——批次继续。
    expect(mocks.startUiTestRun).toHaveBeenCalledTimes(3)
    expect(asserted.entries.map((entry) => entry.status)).toEqual(['failed', 'passed', 'passed'])

    vi.clearAllMocks()
    mocks.prepareUiTestRun.mockResolvedValue(plan())
    mocks.startUiTestRun
      .mockResolvedValueOnce({ status: 'passed', cases: [] })
      .mockResolvedValueOnce({
        status: 'rejected',
        cases: [{ caseId: 'case-1', steps: [{ stepId: 'ping', status: 'rejected', origin: 'approval' }] }],
      })
      .mockResolvedValue({ status: 'passed', cases: [] })
    const rejected = await run()

    // 用户已拒绝就不再替用户继续批准后续文件（与 environment 同一 stopsBatch 规则）。
    expect(mocks.startUiTestRun).toHaveBeenCalledTimes(2)
    expect(rejected.entries.map((entry) => entry.status)).toEqual(['passed', 'rejected', 'skipped'])
    expect(rejected.entries[2]?.runId).toBeNull()
    expect(rejected.entries[2]?.reason).toContain('用户拒绝')
  })
})
