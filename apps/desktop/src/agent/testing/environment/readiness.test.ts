import { describe, expect, it } from 'vitest'
import {
  classifyReadiness,
  readinessProbePlan,
  type EnvironmentProbePlan,
  type ProbeObservation,
} from './readiness'

const plan = (overrides: Partial<EnvironmentProbePlan> = {}): EnvironmentProbePlan => ({
  step: {
    id: 'env-probe:env-1',
    action: 'api.request',
    method: 'GET',
    url: 'http://127.0.0.1:9/api/health',
    redirect: 'manual',
    timeoutMs: 180_000,
  },
  expectStatus: [200],
  ...overrides,
})

const observation = (overrides: Partial<ProbeObservation> = {}): ProbeObservation => ({
  transport: 'received',
  statusCode: 200,
  message: '',
  elapsedMs: 12,
  ...overrides,
})

const recipe = (probe: Record<string, unknown>) => JSON.stringify({
  start: [],
  stop: [],
  readiness: ['curl -fsS http://127.0.0.1:9/api/health'],
  probe,
})

describe('readinessProbePlan', () => {
  it('defaults to GET / expecting 200 and carries the recipe budget', () => {
    const result = readinessProbePlan({
      apiBaseUrl: 'http://127.0.0.1:9',
      recipeJson: JSON.stringify({ start: ['up'], stop: [], readiness: ['ready'], timeoutMs: 60_000 }),
      stepId: 'env-probe:env-1',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.step).toMatchObject({
      id: 'env-probe:env-1',
      action: 'api.request',
      method: 'GET',
      url: 'http://127.0.0.1:9/',
      timeoutMs: 60_000,
    })
    expect(result.plan.expectStatus).toEqual([200])
  })

  it('honours a declared probe and works without a recipe', () => {
    const declared = readinessProbePlan({
      apiBaseUrl: 'https://staging.test/api',
      recipeJson: recipe({ method: 'HEAD', path: '/healthz', expectStatus: [204, 200] }),
      stepId: 'env-probe:env-2',
    })
    expect(declared.ok).toBe(true)
    if (!declared.ok) return
    expect(declared.plan.step).toMatchObject({ method: 'HEAD', url: 'https://staging.test/healthz' })
    expect(declared.plan.expectStatus).toEqual([204, 200])

    const withoutRecipe = readinessProbePlan({
      apiBaseUrl: 'https://staging.test/api',
      recipeJson: null,
      stepId: 'env-probe:env-3',
    })
    expect(withoutRecipe.ok).toBe(true)
    if (!withoutRecipe.ok) return
    expect(withoutRecipe.plan.step).toMatchObject({ method: 'GET', url: 'https://staging.test/' })
  })

  it('refuses to probe when the environment cannot be probed, with an actionable reason', () => {
    const missingBase = readinessProbePlan({ apiBaseUrl: null, recipeJson: null, stepId: 's' })
    expect(missingBase.ok).toBe(false)
    if (missingBase.ok) return
    expect(missingBase.reason).toContain('没有 API Base URL')

    const brokenRecipe = readinessProbePlan({ apiBaseUrl: 'http://127.0.0.1:9', recipeJson: '{ not json', stepId: 's' })
    expect(brokenRecipe).toEqual({ ok: false, reason: '环境配方不是合法 JSON' })

    // 配方经同一个读取器校验：非法路径不会被「信任」而放过。
    const invalidProbe = readinessProbePlan({
      apiBaseUrl: 'http://127.0.0.1:9',
      recipeJson: recipe({ path: 'health' }),
      stepId: 's',
    })
    expect(invalidProbe.ok).toBe(false)
    if (invalidProbe.ok) return
    expect(invalidProbe.reason).toContain('探针路径必须以 / 开头')

    const unusableBase = readinessProbePlan({ apiBaseUrl: 'not a url', recipeJson: null, stepId: 's' })
    expect(unusableBase.ok).toBe(false)
    if (unusableBase.ok) return
    expect(unusableBase.reason).toContain('拼接探针地址')
  })
})

describe('classifyReadiness', () => {
  it('treats only the declared status codes as ready', () => {
    expect(classifyReadiness(plan(), observation())).toMatchObject({
      ready: true,
      verdict: 'ready',
      status: 200,
    })
    const unexpected = classifyReadiness(plan(), observation({ statusCode: 503 }))
    expect(unexpected).toMatchObject({ ready: false, verdict: 'not_ready', status: 503 })
    expect(unexpected.reason).toContain('服务可达但未就绪')
    expect(unexpected.reason).toContain('期望 200')
  })

  it('keeps unreachable, blocked and canceled reasons distinct', () => {
    const timeout = classifyReadiness(plan(), observation({ transport: 'timeout', statusCode: null }))
    expect(timeout.verdict).toBe('unreachable')
    expect(timeout.reason).toContain('超时')

    const refused = classifyReadiness(plan(), observation({
      transport: 'network_error',
      statusCode: null,
      message: 'Connection refused',
    }))
    expect(refused.verdict).toBe('unreachable')
    expect(refused.reason).toContain('Connection refused')

    const blocked = classifyReadiness(plan(), observation({
      transport: 'blocked',
      statusCode: null,
      message: '未授权访问回环或私网地址',
    }))
    expect(blocked.verdict).toBe('blocked')
    expect(blocked.reason).toContain('未授权访问回环或私网地址')
    // 「被策略拒绝」不得被写成「环境不存在」。
    expect(blocked.reason).toContain('不代表环境不存在')

    expect(classifyReadiness(plan(), observation({ transport: 'canceled', statusCode: null }))).toMatchObject({
      ready: false,
      verdict: 'canceled',
    })
  })
})
