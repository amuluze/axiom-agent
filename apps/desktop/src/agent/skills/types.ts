/**
 * Skills 扩展机制的数据契约（首版仅项目级 Skill）。
 *
 * 设计要点（对齐 docs/skills-extension.md §3.3）：
 * - 所有 location 都是工作区相对路径，不保存绝对路径；
 * - snapshot 构建后不可原地修改（structuredClone + 不可变对象）；
 * - 规范化：skills 按 ASCII name 排序、source 字段顺序固定、path 使用 `/`、
 *   description trim 但正文不改、contentSha256 覆盖 canonical 字段 + LF 正文。
 */

export type ProjectSkillSource = {
  kind: 'project'
  root: '.axiom/skills'
}

export interface ProjectSkillDependency {
  name: string
  description: string
  source: ProjectSkillSource
  relativePath: string
  baseRelativePath: string
  contentSha256: string
  /**
   * 软隔离标记：true 时该 Skill 不进入系统提示词的 <available_skills> 清单
   * （formatAvailableSkills 过滤），降低模型自动触发概率。但这是**软隔离非硬隔离**——
   * load_skill 的 registry 不过滤此标记，模型若从用户 `$name` 或会话上下文得知
   * 名字仍可加载。详见 docs/skills-extension.md §6.4 / §7.1。
   */
  disableModelInvocation: boolean
}

export interface ProjectSkillInventorySnapshot {
  schemaVersion: 1
  skills: ProjectSkillDependency[]
}

export const EMPTY_PROJECT_SKILL_INVENTORY: ProjectSkillInventorySnapshot = {
  schemaVersion: 1,
  skills: [],
}

/**
 * 极简行级 parser 的封闭失败原因集合。任何新增字段/语法能力必须先扩展
 * 该集合并同步 §14.3 测试，禁止用"解析失败"这类非 typed 结果替代。
 */
export type SkillParseFailureReason =
  | 'missing_frontmatter'
  | 'metadata_too_large'
  | 'unknown_field'
  | 'duplicate_key'
  | 'invalid_scalar'
  | 'forbidden_syntax' // 缩进 / 列表 / 引号键 / 注释 / YAML 特殊符号

/**
 * 独立诊断通道（不写入 RuntimeHookDiagnostics）。不包含 Skill 正文。
 */
export type SkillDiagnosticCode =
  | 'invalid_frontmatter'
  | 'invalid_name'
  | 'collision'
  | 'too_large'
  | 'inventory_truncated'
  | 'metadata_budget_exceeded'
  | 'content_changed'
  | 'unavailable'

export interface SkillDiagnostic {
  code: SkillDiagnosticCode
  source: ProjectSkillSource
  relativePath: string
  message: string
  timestamp: number
  /** invalid_frontmatter 时携带 §7.2 的安全枚举，不回传原始 frontmatter。 */
  reason?: SkillParseFailureReason
  /** frontmatter 解析错误所在行号（1-based，可选）。 */
  line?: number
}
