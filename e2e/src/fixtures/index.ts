import { randomUUID } from 'node:crypto'
import { expect, test as base, type Page } from '@playwright/test'
import { PROVIDER_PROFILE_SCHEMA_VERSION } from '../../../apps/desktop/src/agent/transport/providerProfileVersion'
import { getEnv, type Env } from '../env'
import { getTopology, type Topology } from '../topology'
import { installFakeTauriHost } from '../host/bridge'
import { startHostServer, type HostServer, type HostSnapshot } from '../host/server'

export interface ScenarioStep {
  kind: 'text' | 'tool'
  text?: string
  name?: string
  input?: Record<string, unknown>
}

/** 控制面客户端：用例借它预置工作区、脚本化模型响应、裁决审批。 */
export interface HostControl {
  baseUrl: string
  snapshot(): Promise<HostSnapshot>
  seedWorkspace(name: string, files?: Record<string, string>): Promise<string>
  script(steps: ScenarioStep[]): Promise<void>
  decideApproval(decision: 'allow' | 'deny'): Promise<void>
  /**
   * 清空运行时累积（turns/calls/approvals/approved/denied/artifacts/cancelled/
   * pickQueue）。保留 workspaces/activeWorkspacePath/secrets/leases——这些由用例
   * 显式 setup，不应被跨用例回收。判定断言一律走 baseline + delta 模式。
   */
  reset(): Promise<void>
}

/** 应用页：已完成桥接注入与首屏加载的被测前端。 */
export interface AppPage {
  page: Page
  clientId: string
  /** 等待应用壳与「provider 就绪」：输入框出现即代表启动路径成功。 */
  waitForReady(): Promise<void>
}

interface TestFixtures {
  host: HostControl
  app: AppPage
}

interface WorkerFixtures {
  env: Env
  topology: Topology
  server: HostServer
  runId: string
}

const seedProfile = () => ({
  schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
  profileId: 'e2e.scripted',
  providerId: 'custom-anthropic-compatible',
  apiFormat: 'anthropic-compatible',
  endpoint: 'http://127.0.0.1:9/e2e/v1/messages',
  modelId: 'e2e-scripted',
  timeoutMs: 60_000,
  maxOutputTokens: 4_096,
  contextWindow: 128_000,
  capabilities: { toolReferences: false, toolSearch: false },
  imageInput: 'catalog',
  secretId: 'provider.custom-anthropic-compatible.api-key',
})

export const test = base.extend<TestFixtures, WorkerFixtures>({
  env: [async ({}, use) => void (await use(getEnv())), { scope: 'worker' }],
  topology: [async ({}, use) => void (await use(getTopology())), { scope: 'worker' }],

  // 每个 worker 一个假宿主：命令面与事件面都在进程内，状态天然隔离。
  server: [
    async ({}, use) => {
      const env = getEnv()
      const topology = getTopology()
      const server = await startHostServer({
        bind: topology.host.bind,
        approvalPolicy: env.E2E_APPROVAL_POLICY,
      })
      try {
        await use(server)
      } finally {
        await server.close()
      }
    },
    { scope: 'worker' },
  ],

  runId: [
    async ({}, use) => {
      // 与 licensor 同思路：动态资源带 runId 前缀，便于跨轮次识别与回收。
      const stamp = new Date().toISOString().replace(/[-:T.]/gu, '').slice(0, 14)
      await use(`${stamp}-${process.pid}`)
    },
    { scope: 'worker' },
  ],

  host: async ({ server, runId }, use) => {
    const call = async <T>(route: string, body?: unknown): Promise<T> => {
      const response = await fetch(`${server.baseUrl}${route}`, {
        method: body === undefined && route.endsWith('state') ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) throw new Error(`${route} 失败：${response.status}`)
      return (await response.json()) as T
    }
    await use({
      baseUrl: server.baseUrl,
      snapshot: () => call<HostSnapshot>('/control/state'),
      seedWorkspace: async (name, files) =>
        (await call<{ path: string }>('/control/seed-workspace', { name: `${runId}-${name}`, files })).path,
      script: async (steps) => {
        await call('/control/scenario', { steps })
      },
      decideApproval: async (decision) => {
        await call('/control/approval', { decision })
      },
      reset: async () => {
        await call('/control/reset', {})
      },
    })
  },

  app: async ({ page, server, topology }, use) => {
    const clientId = randomUUID()
    // 桥接与种子必须在任何应用代码之前注入：前者让 isTauriRuntime() 为真，
    // 后者让会话直接落在脚本化 Provider 上（等价于 licensor 的 stack seed）。
    await page.addInitScript(installFakeTauriHost, { hostBase: server.baseUrl, clientId })
    await page.addInitScript((profile: unknown) => {
      localStorage.setItem('axiom.provider.config.v1', JSON.stringify(profile))
      localStorage.setItem(
        'axiom.provider.profiles.v1',
        JSON.stringify({ schemaVersion: 1, activeProfileId: 'e2e.scripted', profiles: [profile] }),
      )
      // 浏览器能力开关：测试页旅程要求目标 Browser Tab 存在，而 tabs 动作在能力关闭时
      // fail-closed。键与 `apps/desktop/src/config/browserSettings.ts` 的常量一致。
      localStorage.setItem(
        'axiom.browser.config.v1',
        JSON.stringify({ enabled: true, executablePath: '', headless: true, ignoreCertificateErrors: false }),
      )
    }, seedProfile())
    await page.goto(topology.app.base_url)

    const app: AppPage = {
      page,
      clientId,
      waitForReady: async () => {
        // 输入框出现 = 启动路径走通（未落到 fallback / 初始化失败分支）。
        await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: 30_000 })
        await expect(page.getByRole('button', { name: '切换模型' })).toContainText('e2e-scripted', {
          timeout: 30_000,
        })
      },
    }
    await use(app)
  },
})

/** 确认应用内 `<DialogHost>`（取代 window.confirm 后的 DOM 弹窗）。 */
export const confirmAppDialog = async (page: Page): Promise<void> => {
  const dialog = page.getByRole('dialog')
  if (await dialog.count() === 0) return
  await dialog.getByRole('button', { name: '确认' }).click()
}

export { expect }
export type { HostSnapshot, HostServer }
