import type {
  AgentEnvironment,
  WorkspaceListResult,
} from '@/agent/environment/AgentEnvironment'

/**
 * 项目文档（SDD 结构）扫描器：在授权工作区根内检测 `.specs/domain/`、
 * `.specs/tasks/`、`.plans/`、`.docs/` 四个目录的 Markdown 文档，生成一份
 * 结构化「文档索引」（role + title + 相对路径）供提示词注入。
 *
 * 与 Skills 机制的关键区别：文档是**可信的项目说明**而非不受信任指令，
 * 因此不冻结快照、不计算 contentSha256，模型按索引用现有 read 工具直接读
 * 当前磁盘内容。本模块只负责「索引发现」，不做正文加载。
 *
 * 全程 fail-soft：目录缺失/读取失败只跳过该目录或该文档，绝不阻断会话激活。
 */

export type ProjectDocRole = 'domain' | 'task' | 'plan' | 'doc'

export interface ProjectDocEntry {
  role: ProjectDocRole
  title: string
  relativePath: string
}

export interface ProjectDocInventory {
  entries: ProjectDocEntry[]
  /** 因单目录条目上限（MAX_DOC_ROOT_ENTRIES）被截断的文档总数——索引静默缩窄不可接受。 */
  truncatedEntryCount: number
  /**
   * 目录清单本身被宿主截断（Rust list 默认 200 条上限）的受管目录数——此时
   * 未列出的条目里可能还有更多 markdown 文档，条目计数只是下界，必须另行
   * 显式告知模型「可能还有未列入索引的文档」，不得静默缩窄。
   */
  truncatedRootCount: number
  /**
   * frontmatter 标记 `status: done` 的已归档文档数——归档是有意的生命周期收口
   * （任务完成后 finish 阶段标记，避免 .specs/tasks/.plans 无限累积挤占索引预算），
   * 但与截断一样必须显式计数告知，不得让模型误以为目录里只有索引列出的文档。
   */
  archivedCount: number
}

export const EMPTY_PROJECT_DOC_INVENTORY: ProjectDocInventory = {
  entries: [],
  truncatedEntryCount: 0,
  truncatedRootCount: 0,
  archivedCount: 0,
}

/**
 * 受管目录与其语义角色（对齐 sdd-methodology 三层模型 + 实现侧文档）。
 * 数组顺序即最终索引输出的分组顺序：领域约束 → 任务规格 → 实施计划 → 实现现状。
 */
export const DOC_ROOTS: ReadonlyArray<{ dir: string; role: ProjectDocRole }> = [
  { dir: '.specs/domain', role: 'domain' },
  { dir: '.specs/tasks', role: 'task' },
  { dir: '.plans', role: 'plan' },
  { dir: '.docs', role: 'doc' },
]

/** 每个受管目录直接条目处理上限（对齐 MAX_SKILL_ROOT_ENTRIES）。 */
export const MAX_DOC_ROOT_ENTRIES = 64

/** 提取 title 时读取每个文档的行数上限。 */
const TITLE_READ_LINES = 30

const fileStem = (path: string): string => {
  const name = path.split('/').pop() ?? path
  return name.endsWith('.md') ? name.slice(0, -'.md'.length) : name
}

/**
 * 从文档正文提取 title：跳过开头 frontmatter 块后取首个 H1 标题（`# ` 开头）；
 * 无 H1 时回退到文件名 stem。不引入 YAML parser，frontmatter 仅按 `---` 分隔线
 * 跳过，不做字段解析。
 */
const extractTitle = (content: string, fallback: string): string => {
  const lines = content.split('\n')
  let start = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    start = end === -1 ? 0 : end + 1
  }
  for (let index = start; index < lines.length; index += 1) {
    const match = /^#\s+(.+)$/.exec(lines[index] ?? '')
    const title = match?.[1]?.trim()
    if (title) return title
  }
  return fallback
}

/** 归档状态标记值：任务完成后由 finish 阶段写入 frontmatter（`status: done`）。 */
const ARCHIVED_STATUS_VALUE = 'done'

/**
 * 从文档头部内容判定是否已归档：frontmatter 块内 `status:` 值为 done 即归档。
 * 与 {@link extractTitle} 同源消费 head 内容（零额外读取）。行级匹配不引 YAML
 * parser；值严格小写 done，其余值（draft/in_progress/自定义）一律视为活跃——
 * 归档语义必须无歧义，宁可放过不可误伤活跃文档。
 */
