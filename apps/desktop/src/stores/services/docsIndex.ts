import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import {
  AGENTS_ROOT_PATH,
  MAX_NESTED_AGENTS_DEPTH,
  MAX_NESTED_AGENTS_ENTRIES,
  NESTED_AGENTS_PATTERN,
} from '@/agent/prompt/projectAgents'
import {
  DOC_ROOTS,
  MAX_DOC_PAGE_ROOT_ENTRIES,
  ROOT_DOC_FILES,
  scanProjectDocs,
  type ProjectDocEntry,
  type ProjectDocDiagnostic,
  type ProjectDocRole,
} from '@/agent/prompt/projectDocs'
import { createDesktopAgentEnvironment } from '@/platform/desktopAgentEnvironment'

/**
 * 文档页（DocsView）的工作区文档索引。
 *
 * 扫描核心与提示词注入侧共用 `scanProjectDocs`（projectDocs.ts）：受管目录、归档判定
 * （domain 永不归档）、截断/子目录/列举失败/读取失败诊断全部只实现一次。此前两侧各自
 * 扫描，截断估算、根级文件错误与读取失败处理已分叉，页面展示的文档可能与模型看到的
 * 索引不一致。本模块只做「扫描结果 → 页面分组」的映射，不得再含扫描逻辑。
 *
 * 页面侧另有两个「项目指南」分组（根 AGENTS.md / 嵌套 AGENTS.md，docs-view 设计稿
 * dvd-ga / dvd-gn 两组）：AGENTS.md 的提示词注入归 projectContext / projectAgents，
 * **不进 scanProjectDocs**——加进去会改变提示词契约；这里用同一份发现参数
 * （pattern / limit / maxDepth 与 projectAgents.ts 一致）单独扫，只做页面展示。
 */

/** 页面侧分组角色：SDD 五角色 + 两个 AGENTS.md 专用分组。 */
export type DocsGroupRole = ProjectDocRole | 'agents-root' | 'agents-nested'

export interface DocsIndexEntry {
  role: DocsGroupRole
  /** 工作区相对路径（与提示词索引的 path 同源）。 */
  path: string
  fileName: string
  title: string
  archived: boolean
  revision: string
}

export interface DocsIndexGroup {
  role: DocsGroupRole
  /** 受管目录路径；根级文件（design）为 null。 */
  root: string | null
  entries: DocsIndexEntry[]
  /** 已归档（status: done）条目，页面降级展示、保留追溯。 */
  archivedEntries: DocsIndexEntry[]
  /**
   * 本角色的扫描诊断（列举失败/列举截断/条目上限/子目录/读取失败）。页面据此如实展示
   * 「未列入」与「扫描失败」，不得把它们渲染成「目录为空」。角色与扫描根一一对应，
   * 按 role 过滤即得到该组的诊断。
   */
  diagnostics: ProjectDocDiagnostic[]
  /** AGENTS.md 发现被 find 截断（entries 只是下界）；SDD 组恒为 false。 */
  truncated?: boolean
  scanFailed?: boolean
}

export interface WorkspaceDocsIndex {
  groups: DocsIndexGroup[]
}

const fileStem = (path: string): string => {
  const name = path.split('/').pop() ?? path
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -'.md'.length) : name
}

const toDocsIndexEntry = (entry: ProjectDocEntry, archived: boolean): DocsIndexEntry => ({
  role: entry.role,
  path: entry.relativePath,
  fileName: fileStem(entry.relativePath),
  title: entry.title,
  archived,
  revision: entry.revision,
})

/** AGENTS.md 条目无 frontmatter 标题，展示直接用相对路径。 */
const toAgentsEntry = (role: 'agents-root' | 'agents-nested', path: string): DocsIndexEntry => ({
  role,
  path,
  fileName: path.split('/').pop() ?? path,
  title: path,
  archived: false,
  revision: '',
})

