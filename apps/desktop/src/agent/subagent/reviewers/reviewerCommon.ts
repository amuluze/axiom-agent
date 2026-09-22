import type { ExplorePromptOptions } from '../explore/buildExplorePrompt'
import type { ResolvedLanguage } from '@/i18n/locale'

/**
 * 审查类 SubAgent（inspect/examine/review）共享的 system prompt 渲染辅助。
 * 与 explore 的区别只在「角色/审查要点/输出」三段，scope/budget 渲染语义一致，
 * 因此提取为公共函数避免三个审查 builder 重复同样的范围与预算文案。
 *
 * 模板化（v6/v8 起）：builder 的静态正文改为带占位符的模板字符串（zh-CN/en 双
 * 语言，设置页可按语言覆写），运行时经 {@link applyReviewerTemplate} 把
 * {{TOOLS}}/{{SCOPE}}/{{BUDGET}}/{{FORBIDDEN}} 替换为对应渲染结果——默认 zh-CN
 * 模板逐字节等价于历史拼接输出；用户覆写模板省略占位符即省略对应段落（范围与
 * 预算另有运行时强制，不依赖提示词声明）。
 */

export type ReviewerPromptLanguage = ResolvedLanguage

export const renderReviewerScopeNote = (
  { scope, workspaceRoot }: ExplorePromptOptions,
  language: ReviewerPromptLanguage = 'zh-CN',
): string => {
  if (language === 'en') {
    const rootNote = workspaceRoot
      ? `Authorized workspace root: ${workspaceRoot} (scope relative paths are resolved inside this directory; paths outside it do not exist or will be rejected)`
      : null
    if (scope && scope.length > 0) {
      return [
        ...(rootNote ? [rootNote] : []),
        'Workspace scope allowed for this run (relative paths):',
        ...scope.map((entry) => `- ${entry}`),
        'Reads outside the scope will fail; do not attempt them. `..` and absolute paths are rejected, and paths that resolve outside the scope through symlinks fail too.',
      ].join('\n')
    }
    return rootNote
      ? `${rootNote}\nThis run allows read-only access to the entire authorized workspace.`
      : 'This run allows read-only access to the entire authorized workspace.'
  }
  const rootNote = workspaceRoot
    ? `授权工作区根目录：${workspaceRoot}（scope 相对路径在此目录内解析，不在此目录内的路径不存在或将被拒绝）`
    : null
  if (scope && scope.length > 0) {
    return [
      ...(rootNote ? [rootNote] : []),
      '本次允许的工作区范围（相对路径）：',
      ...scope.map((entry) => `- ${entry}`),
      '范围外的读取会失败，请勿尝试；`..` 与绝对路径都会被拒绝，符号链接解析后的实际路径越出范围也会失败。',
    ].join('\n')
  }
  return rootNote
    ? `${rootNote}\n本次允许访问整个已授权工作区（只读）。`
    : '本次允许访问整个已授权工作区（只读）。'
}

/**
 * 预算段渲染。contextWindow 行独立于 budget 渲染（对齐 explore 的同款行）：
 * ledger 的 token 估算拦截照常生效，这里只负责让子 Agent 感知窗口收口节奏、
 * 主动避免无谓的大范围读取。
 */
export const renderReviewerBudgetNote = (
  { budget, contextWindow }: ExplorePromptOptions,
  language: ReviewerPromptLanguage = 'zh-CN',
): string => {
  if (language === 'en') {
    const contextWindowNote = contextWindow && contextWindow > 0
      ? `Your context window is ${contextWindow} tokens; the budget fail-closes as you approach it.`
      : ''
    if (!budget) {
      return [
        'You have fixed turn and tool-call budgets. When nearing the limit, stop expanding the review scope and conclude from the evidence you already have.',
        ...(contextWindowNote ? [contextWindowNote] : []),
      ].join('\n')
    }
    return [
      `You have fixed resource limits: at most ${budget.maxTurns} model requests (each may include multiple tool calls),`,
      `each model request message at most ${Math.round(budget.maxMessageBytes / 1024)} KiB,`,
      `each tool result inlined at most ${Math.round(budget.maxInlineToolResultBytes / 1024)} KiB (deterministically truncated beyond that).`,
      'Turns are the scarcest resource: one model request consumes one turn; batch multiple read-only calls into a single request to reduce turn usage.',
      'Every model request resends the full conversation history, so message bytes grow as history accumulates—reading a large file every round inflates the request quickly;',
      `about ${Math.max(1, Math.round(budget.maxMessageBytes / budget.maxInlineToolResultBytes))} full-size large-file reads will exhaust the message byte budget.`,
      'When nearing the limit, stop expanding the review scope immediately and conclude from the evidence already read; do not keep reading just to be exhaustive.',
      ...(contextWindowNote ? [contextWindowNote] : []),
    ].join('\n')
  }
  const contextWindowNote = contextWindow && contextWindow > 0
    ? `你的上下文窗口为 ${contextWindow} tokens，接近窗口时预算会 fail-closed 收口。`
    : ''
  if (!budget) {
    return [
      '你有固定的轮次与工具调用预算。接近上限时停止扩大审查范围，优先基于已有证据给出审查结论。',
      ...(contextWindowNote ? [contextWindowNote] : []),
    ].join('\n')
  }
  return [
    `你有固定的资源上限：最多 ${budget.maxTurns} 轮模型请求（每轮可包含多个工具调用），`,
    `单次模型请求消息不超过 ${Math.round(budget.maxMessageBytes / 1024)} KiB，`,
    `单次工具结果内联不超过 ${Math.round(budget.maxInlineToolResultBytes / 1024)} KiB（超出确定性截断）。`,
    '轮次是最紧缺的资源：一次模型请求消耗一轮，尽量在单轮内一次发起多个只读调用，减少轮次消耗。',
    '每次模型请求都会重发完整对话历史，消息字节随历史累积增长——每轮 read 一个大文件都会让请求快速膨胀，',
    `约 ${Math.max(1, Math.round(budget.maxMessageBytes / budget.maxInlineToolResultBytes))} 次满额大文件读取就会用尽消息字节预算。`,
    '接近上限时立即停止扩大审查范围，优先基于已读取的证据给出审查结论，不要为穷尽而继续读取。',
    ...(contextWindowNote ? [contextWindowNote] : []),
  ].join('\n')
}

