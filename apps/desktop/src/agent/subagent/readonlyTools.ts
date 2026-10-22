import type { AgentTool } from '@/agent/core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { createReadTool, type ReadToolOptions } from '@/agent/tools/readTool'
import { createLsTool } from '@/agent/tools/lsTool'
import { createGrepTool } from '@/agent/tools/grepTool'
import { createFindTool } from '@/agent/tools/findTool'

/**
 * 子 Agent read 默认行数收窄值：100 行在典型代码文件下约 3-30 KiB，连同
 * 分页提示与 SHA 落在 64 KiB 内联上限内，结果不会被二次截断丢失 offset 续读信息。
 * 主 Agent read 仍用全局默认（200 行）。
 */
export const SUBAGENT_READ_MAX_LINES = 100

/**
 * 子代理唯一可用的只读工具集——单一权威来源（Single Source of Truth）。
 *
 * SubAgent（explore / inspect / examine / review）是只读委派，唯一可用工具就是这组
 * 只读检索工具。本模块同时承载「工具名清单」与「工具构造」：
 *   - {@link SUBAGENT_READONLY_TOOL_NAMES} 供 `builtinSubAgents` 的展示元数据（设置页 UI）；
 *   - {@link createSubAgentReadonlyTools} 供 `SubAgentRuntime.buildChildContext` 构造子上下文。
 *
 * 两处消费方都从本表派生，消除了此前 `builtinSubAgents.ts` 字面量与 `buildChildContext`
 * 硬编码各自独立、靠注释维持同步的漂移风险——增删子代理工具只需改本表一处，名字、构造、
 * 展示自动一致（编译期保障）。
 *
 * 与主 Agent 的 `productToolRuntime.ALWAYS_ACTIVE_READ_TOOLS` 区分：那是主 Agent 启动即
 * 激活的 L0 只读工具集，受 capability 门控；本表是角色允许上限，运行时再与父会话当前活跃工具取交集。
 */
/** 子代理只读工具集的构造选项（目前仅 read 支持参数化）。 */
export interface SubAgentReadonlyToolOptions {
  parentActiveToolNames: readonly string[]
  read?: ReadToolOptions
}

interface SubAgentReadonlyToolFactory {
  readonly name: string
  readonly create: (environment: AgentEnvironment, options: SubAgentReadonlyToolOptions) => AgentTool
}

export const SUBAGENT_READONLY_TOOL_FACTORIES: readonly SubAgentReadonlyToolFactory[] = [
  { name: 'read', create: (environment, options) => createReadTool(environment, options.read) },
  { name: 'ls', create: createLsTool },
  { name: 'grep', create: createGrepTool },
  { name: 'find', create: createFindTool },
]

/**
 * 子代理可用工具名清单（从工厂表派生，非独立字面量）。
 * 供展示元数据消费；与 {@link createSubAgentReadonlyTools} 的实际构造结果始终一致。
 */
export const SUBAGENT_READONLY_TOOL_NAMES: readonly string[] = SUBAGENT_READONLY_TOOL_FACTORIES.map(
  (factory) => factory.name,
)

/**
 * 按 environment 构造子代理只读工具集（供 SubAgentRuntime.buildChildContext）。
 * 工具创建顺序与 {@link SUBAGENT_READONLY_TOOL_FACTORIES} 声明顺序一致。
 */
export const createSubAgentReadonlyTools = (
  environment: AgentEnvironment,
  options: SubAgentReadonlyToolOptions,
): AgentTool[] =>
  SUBAGENT_READONLY_TOOL_FACTORIES
    .filter((factory) => options.parentActiveToolNames.includes(factory.name))
    .map((factory) => factory.create(environment, options))

/** 每个只读工具的一行说明（双语）：提示词「允许的工具」段的数据源。 */
const READONLY_TOOL_HINTS: Record<string, { zh: string; en: string }> = {
  read: { zh: '读取文件内容（文本或图片）', en: 'read file contents (text or images)' },
  ls: { zh: '列出目录条目', en: 'list directory entries' },
  grep: { zh: '在工作区内搜索文本', en: 'search text within the workspace' },
  find: { zh: '按模式查找文件', en: 'locate files by pattern' },
}

/**
 * 子会话提示词的「允许的工具」段——**从工厂表派生**，不另写工具清单。
 *
 * 这段文案此前在四个模板里各写死一份（explore 双语 + 审查三件套共用常量），
 * 与 {@link SUBAGENT_READONLY_TOOL_FACTORIES} 形成第二事实源：工具集增删后文案
 * 不会跟着变，子模型据此会尝试调用不存在的工具、白耗轮次与预算（本仓已发生过
 * 一次：文案宣称有 web_search/web_fetch，而工厂表里从来没有）。
 * 增删工具只需改工厂表，提示词自动跟随。
 */
export const readonlyToolsSection = (language: 'zh-CN' | 'en'): string => {
  const bullets = SUBAGENT_READONLY_TOOL_FACTORIES
    .map((factory) => {
      const hint = READONLY_TOOL_HINTS[factory.name]
      if (!hint) throw new Error(`只读工具缺少提示词说明：${factory.name}`)
      return language === 'en'
        ? `- ${factory.name}: ${hint.en}`
        : `- ${factory.name}：${hint.zh}`
    })
    .join('\n')
  const tail =
    language === 'en'
      ? 'All other tools are unavailable; write, edit, bash, approvals, tool discovery and delegating SubAgents are all forbidden.'
      : '其余工具均不可用；write、edit、bash、审批、工具发现与再次委派 SubAgent 都被禁止。'
  return `# ${language === 'en' ? 'Allowed tools' : '允许的工具'}\n${bullets}\n${tail}`
}
