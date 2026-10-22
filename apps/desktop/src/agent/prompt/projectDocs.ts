import {
  AgentEnvironmentError,
  type AgentEnvironment,
  type AgentEnvironmentErrorCode,
  type WorkspaceListResult,
} from '@/agent/environment/AgentEnvironment'

/**
 * 项目文档（SDD 结构）扫描器：在授权工作区根内检测 `.specs/domain/`、
 * `.specs/tasks/`、`.plans/`、`.docs/` 四个目录的 Markdown 文档，以及根级
 * 单文件 `DESIGN.md`（项目设计意图），生成一份结构化「文档索引」
 * （role + title + 相对路径）供提示词注入。
 *
 * 与 Skills 机制的关键区别：文档是**可信的项目说明**而非不受信任指令，
 * 因此不冻结正文快照，模型按索引用现有 read 工具直接读当前磁盘内容。索引携带
 * 宿主返回的全文 SHA-256 revision，用于正文变化检测，不承担内容信任或授权职能。
 *
 * 全程 fail-soft：目录/文件缺失、读取失败只跳过该来源，绝不阻断会话激活。
 */

export type ProjectDocRole = 'domain' | 'task' | 'plan' | 'doc' | 'design'

export interface ProjectDocEntry {
  role: ProjectDocRole
  title: string
  relativePath: string
  revision: string
}

export type ProjectDocDiagnosticCode =
  | 'root_list_failed'
  | 'root_list_truncated'
  | 'root_entry_limit'
  | 'nested_directories_omitted'
  | 'nested_scan_truncated'
  | 'file_read_failed'

export interface ProjectDocDiagnostic {
  code: ProjectDocDiagnosticCode
  root: string
  role: ProjectDocRole
  affectedCount: number
  reason?: AgentEnvironmentErrorCode
}

export interface ProjectDocInventory {
  entries: ProjectDocEntry[]
  /** 按扫描根聚合的结构化诊断；计数型兼容字段均由本数组派生。 */
  diagnostics: ProjectDocDiagnostic[]
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
  /**
   * 受管目录下的子目录数——索引只取一层，子目录里的文档完全不在索引中。
   * 与截断同口径：显式计数告知，避免模型把索引当全集。
   */
  nestedDirCount: number
  /**
   * 列举失败的受管目录数——与「目录为空」必须区分：目录缺失是正常状态（项目
   * 没用这套结构），列举失败是异常。此前两者同形，失败会让**整个 role 分组**
   * 从索引里消失且没有任何计数，`truncatedRootCount` 仍是 0，模型据此断言
   * 「这个项目没有领域约束文档」——比少几个条目严重得多。
   */
  failedRootCount: number
}

/**
 * 一次扫描的完整结果。提示词只消费 `inventory`；文档页还需要归档条目本身
 * （标题/路径），两者必须来自同一次扫描，否则两侧口径会再次分叉。
 */
export interface ProjectDocScan {
  inventory: ProjectDocInventory
  /** 已归档（status: done）条目；length 恒等于 inventory.archivedCount。 */
  archivedEntries: ProjectDocEntry[]
}

export const EMPTY_PROJECT_DOC_INVENTORY: ProjectDocInventory = {
  entries: [],
  diagnostics: [],
  truncatedEntryCount: 0,
  truncatedRootCount: 0,
  archivedCount: 0,
  nestedDirCount: 0,
  failedRootCount: 0,
}

/**
 * 受管目录与其语义角色（对齐 sdd-methodology 三层模型 + 实现侧文档）。
 * 数组顺序即最终索引输出的分组顺序：领域约束 → 任务规格 → 实施计划 → 实现现状
 * （根级 DESIGN.md 由 {@link ROOT_DOC_FILES} 先行探测，排在其前）。
 */
export const DOC_ROOTS: ReadonlyArray<{ dir: string; role: ProjectDocRole }> = [
  { dir: '.specs/domain', role: 'domain' },
  { dir: '.specs/tasks', role: 'task' },
  { dir: '.plans', role: 'plan' },
  { dir: '.docs', role: 'doc' },
]

