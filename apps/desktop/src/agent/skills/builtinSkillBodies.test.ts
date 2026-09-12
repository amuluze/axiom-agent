import { describe, expect, it } from 'vitest'
import {
  BUILTIN_SKILL_BODIES,
  BUILTIN_SKILL_BODY_NAMES,
  findBuiltinSkillBody,
} from './builtinSkillBodies'

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 每个内置正文必须包含的六段式骨架。 */
const REQUIRED_SECTIONS = ['# 目的', '# 何时进入', '# 前置输入', '# 执行步骤', '# 产出物', '# 退出条件']

describe('builtinSkillBodies', () => {
  it('包含 6 个内置 Skill，name 合法且无重复', () => {
    expect(BUILTIN_SKILL_BODIES).toHaveLength(6)
    const names = BUILTIN_SKILL_BODIES.map((skill) => skill.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(name).toMatch(NAME_PATTERN)
    }
    expect(BUILTIN_SKILL_BODY_NAMES).toEqual(names)
  })

  it('每个 Skill 的 description 与 body 非空', () => {
    for (const skill of BUILTIN_SKILL_BODIES) {
      expect(skill.description.length).toBeGreaterThan(0)
      expect(skill.body.length).toBeGreaterThan(0)
    }
  })

  it('findBuiltinSkillBody 命中/未命中', () => {
    expect(findBuiltinSkillBody('brainstorm')?.name).toBe('brainstorm')
    expect(findBuiltinSkillBody('unknown')).toBeNull()
  })

  it('正文六段式骨架齐全且顺序固定（目的→退出条件）', () => {
    // 行首锚定匹配：标题必须独占一行，避免正文中间出现「# 目的」字样被
    // indexOf 误判为骨架段。
    const headingIndex = (body: string, heading: string): number => {
      const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      const match = new RegExp(`^${escaped}$`, 'mu').exec(body)
      return match?.index ?? -1
    }
    for (const skill of BUILTIN_SKILL_BODIES) {
      const positions = REQUIRED_SECTIONS.map((section) => headingIndex(skill.body, section))
      // 骨架顺序即数组顺序：目的 < 何时进入 < 前置输入 < 执行步骤 < 产出物 < 退出条件。
      for (let index = 0; index < positions.length - 1; index += 1) {
        expect(positions[index], `${skill.name} 缺少骨架段 ${REQUIRED_SECTIONS[index]}`).toBeGreaterThanOrEqual(0)
        expect(positions[index]).toBeLessThan(positions[index + 1]!)
      }
      expect(positions[positions.length - 1]).toBeGreaterThan(0)
    }
  })

  it('正文引用的阶段工具都是已知审查工具（无幻觉引用）', () => {
    const knownReviewers = new Set(['inspect_subagent', 'examine_subagent', 'review_subagent'])
    for (const skill of BUILTIN_SKILL_BODIES) {
      const referenced = [...skill.body.matchAll(/(\w+_subagent)/gu)].map((match) => match[1])
      for (const name of new Set(referenced)) {
        expect(knownReviewers.has(name), `${skill.name} 引用了未知工具 ${name}`).toBe(true)
      }
    }
  })

  it('阶段退出条件指向下一阶段入口，流程可机械跟随', () => {
    const bodyOf = (name: string): string => BUILTIN_SKILL_BODIES.find((skill) => skill.name === name)?.body ?? ''
    const phaseExit = (skill: string): string | null => {
      const match = /# 退出条件\n\n([\s\S]*?)(?=\n# |$)/u.exec(bodyOf(skill))
      return match?.[1]?.trim() ?? null
    }
    // brainstorm/diagnose → inspect_subagent → plan → examine_subagent → implement → review_subagent → finish
    expect(phaseExit('brainstorm')).toContain('inspect_subagent')
    expect(phaseExit('plan')).toContain('examine_subagent')
    expect(phaseExit('implement')).toContain('review_subagent')
    expect(phaseExit('diagnose')).toContain('inspect_subagent')
    // 前置输入反向校验：plan/implement/finish 声明对前一阶段产物的依赖。
    expect(bodyOf('plan')).toContain('已定稿的 Task Spec')
    expect(bodyOf('implement')).toContain('已定稿的 Plan')
    expect(bodyOf('finish')).toContain('代码改动已通过审查')
  })

  it('task-id 规范存在且 plan 引用同一 id（修复4 契约）', () => {
    const brainstorm = findBuiltinSkillBody('brainstorm')!
    expect(brainstorm.body).toContain('task-id 用小写短横线主题词')
    expect(brainstorm.body).toContain('.plans/<task-id>.md')
  })

  it('implement 含 Plan 失效回退出口，与 plan 的歧义回报对称（修复：中途回退不再无门禁）', () => {
    const implement = findBuiltinSkillBody('implement')!
    // Plan 有误 → 回 plan 修订并重新过 examine 门禁，不静默偏离；微调例外须留证据
    expect(implement.body).toContain('停下回到 plan 修订')
    expect(implement.body).toContain('重新通过 examine_subagent 检查')
    expect(implement.body).toContain('不静默偏离 Plan')
    expect(implement.body).toContain('在验证证据中注明')
  })

  it('implement 承认测试不适用改动的验证降级路径（TDD 不覆盖配置/样式/文档）', () => {
    const implement = findBuiltinSkillBody('implement')!
    expect(implement.body).toContain('测试不适用的改动')
    expect(implement.body).toContain('逐项自查')
  })

  it('diagnose 的命令执行引用条件化：未授予能力时不构成对不存在工具的硬引用', () => {
    const diagnose = findBuiltinSkillBody('diagnose')!
    expect(diagnose.body).toContain('若会话已授予命令执行能力')
    // 不再无条件点名 bash 工具
    expect(diagnose.body).not.toContain('bash')
  })

  it('implement 正文无 Axiom 私有概念（修复5 契约）', () => {
    const implement = findBuiltinSkillBody('implement')!
    expect(implement.body).not.toContain('冻结快照')
    expect(implement.body).toContain('遵循项目自身的硬约束')
  })

  it('finish 含分支安全规则：任务分支提交推送、严禁 main/master 直推', () => {
    const finish = findBuiltinSkillBody('finish')!
    expect(finish.body).toContain('严禁直接在 main 或 master 上提交推送')
    expect(finish.body).toContain('Git 分支规则')
    expect(finish.body).toContain('推送到远端同名分支')
    expect(finish.body).toContain('network: true')
    // 前缀不硬编码第二份真相：以系统提示词「# Git 分支规则」段（用户可配置）为准。
    expect(finish.body).toContain('分支前缀以该节为准')
  })

  it('finish 承认简单路径：无 Task Spec 时以用户请求为基准，不补写追溯性 Spec', () => {
    const finish = findBuiltinSkillBody('finish')!
    expect(finish.body).toContain('简单路径')
    expect(finish.body).toContain('不为收口补写追溯性 Spec')
    expect(finish.body).toContain('依据哪份用户请求')
  })

  it('finish 独有职责齐全：AGENTS.md 同步、验证证据汇总、遗留项显式化、审批约定', () => {
    const finish = findBuiltinSkillBody('finish')!
    expect(finish.body).toContain('AGENTS.md/CLAUDE.md')
    expect(finish.body).toContain('汇总验证证据')
    expect(finish.body).toContain('遗留项')
    expect(finish.body).toContain('按宿主的审批约定执行')
  })
})
