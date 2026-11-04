/** 阶段额度可重置，但任务截止时间和已用续跑次数必须由调用方累计。 */
export interface TaskContinuationState {
  reason: string
  aborted: boolean
  continuationCount: number
  elapsedMs: number
  maxDurationMs: number
  /** 由宿主客观判定；模型声称有进展不能替代此信号。 */
  hasProgress: boolean
}

export const MAX_TASK_CONTINUATIONS = 3

export type TaskContinuationDecision =
  | 'continue'
  | 'terminal'
  | 'cancelled'
  | 'duration_limit'
  | 'continuation_limit'
  | 'no_progress'

export function taskPauseMessage(decision: string): string | undefined {
  switch (decision) {
    case 'duration_limit': return '任务已达到累计运行时长上限，已暂停。可检查当前成果后手动继续。'
    case 'continuation_limit': return '任务已达到自动续跑次数上限，已暂停。可检查当前成果后手动继续。'
    case 'no_progress': return '本阶段没有确认到新增有效结果，或出现工具错误，已暂停。请检查工具结果后决定是否继续。'
    default: return undefined
  }
}

export function decideTaskContinuation(state: TaskContinuationState): TaskContinuationDecision {
  if (state.aborted) return 'cancelled'
  if (state.reason !== 'turn_limit' && state.reason !== 'tool_limit') return 'terminal'
  if (!Number.isFinite(state.elapsedMs) || !Number.isFinite(state.maxDurationMs)
    || state.elapsedMs < 0 || state.maxDurationMs <= 0
    || state.elapsedMs >= state.maxDurationMs) return 'duration_limit'
  if (!Number.isInteger(state.continuationCount) || state.continuationCount < 0
    || state.continuationCount >= MAX_TASK_CONTINUATIONS) return 'continuation_limit'
  if (!state.hasProgress) return 'no_progress'
  return 'continue'
}