/**
 * 根级单文件文档（非目录扫描）：目前只有 `DESIGN.md`——项目设计意图
 * （品牌/视觉/交互基调），设计任务的轻量入口。
 *
 * 与受管目录不同，它是工作区根下的**固定文件名**、没有目录可列：探测方式为
 * 按路径直接读头——真实 `readText` 对不存在的路径抛错，即「不存在」信号
 * （与目录缺失同为 fail-soft 跳过）。排序在受管目录**之前**：它是从零生成
 * 设计稿的第一输入，也是 32 KiB 索引预算下最该保证装入的条目。
 */
export const ROOT_DOC_FILES: ReadonlyArray<{ file: string; role: ProjectDocRole }> = [
  { file: 'DESIGN.md', role: 'design' },
]

/**
 * 每个受管目录进入 `<available_docs>` 的**活跃**条目上限（对齐 MAX_SKILL_ROOT_ENTRIES）。
 *
 * 配额按活跃条目计：`status: done` 的归档文档不占名额（归档的用途正是「不再挤占索引」，
 * 若按列举条目计，归档量大的目录会把活跃 Task Spec/Plan 整体挤出索引）。
 */
export const MAX_DOC_ROOT_ENTRIES = 64

/**
 * 文档页树的同口径上限：页面需要看到宿主 `list` 能返回的全部直接子项
 * （对齐 Rust `DEFAULT_LIST_LIMIT = 200`）。提示词索引仍用 64——`<available_docs>`
 * 是元数据预算约束下的摘要面，页面是可浏览的全集面，两者不应共用同一条截断线。
 */
export const MAX_DOC_PAGE_ROOT_ENTRIES = 200

/**
 * 受管与嵌套目录的列举上限：显式请求宿主上限（Rust `MAX_LIST_LIMIT = 1000`），
 * 不再依赖 `DEFAULT_LIST_LIMIT = 200` 的缺省值。
 *
 * 归档不再占活跃配额后，剩下的残余风险是「活跃文档排在宿主返回的 200 条之后而
 * 完全不可见」——目录里累积几百个已归档任务时可真实发生，且与筛选逻辑无关，
 * 纯粹是看不到。超限时宿主仍回报 `truncated`，`root_list_truncated` 诊断照常产生。
 */
export const DOC_LIST_LIMIT = 1000
export const DOC_HEAD_READ_CONCURRENCY = 8

/** 文档页树递归扫描的深度上限（受管目录的直接子目录为第 1 层）。 */
export const MAX_DOC_NESTED_DEPTH = 4
/** 文档页树每个受管目录额外收录的嵌套 Markdown 条目上限（不含直接子项）。 */
export const MAX_DOC_NESTED_ENTRIES = 256
/** 文档页树每个受管目录最多列举的嵌套目录数（防止宽树拖垮一次扫描）。 */
export const MAX_DOC_NESTED_DIRECTORIES = 256

export interface ProjectDocScanOptions {
  /**
   * 仅文档页树使用：递归收集受管目录下的 Markdown，使嵌套文档可浏览/可打开。
   * 提示词索引必须保持缺省 false——`<available_docs>` 只收录直接子项是契约。
   */
  includeNested?: boolean
  /**
   * 每个受管目录进入索引的**活跃**条目上限；缺省 {@link MAX_DOC_ROOT_ENTRIES}。
   * 文档页树传 {@link MAX_DOC_PAGE_ROOT_ENTRIES}。归档条目不受该上限约束
   * （它们不进活跃索引，只进 archivedCount 与页面归档区）。
   *
   * 放宽上限的代价是一次扫描要读更多文档头（归档判定必须逐份读头）；
   * 读头结果按 size/mtime 缓存，重复扫描只付 metadata 比较的代价。
   */
  activeEntryLimit?: number
}

/** 提取 title 时读取每个文档的行数上限。 */
const TITLE_READ_LINES = 30

