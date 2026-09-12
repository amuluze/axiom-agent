import { useMemo } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import type { MentionCandidatesByKind } from './mentionCandidates'
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
    const fileCandidates = authorizedFiles.map((file) => ({
      id: file.path,
      label: file.name,
      hint: file.path,
      isDirectory: file.isDirectory,
    }))
    return {
      file: fileCandidates,
      skill: buildSkillCandidates(skillsForCandidates),
      thread: buildThreadCandidates({ sessions, activeSessionId }),
    }
  }, [authorizedFiles, sessions, activeSessionId, skillsForCandidates])
}
