import { resolve } from 'node:path'
import { confirmAppDialog, expect, test } from '../../src/fixtures'
import { loadYaml } from '../../src/helpers/yaml'
import { WorkspaceCasesSchema } from '../../src/types/cases'

const suite = loadYaml(resolve(import.meta.dirname, 'workspace.cases.yaml'), WorkspaceCasesSchema)

const dirName = (path: string): string => path.split('/').pop() ?? path

test.describe('工作区授权契约', () => {
  for (const item of suite.cases) {
    test(item.desc, async ({ app, host }, testInfo) => {
      testInfo.annotations.push({ type: 'case', description: item.id })
      await app.waitForReady()
      const page = app.page
      // 先预置原生目录选择器将返回的目录，再经真实入口授权（侧栏按钮 → 宿主注册表）。
      const path = await host.seedWorkspace(item.input.workspace_name)
      const name = dirName(path)
      page.on('dialog', (dialog) => void dialog.accept())
      await page.getByLabel('添加工作目录').first().click()
      await expect(page.getByText(name, { exact: false }).first()).toBeVisible()

      switch (item.input.scenario) {
        case 'pick_authorize_list': {
          const snapshot = await host.snapshot()
          expect(snapshot.workspaces, '工作区进入授权注册表').toEqual([path])
          expect(snapshot.activeWorkspacePath, '新授权的工作区成为活动工作区').toBe(path)
          return
        }
        case 'composer_binds_workspace': {
          await expect(page.getByLabel('选择项目').first()).toContainText(name)
          return
        }
        case 'revoke_workspace': {
          // 移除按钮默认隐藏（依赖 .sidebar__project-actions 的 opacity:0 +
          // pointer-events:none，见 sidebar.css），必须先 hover 父行让容器可见，
          // 否则点击被父行 sidebar__project-row 拦截 pointer events。
          await page.getByLabel(`切换工作目录 ${name}`).first().hover()
          await page.getByLabel(`移除工作目录 ${name}`).first().click()
          await confirmAppDialog(page)
          const snapshot = await host.snapshot()
          expect(snapshot.workspaces, '注册表已清空').toEqual([])
          expect(snapshot.activeWorkspacePath, '活动工作区已复位').toBeNull()
          await expect(page.getByText(name, { exact: false })).toHaveCount(0)
          return
        }
      }
    })
  }
})
