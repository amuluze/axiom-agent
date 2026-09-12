import type {
  AgentEnvironment,
  WorkspaceListResult,
} from '@/agent/environment/AgentEnvironment'
import { hashSkillContent } from './canonical'
import { METADATA_MAX_BYTES, parseSkillFile, SkillParseError } from './parseSkillFile'
import type {
  ProjectSkillDependency,
  ProjectSkillInventorySnapshot,
  ProjectSkillSource,
  SkillDiagnostic,
  SkillDiagnosticCode,
} from './types'
import { EMPTY_PROJECT_SKILL_INVENTORY } from './types'

/**
 * 首版只扫描 `.axiom/skills` 一个固定根的一层候选（对齐
 * docs/skills-extension.md §3.1 / §8.1）。不递归、拒绝 symlink、不使用
 * `.axiomignore`、不引入 `.agents/skills` 兼容根。
 *
 * 全程 fail-soft：根目录缺失/读取失败 → empty snapshot + 对应 diagnostic，
 * 绝不阻断会话创建或提示词组装；单个候选解析失败只产生 diagnostic，其他
 * 候选按确定顺序继续，但 registry 中绝不出现该候选的部分字段。
 */

export const PROJECT_SKILLS_ROOT = '.axiom/skills'
export const SKILL_MD_FILENAME = 'SKILL.md'
export const MAX_SKILL_ROOT_ENTRIES = 64
export const MAX_PROJECT_SKILLS = 32
export const MAX_SKILL_BODY_BYTES = 64 * 1024

const READ_PAGE_LINES = 500

export interface LoadProjectSkillsResult {
  snapshot: ProjectSkillInventorySnapshot
  diagnostics: SkillDiagnostic[]
}

const source = (): ProjectSkillSource => ({ kind: 'project', root: PROJECT_SKILLS_ROOT })

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

type BoundedRead =
  | { ok: true; content: string }
  | { ok: false; reason: SkillDiagnosticCode }

/**
 * 分页读取 Skill 文件到 EOF，累计原始字节超过 metadata + body 上限立即
 * 拒绝（不做静默截断）。任何页缺失、offset 不连续或返回异常都不能拿不完整
 * 内容计算 hash（fail-closed）。`signal` 可选的调用方可取消（load_skill 工具
 * 透传父工具 signal）；中止时抛 AbortError，由执行层转 isError。
 */
export const readSkillFileBounded = async (
  workspace: AgentEnvironment['workspace'],
  relativePath: string,
  signal?: AbortSignal,
): Promise<BoundedRead> => {
  const maxBytes = METADATA_MAX_BYTES + MAX_SKILL_BODY_BYTES
  let accumulated = ''
  let offset: number | undefined
  let noProgress = 0
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const page = await workspace.readText(relativePath, offset, READ_PAGE_LINES)
      accumulated += page.content
      if (byteLength(accumulated) > maxBytes) return { ok: false, reason: 'too_large' }
      const next = page.truncated ? page.nextOffset : undefined
      if (next === undefined) break
      if (next === offset) {
        noProgress += 1
        // nextOffset 连续停滞说明底层 read 异常：fail-closed 返回 unavailable，
        // 不把可能不完整的 accumulated 交给下游（否则会用它算 hash，在 load_skill
        // 阶段误报为 SkillChangedError，错误归因到「skill 被改」而非底层读异常）。
        if (noProgress >= 3) return { ok: false, reason: 'unavailable' }
      }
      offset = next
    }
    return { ok: true, content: accumulated }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return { ok: false, reason: 'unavailable' }
  }
}

interface SkillCandidate {
  kind: 'directory' | 'file'
  name: string
  relativePath: string
  baseRelativePath: string
}

