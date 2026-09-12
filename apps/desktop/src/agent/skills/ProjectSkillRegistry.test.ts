import { describe, expect, it } from 'vitest'
import { ProjectSkillRegistry } from './ProjectSkillRegistry'
import type { ProjectSkillDependency } from './types'

const skill = (name: string, overrides: Partial<ProjectSkillDependency> = {}): ProjectSkillDependency => ({
  name,
  description: `${name} 描述`,
  source: { kind: 'project', root: '.axiom/skills' },
  relativePath: `.axiom/skills/${name}.md`,
  baseRelativePath: '.axiom/skills',
  contentSha256: 'a'.repeat(64),
  disableModelInvocation: false,
  ...overrides,
})

describe('ProjectSkillRegistry', () => {
  it('按 name 建立映射，get/has/list/size 正确', () => {
    const registry = ProjectSkillRegistry.fromSnapshot({
      schemaVersion: 1,
      skills: [skill('alpha'), skill('pdf-tools')],
    })
    expect(registry.size).toBe(2)
    expect(registry.has('pdf-tools')).toBe(true)
    expect(registry.get('pdf-tools')?.name).toBe('pdf-tools')
    expect(registry.get('missing')).toBeNull()
    expect(registry.names).toEqual(['alpha', 'pdf-tools'])
    expect(registry.list().map((item) => item.name)).toEqual(['alpha', 'pdf-tools'])
  })

  it('重复 name 保留首条（防御性）', () => {
    const registry = ProjectSkillRegistry.fromSnapshot({
      schemaVersion: 1,
      skills: [skill('alpha', { relativePath: 'first.md' }), skill('alpha', { relativePath: 'second.md' })],
    })
    expect(registry.size).toBe(1)
    expect(registry.get('alpha')?.relativePath).toBe('first.md')
  })

  it('snapshot 返回不可变副本：修改返回对象不影响内部', () => {
    const registry = ProjectSkillRegistry.fromSnapshot({ schemaVersion: 1, skills: [skill('alpha')] })
    const returned = registry.snapshot
    returned.skills[0]!.name = 'hacked'
    expect(registry.get('alpha')).not.toBeNull()
    expect(registry.get('hacked')).toBeNull()
  })

  it('empty 返回空注册表', () => {
    const registry = ProjectSkillRegistry.empty()
    expect(registry.size).toBe(0)
    expect(registry.snapshot).toEqual({ schemaVersion: 1, skills: [] })
  })
})
