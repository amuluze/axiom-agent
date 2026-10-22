import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { confirmAppDialog, expect, test, type HostControl } from '../../src/fixtures'
import { loadYaml } from '../../src/helpers/yaml'
import { TestingCasesSchema } from '../../src/types/cases'

const suite = loadYaml(resolve(import.meta.dirname, 'testing.cases.yaml'), TestingCasesSchema)

/**
 * 工作区里的 `.testspec.json` 用例文件（恰好是 `find_workspace_files *.testspec.json` 的扫描对象）。
 * `broken.testspec.json` 故意缺 version/name/cases：测试页必须把它标成「需要修复」而不是丢弃。
 */
const checkoutSpec = JSON.stringify({
  kind: 'axiom.test',
  version: 1,
  id: 'checkout-flow',
  name: '结算流程',
  target: {},
  cases: [
    {
      id: 'opens-checkout',
      name: '打开结算页并提交订单',
      steps: [
        { id: 'assert-heading', action: 'ui.assert', locator: { role: 'heading', name: '结算页' }, expect: { visible: true } },
        { id: 'click-submit', action: 'ui.click', locator: { role: 'button', name: '提交订单' } },
        { id: 'assert-created', action: 'ui.assert', locator: { text: '订单已创建' }, expect: { textContains: '订单已创建' } },
        { id: 'capture', action: 'ui.screenshot', name: '确认页' },
      ],
    },
  ],
}, null, 2)

/** 断言落在脚本化页面不存在的元素上：运行必须以 failed 收敛，报告才出现发送入口。 */
const paymentSpec = JSON.stringify({
  kind: 'axiom.test',
  version: 1,
  id: 'payment-alert',
  name: '支付结果提示',
  target: {},
  cases: [
    {
      id: 'shows-alert',
      name: '支付成功提示可见',
      steps: [
        { id: 'assert-alert', action: 'ui.assert', locator: { role: 'alert', name: '支付成功' }, expect: { visible: true } },
      ],
    },
  ],
}, null, 2)

const brokenSpec = JSON.stringify({ kind: 'axiom.test', id: 'broken' }, null, 2)

const workspaceFiles = {
  'tests/checkout.testspec.json': checkoutSpec,
  'tests/payment.testspec.json': paymentSpec,
  'tests/broken.testspec.json': brokenSpec,
}

const dirName = (path: string): string => path.split('/').pop() ?? path

/**
 * 当前用例经 UI 授权的工作区。`resetHostState` 有意保留工作区注册表（注册属于用例
 * 显式 setup 而非运行时累积），因此本套件必须在用例结束时经侧栏移除自己创建的工作区，
 * 否则会污染随后运行的 workspace 套件（其断言依赖注册表只含自己授权的目录）。
 */
let authorizedPath: string | null = null

/** 经真实入口授权工作区：预置原生目录选择器将返回的目录 → 侧栏「添加工作目录」。 */
const authorizeWorkspace = async (page: Page, host: HostControl, name: string): Promise<string> => {
  const path = await host.seedWorkspace(name, workspaceFiles)
  authorizedPath = path
  page.on('dialog', (dialog) => void dialog.accept())
  await page.getByLabel('添加工作目录').first().click()
  await expect(page.getByText(dirName(path), { exact: false }).first()).toBeVisible()
  return path
}

const openTestingView = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: '测试', exact: true }).first().click()
  await expect(page.getByRole('button', { name: '重新扫描' })).toBeVisible()
}

/**
 * 测试运行要求目标 Browser Tab：无 tab 时测试页给出「打开浏览器面板」入口，
 * 打开后 BrowserPanel 经 `browser_command` 拉取脚本化 tabs 并写回 browserStore。
 */
const ensureBrowserTab = async (page: Page): Promise<void> => {
  const openBrowser = page.getByRole('button', { name: '打开浏览器面板' })
  if (await openBrowser.count() > 0) await openBrowser.first().click()
  await expect(page.getByLabel('目标标签页')).toContainText('结算页')
}

const startRun = async (page: Page, specPath: string): Promise<void> => {
  await page.getByRole('tab', { name: specPath }).click()
  await ensureBrowserTab(page)
  await page.getByRole('button', { name: '重放' }).first().click()
}

