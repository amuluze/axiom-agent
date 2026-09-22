// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  EMPTY_BUILTIN_PROMPT_OVERRIDES,
  applySkillOverrideEntry,
  applySubAgentOverrideEntry,
  clearSkillOverride,
  getBuiltinPromptOverrides,
  loadBuiltinPromptOverrides,
  saveBuiltinPromptOverrides,
} from './builtinPromptOverrides'

const STORAGE_KEY = 'axiom.prompts.builtin-overrides.v1'

describe('builtinPromptOverrides', () => {
  afterEach(() => {
    window.localStorage.clear()
  })

  it('空载时返回空覆写（SSR/未存储 fail-safe）', () => {
    expect(loadBuiltinPromptOverrides()).toEqual(EMPTY_BUILTIN_PROMPT_OVERRIDES)
    expect(getBuiltinPromptOverrides()).toEqual(EMPTY_BUILTIN_PROMPT_OVERRIDES)
  })

  it('save → get/live binding 与 load（重新读 storage）往返一致', () => {
    const state = applySkillOverrideEntry(EMPTY_BUILTIN_PROMPT_OVERRIDES, 'domain', 'zh-CN', {
      body: '自定义正文',
    })
    saveBuiltinPromptOverrides(state)
    expect(getBuiltinPromptOverrides().skills.domain?.['zh-CN']?.body).toBe('自定义正文')
    expect(loadBuiltinPromptOverrides()).toEqual(state)
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual(state)
  })

  it('损坏 JSON / 非对象载荷 / 未知语言与空串字段全部 fail-safe 丢弃', () => {
    window.localStorage.setItem(STORAGE_KEY, '{broken')
    expect(loadBuiltinPromptOverrides()).toEqual(EMPTY_BUILTIN_PROMPT_OVERRIDES)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      skills: {
        domain: { 'zh-CN': { body: '' }, fr: { body: 'x' }, en: { body: '保留' } },
        '': { en: { body: '空名丢弃' } },
      },
      subagents: { explore: { en: { prompt: '覆盖' } }, unknown_kind: { en: { prompt: 'x' } } },
    }))
    expect(loadBuiltinPromptOverrides()).toEqual({
      version: 1,
      skills: { domain: { en: { body: '保留' } } },
      subagents: { explore: { en: { prompt: '覆盖' } } },
    })
  })

  it('applySkillOverrideEntry：diff 保存，字段改回默认（空 entry）即移除该语言覆写', () => {
    const added = applySkillOverrideEntry(EMPTY_BUILTIN_PROMPT_OVERRIDES, 'plan', 'en', {
      description: '自定义描述',
      body: '自定义正文',
    })
    expect(added.skills.plan?.en).toEqual({ description: '自定义描述', body: '自定义正文' })
    // zh 覆写不受 en 变更影响
    const both = applySkillOverrideEntry(added, 'plan', 'zh-CN', { body: '中文覆写' })
    expect(both.skills.plan?.['zh-CN']).toEqual({ body: '中文覆写' })
    expect(both.skills.plan?.en).toEqual({ description: '自定义描述', body: '自定义正文' })
    // 空 entry = 恢复该语言默认：en 条目移除、zh 保留
    const clearedEn = clearSkillOverride(both, 'plan', 'en')
    expect(clearedEn.skills.plan?.en).toBeUndefined()
    expect(clearedEn.skills.plan?.['zh-CN']).toEqual({ body: '中文覆写' })
    // 最后一个语言也清除 → 技能条目整体移除
    const clearedAll = clearSkillOverride(clearedEn, 'plan', 'zh-CN')
    expect(clearedAll.skills.plan).toBeUndefined()
    expect(clearedAll).toEqual(EMPTY_BUILTIN_PROMPT_OVERRIDES)
  })

  it('applySubAgentOverrideEntry / clearSubAgentOverride：prompt 单字段语义，条目清空即整体移除', () => {
    const added = applySubAgentOverrideEntry(EMPTY_BUILTIN_PROMPT_OVERRIDES, 'inspect', 'zh-CN', {
      prompt: '自定义模板',
    })
    expect(added.subagents.inspect?.['zh-CN']).toEqual({ prompt: '自定义模板' })
    const cleared = applySubAgentOverrideEntry(added, 'inspect', 'zh-CN', {})
    expect(cleared.subagents.inspect).toBeUndefined()
    expect(cleared).toEqual(EMPTY_BUILTIN_PROMPT_OVERRIDES)
  })
})
