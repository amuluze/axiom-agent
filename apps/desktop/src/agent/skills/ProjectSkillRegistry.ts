import type {
  ProjectSkillDependency,
  ProjectSkillInventorySnapshot,
} from './types'

/**
 * 不可变项目 Skill 注册表：按 ASCII name 建立有序映射，运行期间不可原地修改。
 * 每次构造都来自一份完整 snapshot（fromSnapshot），任何替换都生成新实例。
 */
export class ProjectSkillRegistry {
  private constructor(
    private readonly byName: ReadonlyMap<string, ProjectSkillDependency>,
  ) {}

  static fromSnapshot(snapshot: ProjectSkillInventorySnapshot): ProjectSkillRegistry {
    const byName = new Map<string, ProjectSkillDependency>()
    for (const skill of snapshot.skills) {
      // snapshot 由 loader 保证 name 唯一且已按 ASCII 排序；防御性保留首条。
      if (!byName.has(skill.name)) byName.set(skill.name, skill)
    }
    return new ProjectSkillRegistry(byName)
  }

  static empty(): ProjectSkillRegistry {
    return new ProjectSkillRegistry(new Map())
  }

  get(name: string): ProjectSkillDependency | null {
    return this.byName.get(name) ?? null
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  get names(): readonly string[] {
    return Array.from(this.byName.keys())
  }

  list(): ProjectSkillDependency[] {
    return Array.from(this.byName.values())
  }

  get size(): number {
    return this.byName.size
  }

  get snapshot(): ProjectSkillInventorySnapshot {
    return {
      schemaVersion: 1,
      skills: this.list(),
    }
  }
}