/** 只读工具与禁止项段落（三个审查 builder 完全一致；双语由模板占位符取用）。 */
export const REVIEWER_TOOLS_SECTIONS: Record<ReviewerPromptLanguage, string> = {
  'zh-CN': `# 允许的工具
- read：读取文件内容（文本或图片）
- ls：列出目录条目
- grep：在工作区内搜索文本
- find：按模式查找文件
其余工具均不可用；write、edit、bash、审批、工具发现与再次委派 SubAgent 都被禁止。`,
  en: `# Allowed tools
- read: read file contents (text or images)
- ls: list directory entries
- grep: search text within the workspace
- find: locate files by pattern
All other tools are unavailable; write, edit, bash, approvals, tool discovery and delegating SubAgents are all forbidden.`,
}

export const REVIEWER_FORBIDDEN_SECTIONS: Record<ReviewerPromptLanguage, string> = {
  'zh-CN': `# 禁止
- 修改、写入、删除任何文件；不执行命令；不请求审批；不发现新工具；不委派子 Agent。
- 不访问范围外路径（绝对授权文件、\`..\`、符号链接越界都会失败）。`,
  en: `# Forbidden
- Do not modify, write or delete any file; do not execute commands; do not request approvals; do not discover new tools; do not delegate sub-Agents.
- Do not access paths outside the scope (authorized absolute files, \`..\`, and symlink escapes all fail).`,
}

/**
 * 审查模板占位符替换：{{TOOLS}}/{{FORBIDDEN}} 为静态段，{{SCOPE}}/{{BUDGET}} 按
 * 运行时选项渲染。未知 {{X}} 占位符保留原样（可发现的模板笔误优于静默丢失）。
 */
export const applyReviewerTemplate = (
  template: string,
  opts: ExplorePromptOptions,
  language: ReviewerPromptLanguage,
): string =>
  template
    .replaceAll('{{TOOLS}}', REVIEWER_TOOLS_SECTIONS[language])
    .replaceAll('{{FORBIDDEN}}', REVIEWER_FORBIDDEN_SECTIONS[language])
    .replaceAll('{{SCOPE}}', renderReviewerScopeNote(opts, language))
    .replaceAll('{{BUDGET}}', renderReviewerBudgetNote(opts, language))

export type ReviewerVerdict = 'pass' | 'fail' | 'unknown'

/**
 * 从审查结论文本解析结构化判定。三个审查器 system prompt 强制固定结论格式——
 * 中文「结论：通过 / 不通过」（zh-CN 模板）或英文「Verdict: pass / fail」（en 模板），
 * 两种锚点都做防御性提取，取**最后一个**结论锚定的匹配——审查行文中途可能出现
 * 假设性表述（如「若不修复 X 则结论：不通过」），最终判定以末次结论为准；中文匹配
 * 内部「不通过」整体命中时「通过」分支在同一位置无法部分命中（同位锚定，与分支
 * 书写顺序无关），不会被截断成「通过」。无法判定（格式漂移、partial 中途收口）
 * 返回 unknown，父 Agent 回退到阅读全文。结果供 details 审计/UI 展示与 fail 判定
 * 的门禁回环提示消费，不改变父 Agent 决策路径。
 */
export const parseReviewerVerdict = (summary: string): ReviewerVerdict => {
  const pattern = /结论[：:]\s*\**\s*(通过|不通过)|\bverdict\b\s*[：:]\s*\**\s*(pass|fail)/giu
  let match: RegExpExecArray | null
  let last: RegExpExecArray | null = null
  while ((match = pattern.exec(summary)) !== null) last = match
  if (!last) return 'unknown'
  if (last[1] !== undefined) return last[1] === '不通过' ? 'fail' : 'pass'
  return (last[2] ?? '').toLowerCase() === 'fail' ? 'fail' : 'pass'
}
