import { sha256Text } from '@/agent/tools/workspaceToolUtils'

/**
 * Skill 内容的 canonical 序列化与哈希（对齐 docs/skills-extension.md §3.3）：
 * - `contentSha256` 覆盖 canonical 的 name/description/disableModelInvocation
 *   + 规范化正文（换行统一为 LF）；
 * - 未知字段和 YAML 表面写法不参与 hash；
 * - 该 digest 是"会话依赖变化检测值"，不是授权 token 或内容真实性证明。
 */

export interface SkillFrontmatterLike {
  name: string
  description: string
  disableModelInvocation: boolean
}

export const normalizeSkillBody = (body: string): string => body.replace(/\r\n/g, '\n')

export const canonicalizeSkillContent = (
  frontmatter: SkillFrontmatterLike,
  body: string,
): string =>
  JSON.stringify({
    name: frontmatter.name,
    description: frontmatter.description,
    disableModelInvocation: frontmatter.disableModelInvocation,
    body: normalizeSkillBody(body),
  })

export const hashSkillContent = async (
  frontmatter: SkillFrontmatterLike,
  body: string,
): Promise<string> => sha256Text(canonicalizeSkillContent(frontmatter, body))
