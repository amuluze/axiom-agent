import { describe, expect, it } from 'vitest'
import type { ProjectSkillDependency } from '@/agent/skills/types'
import type { StoredAgentSession } from '@/persistence/types'
import {
  buildSkillCandidates,
  buildThreadCandidates,
} from './mentionCandidates'

const baseSession = (overrides: Partial<StoredAgentSession> = {}): StoredAgentSession => ({
  id: 'session-1',
  title: 'Sprint planning',
  systemPrompt: '',
  modelProvider: 'generic-anthropic-compatible',
  modelId: 'claude-test',
  reasoning: null,
  activeToolNames: [],
  providerConfig: null,
  runtimeManifest: null,
  status: 'idle',
  createdAt: 0,
  updatedAt: 0,
  messageCount: 8,
  parentSessionId: null,
  forkedFromMessageId: null,
  branchKind: null,
  retriedMessageId: null,
  ...overrides,
})

const projectSkill = (overrides: Partial<ProjectSkillDependency> = {}): ProjectSkillDependency => ({
  name: 'pdf-tools',
  description: '生成 PDF 文档。',
  source: { kind: 'project', root: '.axiom/skills' },
  relativePath: '.axiom/skills/pdf-tools/SKILL.md',
  baseRelativePath: '.axiom/skills/pdf-tools',
  contentSha256: '0'.repeat(64),
  disableModelInvocation: false,
  ...overrides,
})

describe('mentionCandidates.buildSkillCandidates', () => {
  it('无项目 Skill 时仍返回内置 SDD Skill 候选（/brainstorm 可手打触发）', () => {
    const candidates = buildSkillCandidates([])
    const ids = candidates.map((skill) => skill.id)
    expect(ids).toContain('brainstorm')
    expect(ids).toContain('finish')
    expect(ids).toContain('implement')
    expect((candidates.find((skill) => skill.id === 'brainstorm')?.hint ?? '').length).toBeGreaterThan(0)
  })

  it('项目 Skill 优先展示，内置 Skill 追加且项目同名遮蔽去重', () => {
    const skills = buildSkillCandidates([
      projectSkill({ name: 'pdf-tools', description: '生成 PDF 文档。' }),
      projectSkill({ name: 'release-notes', description: '提取 release notes。' }),
      projectSkill({ name: 'plan', description: '自定义 plan 遮蔽内置。' }),
    ])
    const ids = skills.map((skill) => skill.id)
    expect(ids.slice(0, 3)).toEqual(['pdf-tools', 'release-notes', 'plan'])
    // 项目 plan 遮蔽内置 plan：只出现一次，且 hint 是项目描述。
    expect(ids.filter((id) => id === 'plan')).toHaveLength(1)
    expect(skills.find((skill) => skill.id === 'plan')?.hint).toBe('自定义 plan 遮蔽内置。')
    // 其余内置仍在。
    expect(ids).toContain('brainstorm')
  })

  it('includes disableModelInvocation skills (user can still trigger via /name)', () => {
    const skills = buildSkillCandidates([
      projectSkill({ name: 'secret-flow', description: '仅手动触发', disableModelInvocation: true }),
    ])
    expect(skills.map((skill) => skill.id)).toContain('secret-flow')
  })

  it('truncates long project skill descriptions to 64 characters', () => {
    const long = 'x'.repeat(200)
    const skills = buildSkillCandidates([projectSkill({ name: 'custom', description: long })])
    expect(skills.find((skill) => skill.id === 'custom')?.hint).toBe(long.slice(0, 64))
  })
})

describe('mentionCandidates.buildThreadCandidates', () => {
  const now = 1_700_000_000_000
  const day = 24 * 60 * 60 * 1000

  it('returns every session except the active one, sorted by updatedAt desc', () => {
    const sessions = [
      baseSession({ id: 's1', title: 'older', updatedAt: now - 5 * day }),
      baseSession({ id: 's2', title: 'newer', updatedAt: now - day }),
      baseSession({ id: 's3', title: 'middle', updatedAt: now - 3 * day }),
    ]
    const candidates = buildThreadCandidates({ sessions, activeSessionId: 's2', now })
    expect(candidates.map((candidate) => candidate.id)).toEqual(['s3', 's1'])
  })

  it('excludes the active session from the result', () => {
    const sessions = [
      baseSession({ id: 'active', title: 'A', updatedAt: now }),
      baseSession({ id: 'other', title: 'B', updatedAt: now - day }),
    ]
    const candidates = buildThreadCandidates({ sessions, activeSessionId: 'active', now })
    expect(candidates.map((candidate) => candidate.id)).toEqual(['other'])
  })

  it('falls back to "未命名会话" when the title is empty', () => {
    const candidates = buildThreadCandidates({
      sessions: [baseSession({ id: 's', title: '' })],
      now,
    })
    expect(candidates[0]?.label).toBe('未命名会话')
  })

  it('includes a relative time + message count in the hint', () => {
    const sessions = [baseSession({ id: 's', title: 'A', updatedAt: now - day, messageCount: 12 })]
    const candidates = buildThreadCandidates({ sessions, now })
    expect(candidates[0]?.hint).toBe('1d ago · 12 条消息')
  })

  it('returns an empty list when no sessions exist', () => {
    expect(buildThreadCandidates({ sessions: [], now })).toEqual([])
  })
})