interface DocFileCandidate {
  relativePath: string
  workspacePath: string
  sizeBytes: number
  modifiedMs?: number
}

interface CachedDocHead {
  sizeBytes: number
  modifiedMs: number
  verifiedAt: number
  title: string
  archived: boolean
  revision: string
}

/** metadata 命中时复用 revision 的最长时间；防止 size/mtime 均未变的极端外部写入长期漏检。 */
const REVISION_CACHE_MAX_AGE_MS = 10 * 60 * 1000
const MAX_REVISION_CACHE_ENTRIES = 4096
const revisionCache = new Map<string, CachedDocHead>()

/** 测试/诊断用：清空 revision 缓存，避免跨用例的 metadata 命中污染。 */
export const clearProjectDocRevisionCache = (): void => {
  revisionCache.clear()
}

const revisionCacheKey = (
  workspacePath: string,
  role: ProjectDocRole,
  relativePath: string,
): string => `${workspacePath}\0${role}\0${relativePath}`

const fileStem = (path: string): string => {
  const name = path.split('/').pop() ?? path
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -'.md'.length) : name
}

const errorReason = (error: unknown): AgentEnvironmentErrorCode =>
  error instanceof AgentEnvironmentError ? error.code : 'unknown'

/**
 * 从文档正文提取 title：跳过开头 frontmatter 块后取首个 H1 标题（`# ` 开头）；
 * 无 H1 时回退到文件名 stem。不引入 YAML parser，frontmatter 仅按 `---` 分隔线
 * 跳过，不做字段解析。
 */
