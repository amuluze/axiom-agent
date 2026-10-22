import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentReadiness } from '@/agent/testing/environment/readiness'

const mocks = vi.hoisted(() => ({ probeEnvironmentReadiness: vi.fn() }))
vi.mock('@/platform/testEnvironmentProbe', () => ({ probeEnvironmentReadiness: mocks.probeEnvironmentReadiness }))

import { ENVIRONMENT_READINESS_TTL_MS, ensureEnvironmentReady, resetEnvironmentReadinessCache } from './testEnvironmentReadiness'
import type { TestEnvironmentRecord } from '@/platform/testEnvironments'

const environment = (overrides: Partial<TestEnvironmentRecord> = {}): TestEnvironmentRecord => ({
  id: 'local-shop',
  name: '本地开发环境',
  kind: 'local',
  recipeJson: JSON.stringify({ start: [], stop: [], readiness: ['ready'], timeoutMs: 60_000 }),
  webBaseUrl: null,
  apiBaseUrl: 'http://127.0.0.1:9',
  viewportWidth: null,
  viewportHeight: null,
  allowPrivateNetwork: false,
  headersJson: '{}',
  secretIdsJson: '[]',
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
})

const readiness = (ready: boolean, verdict: EnvironmentReadiness['verdict'] = ready ? 'ready' : 'not_ready'): EnvironmentReadiness => ({
  ready,
  verdict,
  reason: ready ? '环境就绪' : '服务可达但未就绪',
  status: ready ? 200 : 503,
  elapsedMs: 5,
})

const PROBE = { method: 'GET', url: 'http://127.0.0.1:9/' }

const probeResult = (value: EnvironmentReadiness) => ({ readiness: value, probe: PROBE })

const approver = () => ({
  approve: async () => true,
  respond: () => false,
  list: () => [],
  subscribe: () => () => undefined,
})

const ensure = (record: TestEnvironmentRecord, now: () => number) =>
  ensureEnvironmentReady({
    environment: record,
    runId: 'run-1',
    approver: approver(),
    signal: new AbortController().signal,
    now,
  })

describe('ensureEnvironmentReady', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetEnvironmentReadinessCache()
  })

  it('caches a ready environment and reuses it inside the TTL', async () => {
    mocks.probeEnvironmentReadiness.mockResolvedValue(probeResult(readiness(true)))
    let clock = 1_000

    expect((await ensure(environment(), () => clock)).readiness.ready).toBe(true)
    expect((await ensure(environment(), () => clock)).readiness.ready).toBe(true)
    expect(mocks.probeEnvironmentReadiness).toHaveBeenCalledTimes(1)

    clock += ENVIRONMENT_READINESS_TTL_MS + 1
    await ensure(environment(), () => clock)
    expect(mocks.probeEnvironmentReadiness).toHaveBeenCalledTimes(2)
  })

  it('marks the facts as cache-served when the readiness came from the cache', async () => {
    mocks.probeEnvironmentReadiness.mockResolvedValue(probeResult(readiness(true)))
    const clock = () => 1_000

    const first = await ensure(environment(), clock)
    expect(first.facts).toMatchObject({ preparedBy: 'probe', name: '本地开发环境', kind: 'local', status: 200 })
    const cached = await ensure(environment(), clock)
    expect(cached.facts.preparedBy).toBe('cache')
    expect(mocks.probeEnvironmentReadiness).toHaveBeenCalledTimes(1)
  })

  it('never caches a not-ready result so the next attempt probes again', async () => {
    mocks.probeEnvironmentReadiness.mockResolvedValueOnce(probeResult(readiness(false, 'unreachable')))
    mocks.probeEnvironmentReadiness.mockResolvedValueOnce(probeResult(readiness(true)))
    const clock = () => 1_000

    const first = (await ensure(environment(), clock)).readiness
    expect(first).toMatchObject({ ready: false, verdict: 'unreachable' })
    const second = (await ensure(environment(), clock)).readiness
    expect(second.ready).toBe(true)
    expect(mocks.probeEnvironmentReadiness).toHaveBeenCalledTimes(2)
  })

  it('invalidates the cache when the environment file changes', async () => {
    mocks.probeEnvironmentReadiness.mockResolvedValue(probeResult(readiness(true)))
    const clock = () => 1_000

    await ensure(environment(), clock)
    // 配方（探针/预算）一变就是另一套环境：不能拿旧结论当就绪。
    await ensure(environment({ recipeJson: JSON.stringify({ start: [], stop: [], readiness: ['ready'], timeoutMs: 60_000, probe: { method: 'GET', path: '/healthz', expectStatus: [204] } }) }), clock)
    expect(mocks.probeEnvironmentReadiness).toHaveBeenCalledTimes(2)

    await ensure(environment({ apiBaseUrl: 'http://127.0.0.1:8' }), clock)
    expect(mocks.probeEnvironmentReadiness).toHaveBeenCalledTimes(3)
  })

  it('passes the probe reason through untouched', async () => {
    mocks.probeEnvironmentReadiness.mockResolvedValue(probeResult({
      ready: false,
      verdict: 'blocked',
      reason: '宿主拒绝了这次探测请求：未授权访问回环或私网地址。这是地址与网络策略的问题，不代表环境不存在。',
      status: null,
      elapsedMs: 0,
    }))
    const result = (await ensure(environment(), () => 1_000)).readiness
    expect(result.reason).toContain('未授权访问回环或私网地址')
    expect(result.reason).toContain('不代表环境不存在')
  })
})
