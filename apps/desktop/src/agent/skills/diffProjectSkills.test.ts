import { describe, expect, it } from 'vitest'
import { diffProjectSkills, hasProjectSkillChanges } from './diffProjectSkills'
import type { ProjectSkillDependency } from './types'

const skill = (name: string, sha: string): ProjectSkillDependency => ({
  name,
  description: `${name} 描述`,
  source: { kind: 'project', root: '.axiom/skills' },
  relativePath: `.axiom/skills/${name}.md`,
  baseRelativePath: '.axiom/skills',
  contentSha256: sha,
  disableModelInvocation: false,
})

const snapshotOf = (...skills: ProjectSkillDependency[]) => ({ schemaVersion: 1 as const, skills })

describe('diffProjectSkills', () => {
  it('identifies added, removed, and changed skills', () => {
    const current = snapshotOf(skill('alpha', 'a'.repeat(64)), skill('beta', 'b'.repeat(64)))
    const next = snapshotOf(
      skill('beta', 'b'.repeat(64)),
      skill('gamma', 'c'.repeat(64)), // 新增
      skill('alpha', 'd'.repeat(64)), // 内容变化
    )
    expect(diffProjectSkills(current, next)).toEqual({
      added: ['gamma'],
      removed: [], // alpha/beta 都在（alpha 变化，未删除）
      changed: ['alpha'],
    })
  })

  it('identifies removed skills', () => {
    const current = snapshotOf(skill('alpha', 'a'.repeat(64)), skill('beta', 'b'.repeat(64)))
    const next = snapshotOf(skill('alpha', 'a'.repeat(64)))
    expect(diffProjectSkills(current, next)).toEqual({
      added: [],
      removed: ['beta'],
      changed: [],
    })
  })

  it('returns empty diff for identical snapshots', () => {
    const current = snapshotOf(skill('alpha', 'a'.repeat(64)))
    const next = snapshotOf(skill('alpha', 'a'.repeat(64)))
    expect(diffProjectSkills(current, next)).toEqual({ added: [], removed: [], changed: [] })
    expect(hasProjectSkillChanges(diffProjectSkills(current, next))).toBe(false)
  })

  it('hasProjectSkillChanges reports true on any category', () => {
    expect(hasProjectSkillChanges({ added: ['x'], removed: [], changed: [] })).toBe(true)
    expect(hasProjectSkillChanges({ added: [], removed: ['x'], changed: [] })).toBe(true)
    expect(hasProjectSkillChanges({ added: [], removed: [], changed: ['x'] })).toBe(true)
    expect(hasProjectSkillChanges({ added: [], removed: [], changed: [] })).toBe(false)
  })
})