export const extractTitle = (content: string, fallback: string): string => {
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
 *
 * **只有任务类产物参与归档**（`.specs/tasks` / `.plans`）。Domain Spec、`.docs/`
 * 与根 DESIGN.md 都是长期/活文档：误写 `status: done` 不生效，也不计入归档计数。
 * 否则一条手滑的 frontmatter 就会把长期约束或设计基调静默移出活跃索引。
 */
const ARCHIVABLE_ROLES: ReadonlySet<ProjectDocRole> = new Set(['task', 'plan'])

export const extractArchived = (content: string, role: ProjectDocRole): boolean => {
  if (!ARCHIVABLE_ROLES.has(role)) return false
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
  candidate: DocFileCandidate,
  fallback: string,
  role: ProjectDocRole,
): Promise<{
  entry: ProjectDocEntry | null
  archived: boolean
  failureReason?: AgentEnvironmentErrorCode
}> => {
  const cacheKey = candidate.modifiedMs === undefined
    ? null
    : revisionCacheKey(candidate.workspacePath, role, candidate.relativePath)
  const cached = cacheKey ? revisionCache.get(cacheKey) : undefined
  if (
    cacheKey
    && cached
    && cached.sizeBytes === candidate.sizeBytes
    && cached.modifiedMs === candidate.modifiedMs
    && Date.now() - cached.verifiedAt <= REVISION_CACHE_MAX_AGE_MS
  ) {
    return {
      entry: {
        role,
        title: cached.title,
        relativePath: candidate.relativePath,
        revision: cached.revision,
      },
      archived: cached.archived,
    }
  }
  try {
    const read = await workspace.readText(candidate.relativePath, 1, TITLE_READ_LINES)
    const title = extractTitle(read.content, fallback)
    const archived = extractArchived(read.content, role)
    if (cacheKey && candidate.modifiedMs !== undefined) {
      if (revisionCache.size >= MAX_REVISION_CACHE_ENTRIES) revisionCache.clear()
      revisionCache.set(cacheKey, {
        sizeBytes: candidate.sizeBytes,
        modifiedMs: candidate.modifiedMs,
        verifiedAt: Date.now(),
        title,
        archived,
        revision: read.sha256,
      })
    }
    return {
      entry: {
        role,
        title,
        relativePath: candidate.relativePath,
        revision: read.sha256,
      },
      archived,
    }
  } catch (error) {
    if (cacheKey) revisionCache.delete(cacheKey)
    const reason = errorReason(error)
    // 读头失败不进入索引：标题/归档状态都未确认，用文件名兜底会把「不可读」
    // 伪装成完整条目。not_found 是列举后文件消失的正常竞态，静默跳过；
    // 其它失败保留结构化诊断，让模型知道该路径存在但未能确认。
    return {
      entry: null,
      archived: false,
      failureReason: reason === 'not_found' ? undefined : reason,
    }
  }
}

const listDocFiles = async (
  workspace: AgentEnvironment['workspace'],
  dir: string,
  role: ProjectDocRole,
  includeNested: boolean,
): Promise<{
  files: DocFileCandidate[]
  workspacePath: string
  rootTruncated: boolean
  nestedDirCount: number
  nestedDirectories: string[]
  diagnostics: ProjectDocDiagnostic[]
}> => {
  let listing: WorkspaceListResult
  try {
    listing = await workspace.list(dir, DOC_LIST_LIMIT)
  } catch (error) {
    // 目录缺失是部分采用 SDD 的正常状态；其他错误才是清单不完整。
    const reason = errorReason(error)
    return {
      files: [],
      workspacePath: '',
      rootTruncated: false,
      nestedDirCount: 0,
      nestedDirectories: [],
      diagnostics: reason === 'not_found'
        ? []
        : [{
            code: 'root_list_failed',
            root: dir,
            role,
            affectedCount: 1,
            reason,
          }],
    }
  }
  // 宿主 list 有自身的条目上限（默认 200）：listing.truncated=true 时清单不是全集，
  // 未列出的条目里可能还有更多 markdown——无法精确计数，向上层传递截断事实。
  const markdown = listing.entries
    .filter((entry) => entry.kind === 'file' && entry.name.toLowerCase().endsWith('.md'))
  // 不在这里按条目数截断：活跃配额必须在读头判定归档之后才消耗（见 scanProjectDocs），
  // 否则归档文档会白占名额，把活跃 Task Spec/Plan 挤出索引。上界由宿主 list 自身
  // 的条目上限承担（超出即 listing.truncated → root_list_truncated 诊断）。
  const nestedDirectories = listing.entries
    .filter((entry) => entry.kind === 'directory')
    .map((entry) => entry.path)
  const nestedDirCount = nestedDirectories.length
  const diagnostics: ProjectDocDiagnostic[] = []
  if (listing.truncated) {
    diagnostics.push({ code: 'root_list_truncated', root: dir, role, affectedCount: 1 })
  }
  if (!includeNested && nestedDirCount > 0) {
    // 提示词索引只取一层（不递归）。子目录里的文档完全不在索引中，且不进任何
    // 既有计数——模型会把索引当全集。计数并显式告知，否则「静默缩窄」不可接受。
    diagnostics.push({
      code: 'nested_directories_omitted',
      root: dir,
      role,
      affectedCount: nestedDirCount,
    })
  }
  const workspacePath = listing.workspace.path
  return {
    files: markdown.map((entry) => ({
      relativePath: entry.path,
      workspacePath,
      sizeBytes: entry.sizeBytes,
      modifiedMs: entry.modifiedMs,
    })),
    workspacePath,
    rootTruncated: listing.truncated,
    nestedDirCount,
    nestedDirectories,
    diagnostics,
  }
}

/**
 * 文档页树专用的递归收集：从受管目录的直接子目录开始，广度优先读取嵌套
 * Markdown。深度/条目超限与嵌套目录列举失败都必须形成诊断，不得静默缩窄。
 * 提示词索引不调用本函数（保持只收直接子项）。
 */
const collectNestedDocFiles = async (
  workspace: AgentEnvironment['workspace'],
  root: string,
  role: ProjectDocRole,
  directories: string[],
  workspacePath: string,
): Promise<{ files: DocFileCandidate[]; diagnostics: ProjectDocDiagnostic[] }> => {
  const files: DocFileCandidate[] = []
  const diagnostics: ProjectDocDiagnostic[] = []
  let omitted = 0
  let listedDirectories = 0
  const queue = directories.map((path) => ({ path, depth: 1 }))
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    if (current.depth > MAX_DOC_NESTED_DEPTH) {
      omitted += 1
      continue
    }
    if (listedDirectories >= MAX_DOC_NESTED_DIRECTORIES) {
      omitted += 1
      continue
    }
    listedDirectories += 1
    let listing: WorkspaceListResult
    try {
      listing = await workspace.list(current.path, DOC_LIST_LIMIT)
    } catch (error) {
      const reason = errorReason(error)
      // 嵌套目录在列举后被删除是正常竞态；其余失败必须如实报告。
      if (reason !== 'not_found') {
        diagnostics.push({
          code: 'root_list_failed',
          root: current.path,
          role,
          affectedCount: 1,
          reason,
        })
      }
      continue
    }
    if (listing.truncated) {
      diagnostics.push({
        code: 'root_list_truncated',
        root: current.path,
        role,
        affectedCount: 1,
      })
    }
    for (const entry of listing.entries) {
      if (entry.kind === 'directory') {
        queue.push({ path: entry.path, depth: current.depth + 1 })
      } else if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.md')) {
        if (files.length >= MAX_DOC_NESTED_ENTRIES) omitted += 1
        else files.push({
          relativePath: entry.path,
          workspacePath: listing.workspace.path || workspacePath,
          sizeBytes: entry.sizeBytes,
          modifiedMs: entry.modifiedMs,
        })
      }
    }
  }
  if (omitted > 0) {
    diagnostics.push({
      code: 'nested_scan_truncated',
      root,
      role,
      affectedCount: omitted,
    })
  }
  return { files, diagnostics }
}

