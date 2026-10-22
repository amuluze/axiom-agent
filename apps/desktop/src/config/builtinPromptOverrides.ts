/**
 * 内置技能 / 内置子智能体提示词的用户覆写（设置页「技能 / 子智能体」区读写）。
 *
 * 无任何 import 的叶子模块（模式同 browserSettings.ts）：agent 层经
 * promptLocalizationHost 间接读取（不 import stores），设置页 UI 直接读写同一份
 * 持久化。localStorage key 沿用 `axiom.<域>.<名>.v1` 约定；结构逐项校验，损坏
 * 载荷 fail-safe 回退空覆写（等价全部使用随产品分发的默认值）。
 *
 * 覆写语义（per-language、按字段生效）：
 * - 技能：description / body 按语言独立覆写，未覆写字段回落内置默认（zh-CN/en
 *   两个语言变体互不影响）；
 * - 子智能体：prompt 为该语言 system prompt 模板的完整替换，支持 {{SCOPE}} /
 *   {{BUDGET}} / {{TOOLS}} / {{FORBIDDEN}} 占位符——运行时渲染为动态范围/预算/
 *   工具说明，省略占位符即省略对应段落（范围与预算另有运行时强制，不受覆写影响）。
 *
 * 覆写只改「模型可见提示词内容」，不改变任何运行时安全边界（scope 探测、预算
 * ledger、只读工具集照常生效）；名称是覆写键，不可经覆写改名。
 */

export type PromptOverrideLanguage = 'zh-CN' | 'en'

export interface BuiltinSkillOverrideEntry {
  description?: string
  body?: string
}

export interface BuiltinSubAgentOverrideEntry {
  /** 完整替换该语言的 system prompt 模板。 */
  prompt?: string
}

export type BuiltinSubAgentOverrideKind = 'explore' | 'inspect' | 'examine' | 'review'

export interface BuiltinPromptOverridesState {
  version: 1
  skills: Record<string, Partial<Record<PromptOverrideLanguage, BuiltinSkillOverrideEntry>>>
  subagents: Partial<
    Record<BuiltinSubAgentOverrideKind, Partial<Record<PromptOverrideLanguage, BuiltinSubAgentOverrideEntry>>>
  >
}

export const EMPTY_BUILTIN_PROMPT_OVERRIDES: BuiltinPromptOverridesState = {
  version: 1,
  skills: {},
  subagents: {},
}

const BUILTIN_PROMPT_OVERRIDES_STORAGE_KEY = 'axiom.prompts.builtin-overrides.v1'

const SUBAGENT_KINDS: readonly BuiltinSubAgentOverrideKind[] = ['explore', 'inspect', 'examine', 'review']
const OVERRIDE_LANGUAGES: readonly PromptOverrideLanguage[] = ['zh-CN', 'en']

/** 空串覆写无意义（等价回落默认），解析期一律丢弃。 */
/**
 * 单条覆写的正文上限（UTF-16 code unit）。
 *
 * 覆写只改模型可见文本，范围/预算/只读工具集仍由运行时强制，**不构成安全边界
 * 变化**；但清单层的 32 KiB 预算只约束 `<available_skills>` 的元数据，正文本身
 * 原先无上限——一次误粘贴可以把任意长内容塞进每一次工具调用与后续每一轮上下文。
 * 上限取内置正文最大者的数倍量级（内置正文本身在 1–4 KiB 量级）。
 */
export const MAX_BUILTIN_OVERRIDE_TEXT = 16 * 1024

const parseOverrideText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_BUILTIN_OVERRIDE_TEXT
    ? value
    : undefined

/**
 * 覆写文本是否可保存（供设置页即时反馈）。空串是「移除覆写」的约定，返回 true。
 */
export const isValidOverrideText = (value: string): boolean =>
  value.length === 0 || value.length <= MAX_BUILTIN_OVERRIDE_TEXT

