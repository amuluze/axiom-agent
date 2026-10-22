import { resolve } from 'node:path'
import { expect, test } from '../../src/fixtures'
import { loadYaml } from '../../src/helpers/yaml'
import { ShellCasesSchema } from '../../src/types/cases'

const suite = loadYaml(resolve(import.meta.dirname, 'shell.cases.yaml'), ShellCasesSchema)

test.describe('应用壳启动契约', () => {
  for (const item of suite.cases) {
    test(item.desc, async ({ app, host }, testInfo) => {
      testInfo.annotations.push({ type: 'case', description: item.id })
      await app.waitForReady()

      switch (item.input.scenario) {
        case 'shell_boot': {
          // 初始化回退（DEV 下会写 settingsError 横幅）属于启动失败，必须显式排除。
          await expect(app.page.getByText('初始化桌面能力失败')).toHaveCount(0)
          await expect(app.page.getByRole('textbox').first()).toBeVisible()
          return
        }
        case 'runtime_info': {
          await expect(app.page.locator('html')).toHaveAttribute('data-os', 'macos')
          return
        }
        case 'workspace_empty': {
          await expect(app.page.getByLabel('添加工作目录').first()).toBeVisible()
          const snapshot = await host.snapshot()
          expect(snapshot.workspaces, '尚未授权任何工作区').toEqual([])
          return
        }
      }
    })
  }
})