/**
 * 探测一个根级单文件文档：按路径读头。not_found 静默跳过；其它读取错误记为
 * file_read_failed 诊断、不阻断扫描。归档标记随条目返回（archived 标志），
 * 由调用方分流进活跃索引或归档计数。
 */
const probeRootDocFile = async (
  workspace: AgentEnvironment['workspace'],
  file: string,
  role: ProjectDocRole,
): Promise<{
  entry: ProjectDocEntry | null
  archived: boolean
  diagnostic?: ProjectDocDiagnostic
}> => {
  try {
    const read = await workspace.readText(file, 1, TITLE_READ_LINES)
    return {
      entry: {
        role,
        title: extractTitle(read.content, fileStem(file)),
        relativePath: file,
        revision: read.sha256,
      },
      archived: extractArchived(read.content, role),
    }
  } catch (error) {
    // 文件不存在或读取失败：fail-soft 跳过，不阻断扫描。
    const reason = errorReason(error)
    return {
      entry: null,
      archived: false,
      diagnostic: reason === 'not_found'
        ? undefined
        : {
            code: 'file_read_failed',
            root: file,
            role,
            affectedCount: 1,
            reason,
          },
    }
  }
}

/**
 * 扫描受管目录，返回按 role 分组、组内按相对路径排序的文档索引。
 * 顺序：根级单文件文档（DESIGN.md）→ 四个受管目录（领域约束 → 任务规格 →
 * 实施计划 → 实现现状）。
 * list 返回顺序依赖 Rust list_impl 的确定性排序契约（file_name 小写），
 * 这里仍对组内路径做 localeCompare 兜底，保证跨机器结果一致。
 * frontmatter `status: done` 的文档不进索引（归档生命周期收口），计入 archivedCount。
 *
 * 活跃条目配额（`activeEntryLimit`，缺省 {@link MAX_DOC_ROOT_ENTRIES}）在读头判定归档
 * **之后**按目录消耗：归档文档自己退出索引，不得继续占用活跃名额（否则归档量大的
 * 目录会把活跃 Task Spec/Plan 整体挤出索引）。超额活跃条目计入 `root_entry_limit` 诊断。
 *
 * 缺省为提示词索引的浅扫描（受管目录只收直接子项）。`includeNested` 仅供文档页树
 * 递归展开嵌套 Markdown；提示词调用方不得开启，否则会改变 `<available_docs>` 契约。
 */
