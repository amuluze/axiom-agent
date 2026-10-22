import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from '../../src/fixtures'
import { loadYaml } from '../../src/helpers/yaml'
import { AgentRunCasesSchema } from '../../src/types/cases'

const suite = loadYaml(resolve(import.meta.dirname, 'agent-run.cases.yaml'), AgentRunCasesSchema)

const sendPrompt = async (page: Page, text: string): Promise<void> => {
  await page.getByRole('textbox').first().fill(text)
  // Composer textarea 与按钮都带 aria-label「发送给 Axiom」/「发送」，这里
  // 必须按 role 限定到 button 才能命中真正的发送按钮（textarea 也命中）。
  await page.getByRole('button', { name: '发送', exact: true }).first().click()
}

/**
 * 审批卡片选择器：必须 scope 在 `.approval-card` 容器里，否则 BackgroundApprovals
 * 后台收件箱内同名「拒绝」/「允许一次」按钮会先匹配上，点了不活跃后台卡片的按钮
 * 不会触发主活跃会话的审批 settle——主卡片原按钮没被点中，run 直接因挂起超时被
 * 协调器自动拒绝，导致测试行为错乱。
 */
const approvalCard = (page: Page) => page.locator('aside.approval-card')

/**
 * 模型发现 bash 工具的脚本化 turn：bash 是 L1 discover-gated
 * （productToolRuntime.ts 的 ALWAYS_ACTIVE_READ_TOOLS 不含），必须先经
 * discover_agent_tools 把 activeToolNames 拉起 bash 才能调起命令执行。
 * 若脚本跳过这一步，运行时会在 toolExecution.ts:336 抛「工具尚未激活：bash」，
 * 整个审批旅程无法触发，CE-E2E-RUN-003/004/005 三条规则都无法被验证。
 */
const discoverBashTurn = { kind: 'tool', name: 'discover_agent_tools', input: { query: 'bash' } } as const

test.describe('Agent 运行旅程', () => {
  for (const item of suite.cases) {
    test(item.desc, async ({ app, host }, testInfo) => {
      testInfo.annotations.push({ type: 'case', description: item.id })
      await app.waitForReady()
      const page = app.page
      // 发送闸门要求活动会话绑定已授权工作区：先经 UI 完成授权。
      const path = await host.seedWorkspace(item.input.scenario)
      const name = path.split('/').pop() ?? path
      page.on('dialog', (dialog) => void dialog.accept())
      await page.getByLabel('添加工作目录').first().click()
      await expect(page.getByText(name, { exact: false }).first()).toBeVisible()

      switch (item.input.scenario) {
        case 'text_run_streams': {
          // 清空上一用例残留的 turns 与累积 calls——否则脚本化 turn 会被
          // 之前的请求提前取走（shift 取一次就少一个），用例就拿不到响应。
          await host.reset()
          await host.script([{ kind: 'text', text: 'E2E 脚本化回复：运行环境已确认。' }])
          const baselineCalls = (await host.snapshot()).calls.length
          await sendPrompt(page, item.input.prompt)
          await expect(page.getByText('E2E 脚本化回复：运行环境已确认。').first())
            .toBeVisible({ timeout: 30_000 })
          const snapshot = await host.snapshot()
          const commands = snapshot.calls.slice(baselineCalls).map((call) => call.cmd)
          expect(commands, '模型请求经宿主模型流通道').toContain('stream_model_http')
          return
        }
        case 'bash_tool_approved': {
          // reset 必须在 script 之前——script 之后调 reset 会把刚入队的
          // 脚本化 turn 一并清空，模型永远拿不到 bash turn。
          await host.reset()
          // 第三 turn 文本复述 stdout(脚本化模型在 bash 工具结果后做的事),
          // 让 e2e-ok 通过助手回复渲染到会话视图——bash stdout 本身只作为
          // role:tool 消息进入模型提示,UI 视图只渲染 assistant 文本块。
          await host.script([
            discoverBashTurn,
            { kind: 'tool', name: 'bash', input: { command: item.input.command } },
            { kind: 'text', text: `命令已执行完毕,输出为 ${item.input.command.replace(/^echo\s+/, '')}。` },
          ])
          const baselineCalls = (await host.snapshot()).calls.length
          await sendPrompt(page, item.input.prompt)
          // 审批卡片保持待处理,由用例在 UI 上裁决;宿主随后签发租约。
          // 必须 scope 在主审批卡片容器里(详见 approvalCard 注释)。
          await approvalCard(page).getByRole('button', { name: '允许一次' }).first().click()
          await host.decideApproval('allow')
          await expect(page.getByText(/^命令已执行完毕.*e2e-ok/u).first()).toBeVisible({ timeout: 30_000 })
          // bash 工具调用块标题即命令字面量（'Run echo e2e-ok'），证明命令
          // 已实际派发到 host.run_workspace_command 并被回填。
          await expect(page.getByText('Run echo e2e-ok').first()).toBeVisible()
          const snapshot = await host.snapshot()
          const delta = snapshot.calls.slice(baselineCalls)
          expect(
            snapshot.approved.includes('run_workspace_command'),
            '宿主签发过一次工作区命令租约',
          ).toBe(true)
          expect(
            delta.some((call) => call.cmd === 'run_workspace_command'),
            '工作区命令在本用例增量内执行',
          ).toBe(true)
          return
        }
        case 'bash_tool_denied': {
          await host.reset()
          await host.script([
            discoverBashTurn,
            { kind: 'tool', name: 'bash', input: { command: item.input.command } },
            { kind: 'text', text: '已按拒绝处理。' },
          ])
          const baselineCalls = (await host.snapshot()).calls.length
          await sendPrompt(page, item.input.prompt)
          await approvalCard(page).getByRole('button', { name: '拒绝' }).first().click()
          await expect(page.getByText('已按拒绝处理。').first()).toBeVisible({ timeout: 30_000 })
          const snapshot = await host.snapshot()
          const delta = snapshot.calls.slice(baselineCalls)
          // 拒绝路径：bash 仍会请求 lease（host.request_workspace_approval_lease），
          // 但用户在审批卡片上点「拒绝」后由 UI 层 settle，host 不进入 issueLease
          // 分支，所以 host.approved 中不会出现 run_workspace_command。
          // 这条规则保真 CE-E2E-RUN-005：「拒绝时宿主不签发租约（fail-closed）」。
          // bash 工具调用块标题（命令字面量）必须出现——证明 bash turn 真的被
          // 模型发起了（不是脚本队列被错位消费），仅 host 层未执行命令。
          await expect(page.getByText('Run echo e2e-ok').first()).toBeVisible()
          expect(
            snapshot.approved.includes('run_workspace_command'),
            '拒绝路径不得签发 run_workspace_command 租约',
          ).toBe(false)
          expect(
            delta.some((call) => call.cmd === 'run_workspace_command'),
            '拒绝路径命令不得在工作区内执行',
          ).toBe(false)
          // UI 校验：'e2e-ok' 精确独立文本不应出现（仅「Run echo e2e-ok」命令预览
          // 会被命中，但精确等于独立字符串的 e2e-ok 不存在）。
          await expect(page.getByText('e2e-ok', { exact: true })).toHaveCount(0)
          return
        }
      }
    })
  }
})
