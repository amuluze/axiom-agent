import type { AgentCapability, TestAutomationPolicy } from '@/config/runtimePolicy'
import type { AgentTool } from '../core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { desktopAgentEnvironment } from '@/agent/environment/agentEnvironmentHost'
import { createLsTool } from './lsTool'
import { createGrepTool } from './grepTool'
import { createFindTool } from './findTool'
import { createReadTool } from './readTool'
import { createWriteTool } from './writeTool'
import { createEditTool } from './editTool'
import { createApplyChangesTool } from './applyChangesTool'
import { createBashTool } from './bashTool'
import { createRestoreTrashTool } from './restoreTrashTool'
import { createDesignQueryTool } from './designQueryTool'
import { createDesignImportTool } from './designImportTool'
import { createUiSnapshotTool } from './uiSnapshotTool'
import { createUiFindTool } from './uiFindTool'
import { createUiScreenshotTool } from './uiScreenshotTool'
import { createUiWaitTool } from './uiWaitTool'
import { createUiAssertTool } from './uiAssertTool'
import { createUiNavigateTool } from './uiNavigateTool'
import { createUiClickTool } from './uiClickTool'
import { createUiInputTool } from './uiInputTool'
import { createUiSelectTool } from './uiSelectTool'
import { createUiPressTool } from './uiPressTool'
import { createApiRequestTool } from './apiRequestTool'
import type { DesignComponentSummary } from '@/agent/design/componentInventoryHost'
import { createLoadSkillTool } from '@/agent/skills/createLoadSkillTool'
import { createExploreSubAgentTool } from '@/agent/subagent/explore/createExploreSubAgentTool'
import { createInspectSubAgentTool } from '@/agent/subagent/reviewers/createInspectSubAgentTool'
import { createExamineSubAgentTool } from '@/agent/subagent/reviewers/createExamineSubAgentTool'
import { createReviewSubAgentTool } from '@/agent/subagent/reviewers/createReviewSubAgentTool'

export interface ToolRegistryOptions {
  capabilities: AgentCapability[]
  environment?: AgentEnvironment
  /**
   * H1-5 发布档策略（由 App 层从 `RUNTIME_POLICY.testAutomation` 注入）。Agent 层不 import
   * app config 的**值**（既有方向是 `agent/**` 只做 type-only import），故策略经装配注入。
   * 缺省取 fail-closed 的开发档：仅本地 loopback、不开放生成。
   */
  testAutomation?: TestAutomationPolicy
  /** `.ax` 组件清单来源（宿主装配注入；缺省由 design_query 用宿主接缝取）。 */
  designComponentInventory?: () => DesignComponentSummary[]
}

/** 未注入发布档策略时的 fail-closed 默认：等同开发 feature flag 档。 */
const LOCKED_TEST_AUTOMATION: TestAutomationPolicy = { externalTargets: false, agentGeneration: false }

