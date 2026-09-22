import { useMemo } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import type { MentionCandidatesByKind } from './mentionCandidates'
import { compactParentHint } from './mentionHints'
import type { MentionCandidate } from './mentionParser'
import {
  buildSkillCandidates,
  buildThreadCandidates,
} from './mentionCandidates'

/**
 * Collect mention candidates for every kind from agentStore.
 * The skill list comes from the current project Skill snapshot plus built-in SDD skills,
 * the thread list from persisted sessions, and the file list from the authorised read
 * paths (files and directories) already in agentStore.
 */
export const useMentionCandidates = (): MentionCandidatesByKind => {
  const authorizedFiles = useAgentStore((state) => state.authorizedFiles)
  const sessions = useAgentStore((state) => state.sessions)
  const activeSessionId = useAgentStore((state) => state.activeSessionId)
  const projectSkills = useAgentStore((state) => state.projectSkills)
  const skillsEnabled = useUiStore((state) => state.projectSkillsEnabled)
  const skillsForCandidates = skillsEnabled ? projectSkills.skills : []
  return useMemo(() => {
    const fileCandidates: MentionCandidate[] = authorizedFiles.map((file) => ({
      id: file.path,
      label: file.name,
      // 完整绝对路径会挤掉候选行：只保留父目录末两段。
      hint: compactParentHint(file.path),
      isDirectory: file.isDirectory,
      group: 'referenced',
    }))
    return {
      file: fileCandidates,
      skill: buildSkillCandidates(skillsForCandidates),
      thread: buildThreadCandidates({ sessions, activeSessionId }),
    }
  }, [authorizedFiles, sessions, activeSessionId, skillsForCandidates])
}