const extractArchived = (content: string): boolean => {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') return false
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end === -1) return false
  for (let index = 1; index < end; index += 1) {
    const match = /^status:\s*(\S+)\s*$/.exec(lines[index] ?? '')
    if (match?.[1] === ARCHIVED_STATUS_VALUE) return true
  }
  return false
}

const readHead = async (
  workspace: AgentEnvironment['workspace'],
  relativePath: string,
  fallback: string,
): Promise<{ title: string; archived: boolean }> => {
  try {
    const read = await workspace.readText(relativePath, 1, TITLE_READ_LINES)
    return {
      title: extractTitle(read.content, fallback),
      archived: extractArchived(read.content),
    }
  } catch {
    // 读失败用文件名兜底、按活跃处理，不阻断扫描。
    return { title: fallback, archived: false }
  }
}

const listDocFiles = async (
  workspace: AgentEnvironment['workspace'],
  dir: string,
): Promise<{ files: string[]; truncated: number; rootTruncated: boolean }> => {
  let listing: WorkspaceListResult
  try {
    listing = await workspace.list(dir)
  } catch {
    // 目录缺失/未授权是正常状态，fail-soft 跳过。
    return { files: [], truncated: 0, rootTruncated: false }
  }
  // 宿主 list 有自身的条目上限（默认 200）：listing.truncated=true 时清单不是全集，
  // 未列出的条目里可能还有更多 markdown——无法精确计数，向上层传递截断事实。
  const markdown = listing.entries
    .filter((entry) => entry.kind === 'file' && entry.name.endsWith('.md'))
  return {
    files: markdown.slice(0, MAX_DOC_ROOT_ENTRIES).map((entry) => entry.path),
    truncated: Math.max(0, markdown.length - MAX_DOC_ROOT_ENTRIES),
    rootTruncated: listing.truncated,
  }
}

/**
 * 扫描受管目录，返回按 role 分组、组内按相对路径排序的文档索引。
 * list 返回顺序依赖 Rust list_impl 的确定性排序契约（file_name 小写），
 * 这里仍对组内路径做 localeCompare 兜底，保证跨机器结果一致。
 * frontmatter `status: done` 的文档不进索引（归档生命周期收口），计入 archivedCount。
 */
export const loadProjectDocs = async (
  environment: Pick<AgentEnvironment, 'workspace'>,
): Promise<ProjectDocInventory> => {
  const entries: ProjectDocEntry[] = []
  let truncatedEntryCount = 0
  let truncatedRootCount = 0
  let archivedCount = 0
  for (const { dir, role } of DOC_ROOTS) {
    const { files, truncated, rootTruncated } = await listDocFiles(environment.workspace, dir)
    truncatedEntryCount += truncated
    if (rootTruncated) truncatedRootCount += 1
    files.sort((left, right) => left.localeCompare(right, 'en'))
    for (const relativePath of files) {
      const fallback = fileStem(relativePath)
      const { title, archived } = await readHead(environment.workspace, relativePath, fallback)
      if (archived) {
        archivedCount += 1
        continue
      }
      entries.push({ role, title, relativePath })
    }
  }
  return { entries, truncatedEntryCount, truncatedRootCount, archivedCount }
}

/**
 * 两份索引是否逐项相同（role/路径/标题全等且顺序一致，归档计数一致）。
 * 会话运行结束后重扫磁盘用本函数决定是否重建提示词——索引未变化时
 * 不触碰 runtime manifest，避免每个 run 结束都产生一次依赖版本提交。
 */
export const projectDocInventoryEqual = (
  left: ProjectDocInventory,
  right: ProjectDocInventory,
): boolean => {
  if (left.entries.length !== right.entries.length) return false
  if (left.truncatedEntryCount !== right.truncatedEntryCount) return false
  if (left.truncatedRootCount !== right.truncatedRootCount) return false
  if (left.archivedCount !== right.archivedCount) return false
  return left.entries.every((entry, index) => {
    const other = right.entries[index]
    return other !== undefined
      && entry.role === other.role
      && entry.relativePath === other.relativePath
      && entry.title === other.title
  })
}
