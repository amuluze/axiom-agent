import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ readWorkspaceText: vi.fn() }))
vi.mock('@/platform/workspace', () => ({ readWorkspaceText: mocks.readWorkspaceText }))

import { browserTargetOrigin, prepareUiTestRun } from './testRunPreparation'

const source = (steps: unknown[], target: Record<string, unknown> = {}) => JSON.stringify({
  kind: 'axiom.test',
  version: 1,
  id: 'checkout',
  name: 'Checkout',
  target,
  cases: [{ id: 'case-one', name: 'Case', steps }],
})

describe('prepareUiTestRun', () => {
  beforeEach(() => mocks.readWorkspaceText.mockReset())

  it('reads, compiles and resolves an executable UI-only plan', async () => {
    mocks.readWorkspaceText.mockResolvedValue({
      content: source(
        [{ id: 'open', action: 'ui.navigate', url: '/checkout' }],
        { webBaseUrl: 'https://shop.test' },
      ),
      truncated: false,
    })
    const plan = await prepareUiTestRun({ path: 'tests/a.testspec.json', workspacePath: '/repo' })
    expect(plan.cases[0]?.steps[0]).toMatchObject({ url: 'https://shop.test/checkout' })
  })

  it('reports missing environment values before execution', async () => {
    mocks.readWorkspaceText.mockResolvedValue({
      content: source(
        [{ id: 'open', action: 'ui.navigate', url: '/checkout' }],
        { webBaseUrl: `\${env.WEB_BASE_URL}` },
      ),
      truncated: false,
    })
    await expect(prepareUiTestRun({ path: 'tests/a.testspec.json', workspacePath: '/repo' }))
      .rejects.toThrow('引用了未声明的环境变量「WEB_BASE_URL」')
  })

  it('reads, compiles and resolves an executable API plan', async () => {
    mocks.readWorkspaceText.mockResolvedValue({
      content: source(
        [{ id: 'request', action: 'api.request', method: 'GET', url: `\${env.API_BASE_URL}/orders` }],
        { apiBaseUrl: `\${env.API_BASE_URL}` },
      ),
      truncated: false,
    })
    const plan = await prepareUiTestRun({
      path: 'tests/a.testspec.json',
      workspacePath: '/repo',
      environment: { API_BASE_URL: 'https://api.test' },
    })
    expect(plan.cases[0]?.steps[0]).toMatchObject({ url: 'https://api.test/orders' })
  })

  it('injects the run marker so run placeholders resolve per run', async () => {
    mocks.readWorkspaceText.mockResolvedValue({
      content: JSON.stringify({
        kind: 'axiom.test',
        version: 2,
        id: 'checkout',
        name: 'Checkout',
        target: { apiBaseUrl: `\${env.API_BASE_URL}` },
        cases: [{
          id: 'case-one',
          name: 'Case',
          steps: [{
            id: 'request',
            action: 'api.request',
            method: 'GET',
            url: `\${env.API_BASE_URL}/orders/\${run.slug}`,
          }],
        }],
      }),
      truncated: false,
    })
    const environment = { API_BASE_URL: 'https://api.test' }
    const first = await prepareUiTestRun({ path: 'tests/a.testspec.json', workspacePath: '/repo', environment, runId: 'test-run-a' })
    const second = await prepareUiTestRun({ path: 'tests/a.testspec.json', workspacePath: '/repo', environment, runId: 'test-run-b' })
    expect(first.cases[0]?.steps[0]).toMatchObject({ url: 'https://api.test/orders/axiomrun-test-run-a' })
    expect(second.cases[0]?.steps[0]).toMatchObject({ url: 'https://api.test/orders/axiomrun-test-run-b' })
    expect(first.specHash).toBe(second.specHash)

    await expect(prepareUiTestRun({ path: 'tests/a.testspec.json', workspacePath: '/repo', environment }))
      .rejects.toThrow('缺少取值')
  })
})

describe('browserTargetOrigin', () => {
  it('keeps only the HTTP origin', () => {
    expect(browserTargetOrigin('https://shop.test:8443/checkout')).toBe('https://shop.test:8443')
  })

  it('rejects non-HTTP targets', () => {
    expect(() => browserTargetOrigin('file:///tmp/index.html')).toThrow('HTTP(S)')
  })
})
