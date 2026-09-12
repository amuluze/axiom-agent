import type { ProjectSkillInventorySnapshot } from './types'

/**
 * 对比当前会话冻结的 Skill 快照与重新扫描结果，产出 reload 的 diff。
 * - `added`：新扫描有、当前无；
 * - `removed`：当前有、新扫描无；
 * - `changed`：两边都有但 contentSha256 不同（正文/frontmatter 变化）。
 * 供设置-技能页展示"新增/删除/内容变化"并让用户确认后应用（docs/skills-extension.md §7.3）。
 */

export interface ProjectSkillDiff {
  added: string[]
  removed: string[]
  changed: string[]
}

export const diffProjectSkills = (
  current: ProjectSkillInventorySnapshot,
  next: ProjectSkillInventorySnapshot,
): ProjectSkillDiff => {
  const currentBy = new Map(current.skills.map((skill) => [skill.name, skill]))
  const nextBy = new Map(next.skills.map((skill) => [skill.name, skill]))
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [name, skill] of nextBy) {
    const existing = currentBy.get(name)
    if (!existing) added.push(name)
    else if (existing.contentSha256 !== skill.contentSha256) changed.push(name)
  }
  for (const name of currentBy.keys()) {
    if (!nextBy.has(name)) removed.push(name)
  }
  return { added, removed, changed }
}

export const hasProjectSkillChanges = (diff: ProjectSkillDiff): boolean =>
  diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0
