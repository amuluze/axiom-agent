import { describe, expect, it } from 'vitest'
import {
  aggregateStatus,
  canTransitionStatus,
  failureOriginForCase,
  failureOriginForOutcome,
  interruptStatus,
  isFailureOrigin,
  isTerminalStatus,
  stopsBatch,
  transitionStatus,
  type TestRunStatus,
} from './runState'

describe('test run state machine', () => {
  it('allows the approval path queued → running → waiting_approval → running → passed', () => {
    let status: TestRunStatus = 'queued'
    status = transitionStatus(status, 'running')
    status = transitionStatus(status, 'waiting_approval')
    status = transitionStatus(status, 'running')
    status = transitionStatus(status, 'passed')
    expect(status).toBe('passed')
  })

  it('keeps assertion failure, rejection and infrastructure error as distinct terminals', () => {
    expect(canTransitionStatus('running', 'failed')).toBe(true)
    expect(canTransitionStatus('running', 'error')).toBe(true)
    expect(canTransitionStatus('waiting_approval', 'rejected')).toBe(true)
    expect(canTransitionStatus('waiting_approval', 'failed')).toBe(false)
    expect(canTransitionStatus('running', 'interrupted')).toBe(true)
  })

  it('treats every terminal status as immutable', () => {
    const terminals: TestRunStatus[] = [
      'passed', 'failed', 'error', 'rejected', 'skipped', 'canceled', 'interrupted',
    ]
    for (const status of terminals) {
      expect(isTerminalStatus(status)).toBe(true)
      expect(() => transitionStatus(status, 'running')).toThrow('非法测试状态转移')
    }
  })

  it('rejects a repeated settle of the same step', () => {
    const settled = transitionStatus('running', 'passed')
    expect(() => transitionStatus(settled, 'passed')).toThrow('passed → passed')
  })

  it('never auto-resumes a step that was in flight at crash time', () => {
    expect(interruptStatus('running')).toBe('interrupted')
    expect(interruptStatus('waiting_approval')).toBe('interrupted')
    expect(interruptStatus('queued')).toBe('skipped')
    expect(interruptStatus('failed')).toBe('failed')
  })

  it('aggregates children by diagnostic priority', () => {
    expect(aggregateStatus(['passed', 'failed', 'skipped'])).toBe('failed')
    expect(aggregateStatus(['passed', 'rejected', 'failed'])).toBe('rejected')
    expect(aggregateStatus(['passed', 'canceled'])).toBe('canceled')
    expect(aggregateStatus(['passed', 'passed'])).toBe('passed')
    expect(aggregateStatus(['skipped', 'skipped'])).toBe('skipped')
  })
})

describe('failure origin', () => {
  it('derives the origin from the verdict without guessing semantics', () => {
    expect(failureOriginForOutcome({ verdict: 'failed' })).toBe('assertion')
    expect(failureOriginForOutcome({ verdict: 'rejected' })).toBe('approval')
    // error 缺省按步骤级故障解释，只有驱动给出显式事实时才升级为环境问题。
    expect(failureOriginForOutcome({ verdict: 'error' })).toBe('driver')
    expect(failureOriginForOutcome({ verdict: 'error', origin: 'environment' })).toBe('environment')
  })

  it('gives no origin to steps that did not fail', () => {
    expect(failureOriginForOutcome({ verdict: 'passed' })).toBeNull()
    expect(failureOriginForOutcome({ verdict: 'canceled' })).toBeNull()
  })

  it('takes the case origin from the first step that did not pass', () => {
    expect(failureOriginForCase([
      { status: 'passed' },
      { status: 'error', origin: 'environment' },
      { status: 'skipped' },
    ])).toBe('environment')
    // 没有驱动事实时按状态兜底，取消/中断/跳过不产生归因。
    expect(failureOriginForCase([{ status: 'rejected' }])).toBe('approval')
    expect(failureOriginForCase([{ status: 'canceled' }, { status: 'passed' }])).toBeNull()
    expect(failureOriginForCase([])).toBeNull()
  })

  it('stops a batch only for environment and approval origins', () => {
    expect(stopsBatch('environment')).toBe(true)
    expect(stopsBatch('approval')).toBe(true)
    // 断言失败是产品/测试问题，后续用例仍然有价值。
    expect(stopsBatch('assertion')).toBe(false)
    expect(stopsBatch('driver')).toBe(false)
    expect(stopsBatch(null)).toBe(false)
    expect(isFailureOrigin('environment')).toBe(true)
    expect(isFailureOrigin('whatever')).toBe(false)
  })
})
