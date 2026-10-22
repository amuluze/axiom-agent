import 'dotenv/config'
import { defineConfig } from '@playwright/test'
import { getEnv } from './src/env'
import { getTopology } from './src/topology'

const env = getEnv()
const topology = getTopology()

/**
 * 两个 project 对应两层被测面：
 *  - integration：单一界面的黑盒契约（应用壳启动、工作区授权）。
 *  - e2e：跨界面旅程（发送 → 流式 → 工具调用 → 审批）。
 * 前端 dev server 由 e2e/vite.config.ts 提供（apps/desktop 源码 + 假 Tauri 宿主注入）。
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.runner.ts',
  reporter: [['list'], ['html', { open: 'never' }]],
  retries: env.E2E_RETRIES,
  workers: env.E2E_WORKERS,
  timeout: env.E2E_TEST_TIMEOUT_MS,
  expect: { timeout: env.E2E_EXPECT_TIMEOUT_MS },
  use: {
    baseURL: topology.app.base_url,
    locale: 'zh-CN',
    headless: env.E2E_HEADLESS,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      // Chromium 自身的沙箱无法在宿主 OS 沙箱（seatbelt / bubblewrap）内初始化，
      // 会以 SIGSEGV 崩溃；本套件的隔离边界由宿主沙箱提供，故关闭浏览器内层沙箱。
      chromiumSandbox: false,
    },
  },
  webServer: {
    command: 'npm run dev',
    url: topology.app.base_url,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'integration',
      testDir: './integration',
      fullyParallel: false,
    },
    {
      name: 'e2e',
      testDir: './e2e',
      fullyParallel: false,
      timeout: 120_000,
    },
  ],
})
