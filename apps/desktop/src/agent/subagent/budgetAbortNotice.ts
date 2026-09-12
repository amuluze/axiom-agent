/**
 * 预算类中止（预算耗尽 / 轮次、工具、时长上限且无总结）的父模型恢复配方。
 * explore 与三个审查工具共用：失败现场不给恢复配方时，模型倾向以同等规模盲目
 * 重试，会更快烧光父 run 配额——先收口已有证据，再收窄 scope 定点补探/补审。
 * 与 task 超限回环指引（taskOverflowNotice）同一收口哲学。
 */
export const BUDGET_ABORT_GUIDANCE
  = '建议：基于已收集到的信息直接收口，或把 scope 收窄到未覆盖部分后重新委派；重复同等规模的委派会更快耗尽父 run 配额。'

/** 预算中止错误识别：SubAgentRuntime.settleResult 的抛错文案形态。 */
export const isBudgetAbortError = (message: string): boolean =>
  /预算耗尽|预算中止|中止且没有总结/.test(message)

/** partial 收口时的前缀短语：探索/审查各自定制（其余配方文本共享）。 */
export const budgetPartialGuidance = (label: '探索' | '审查'): string =>
  `\n\n${label}预算已用尽：${BUDGET_ABORT_GUIDANCE}`