const parseSkillEntry = (
  value: unknown,
): Partial<Record<PromptOverrideLanguage, BuiltinSkillOverrideEntry>> | null => {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const entry: Partial<Record<PromptOverrideLanguage, BuiltinSkillOverrideEntry>> = {}
  for (const language of OVERRIDE_LANGUAGES) {
    const variant = record[language]
    if (variant === null || typeof variant !== 'object') continue
    const fields = variant as Record<string, unknown>
    const description = parseOverrideText(fields.description)
    const body = parseOverrideText(fields.body)
    if (description !== undefined || body !== undefined) {
      entry[language] = {
        ...(description !== undefined ? { description } : {}),
        ...(body !== undefined ? { body } : {}),
      }
    }
  }
  return Object.keys(entry).length > 0 ? entry : null
}

const parseSubAgentEntry = (value: unknown): Partial<Record<PromptOverrideLanguage, BuiltinSubAgentOverrideEntry>> | null => {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const entry: Partial<Record<PromptOverrideLanguage, BuiltinSubAgentOverrideEntry>> = {}
  for (const language of OVERRIDE_LANGUAGES) {
    const prompt = parseOverrideText((record[language] as Record<string, unknown> | undefined)?.prompt)
    if (prompt !== undefined) entry[language] = { prompt }
  }
  return Object.keys(entry).length > 0 ? entry : null
}

export const loadBuiltinPromptOverrides = (): BuiltinPromptOverridesState => {
  if (typeof window === 'undefined') return { ...EMPTY_BUILTIN_PROMPT_OVERRIDES }
  try {
    const raw = window.localStorage.getItem(BUILTIN_PROMPT_OVERRIDES_STORAGE_KEY)
    if (!raw) return { ...EMPTY_BUILTIN_PROMPT_OVERRIDES }
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return { ...EMPTY_BUILTIN_PROMPT_OVERRIDES }
    const record = parsed as Record<string, unknown>
    const state: BuiltinPromptOverridesState = { version: 1, skills: {}, subagents: {} }
    const skills = record.skills
    if (skills !== null && typeof skills === 'object') {
      for (const [name, entry] of Object.entries(skills as Record<string, unknown>)) {
        const parsedEntry = parseSkillEntry(entry)
        if (parsedEntry !== null && name.length > 0) state.skills[name] = parsedEntry
      }
    }
    const subagents = record.subagents
    if (subagents !== null && typeof subagents === 'object') {
      for (const kind of SUBAGENT_KINDS) {
        const parsedEntry = parseSubAgentEntry((subagents as Record<string, unknown>)[kind])
        if (parsedEntry !== null) state.subagents[kind] = parsedEntry
      }
    }
    return state
  } catch {
    return { ...EMPTY_BUILTIN_PROMPT_OVERRIDES }
  }
}

/** 持久化并同步模块级 live binding（agent 层经宿主 getter 即时读到新值）。 */
export const saveBuiltinPromptOverrides = (state: BuiltinPromptOverridesState): void => {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(BUILTIN_PROMPT_OVERRIDES_STORAGE_KEY, JSON.stringify(state))
  activeBuiltinPromptOverrides = state
}

let activeBuiltinPromptOverrides: BuiltinPromptOverridesState = loadBuiltinPromptOverrides()

export const getBuiltinPromptOverrides = (): BuiltinPromptOverridesState => activeBuiltinPromptOverrides

const pruneEmpty = (state: BuiltinPromptOverridesState): BuiltinPromptOverridesState => {
  for (const [name, entry] of Object.entries(state.skills)) {
    if (entry === undefined || Object.keys(entry).length === 0) delete state.skills[name]
  }
  for (const kind of SUBAGENT_KINDS) {
    const entry = state.subagents[kind]
    if (entry !== undefined && Object.keys(entry).length === 0) delete state.subagents[kind]
  }
  return state
}

