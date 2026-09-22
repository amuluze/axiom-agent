import { describe, expect, it } from 'vitest'
import {
  BUILTIN_SKILL_BODIES,
  BUILTIN_SKILL_BODY_NAMES,
  findBuiltinSkillBody,
  resolveBuiltinSkillVariant,
} from './builtinSkillBodies'

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 每个内置正文（中文基线）必须包含的六段式骨架。 */
const REQUIRED_SECTIONS = ['# 目的', '# 何时进入', '# 前置输入', '# 执行步骤', '# 产出物', '# 退出条件']
/** 英文变体的六段式骨架（与中文段一一对应）。 */
const REQUIRED_SECTIONS_EN = ['# Purpose', '# When to enter', '# Required inputs', '# Execution steps', '# Outputs', '# Exit criteria']

const zhBody = (skill: (typeof BUILTIN_SKILL_BODIES)[number]): string => skill['zh-CN'].body
const enBody = (skill: (typeof BUILTIN_SKILL_BODIES)[number]): string => skill.en.body

/** 行首锚定匹配：标题必须独占一行，避免正文中间出现同名字样被 indexOf 误判为骨架段。 */
const headingIndex = (body: string, heading: string): number => {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`^${escaped}$`, 'mu').exec(body)
  return match?.index ?? -1
}

