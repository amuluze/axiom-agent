import type { SubAgentKind } from '@/agent/core/types'
import { buildExploreSystemPrompt, EXPLORE_PROMPT_TEMPLATES, type ExplorePromptOptions } from './explore/buildExplorePrompt'
import { buildInspectSystemPrompt, INSPECT_PROMPT_TEMPLATES } from './reviewers/buildInspectPrompt'
import { buildExamineSystemPrompt, EXAMINE_PROMPT_TEMPLATES } from './reviewers/buildExaminePrompt'
import { buildReviewSystemPrompt, REVIEW_PROMPT_TEMPLATES } from './reviewers/buildReviewPrompt'
import type { ReviewerPromptLanguage } from './reviewers/reviewerCommon'

/**
 * 内置子智能体 system prompt 的模板/预览目录（设置-子智能体页的查看/编辑入口，
 * 与运行时 SubAgentRuntime 共用同一组 builder——模板即真实发送内容的静态部分）。
 */

export const BUILTIN_SUBAGENT_PROMPT_TEMPLATES: Record<
  SubAgentKind,
  Record<ReviewerPromptLanguage, string>
> = {
  explore: EXPLORE_PROMPT_TEMPLATES,
  inspect: INSPECT_PROMPT_TEMPLATES,
  examine: EXAMINE_PROMPT_TEMPLATES,
  review: REVIEW_PROMPT_TEMPLATES,
}

type SubAgentPromptBuilder = (
  opts: ExplorePromptOptions,
  localization?: { language?: ReviewerPromptLanguage; overrideTemplate?: string },
) => string

const BUILDERS: Record<SubAgentKind, SubAgentPromptBuilder> = {
  explore: buildExploreSystemPrompt,
  inspect: buildInspectSystemPrompt,
  examine: buildExamineSystemPrompt,
  review: buildReviewSystemPrompt,
}

/** 指定语言的原始 system prompt 模板（占位符未渲染）——编辑态直接呈现可保存文本。 */
export const getBuiltinSubAgentPromptTemplate = (
  kind: SubAgentKind,
  language: ReviewerPromptLanguage,
): string => {
  const templates = BUILTIN_SUBAGENT_PROMPT_TEMPLATES[kind]
  return templates[language] ?? templates['zh-CN']
}

/**
 * 按默认选项（全工作区只读 + 默认预算文案）渲染后的完整 prompt——查看态预览；
 * 运行时会以真实 scope/预算替换占位符。覆写模板存在时按覆写渲染。
 */
export const getBuiltinSubAgentPromptPreview = (
  kind: SubAgentKind,
  language: ReviewerPromptLanguage,
  overrideTemplate?: string,
): string => {
  const localization = overrideTemplate !== undefined
    ? { language, overrideTemplate }
    : { language }
  return BUILDERS[kind]({}, localization)
}
