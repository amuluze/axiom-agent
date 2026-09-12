import type { SkillParseFailureReason } from './types'

/**
 * 极简行级 frontmatter parser（首版不引入 `yaml` 依赖）。
 *
 * 安全关键路径：它只认 frontmatter 内的 `key: value` 标量行，严格白名单
 * 字段，结构上不可能进入 YAML 的 alias/anchor/tag/merge 构造路径。任何
 * 非预期输入直接抛 {@link SkillParseError}（typed reason），失败候选绝不
 * 以部分字段进入 registry。
 *
 * 规则（对齐 docs/skills-extension.md §3.2）：
 * - frontmatter 必须从文件首行 `---` 开始，到下一个独占一行的 `---` 结束；
 * - metadata 区最大 8 KiB；
 * - 只接受 `---` 固定分隔符，不接受 `...` 或其它变体；
 * - 每行必须匹配 `^([a-z0-9-]+):\s*(.*)$`；不匹配（含空行/缩进/列表/
 *   引号键/注释/`<<` merge/`*alias`/`&anchor`/`!tag`）直接抛错；
 * - key 白名单 {name, description, disable-model-invocation}，未知 key 拒绝；
 * - 每个 key 只允许出现一次；
 * - `name`/`description` 值按原始字符串取值（不剥引号、不解析转义、不做
 *   Unicode 规范化），字段校验时 trim；
 * - `disable-model-invocation` 只接受字面 `true`/`false`；
 * - 解析结果必须是固定三字段的 plain object。
 *
 * 正文（结束 `---` 之后）原样返回；其 64 KiB 上限由 loader 的 bounded 读取
 * 保证，不在此处校验，也不做静默截断。
 */

export const METADATA_MAX_BYTES = 8 * 1024

const ALLOWED_FIELDS = new Set(['name', 'description', 'disable-model-invocation'])
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FIELD_LINE_PATTERN = /^([a-z0-9-]+):\s*(.*)$/
const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

export class SkillParseError extends Error {
  readonly code = 'SKILL_FRONTMATTER_INVALID'

  constructor(
    readonly reason: SkillParseFailureReason,
    message: string,
    readonly line?: number,
  ) {
    super(message)
    this.name = 'SkillParseError'
  }
}

export interface ParsedSkillFrontmatter {
  name: string
  description: string
  disableModelInvocation: boolean
  body: string
}

export const parseSkillFile = (content: string): ParsedSkillFrontmatter => {
  // 首行必须是 `---`（不处理 BOM/前导空白：不匹配即 missing_frontmatter）。
  if (!content.startsWith('---\n') && content !== '---') {
    throw new SkillParseError('missing_frontmatter', 'Skill 文件必须以首行 `---` 开始')
  }

  const lines = content.split('\n')

  // 找结束 `---`：独占一行（trim 后），只认 `---`，不接受 `...` 等变体。
  let endIndex = -1
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]!.trim() === '---') {
      endIndex = index
      break
    }
  }
  if (endIndex === -1) {
    throw new SkillParseError('missing_frontmatter', '缺少结束 `---` 分隔符')
  }

  // metadata 原始字节上限检查（在逐行匹配之前，避免超大输入耗尽处理）。
  const metadata = lines.slice(1, endIndex).join('\n')
  if (byteLength(metadata) > METADATA_MAX_BYTES) {
    throw new SkillParseError('metadata_too_large', `metadata 区超过 ${METADATA_MAX_BYTES} 字节上限`)
  }

  // 逐行匹配白名单 `key: value`；任何不匹配立即抛错（结构上不可能进入
  // alias/anchor/tag 构造路径）。
  const fields: Record<string, { value: string; line: number }> = {}
  for (let index = 1; index < endIndex; index++) {
    const line = lines[index]!
    const match = FIELD_LINE_PATTERN.exec(line)
    if (!match) {
      // 空行是最常见的迁移踩坑点（从其他工具复制带空行的 frontmatter），单独提示。
      const detail = line.trim() === ''
        ? 'frontmatter 内不允许空行（字段间也不能留空行）'
        : '不是合法的 `key: value` 标量行（缩进、列表、引号键、注释或 YAML 特殊符号均不允许）'
      throw new SkillParseError(
        'forbidden_syntax',
        `第 ${index + 1} 行${detail}`,
        index + 1,
      )
    }
    const key = match[1]!
    const value = match[2] ?? ''
    if (!ALLOWED_FIELDS.has(key)) {
      throw new SkillParseError('unknown_field', `未知字段 \`${key}\`（白名单：${Array.from(ALLOWED_FIELDS).join(', ')}）`, index + 1)
    }
    if (fields[key] !== undefined) {
      throw new SkillParseError('duplicate_key', `字段 \`${key}\` 重复出现`, index + 1)
    }
    fields[key] = { value, line: index + 1 }
  }

  // 校验字段值：全部成功后才产出不可变结果，失败即原子拒绝。
  const nameField = fields.name
  if (nameField === undefined) {
    throw new SkillParseError('invalid_scalar', '缺少必填字段 `name`')
  }
  const name = nameField.value.trim()
  if (name.length < 1 || name.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(name)) {
    throw new SkillParseError(
      'invalid_scalar',
      `\`name\` 必须匹配 ^[a-z0-9]+(?:-[a-z0-9]+)*$ 且长度 1–${MAX_NAME_LENGTH}`,
      nameField.line,
    )
  }

  const descriptionField = fields.description
  if (descriptionField === undefined) {
    throw new SkillParseError('invalid_scalar', '缺少必填字段 `description`')
  }
  const description = descriptionField.value.trim()
  if (description.length < 1 || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new SkillParseError(
      'invalid_scalar',
      `\`description\` trim 后长度必须在 1–${MAX_DESCRIPTION_LENGTH} 字符`,
      descriptionField.line,
    )
  }

  // disable-model-invocation 是软隔离标记：控制是否进入 <available_skills> 清单
  // （formatAvailableSkills 过滤），但不阻止 load_skill 加载（registry 不过滤）。
  // 详见 docs/skills-extension.md §6.4。
  let disableModelInvocation = false
  const flagField = fields['disable-model-invocation']
  if (flagField !== undefined) {
    if (flagField.value !== 'true' && flagField.value !== 'false') {
      throw new SkillParseError('invalid_scalar', '`disable-model-invocation` 只接受字面 true / false', flagField.line)
    }
    disableModelInvocation = flagField.value === 'true'
  }

  const body = lines.slice(endIndex + 1).join('\n')
  return { name, description, disableModelInvocation, body }
}
