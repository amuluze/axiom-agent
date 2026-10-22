import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'

/**
 * 嵌套 `AGENTS.md` 的发现结果：只含**相对路径**，不含任何正文。
 *
 * 与 `ProjectDocInventory` 同构的分层理由：说明文档是可信项目说明（不冻结、
 * 不哈希），按需 `read` 即取当前磁盘内容；索引只负责「让模型知道它存在」。
 */
export interface ProjectAgentsInventory {
  /** 相对路径，浅层目录优先（与根 `DESIGN.md` 排索引首位的预算优先级同向）。 */
  entries: string[]
  /**
   * 发现达到条目上限：条目只是下界，必须显式告知模型「可能还有未列入索引的
   * `AGENTS.md`」，否则模型会断言「该目录没有局部约定」而照常写代码。
   */
  truncated: boolean
}

export const EMPTY_PROJECT_AGENTS_INVENTORY: ProjectAgentsInventory = { entries: [], truncated: false }

/** 注入索引的条目上限；与预算省略是两套独立的缩窄来源，各自计数告知。 */
export const MAX_NESTED_AGENTS_ENTRIES = 256

/**
 * 扫描深度上限（宿主 `max_depth`，工作区根的直接子项为 1）。
 *
 * 不限深就得为每个 `agent_end` 付一次**全树遍历**：`find_impl` 的条目上限只在
 * 凑满 `limit` 个匹配之后才 break（Rust `workspace_access.rs`），而 AGENTS.md 的
 * 密度通常远低于上限，故上限实际上从不生效，每次调用都是完整 walk。深度上限把
 * 该成本变成有界的：6 层已覆盖 `packages/<pkg>/<sub>/`、`apps/<app>/src-tauri/`
 * 这类真实布局，更深的 `AGENTS.md` 属少数——由渲染层的**常驻说明**承担告知
 * （该口径恒为真，不是某次扫描的偶发缩窄）。
 */
export const MAX_NESTED_AGENTS_DEPTH = 6

/**
 * 发现用的 glob。globset 的双星号前缀匹配零个或多个路径分量，因此也命中
 * 工作区根的 `AGENTS.md`（该条由下面的根路径过滤剔除）。
 */
export const NESTED_AGENTS_PATTERN = '**/AGENTS.md'

/** 根 `AGENTS.md` 的路径形式；其正文已由 `projectContext` 全文注入，不重复入索引。 */
export const AGENTS_ROOT_PATH = 'AGENTS.md'

const depthOf = (path: string): number => path.split('/').length

/**
 * 发现工作区内（根之外）的 `AGENTS.md`。
 *
 * **返回 `null` 表示扫描失败，与「扫完了、确实没有」是两回事。** 两者若合并，
 * 一次偶发的 IPC/授权错误就会把整块索引从 live 提示词里删掉——退化窗口横跨
 * 一整个 run，其间模型可能在「以为没有局部约定」的状态下改代码。调用方据此
 * 保留旧镜像（首次扫描无旧值才落空），失败既不提交也不消失。
 *
 * **为什么只做索引、不注入正文**：根 `AGENTS.md` 的定位是项目入口，嵌套文件是
 * 各目录的局部约定，两者体量不可控（monorepo 里可达数百份）。按需 `read` 让
 * 模型在真正动某个目录时才付这份上下文；而自动注入会绕过 `projectContext` 的
 * 字节预算与显式注记，把「模型主动读取」反转为「被动接受未请求的内容」。
 *
 * 走 `workspace.find` 而非逐层 `list`：find 单趟遍历，遵循 `.gitignore`
 * （含 global/exclude）并跳过 `.git`/`node_modules`/`target`/`dist`/`.next`/
 * `.cache`，正好是「不该注入局部约定的目录」的同一集合——被忽略目录里的
 * `AGENTS.md` 因此不可见，这一点由渲染层的常驻说明承担，而非静默缩窄。
 */
export const loadProjectAgents = async (
  environment: Pick<AgentEnvironment, 'workspace'>,
): Promise<ProjectAgentsInventory | null> => {
  try {
    const result = await environment.workspace.find({
      requestId: 'project-agents-scan',
      pattern: NESTED_AGENTS_PATTERN,
      limit: MAX_NESTED_AGENTS_ENTRIES,
      maxDepth: MAX_NESTED_AGENTS_DEPTH,
      // 刷新跑在会话 idle 期，不挂在任何一次 turn 的取消信号上：扫描必须跑完，
      // 否则半截清单会被深比较当成「索引变化」提交。
      signal: new AbortController().signal,
    })
    const entries = result.matches
      .filter((entry) => entry.kind === 'file' && entry.path !== AGENTS_ROOT_PATH)
      .map((entry) => entry.path)
      // 浅层优先：预算紧张时先保住离根最近的局部约定（它们通常作用域最大）。
      .sort((left, right) => {
        const byDepth = depthOf(left) - depthOf(right)
        return byDepth !== 0 ? byDepth : left.localeCompare(right, 'en')
      })
    return { entries, truncated: result.truncated }
  } catch {
    return null
  }
}

/**
 * 深比较：条目逐项（含顺序）比对，外加截断标记。
 *
 * 截断标记必须参与比较——它是模型可见的注记内容，标记变化即提示词变化；
 * 只比条目会让「扫描上限被触发」这一事实永远传不到模型眼前。
 */
export const projectAgentsInventoryEqual = (
  left: ProjectAgentsInventory,
  right: ProjectAgentsInventory,
): boolean =>
  left.truncated === right.truncated
  && left.entries.length === right.entries.length
  && left.entries.every((entry, index) => entry === right.entries[index])
