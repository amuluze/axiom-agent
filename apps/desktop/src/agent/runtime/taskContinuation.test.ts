import { describe, expect, it } from 'vitest'
import { decideTaskContinuation, type TaskContinuationState } from './taskContinuation'

const progressing: TaskContinuationState = {
  reason: 'turn_limit', aborted: false, continuationCount: 0,
  elapsedMs: 100, maxDurationMs: 1000, hasProgress: true,
}

describe('任务阶段续跑决策', () => {
  it('只允许有进展的轮次或工具触限续跑', () => {
    expect(decideTaskContinuation(progressing)).toBe('continue')
    expect(decideTaskContinuation({ ...progressing, reason: 'tool_limit' })).toBe('continue')
    for (const reason of ['completed', 'stopped', 'aborted', 'error', 'time_limit']) {
      expect(decideTaskContinuation({ ...progressing, reason })).toBe('terminal')
    }
  })
  it('用户取消优先于其他判定', () => {
    expect(decideTaskContinuation({ ...progressing, aborted: true, elapsedMs: 2000 })).toBe('cancelled')
  })
  it('累计时长和续跑次数不会无限扩张', () => {
    expect(decideTaskContinuation({ ...progressing, elapsedMs: 1000 })).toBe('duration_limit')
    expect(decideTaskContinuation({ ...progressing, continuationCount: 3 })).toBe('continuation_limit')
    expect(decideTaskContinuation({ ...progressing, continuationCount: 2 })).toBe('continue')
  })
  it('没有客观进展时暂停', () => {
    expect(decideTaskContinuation({ ...progressing, hasProgress: false })).toBe('no_progress')
  })
  it('无效累计账本拒绝续跑', () => {
    expect(decideTaskContinuation({ ...progressing, elapsedMs: NaN })).toBe('duration_limit')
    expect(decideTaskContinuation({ ...progressing, continuationCount: NaN })).toBe('continuation_limit')
  })
})