const assertSkeletonOrder = (
  body: string,
  label: string,
  sections: readonly string[],
): void => {
  const positions = sections.map((section) => headingIndex(body, section))
  // 骨架顺序即数组顺序：目的 < 何时进入 < 前置输入 < 执行步骤 < 产出物 < 退出条件。
  for (let index = 0; index < positions.length - 1; index += 1) {
    expect(positions[index], `${label} 缺少骨架段 ${sections[index]}`).toBeGreaterThanOrEqual(0)
    expect(positions[index]).toBeLessThan(positions[index + 1]!)
  }
  expect(positions[positions.length - 1]).toBeGreaterThan(0)
}

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

  it('每个 Skill 的 zh-CN/en 变体 description 与 body 均非空', () => {
    for (const skill of BUILTIN_SKILL_BODIES) {
      expect(skill['zh-CN'].description.length).toBeGreaterThan(0)
      expect(skill['zh-CN'].body.length).toBeGreaterThan(0)
      expect(skill.en.description.length).toBeGreaterThan(0)
      expect(skill.en.body.length).toBeGreaterThan(0)
    }
  })

  it('findBuiltinSkillBody 命中/未命中', () => {
    expect(findBuiltinSkillBody('brainstorm')?.name).toBe('brainstorm')
    expect(findBuiltinSkillBody('unknown')).toBeNull()
  })

  it('resolveBuiltinSkillVariant：无覆写返回内置变体，覆写字段优先、未覆写字段回落', () => {
    const skill = findBuiltinSkillBody('domain')!
    expect(resolveBuiltinSkillVariant(skill, 'zh-CN')).toBe(skill['zh-CN'])
    expect(resolveBuiltinSkillVariant(skill, 'en')).toBe(skill.en)
    const overridden = resolveBuiltinSkillVariant(skill, 'zh-CN', { body: '自定义正文' })
    expect(overridden.body).toBe('自定义正文')
    expect(overridden.description).toBe(skill['zh-CN'].description)
  })

  it('中文正文六段式骨架齐全且顺序固定（目的→退出条件）', () => {
    for (const skill of BUILTIN_SKILL_BODIES) {
      assertSkeletonOrder(zhBody(skill), `${skill.name} zh-CN`, REQUIRED_SECTIONS)
    }
  })

  it('英文变体六段式骨架齐全且顺序固定，且不残留中文骨架或占位符', () => {
    for (const skill of BUILTIN_SKILL_BODIES) {
      assertSkeletonOrder(enBody(skill), `${skill.name} en`, REQUIRED_SECTIONS_EN)
      expect(enBody(skill)).not.toContain('# 目的')
      expect(enBody(skill)).not.toContain('{{')
    }
  })

  it('正文引用的阶段工具都是已知审查工具（无幻觉引用，双语一致）', () => {
    const knownReviewers = new Set(['inspect_subagent', 'examine_subagent', 'review_subagent'])
    for (const skill of BUILTIN_SKILL_BODIES) {
      for (const body of [zhBody(skill), enBody(skill)]) {
        const referenced = [...body.matchAll(/(\w+_subagent)/gu)].map((match) => match[1])
        for (const name of new Set(referenced)) {
          expect(knownReviewers.has(name), `${skill.name} 引用了未知工具 ${name}`).toBe(true)
        }
      }
    }
  })

  it('阶段退出条件指向下一阶段入口，流程可机械跟随（双语一致）', () => {
    const bodyOf = (name: string, language: 'zh-CN' | 'en'): string =>
      BUILTIN_SKILL_BODIES.find((skill) => skill.name === name)?.[language].body ?? ''
    const phaseExit = (skill: string, language: 'zh-CN' | 'en'): string | null => {
      const pattern = language === 'zh-CN' ? /# 退出条件\n\n([\s\S]*?)(?=\n# |$)/u : /# Exit criteria\n\n([\s\S]*?)(?=\n# |$)/u
      const match = pattern.exec(bodyOf(skill, language))
      return match?.[1]?.trim() ?? null
    }
    for (const language of ['zh-CN', 'en'] as const) {
      // brainstorm/diagnose → inspect_subagent → plan → examine_subagent → implement → review_subagent → finish
      expect(phaseExit('brainstorm', language)).toContain('inspect_subagent')
      expect(phaseExit('plan', language)).toContain('examine_subagent')
      expect(phaseExit('implement', language)).toContain('review_subagent')
      expect(phaseExit('diagnose', language)).toContain('inspect_subagent')
    }
    // 前置输入反向校验：plan/implement/finish 声明对前一阶段产物的依赖（中文基线）。
    expect(zhBody(findBuiltinSkillBody('plan')!)).toContain('已定稿的 Task Spec')
    expect(zhBody(findBuiltinSkillBody('implement')!)).toContain('已定稿的 Plan')
    expect(zhBody(findBuiltinSkillBody('finish')!)).toContain('代码改动已通过审查')
  })

  it('task-id 规范存在且 plan 引用同一 id（修复4 契约）', () => {
    const brainstorm = findBuiltinSkillBody('brainstorm')!
    expect(zhBody(brainstorm)).toContain('task-id 用小写短横线主题词')
    expect(zhBody(brainstorm)).toContain('.plans/<task-id>.md')
    expect(enBody(brainstorm)).toContain('.plans/<task-id>.md')
  })

  it('implement 含 Plan 失效回退出口，与 plan 的歧义回报对称（修复：中途回退不再无门禁）', () => {
    const implement = findBuiltinSkillBody('implement')!
    // Plan 有误 → 回 plan 修订并重新过 examine 门禁，不静默偏离；微调例外须留证据
    expect(zhBody(implement)).toContain('停下回到 plan 修订')
    expect(zhBody(implement)).toContain('重新通过 examine_subagent 检查')
    expect(zhBody(implement)).toContain('不静默偏离 Plan')
    expect(zhBody(implement)).toContain('在验证证据中注明')
    expect(enBody(implement)).toContain('return to plan for revision')
    expect(enBody(implement)).toContain('never silently deviate from the Plan')
  })

  it('implement 承认测试不适用改动的验证降级路径（TDD 不覆盖配置/样式/文档）', () => {
    const implement = findBuiltinSkillBody('implement')!
    expect(zhBody(implement)).toContain('测试不适用的改动')
    expect(zhBody(implement)).toContain('逐项自查')
    expect(enBody(implement)).toContain('where tests do not apply')
  })

  it('diagnose 的命令执行引用条件化：未授予能力时不构成对不存在工具的硬引用', () => {
    const diagnose = findBuiltinSkillBody('diagnose')!
    expect(zhBody(diagnose)).toContain('若会话已授予命令执行能力')
    // 不再无条件点名 bash 工具
    expect(zhBody(diagnose)).not.toContain('bash')
    expect(enBody(diagnose)).toContain('command execution granted')
  })

  it('implement 正文无 Axiom 私有概念（修复5 契约）', () => {
    const implement = findBuiltinSkillBody('implement')!
    expect(zhBody(implement)).not.toContain('冻结快照')
    expect(zhBody(implement)).toContain('遵循项目自身的硬约束')
    expect(enBody(implement)).toContain("the project's own hard constraints")
  })

  it('finish 含分支安全规则：任务分支提交推送、严禁 main/master 直推（双语一致）', () => {
    const finish = findBuiltinSkillBody('finish')!
    expect(zhBody(finish)).toContain('严禁直接在 main 或 master 上提交推送')
    expect(enBody(finish)).toContain('directly on main or master is strictly forbidden')
    for (const body of [zhBody(finish), enBody(finish)]) {
      expect(body).toContain('network: true')
    }
    expect(zhBody(finish)).toContain('Git 分支规则')
    expect(zhBody(finish)).toContain('推送到远端同名分支')
    // 前缀不硬编码第二份真相：以系统提示词「# Git 分支规则」段（用户可配置）为准。
    expect(zhBody(finish)).toContain('分支前缀以该节为准')
    expect(enBody(finish)).toContain('"# Git branch rules"')
  })

  it('finish 承认简单路径：无 Task Spec 时以用户请求为基准，不补写追溯性 Spec', () => {
    const finish = findBuiltinSkillBody('finish')!
    expect(zhBody(finish)).toContain('简单路径')
    expect(zhBody(finish)).toContain('不为收口补写追溯性 Spec')
    expect(zhBody(finish)).toContain('依据哪份用户请求')
    expect(enBody(finish)).toContain('do not write retroactive Specs just to close out')
  })

  it('finish 独有职责齐全：AGENTS.md 同步、验证证据汇总、遗留项显式化、审批约定（双语一致）', () => {
    const finish = findBuiltinSkillBody('finish')!
    for (const body of [zhBody(finish), enBody(finish)]) {
      expect(body).toContain('AGENTS.md/CLAUDE.md')
      expect(body).toContain('network: true')
    }
    expect(zhBody(finish)).toContain('汇总验证证据')
    expect(zhBody(finish)).toContain('遗留项')
    expect(zhBody(finish)).toContain('按宿主的审批约定执行')
    expect(enBody(finish)).toContain('verification evidence')
    expect(enBody(finish)).toContain('leftover')
  })
})
