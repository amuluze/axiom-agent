import { z } from 'zod'

/**
 * `*.cases.yaml` 的 zod 契约：用例文件是数据，schema 是它的类型。按
 * resource/operation 分派，`npm run check-suite` 在不连接环境的前提下校验
 * 「用例数据 ↔ 契约 ↔ spec 规则」三方一致。
 */
export const CaseBaseSchema = z.object({
  id: z.string().min(1),
  desc: z.string().min(1),
  verifies: z.array(z.string().min(1)).default([]),
})

const SpecSchema = z.object({
  feature: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().min(1),
  }),
  business_rules: z.array(z.object({ id: z.string().min(1), title: z.string().min(1) })).min(1),
  groups: z
    .array(z.object({ id: z.string().min(1), title: z.string().min(1), cases: z.array(z.string().min(1)).min(1) }))
    .min(1),
})

export const SpecDocSchema = SpecSchema
export type SpecDoc = z.infer<typeof SpecSchema>

/** integration/shell —— 应用壳启动契约。 */
export const ShellCasesSchema = z.object({
  resource: z.literal('app.shell'),
  operation: z.literal('boot'),
  cases: z.array(
    CaseBaseSchema.extend({
      input: z.object({
        scenario: z.enum(['shell_boot', 'runtime_info', 'workspace_empty']),
      }),
    }),
  ),
})

/** integration/workspace —— 工作区授权契约。 */
export const WorkspaceCasesSchema = z.object({
  resource: z.literal('app.workspace'),
  operation: z.literal('authorization'),
  cases: z.array(
    CaseBaseSchema.extend({
      input: z.object({
        scenario: z.enum(['pick_authorize_list', 'revoke_workspace', 'composer_binds_workspace']),
        workspace_name: z.string().min(1).default('demo'),
      }),
    }),
  ),
})

/** e2e/agent-run —— 发送到工具审批的完整旅程。 */
export const AgentRunCasesSchema = z.object({
  resource: z.literal('agent.run'),
  operation: z.literal('journey'),
  cases: z.array(
    CaseBaseSchema.extend({
      input: z.object({
        scenario: z.enum(['text_run_streams', 'bash_tool_approved', 'bash_tool_denied']),
        prompt: z.string().min(1).default('请说明你的运行环境。'),
        command: z.string().min(1).default('echo e2e-ok'),
      }),
    }),
  ),
})

/** e2e/integration/testing —— 测试页运行旅程。 */
export const TestingCasesSchema = z.object({
  resource: z.literal('app.testing'),
  operation: z.literal('journey'),
  cases: z.array(
    CaseBaseSchema.extend({
      input: z.object({
        scenario: z.enum(['scan_lists_specs', 'run_with_approval', 'report_handoff']),
        workspace_name: z.string().min(1).default('testing'),
      }),
    }),
  ),
})

export type ShellCases = z.infer<typeof ShellCasesSchema>
export type WorkspaceCases = z.infer<typeof WorkspaceCasesSchema>
export type AgentRunCases = z.infer<typeof AgentRunCasesSchema>
export type TestingCases = z.infer<typeof TestingCasesSchema>
