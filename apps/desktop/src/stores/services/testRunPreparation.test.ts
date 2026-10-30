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

describe('prepareUiTestRun v9（fixture 文件引用）', () => {
  beforeEach(() => mocks.readWorkspaceText.mockReset())

  const specWithFixture = JSON.stringify({
    kind: 'axiom.test',
    version: 9,
    id: 'cert',
    name: '证书导入',
    target: { apiBaseUrl: 'https://api.test' },
    testPoints: [{ id: 'tp-cert', kind: 'new_feature', title: '导入', acceptance: '可客观判定' }],
    cases: [{
      id: 'import',
      name: '导入证书',
      verifies: ['tp-cert'],
      steps: [{
        id: 'import',
        action: 'api.request',
        method: 'POST',
        url: '/certificates/import',
        body: {
          certificate_content: { file: 'tests/fixtures/cert.pem' },
          key_content: { file: 'tests/fixtures/key.pem' },
        },
        expect: [{ status: 201 }],
      }],
    }],
  })

  it('reads fixture files from the workspace and injects their contents', async () => {
    mocks.readWorkspaceText
      .mockResolvedValueOnce({ content: specWithFixture, truncated: false })
      .mockResolvedValueOnce({ content: 'CERT-PEM', truncated: false })
      .mockResolvedValueOnce({ content: 'KEY-PEM', truncated: false })
    const plan = await prepareUiTestRun({ path: 'tests/cert.testspec.json', workspacePath: '/repo' })
    expect(plan.cases[0]?.steps[0]).toMatchObject({
      body: { certificate_content: 'CERT-PEM', key_content: 'KEY-PEM' },
    })
    expect(mocks.readWorkspaceText).toHaveBeenNthCalledWith(2, 'tests/fixtures/cert.pem', 0, 1_000, '/repo')
  })

  it('fails closed when a fixture exceeds the read budget', async () => {
    mocks.readWorkspaceText
      .mockResolvedValueOnce({ content: specWithFixture, truncated: false })
      .mockResolvedValueOnce({ content: 'CERT-PEM', truncated: true })
    await expect(prepareUiTestRun({ path: 'tests/cert.testspec.json', workspacePath: '/repo' }))
      .rejects.toThrow('超过读取上限')
  })

  it('rejects fixture paths outside tests/fixtures at parse time', async () => {
    mocks.readWorkspaceText.mockResolvedValueOnce({
      content: specWithFixture.replace('tests/fixtures/cert.pem', '../secret.pem'),
      truncated: false,
    })
    await expect(prepareUiTestRun({ path: 'tests/cert.testspec.json', workspacePath: '/repo' }))
      .rejects.toThrow('文件引用必须是 tests/fixtures/ 下的工作区相对路径')
  })
})
