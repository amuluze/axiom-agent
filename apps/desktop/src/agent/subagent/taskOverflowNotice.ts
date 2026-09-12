/** 内置委派工具统一的 task 字符上限（explore 与三个审查器同值）。 */
export const MAX_TASK_LENGTH = 8000

/**
 * task 超限回环指引：四个委派工具的失败现场最强信号位与 review 的 diff 超限报错
 * 同一收口哲学——静态指引在提示词里、离失败现场太远，报错只给事实不给恢复配方时，
 * 模型倾向放弃委派改为主 Agent 自查替代，独立审查/探索恰在最大任务上静默失效。
 * 子 Agent 全员有 read，「全文给路径」对所有委派通用；diff 通道仅 review 开放，
 * 由调用方按需追加对应尾巴。
 */
export const TASK_OVERFLOW_GUIDANCE
  = '不要在 task 内嵌大段全文：写清任务意图与关键背景即可，需要完整内容的对象给出其工作区相对路径，由子 Agent 自行 read。'

/** 调用点已确认 task 为 string，这里只负责拼接实际上限、实测字符数与回环指引。 */
export const formatTaskOverflowError = (actualLength: number): { ok: false; error: string } => ({
  ok: false,
  error: `task must be at most ${MAX_TASK_LENGTH} characters (got ${actualLength}). ${TASK_OVERFLOW_GUIDANCE}`,
})