export const createToolRegistry = ({
  capabilities,
  environment = desktopAgentEnvironment,
  testAutomation = LOCKED_TEST_AUTOMATION,
  designComponentInventory,
}: ToolRegistryOptions): AgentTool[] => {
  const enabled = new Set(capabilities)
  const tools: AgentTool[] = []

  const canRead = enabled.has('filesystem:read') || enabled.has('workspace:read')
  if (canRead) {
    tools.push(createReadTool(environment))
    if (enabled.has('workspace:read')) {
      tools.push(createLsTool(environment), createGrepTool(environment), createFindTool(environment))
      // design_query：只读 .ax 子树查询（Rust read_design_document 通道；.pen 仅经
      // design_import 一次性迁移），discover-gated 不进默认激活集——设计编辑会话由
      // 模型按需经 discover_agent_tools 激活，避免非设计会话的工具表膨胀。
      tools.push(createDesignQueryTool(environment, {
        ...(designComponentInventory ? { componentInventory: designComponentInventory } : {}),
      }))
      // 项目技能加载工具：workspace:read 时始终注册到完整工具表（manifest 不随
      // 项目是否存在 Skill 漂移）。默认激活由 agentStore.ts::defaultActiveToolNamesForSession
      // 条件决定（项目 Skills 开关开启 + snapshot 非空时默认 active）；恢复会话走
      // 持久化 activeToolNames，不因应用升级静默获得新工具。
      // capabilities 透传：内置 Skill 正文硬引用审查 SubAgent，未授予 subagent:review
      // 时返回口追加自查说明。
      tools.push(createLoadSkillTool({ environment, capabilities }))
    }
  }

  if (enabled.has('workspace:read') && enabled.has('subagent:explore')) {
    // Explore SubAgent：workspace:read + subagent:explore 才注册到完整工具表。
    // discover-gated，不加入默认激活集（productToolRuntime 的 ALWAYS_ACTIVE_READ_TOOLS 不含它）。
    tools.push(createExploreSubAgentTool())
  }

  if (enabled.has('workspace:read') && enabled.has('subagent:review')) {
    // 审查 SubAgent（inspect/examine/review）：workspace:read + subagent:review 才
    // 注册到完整工具表。与 explore 同为只读委派，但语义是「对产物做门禁判定」，
    // 因此独立 capability 门控（未来可单独禁用审查而保留探索）。discover-gated，
    // 不加入默认激活集。capabilities 透传给 review：无 diff 委派的降级提醒按
    // workspace:execute 分化（有命令能力却未采集 diff 属可避免的降级）。
    tools.push(
      createInspectSubAgentTool(),
      createExamineSubAgentTool(),
      createReviewSubAgentTool({ capabilities }),
    )
  }

  if (enabled.has('workspace:read') && enabled.has('ui-test:read')) {
    // UI 只读探索（G1-2）：workspace:read + ui-test:read 才注册到完整工具表。
    // 与子代理工具同为 discover-gated——不加入默认激活集（ALWAYS_ACTIVE_READ_TOOLS
    // 只含 read/ls/grep/find），且宿主通道由 scopeAgentEnvironment 按 ui-test:read
    // 门控：未授予时浏览器通道连宿主都不可达。只读，不设 requiresApproval。
    tools.push(
      createUiSnapshotTool(environment),
      createUiFindTool(environment),
      createUiScreenshotTool(environment),
      createUiWaitTool(environment),
      createUiAssertTool(environment),
    )
  }

  if (enabled.has('workspace:read') && enabled.has('ui-test:write')) {
    // UI 写探索（G1-3）：workspace:read + ui-test:write 才注册到完整工具表。
    // 与只读块并列且同属 discover-gated——不加入默认激活集（ALWAYS_ACTIVE_READ_TOOLS
    // 只含 read/ls/grep/find）。每个工具都 `requiresApproval`（逐次审批是 Agent 层的
    // 门），宿主写通道由 scopeAgentEnvironment 按 ui-test:write 单独门控：未授予时
    // 浏览器写通道连宿主都不可达。tabId 省略时要用活动标签页，因此工具还会走只读
    // 通道（`ui-test:read`）——桌面默认同时授予两者，实际不会出现只写不读的会话。
    tools.push(
      createUiNavigateTool(environment),
      createUiClickTool(environment),
      createUiInputTool(environment),
      createUiSelectTool(environment),
      createUiPressTool(environment),
    )
  }

  if (enabled.has('workspace:read') && enabled.has('api-test:request')) {
    // API 探索（G1-4）：workspace:read + api-test:request 才注册到完整工具表。
    // workspace:read 是因为测试环境与 API Driver 都以当前授权工作区为归属（Rust 按
    // 工作区根加载 test_environments），与其它工具块同一前置条件。discover-gated——
    // 不加入默认激活集（ALWAYS_ACTIVE_READ_TOOLS 只含 read/ls/grep/find）；工具自身
    // `requiresApproval`（逐次审批），宿主通道由 scopeAgentEnvironment 按本能力单独
    // 门控：未授予时 API 通道连宿主都不可达。另叠一层 H1-5 发布档目标门：开发档只放行
    // 回环/本地目标（`testAutomation.externalTargets`）。
    tools.push(createApiRequestTool(environment, testAutomation))
  }

  if (enabled.has('workspace:write')) {
    tools.push(
      createWriteTool(environment),
      createEditTool(environment),
      createApplyChangesTool(environment),
      createRestoreTrashTool(environment),
      // design_import：.pen → .ax 一次性迁移（写工具，discover-gated + 审批）。
      createDesignImportTool(environment),
    )
  }

  if (enabled.has('workspace:execute')) {
    tools.push(createBashTool(environment))
  }

  return tools
}
