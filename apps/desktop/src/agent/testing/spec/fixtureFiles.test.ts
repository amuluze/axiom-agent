import { describe, expect, it } from 'vitest'
import type { CompiledTestPlan } from './compileTestPlan'
import { collectFixtureReferences, resolveFixtureReferences } from './fixtureFiles'

const plan = (): CompiledTestPlan => ({
  specId: 'cert',
  name: '证书',
  specVersion: 9,
  specHash: 'hash',
  target: {},
  environmentNames: [],
  hooks: { beforeAll: [{ id: 'h', action: 'api.request', method: 'POST', url: 'http://x/', body: { cert: { file: 'tests/fixtures/cert.pem' } } }] },
  cases: [{
    id: 'case',
    name: '用例',
    steps: [
      { id: 'a', action: 'api.request', method: 'POST', url: 'http://x/', body: { key: { file: 'tests/fixtures/key.pem' }, list: [{ file: 'tests/fixtures/cert.pem' }] } },
      { id: 'b', action: 'api.request', method: 'GET', url: 'http://x/' },
    ],
  }],
})

describe('fixtureFiles', () => {
  it('collects unique referenced files across hooks and cases', () => {
    expect(collectFixtureReferences(plan())).toEqual(['tests/fixtures/cert.pem', 'tests/fixtures/key.pem'])
  })

  it('substitutes file contents and returns a frozen plan', () => {
    const resolved = resolveFixtureReferences(plan(), new Map([
      ['tests/fixtures/cert.pem', 'CERT'],
      ['tests/fixtures/key.pem', 'KEY'],
    ]))
    expect(resolved.hooks?.beforeAll?.[0]).toMatchObject({ body: { cert: 'CERT' } })
    expect(resolved.cases[0]?.steps[0]).toMatchObject({ body: { key: 'KEY', list: ['CERT'] } })
    expect(Object.isFrozen(resolved)).toBe(true)
  })

  it('fails closed when a referenced file has no content', () => {
    expect(() => resolveFixtureReferences(plan(), new Map())).toThrow('缺少内容')
  })
})
