import { isTauriRuntime } from '@/platform/environment'

export type AgentCapability =
  | 'filesystem:read'
  | 'workspace:read'
  | 'workspace:write'
  | 'workspace:execute'
  | 'ui-test:read'
  | 'ui-test:write'
  | 'api-test:request'
  | 'subagent:explore'
  | 'subagent:review'

/**
 * UI/API 自动化的**分阶段发布档位**（H1-5 feature flag 层）。
 *
 * 计划 §12 H1-5 把发布拆成四档：开发 feature flag（仅本地 loopback）→ 内测（开放
 * 外部 HTTPS 测试环境）→ Beta（开放 Agent 生成和修复）→ GA（安全审计/性能预算/使用文档）。
 * 本字段是前两档的开关面，由 `mode` 派生默认：
 *
 * - `development`：两者都 false——本地构建只允许回环目标，且不开放 Agent 生成。
 * - `production`：两者都 true——与历史行为一致（内测/Beta 语义），不改动既有生产链路。
 *
 * 两个开关的语义与消费点各自独立，不要互相替代：
 *
 * - `externalTargets`：由 `agent/tools/apiRequestTool.ts` 的 `validate` 消费——开发档里
 *   `api_request` 的目标主机必须是回环/本地（`localhost`、`127.0.0.0/8`、`::1`、`*.local`），
 *   否则以可读错误拒绝。这是**工具校验层**的门，与 Rust 的权威出网策略（私网授权、
 *   公网明文恒拒）相互独立：工具门在开发档收窄「能去哪」，Rust 仍逐个请求判定。
 * - `agentGeneration`：Beta 档开关（Agent 生成/固化/修复测试）。由测试页「固化到用例
 *   文件」入口消费（`components/testing/TestingView.tsx` 的 `solidifyDisabledReason`
 *   链首）：关闭时固化面板整体禁用并解释档位，纯重放与报告回传不受影响。开发档的
 *   探索工具**仍按能力授予**（见下方 `toolCapabilities` 注释），故它不是工具注册门。
 */
export interface TestAutomationPolicy {
  /** 允许外部/公网 HTTPS 测试目标（内测档起开放；开发档只允许本地回环）。 */
  externalTargets: boolean
  /** 允许 Agent 生成/固化/修复测试（Beta 档开放）。 */
  agentGeneration: boolean
}

export interface RuntimePolicy {
  mode: 'development' | 'production'
  desktop: boolean
  allowDemoProvider: boolean
  allowInitializationFallback: boolean
  requireConfiguredProvider: boolean
  testAutomation: TestAutomationPolicy
  toolCapabilities: AgentCapability[]
}

export interface RuntimePolicyEnvironment {
  development: boolean
  desktop: boolean
  operatingSystem?: string
  sandboxAvailable?: boolean
}

export const createRuntimePolicy = ({
  development,
  desktop,
  operatingSystem,
  sandboxAvailable = false,
}: RuntimePolicyEnvironment): RuntimePolicy => ({
  mode: development ? 'development' : 'production',
  desktop,
  allowDemoProvider: development,
  allowInitializationFallback: development,
  requireConfiguredProvider: !development,
  // H1-5：发布档位由 mode 派生（开发档只放行本地 loopback，生产档按内测/Beta 语义放开）。
  testAutomation: {
    externalTargets: !development,
    agentGeneration: !development,
  },
  // 开发档**仍授予** UI/API 探索能力（便于本地开发：工具仍注册、仍可 discover 后使用），
  // 收窄发生在 `testAutomation.externalTargets` 的工具门（公网目标被拒，回环目标可用），
  // 而不是这一层的能力裁剪——能力是注册门，发布档是目标门，二者语义不同。
  toolCapabilities: [
    ...(desktop
      ? [
          'workspace:read' as const,
          'workspace:write' as const,
          ...(sandboxAvailable && (operatingSystem === 'macos' || operatingSystem === 'linux')
            ? ['workspace:execute' as const]
            : []),
          // UI 只读探索（2026-10-13 开放）。与子代理同为**注册门**前提：五个 ui_* 工具
          // 注册后**不进默认激活集**（模型须先 `discover_agent_tools`），且宿主环境面用
          // `scopeAgentEnvironment` 按本能力门控 `browser.command`——工具不可达即宿主
          // 通道也不可达。只读：不导航/不点击/不输入（写动作走下面的 `ui-test:write`
          // 写通道，与只读动作在类型上分列）；子代理用 `scopedReadEnvironment`，
          // 结构上无此通道。
          'ui-test:read' as const,
          // UI 写探索（2026-10-13 开放）。同样只是**注册门**前提：五个 ui_* 写工具注册后
          // **不进默认激活集**（模型须先 `discover_agent_tools`），且每一个都
          // `requiresApproval`——逐次审批是 Agent 层的门，宿主写通道 `browser.write`
          // 由 `scopeAgentEnvironment` 按本能力单独门控（与只读通道 `browser.command`
          // 的 `ui-test:read` 分列，只读路径结构上看不到写动作）。写动作会真实改变页面
          //（导航/点击/输入/选择/按键），只用于探索，不承担正式回归；子代理用
          // `scopedReadEnvironment`，结构上无此通道。
          'ui-test:write' as const,
          // API 探索（2026-10-13 开放）。同样只是**注册门**前提：`api_request` 注册后
          // **不进默认激活集**（模型须先 `discover_agent_tools`），且 `requiresApproval`——
          // 逐次审批是 Agent 层的门，宿主通道 `api.runStep` 由 `scopeAgentEnvironment`
          // 按本能力门控（未授予时连宿主都不可达）。出网策略、Secret 注入与脱敏证据都在
          // Rust 权威执行（公网 HTTPS 允许、公网明文 HTTP 恒拒、回环/私网需测试环境
          // 显式授权）；子代理用 `scopedReadEnvironment`，结构上无此通道。
          'api-test:request' as const,
          // 子代理只读委派（2026-10-10 开放）。三道门各自独立：此处只是**注册门**的
          // 前提——`createToolRegistry` 按 capability 注册四个 *_subagent，它们
          // **不进默认激活集**（模型须先 `discover_agent_tools`），且子会话工具集是
          // 「只读工厂表 ∩ 父会话现场活跃工具」的 fail-closed 交集，写/命令/绝对读/
          // Artifact 写入在 `scopedReadEnvironment` 层结构不可达。预算由父 run 统一
          // 承担（次数/请求/时长三重上界）。
          'subagent:review' as const,
          'subagent:explore' as const,
        ]
      : []),
  ],
})

export const RUNTIME_POLICY = createRuntimePolicy({
  development: import.meta.env.DEV,
  desktop: isTauriRuntime(),
})