test.describe('测试页运行旅程', () => {
  // 用例结束即撤销本用例授权的工作区（见 authorizedPath 注释）。
  test.afterEach(async ({ app, host }) => {
    const path = authorizedPath
    authorizedPath = null
    if (!path) return
    const page = app.page
    const name = dirName(path)
    // 测试视图把侧栏覆写为「测试助手」；先返回会话视图，工作区行才重新出现。
    const back = page.getByRole('button', { name: '返回' })
    if (await back.count() > 0) await back.first().click()
    await page.getByLabel(`切换工作目录 ${name}`).first().hover()
    await page.getByLabel(`移除工作目录 ${name}`).first().click()
    await confirmAppDialog(page)
    await expect.poll(async () => (await host.snapshot()).workspaces).not.toContain(path)
  })

  for (const item of suite.cases) {
    test(item.desc, async ({ app, host }, testInfo) => {
      testInfo.annotations.push({ type: 'case', description: item.id })
      await app.waitForReady()
      const page = app.page

      // 每个用例独立的工作区与运行记录：reset 先清运行时累积（含上一用例的
      // 测试运行/租约），再 seed 目录、授权、进入测试页。
      await host.reset()
      await authorizeWorkspace(page, host, item.input.workspace_name)
      const baselineCalls = (await host.snapshot()).calls.length
      await openTestingView(page)

      switch (item.input.scenario) {
        case 'scan_lists_specs': {
          // 扫描结果：3 个用例文件标签；非法文件标红并在 title 里带首条校验问题。
          const tabs = page.getByRole('tablist', { name: '用例文件' }).getByRole('tab')
          await expect(tabs).toHaveCount(3)
          await expect(page.getByRole('tab', { name: 'tests/checkout.testspec.json' }))
            .toHaveAttribute('title', 'tests/checkout.testspec.json')
          await expect(page.getByRole('tab', { name: 'tests/broken.testspec.json' }))
            .toHaveClass(/is-invalid/)
          await expect(page.getByRole('tab', { name: 'tests/broken.testspec.json' }))
            .toHaveAttribute('title', /不支持的版本，当前支持 1 \/ 2 \/ 3/)
          // 合法用例展示扫描出的元数据。
          await expect(page.getByText('tests/checkout.testspec.json · 1 个场景 · UI 4 步 · API 0 步'))
            .toBeVisible()
          // 扫描真的走了宿主命令面（而不是前端内置的假数据）。
          const commands = (await host.snapshot()).calls.slice(baselineCalls).map((call) => call.cmd)
          expect(commands, '扫描经宿主枚举工作区文件').toContain('find_workspace_files')
          expect(commands, '扫描经宿主读取用例文件').toContain('read_workspace_text')
          return
        }

        case 'run_with_approval': {
          await startRun(page, 'tests/checkout.testspec.json')

          // 写步骤挂起：审批卡片给出动作与目标，允许后宿主签发租约并执行。
          const approval = page.locator('.testing-approval-item')
          await expect(approval).toContainText('点击 role=button 名称「提交订单」')
          await approval.getByRole('button', { name: '允许执行' }).click()

          // 实时推进：运行页按步骤累计状态。
          await expect(page.locator('.testing-view__row', { hasText: 'assert-heading' }).first()).toBeVisible()
          await expect(page.locator('.testing-view__row', { hasText: 'capture' }).first()).toBeVisible()

          // 运行结束渲染报告：状态通过、步骤明细含证据哈希。
          await expect(page.getByRole('heading', { name: '运行报告' })).toBeVisible({ timeout: 30_000 })
          await expect(page.locator('.testing-view__pill--pass').first()).toHaveText('通过')
          await expect(page.getByText('tests/checkout.testspec.json', { exact: false }).first()).toBeVisible()
          await expect(page.locator('li', { hasText: 'ui.click · click-submit' })).toContainText('通过')
          const captureRow = page.locator('li', { hasText: 'ui.screenshot · capture' })
          await captureRow.getByRole('button', { name: '展开步骤详情' }).click()
          await expect(page.locator('.testing-view__row-details').filter({ hasText: '证据 SHA-256' }))
            .toBeVisible()

          const snapshot = await host.snapshot()
          const delta = snapshot.calls.slice(baselineCalls).map((call) => call.cmd)
          expect(delta, '运行经宿主记录用例运行').toContain('create_test_run_record')
          expect(delta, '写步骤经宿主签发步骤租约').toContain('issue_test_step_lease')
          expect(delta, '写步骤由宿主执行').toContain('run_ui_write_step')
          expect(delta, '读断言由宿主判定').toContain('run_ui_read_step')
          return
        }

        case 'report_handoff': {
          await startRun(page, 'tests/payment.testspec.json')

          // 断言失败 → 运行 failed → 报告给出「发送并打开会话」。
          await expect(page.getByRole('heading', { name: '运行报告' })).toBeVisible({ timeout: 30_000 })
          await expect(page.locator('.testing-view__pill--fail').first()).toHaveText('失败')
          await expect(page.locator('li', { hasText: 'ui.assert · assert-alert' })).toContainText('失败')

          await page.getByRole('button', { name: '发送并打开会话' }).click()

          // 切到会话视图，失败摘要作为消息渲染。
          await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: 30_000 })
          await expect(page.getByText('请根据以下 Axiom 自动化测试失败报告', { exact: false }).first())
            .toBeVisible({ timeout: 30_000 })
          await expect(page.getByText('tests/payment.testspec.json', { exact: false }).first()).toBeVisible()
          return
        }
      }
    })
  }
})
