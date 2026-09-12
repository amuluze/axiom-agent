import type { ProjectSkillDependency } from '@/agent/skills/types'
import { BUILTIN_SKILL_BODIES } from '@/agent/skills/builtinSkillBodies'
import type { StoredAgentSession } from '@/persistence/types'
import type { MentionCandidate } from './mentionParser'

const HINT_MAX_LENGTH = 64

const formatRelativeTime = (timestamp: number, now: number): string => {
  const diff = now - timestamp
  const day = 24 * 60 * 60 * 1000
  if (diff >= day) return `${Math.floor(diff / day)}d ago`
  const hour = 60 * 60 * 1000
  if (diff >= hour) return `${Math.floor(diff / hour)}h ago`
  if (diff < 0) return '未来'
  return 'just now'
}

export interface BuildThreadCandidatesOptions {
  sessions: StoredAgentSession[]
  activeSessionId?: string | null
  now?: number
}

export const buildThreadCandidates = ({
  sessions,
  activeSessionId,
  now = Date.now(),
}: BuildThreadCandidatesOptions): MentionCandidate[] => {
  return sessions
    .filter((session) => session.id !== activeSessionId)
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((session) => ({
      id: session.id,
      label: session.title && session.title.length > 0 ? session.title : '未命名会话',
      hint: `${formatRelativeTime(session.updatedAt, now)} · ${session.messageCount} 条消息`,
    }))
}

/**
 * 构建 `/` 技能候选：项目 Skill 全部展示（含 `disableModelInvocation`：该标记
 * 只阻止模型自动触发，不阻止用户经 `/name` 手动指定——这正是 popover 候选的价值）；
 * 内置 SDD Skill 追加（`/domain`/`/brainstorm` 等可手打触发，应有候选提示），项目同名遮蔽去重。
 */
export const buildSkillCandidates = (
  projectSkills: readonly ProjectSkillDependency[] = [],
): MentionCandidate[] => {
  const projectNames = new Set(projectSkills.map((skill) => skill.name))
  return [
    ...projectSkills.map((skill) => ({
      id: skill.name,
      label: skill.name,
      hint: skill.description.slice(0, HINT_MAX_LENGTH),
    })),
    ...BUILTIN_SKILL_BODIES
      .filter((skill) => !projectNames.has(skill.name))
      .map((skill) => ({
        id: skill.name,
        label: skill.name,
        hint: skill.description.slice(0, HINT_MAX_LENGTH),
      })),
  ]
}

export interface MentionCandidatesByKind {
  file: MentionCandidate[]
  skill: MentionCandidate[]
  thread: MentionCandidate[]
}
