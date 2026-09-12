import type { ExplorePromptOptions } from '../explore/buildExplorePrompt'

/**
 * 审查类 SubAgent（inspect/examine/review）共享的 system prompt 渲染辅助。
 * 与 explore 的区别只在「角色/审查要点/输出」三段，scope/budget 渲染语义一致，
 * 因此提取为公共函数避免三个审查 builder 重复同样的范围与预算文案。
 */

export const renderReviewerScopeNote = ({ scope, workspaceRoot }: ExplorePromptOptions): string => {
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
export const renderReviewerBudgetNote = ({ budget, contextWindow }: ExplorePromptOptions): string => {
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

/** 只读工具与禁止项段落（三个审查 builder 完全一致）。 */
export const REVIEWER_TOOLS_SECTION = `# 允许的工具
- read：读取文件内容（文本或图片）
- ls：列出目录条目
- grep：在工作区内搜索文本
- find：按模式查找文件
其余工具均不可用；write、edit、bash、审批、工具发现与再次委派 SubAgent 都被禁止。`

export const REVIEWER_FORBIDDEN_SECTION = `# 禁止
- 修改、写入、删除任何文件；不执行命令；不请求审批；不发现新工具；不委派子 Agent。
- 不访问范围外路径（绝对授权文件、\`..\`、符号链接越界都会失败）。`

export type ReviewerVerdict = 'pass' | 'fail' | 'unknown'

/**
 * 从审查结论文本解析结构化判定。三个审查器 system prompt 强制「结论：通过 / 不通过」
 * 固定格式，这里做防御性提取，取**最后一个**「结论：」锚定的匹配——审查行文中途
 * 可能出现假设性表述（如「若不修复 X 则结论：不通过」），最终判定以末次结论为准；
 * 每个匹配内部「不通过」整体命中时「通过」分支在同一位置无法部分命中（同位锚定，
 * 与分支书写顺序无关），不会被截断成「通过」。无法判定（格式漂移、partial 中途
 * 收口）返回 unknown，父 Agent 回退到阅读全文。结果供 details 审计/UI 展示与
 * fail 判定的门禁回环提示消费，不改变父 Agent 决策路径。
 */
export const parseReviewerVerdict = (summary: string): ReviewerVerdict => {
  const pattern = /结论[：:]\s*(通过|不通过)/gu
  let match: RegExpExecArray | null
  let last: RegExpExecArray | null = null
  while ((match = pattern.exec(summary)) !== null) last = match
  if (!last) return 'unknown'
  return last[1] === '不通过' ? 'fail' : 'pass'
}