export const scanProjectDocs = async (
  environment: Pick<AgentEnvironment, 'workspace'>,
  options: ProjectDocScanOptions = {},
): Promise<ProjectDocScan> => {
  const includeNested = options.includeNested === true
  const activeEntryLimit = Math.max(1, Math.floor(options.activeEntryLimit ?? MAX_DOC_ROOT_ENTRIES))
  const entries: ProjectDocEntry[] = []
  const archivedEntries: ProjectDocEntry[] = []
  const diagnostics: ProjectDocDiagnostic[] = []
  for (const { file, role } of ROOT_DOC_FILES) {
    const { entry, archived, diagnostic } = await probeRootDocFile(
      environment.workspace,
      file,
      role,
    )
    if (entry && archived) archivedEntries.push(entry)
    else if (entry) entries.push(entry)
    if (diagnostic) diagnostics.push(diagnostic)
  }
  const scannedRoots = await Promise.all(DOC_ROOTS.map(async ({ dir, role }) => ({
    dir,
    role,
    result: await listDocFiles(environment.workspace, dir, role, includeNested),
  })))
  const nestedResults = await Promise.all(scannedRoots.map(({ dir, role, result }) =>
    includeNested && result.nestedDirectories.length > 0
      ? collectNestedDocFiles(
          environment.workspace,
          dir,
          role,
          result.nestedDirectories,
          result.workspacePath,
        )
      : Promise.resolve({ files: [], diagnostics: [] })))
  const pendingFiles: Array<DocFileCandidate & { root: string; role: ProjectDocRole }> = []
  for (const [index, { dir: root, role, result }] of scannedRoots.entries()) {
    diagnostics.push(...result.diagnostics)
    diagnostics.push(...(nestedResults[index]?.diagnostics ?? []))
    const files = [...result.files, ...(nestedResults[index]?.files ?? [])]
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'))
    pendingFiles.push(...files.map((file) => ({ ...file, root, role })))
  }
  // 读头结果按扫描序下标回填：并发读取的完成顺序不得影响索引输出顺序。
  const headResults = new Array<{ entry: ProjectDocEntry; archived: boolean } | undefined>(pendingFiles.length)
  const readFailureReasons = new Array<AgentEnvironmentErrorCode | undefined>(pendingFiles.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < pendingFiles.length) {
      const index = cursor
      cursor += 1
      const pending = pendingFiles[index]
      if (!pending) continue
      const { relativePath, role } = pending
      const { entry, archived, failureReason } = await readHead(
        environment.workspace,
        pending,
        fileStem(relativePath),
        role,
      )
      readFailureReasons[index] = failureReason
      if (entry) headResults[index] = { entry, archived }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(DOC_HEAD_READ_CONCURRENCY, pendingFiles.length) },
    worker,
  ))
  // 归档分流与活跃配额同在读头之后：归档条目不限量（它们不进活跃索引），
  // 活跃条目按 root 各自消耗配额，超额部分转为 root_entry_limit 诊断。
  const activeCountByRoot = new Map<string, number>()
  const omittedByRoot = new Map<string, number>()
  for (const [index, head] of headResults.entries()) {
    if (!head) continue
    const pending = pendingFiles[index]
    if (!pending) continue
    if (head.archived) {
      archivedEntries.push(head.entry)
      continue
    }
    const used = activeCountByRoot.get(pending.root) ?? 0
    if (used >= activeEntryLimit) {
      omittedByRoot.set(pending.root, (omittedByRoot.get(pending.root) ?? 0) + 1)
      continue
    }
    activeCountByRoot.set(pending.root, used + 1)
    entries.push(head.entry)
  }
  // 按受管目录顺序输出配额诊断，保证诊断顺序跨扫描稳定（UI 与提示词都依赖）。
  for (const { dir: root, role } of scannedRoots) {
    const omitted = omittedByRoot.get(root)
    if (!omitted) continue
    diagnostics.push({ code: 'root_entry_limit', root, role, affectedCount: omitted })
  }
  const readFailures = new Map<string, ProjectDocDiagnostic>()
  for (const [index, failureReason] of readFailureReasons.entries()) {
    const pending = pendingFiles[index]
    if (!failureReason || !pending) continue
    const key = `${pending.root}\0${failureReason}`
    const current = readFailures.get(key)
    readFailures.set(key, current
      ? { ...current, affectedCount: current.affectedCount + 1 }
      : {
          code: 'file_read_failed',
          root: pending.root,
          role: pending.role,
          affectedCount: 1,
          reason: failureReason,
        })
  }
  diagnostics.push(...readFailures.values())
  const truncatedEntryCount = diagnostics
    .filter((item) => item.code === 'root_entry_limit')
    .reduce((total, item) => total + item.affectedCount, 0)
  const truncatedRootCount = diagnostics
    .filter((item) => item.code === 'root_list_truncated').length
  const nestedDirCount = diagnostics
    .filter((item) => item.code === 'nested_directories_omitted')
    .reduce((total, item) => total + item.affectedCount, 0)
  const failedRootCount = diagnostics
    .filter((item) => item.code === 'root_list_failed').length
  return {
    inventory: {
      entries,
      diagnostics,
      truncatedEntryCount,
      truncatedRootCount,
      archivedCount: archivedEntries.length,
      nestedDirCount,
      failedRootCount,
    },
    archivedEntries,
  }
}