/**
 * 扫描工作区的文档树。分组顺序（docs-view 设计稿树序）：项目指南（AGENTS.md）→
 * 根级文件（DESIGN.md）→ 四个受管目录（领域约束 → 任务规格 → 实施计划 → 实现现状）
 * → 子目录指南（任意目录深度的 AGENTS.md）。SDD 部分与提示词索引的分组顺序一致；
 * AGENTS.md 两组只进页面。`environment` 默认绑定到给定工作区；测试可注入伪环境。
 */
export const scanWorkspaceDocs = async (
  workspacePath?: string,
  environment: Pick<AgentEnvironment, 'workspace'> = createDesktopAgentEnvironment(workspacePath),
): Promise<WorkspaceDocsIndex> => {
  // 文档页树递归展开受管目录；提示词索引仍用默认的浅扫描（只收直接子项）。
  // 活跃配额用页面口径（宿主 list 能返回的全部直接子项）：页面是可浏览的全集面，
  // 与 `<available_docs>` 的 64 条元数据摘要线不应共用同一条截断线。
  const scan = await scanProjectDocs(environment, {
    includeNested: true,
    activeEntryLimit: MAX_DOC_PAGE_ROOT_ENTRIES,
  })
  const sddRoles: Array<{ role: ProjectDocRole; root: string | null }> = [
    ...ROOT_DOC_FILES.map(({ role }) => ({ role, root: null })),
    ...DOC_ROOTS.map(({ dir, role }) => ({ role, root: dir })),
  ]
  // AGENTS.md 发现：与 projectAgents.loadProjectAgents 同参数（pattern/limit/maxDepth），
  // 保证页面树与提示词 <available_agents> 索引看到同一集合。失败 fail-soft——
  // 两个指南组消失但不阻断 SDD 分组展示。
  const agentsRoot: DocsIndexEntry[] = []
  const agentsNested: DocsIndexEntry[] = []
  let agentsTruncated = false
  let agentsScanFailed = false
  try {
    // glob 双星前缀同样命中根 AGENTS.md（与 projectAgents.ts 的发现口径一致），
    // 根条目分到「项目指南」、其余分到「子目录指南」。
    const found = await environment.workspace.find({
      requestId: 'docs-view-agents-scan',
      pattern: NESTED_AGENTS_PATTERN,
      limit: MAX_NESTED_AGENTS_ENTRIES,
      maxDepth: MAX_NESTED_AGENTS_DEPTH,
      signal: new AbortController().signal,
    })
    agentsTruncated = found.truncated
    for (const match of found.matches) {
      if (match.kind !== 'file') continue
      if (match.path === AGENTS_ROOT_PATH) agentsRoot.push(toAgentsEntry('agents-root', match.path))
      else agentsNested.push(toAgentsEntry('agents-nested', match.path))
    }
    agentsNested.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  } catch {
    agentsScanFailed = true
  }
  return {
    // 全空且无诊断时仍返回完整分组骨架——页面据此区分「没扫描到」与「扫描失败」。
    groups: [
      {
        role: 'agents-root' as DocsGroupRole,
        root: null,
        entries: agentsRoot,
        archivedEntries: [],
        diagnostics: [],
        scanFailed: agentsScanFailed,
      },
      ...sddRoles.map(({ role, root }): DocsIndexGroup => ({
        role,
        root,
        entries: scan.inventory.entries
          .filter((entry) => entry.role === role)
          .map((entry) => toDocsIndexEntry(entry, false)),
        archivedEntries: scan.archivedEntries
          .filter((entry) => entry.role === role)
          .map((entry) => toDocsIndexEntry(entry, true)),
        diagnostics: scan.inventory.diagnostics.filter((diagnostic) => diagnostic.role === role),
      })),
      {
        role: 'agents-nested' as DocsGroupRole,
        root: './**/AGENTS.md',
        entries: agentsNested,
        archivedEntries: [],
        diagnostics: [],
        truncated: agentsTruncated,
      },
    ],
  }
}

/** 索引中是否存在任何可展示内容（条目或任一诊断，诊断需如实展示）。 */
export const docsIndexHasContent = (index: WorkspaceDocsIndex): boolean =>
  index.groups.some((group) =>
    group.entries.length > 0
    || group.archivedEntries.length > 0
    || group.diagnostics.length > 0
    || group.scanFailed === true)
