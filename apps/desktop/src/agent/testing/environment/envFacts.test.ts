import { describe, expect, it } from 'vitest'
import { describeEnvironmentFacts, environmentFactsFrom, serializeEnvironmentFacts } from './envFacts'

const facts = environmentFactsFrom({
  environment: { id: 'env-1', name: '本地开发环境', kind: 'local' },
  probe: { method: 'GET', url: 'http://127.0.0.1:9/api/health' },
  readiness: { ready: true, verdict: 'ready', reason: '环境就绪', status: 200, elapsedMs: 21 },
  preparedBy: 'probe',
})

describe('environmentFactsFrom', () => {
  it('snapshots the environment name, mode and probe target', () => {
    expect(facts).toEqual({
      environmentId: 'env-1',
      name: '本地开发环境',
      kind: 'local',
      probe: { method: 'GET', url: 'http://127.0.0.1:9/api/health' },
      verdict: 'ready',
      status: 200,
      elapsedMs: 21,
      preparedBy: 'probe',
    })
  })

  it('records the absence of a probe target instead of inventing one', () => {
    const withoutProbe = environmentFactsFrom({
      environment: { id: 'env-2', name: '无地址环境', kind: 'remote' },
      probe: null,
      readiness: { ready: false, verdict: 'unusable', reason: '没有 API Base URL', status: null, elapsedMs: 0 },
      preparedBy: 'probe',
    })
    expect(withoutProbe.probe.url).toContain('未探测')
    expect(describeEnvironmentFacts(serializeEnvironmentFacts(withoutProbe))).toContain('无地址环境（remote）')
  })
})

describe('describeEnvironmentFacts', () => {
  it('renders one readable line for the report', () => {
    expect(describeEnvironmentFacts(serializeEnvironmentFacts(facts))).toBe(
      '本次环境：本地开发环境（local） · 探针 GET http://127.0.0.1:9/api/health → 返回 200（21 ms） · 本次探测',
    )
  })

  it('distinguishes a cached conclusion from a fresh probe', () => {
    const cached = { ...facts, preparedBy: 'cache' as const }
    expect(describeEnvironmentFacts(JSON.stringify(cached))).toContain('就绪结论来自会话内缓存（本次未重新探测）')
  })

  it('degrades to null on untrusted history instead of throwing', () => {
    expect(describeEnvironmentFacts(null)).toBeNull()
    expect(describeEnvironmentFacts(undefined)).toBeNull()
    expect(describeEnvironmentFacts('')).toBeNull()
    expect(describeEnvironmentFacts('{ not json')).toBeNull()
    expect(describeEnvironmentFacts('"text"')).toBeNull()
    expect(describeEnvironmentFacts('[]')).toBeNull()
    expect(describeEnvironmentFacts('{"name":"缺少档位"}')).toBeNull()
    expect(describeEnvironmentFacts('{"name":"X","kind":"cluster"}')).toBeNull()
    // 缺 probe 段仍可读：历史记录里可能只有结论。
    expect(describeEnvironmentFacts('{"name":"旧记录","kind":"remote","verdict":"ready"}'))
      .toBe('本次环境：旧记录（remote） · 探针 — （未记录） → 结论 ready · 本次探测')
  })
})
