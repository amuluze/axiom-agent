import type { AgentTool } from '@/agent/core/types'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import { createReadTool, type ReadToolOptions } from '@/agent/tools/readTool'
import { createLsTool } from '@/agent/tools/lsTool'
import { createGrepTool } from '@/agent/tools/grepTool'
import { createFindTool } from '@/agent/tools/findTool'
import { createWebSearchTool } from '@/agent/tools/webSearchTool'
import { createWebFetchTool } from '@/agent/tools/webFetchTool'

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
 * 激活的 L0 只读工具集，受 capability 门控；本表是子代理固定不变的工具集，语义独立。
 */
/** 子代理只读工具集的构造选项（目前仅 read 支持参数化）。 */
export interface SubAgentReadonlyToolOptions {
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
  // web 只读检索与 read/grep 同级：子 Agent 与主 Agent 共享同一 web 能力
  // （公网只读、无审批语义、Rust 权威校验），供探索/审查时核对外部文档。
  { name: 'web_search', create: createWebSearchTool },
  { name: 'web_fetch', create: createWebFetchTool },
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
  options: SubAgentReadonlyToolOptions = {},
): AgentTool[] =>
  SUBAGENT_READONLY_TOOL_FACTORIES.map((factory) => factory.create(environment, options))