export const loadProjectSkills = async (
  environment: Pick<AgentEnvironment, 'workspace'>,
): Promise<LoadProjectSkillsResult> => {
  const diagnostics: SkillDiagnostic[] = []
  const timestamp = Date.now()
  const push = (
    code: SkillDiagnosticCode,
    relativePath: string,
    message: string,
    reason?: SkillDiagnostic['reason'],
    line?: number,
  ): void => {
    diagnostics.push({ code, source: source(), relativePath, message, timestamp, ...(reason ? { reason } : {}), ...(line !== undefined ? { line } : {}) })
  }

  let listing: WorkspaceListResult
  try {
    listing = await environment.workspace.list(PROJECT_SKILLS_ROOT)
  } catch {
    // 根目录缺失/未授权是正常状态：fail-soft 返回空 snapshot，不产 diagnostic。
    return { snapshot: EMPTY_PROJECT_SKILL_INVENTORY, diagnostics }
  }

  const candidates: SkillCandidate[] = []
  // 截断依赖 workspace.list 的确定性排序契约：Rust 侧 list_impl 按 file_name
  // 小写形式稳定排序（见 workspace_access.rs::list_impl），DEFAULT_LIST_LIMIT(200)
  // > MAX_SKILL_ROOT_ENTRIES(64)，故 slice(0,64) 在跨机器/跨运行上选取的条目集合
  // 是确定的。本层不二次排序 listing——仅在下方候选解析成功后按 ASCII name 排序
  // 保证最终 snapshot 稳定。若未来 list 的排序契约改变，需在此补充防御性排序。
  const directEntries = listing.entries.slice(0, MAX_SKILL_ROOT_ENTRIES)
  if (listing.entries.length > MAX_SKILL_ROOT_ENTRIES) {
    push('inventory_truncated', PROJECT_SKILLS_ROOT, `扫描根直接条目超过 ${MAX_SKILL_ROOT_ENTRIES}，仅处理前 ${MAX_SKILL_ROOT_ENTRIES} 个`)
  }
  for (const entry of directEntries) {
    if (entry.kind === 'directory') {
      candidates.push({
        kind: 'directory',
        name: entry.name,
        relativePath: `${entry.path}/${SKILL_MD_FILENAME}`,
        baseRelativePath: entry.path,
      })
    } else if (entry.kind === 'file' && entry.name.endsWith('.md')) {
      const stem = entry.name.slice(0, -'.md'.length)
      candidates.push({
        kind: 'file',
        name: stem,
        relativePath: entry.path,
        baseRelativePath: PROJECT_SKILLS_ROOT,
      })
    } else if (entry.kind === 'symlink') {
      push('unavailable', entry.path, 'symlink 候选直接拒绝，避免来源和 baseDir 漂移')
    }
    // kind 'other' 或非 .md 文件：忽略
  }

  // 同根同名冲突（目录 + 单文件）：全部拒绝，不依赖文件系统枚举顺序。
  const namesByCandidate = new Map<string, string[]>()
  for (const candidate of candidates) {
    const paths = namesByCandidate.get(candidate.name) ?? []
    paths.push(candidate.relativePath)
    namesByCandidate.set(candidate.name, paths)
  }

  const skills: ProjectSkillDependency[] = []
  for (const candidate of candidates) {
    const conflicted = (namesByCandidate.get(candidate.name) ?? []).length > 1
    if (conflicted) {
      push('collision', candidate.relativePath, `同根同名候选冲突（${candidate.name}），目录形态与单文件形态全部拒绝`)
      continue
    }

    const read = await readSkillFileBounded(environment.workspace, candidate.relativePath)
    if (!read.ok) {
      push(read.reason, candidate.relativePath, read.reason === 'too_large' ? 'Skill 文件超过 metadata + 正文字节上限' : 'Skill 文件读取失败')
      continue
    }

    let parsed: ReturnType<typeof parseSkillFile>
    try {
      parsed = parseSkillFile(read.content)
    } catch (error) {
      if (error instanceof SkillParseError) {
        push('invalid_frontmatter', candidate.relativePath, error.message, error.reason, error.line)
      } else {
        push('invalid_frontmatter', candidate.relativePath, 'frontmatter 解析失败')
      }
      continue
    }

    // frontmatter name 必须与目录名/文件 stem 一致。
    if (parsed.name !== candidate.name) {
      push('invalid_name', candidate.relativePath, `frontmatter name（${parsed.name}）与目录名/文件 stem（${candidate.name}）不一致`)
      continue
    }

    if (byteLength(parsed.body) > MAX_SKILL_BODY_BYTES) {
      push('too_large', candidate.relativePath, `Skill 正文超过 ${MAX_SKILL_BODY_BYTES} 字节上限`)
      continue
    }

    const contentSha256 = await hashSkillContent(parsed, parsed.body)
    skills.push({
      name: parsed.name,
      description: parsed.description,
      source: source(),
      relativePath: candidate.relativePath,
      baseRelativePath: candidate.baseRelativePath,
      contentSha256,
      disableModelInvocation: parsed.disableModelInvocation,
    })
  }

  // 规范化：按 ASCII name 排序，保证不同机器结果一致；再应用有效数量上限。
  skills.sort((left, right) => left.name.localeCompare(right.name, 'en'))
  const selected = skills.slice(0, MAX_PROJECT_SKILLS)
  if (skills.length > MAX_PROJECT_SKILLS) {
    push('inventory_truncated', PROJECT_SKILLS_ROOT, `有效 project skills 超过 ${MAX_PROJECT_SKILLS}，跳过 ${skills.length - MAX_PROJECT_SKILLS} 个`)
  }

  return { snapshot: { schemaVersion: 1, skills: selected }, diagnostics }
}