/**
 * 把某语言下按字段 diff 出的技能覆写并入状态：字段等同默认（不进 entry）时移除
 * 该字段覆写，语言条目清空时移除条目——「把文本改回默认值」与「恢复默认」等效。
 */
export const applySkillOverrideEntry = (
  state: BuiltinPromptOverridesState,
  name: string,
  language: PromptOverrideLanguage,
  entry: BuiltinSkillOverrideEntry,
): BuiltinPromptOverridesState => {
  const skills = { ...state.skills }
  const existing: Partial<Record<PromptOverrideLanguage, BuiltinSkillOverrideEntry>> = { ...skills[name] }
  const fields: BuiltinSkillOverrideEntry = { ...existing[language] }
  // 保存侧把关：超限正文直接跳过写入（isValidOverrideText 供设置页提前提示）——
  // 清空文本是「移除覆写」的约定，不能与「超限被拒」共用同一条路径，否则用户
  // 粘贴超长正文会静默变成「清空该字段覆写」。
  // 三种语义必须分开：空 entry = 恢复该语言默认（清全部字段，既有约定）；
  // 空串 = 只清该字段；超长 = 拒绝写入且**不动原值**——超限与「清空」若共用
  // 同一条路径，粘贴超长正文会静默变成「清空该字段覆写」，比拒绝更糟。
  if (Object.keys(entry).length === 0) {
    delete existing[language]
    skills[name] = existing
    if (Object.keys(existing).length === 0) delete skills[name]
    return pruneEmpty({ version: 1, skills, subagents: { ...state.subagents } })
  }
  if (entry.description !== undefined) {
    if (entry.description === '') delete fields.description
    else if (isValidOverrideText(entry.description)) fields.description = entry.description
  }
  if (entry.body !== undefined) {
    if (entry.body === '') delete fields.body
    else if (isValidOverrideText(entry.body)) fields.body = entry.body
  }
  if (fields.description === undefined && fields.body === undefined) delete existing[language]
  else existing[language] = fields
  if (Object.keys(existing).length === 0) delete skills[name]
  else skills[name] = existing
  return pruneEmpty({ version: 1, skills, subagents: { ...state.subagents } })
}

/** 清除某语言下的技能覆写（该语言回落内置默认；另一语言覆写保留）。 */
export const clearSkillOverride = (
  state: BuiltinPromptOverridesState,
  name: string,
  language: PromptOverrideLanguage,
): BuiltinPromptOverridesState => applySkillOverrideEntry(state, name, language, {})

/** 同 applySkillOverrideEntry 的子智能体版（仅 prompt 一个字段）。 */
export const applySubAgentOverrideEntry = (
  state: BuiltinPromptOverridesState,
  kind: BuiltinSubAgentOverrideKind,
  language: PromptOverrideLanguage,
  entry: BuiltinSubAgentOverrideEntry,
): BuiltinPromptOverridesState => {
  const subagents = { ...state.subagents }
  const existing = { ...subagents[kind] }
  // 空串 = 移除该语言覆写；超长 = 拒绝写入且不动原值（与 applySkillOverrideEntry 同口径）。
  // 与技能版同口径：空 entry 清整条、空串清该字段、超长拒绝且不动原值。
  if (Object.keys(entry).length === 0 || entry.prompt === '') delete existing[language]
  else if (isValidOverrideText(entry.prompt!)) existing[language] = { prompt: entry.prompt }
  if (Object.keys(existing).length === 0) delete subagents[kind]
  else subagents[kind] = existing
  return pruneEmpty({ version: 1, skills: { ...state.skills }, subagents })
}

/** 清除某语言下的子智能体提示词覆写。 */
export const clearSubAgentOverride = (
  state: BuiltinPromptOverridesState,
  kind: BuiltinSubAgentOverrideKind,
  language: PromptOverrideLanguage,
): BuiltinPromptOverridesState => applySubAgentOverrideEntry(state, kind, language, {})