export const loadProjectDocs = async (
  environment: Pick<AgentEnvironment, 'workspace'>,
): Promise<ProjectDocInventory> => (await scanProjectDocs(environment)).inventory

/**
 * 索引元数据比较（role/路径/标题/计数/诊断，顺序一致）；`includeRevision` 控制
 * 是否把完整 SHA 也纳入。提示词重建用忽略 revision 的版本，UI 刷新信号用完整版本。
 */
const projectDocInventoryMetadataEqual = (
  left: ProjectDocInventory,
  right: ProjectDocInventory,
  includeRevision: boolean,
): boolean => {
  if (left.entries.length !== right.entries.length) return false
  if (left.truncatedEntryCount !== right.truncatedEntryCount) return false
  if (left.truncatedRootCount !== right.truncatedRootCount) return false
  if (left.archivedCount !== right.archivedCount) return false
  if (left.nestedDirCount !== right.nestedDirCount) return false
  if (left.failedRootCount !== right.failedRootCount) return false
  if (left.diagnostics.length !== right.diagnostics.length) return false
  if (!left.diagnostics.every((diagnostic, index) => {
    const other = right.diagnostics[index]
    return other !== undefined
      && diagnostic.code === other.code
      && diagnostic.root === other.root
      && diagnostic.role === other.role
      && diagnostic.affectedCount === other.affectedCount
      && diagnostic.reason === other.reason
  })) return false
  return left.entries.every((entry, index) => {
    const other = right.entries[index]
    return other !== undefined
      && entry.role === other.role
      && entry.relativePath === other.relativePath
      && entry.title === other.title
      && (!includeRevision || entry.revision === other.revision)
  })
}

/**
 * 完整索引相等：包含 revision。用于 UI 刷新信号等「正文变化也算变化」的场景。
 */
export const projectDocInventoryEqual = (
  left: ProjectDocInventory,
  right: ProjectDocInventory,
): boolean => projectDocInventoryMetadataEqual(left, right, true)

/**
 * 提示词可见内容相等：忽略 revision。`<available_docs>` 不再渲染 revision，
 * 因此纯正文编辑不应触发 `runtime_dependencies_update` / checkpoint 失效；
 * 标题、路径、归档状态、诊断等模型可见元数据变化仍会触发重建。
 */
export const projectDocPromptInventoryEqual = (
  left: ProjectDocInventory,
  right: ProjectDocInventory,
): boolean => projectDocInventoryMetadataEqual(left, right, false)
