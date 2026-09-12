import type { AgentCapability } from '@/config/runtimePolicy'
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
import { createWebSearchTool } from './webSearchTool'
import { createWebFetchTool } from './webFetchTool'
import { createBrowserTool } from './browserTool'
import { createComputerTool } from './computerTool'
import { createSshHostsTool } from './sshHostsTool'
import { createSshTool } from './sshTool'
import { createLoadSkillTool } from '@/agent/skills/createLoadSkillTool'
import { createExploreSubAgentTool } from '@/agent/subagent/explore/createExploreSubAgentTool'
import { createInspectSubAgentTool } from '@/agent/subagent/reviewers/createInspectSubAgentTool'
import { createExamineSubAgentTool } from '@/agent/subagent/reviewers/createExamineSubAgentTool'
import { createReviewSubAgentTool } from '@/agent/subagent/reviewers/createReviewSubAgentTool'

export interface ToolRegistryOptions {
  capabilities: AgentCapability[]
  environment?: AgentEnvironment
}

export const createToolRegistry = ({
  capabilities,
  environment = desktopAgentEnvironment,
}: ToolRegistryOptions): AgentTool[] => {
  const enabled = new Set(capabilities)
  const tools: AgentTool[] = []

  const canRead = enabled.has('filesystem:read') || enabled.has('workspace:read')
  if (canRead) {
    tools.push(createReadTool(environment))
    if (enabled.has('workspace:read')) {
      tools.push(createLsTool(environment), createGrepTool(environment), createFindTool(environment))
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

  if (enabled.has('workspace:write')) {
    tools.push(
      createWriteTool(environment),
      createEditTool(environment),
      createApplyChangesTool(environment),
      createRestoreTrashTool(environment),
    )
  }

  if (enabled.has('workspace:execute')) {
    tools.push(createBashTool(environment))
  }

  // web 只读工具：独立 capability 门控（与工作区读取无关），discover-gated
  // 不进入默认激活集——外部内容不可信且涉及查询词外发，由模型按需经
  // discover_agent_tools 激活，不随会话启动默认暴露。
  if (enabled.has('web:read')) {
    tools.push(createWebSearchTool(environment), createWebFetchTool(environment))
  }

  // browser 工具：独立 capability 门控，discover-gated 不进默认激活集。注册只看
  // capability（不随设置开关漂移）——持久化 activeToolNames 里的 browser 在用户
  // 关闭设置后恢复会话时不至于因「未注册」而失败；「未启用」由 Rust 侧对 spawn
  // 类动作 fail-closed 报错引导（恢复语义见 restoredActiveToolNames 的 throw 约定）。
  // 主 Agent 专用：scopedReadEnvironment 结构性封死 browser 节，子 Agent 不共享
  // 有状态浏览器会话。
  if (enabled.has('web:browser')) {
    tools.push(createBrowserTool(environment))
  }

  // computer 工具：与 browser 同款 capability 门控（discover-gated 不进默认
  // 激活集，注册不随设置开关漂移）。主 Agent 专用：scopedReadEnvironment
  // 结构性封死 computer 节——真用户桌面的控制权不下放子 Agent。
  if (enabled.has('computer:control')) {
    tools.push(createComputerTool(environment))
  }

  // ssh 工具：独立 capability 门控，discover-gated 不进默认激活集；注册只看
  // capability（与 browser/computer 同一恢复安全语义）。实际放行是逐次审批
  // （lease 绑定 {host, command}）+ Rust 会话授权表，无设置开关可漂移。主
  // Agent 专用：scopedReadEnvironment 结构性封死 ssh 节——真实远程主机的
  // 特权通道不共享给只读子 Agent。
  if (enabled.has('ssh:remote')) {
    tools.push(createSshHostsTool(environment), createSshTool(environment))
  }

  return tools
}
