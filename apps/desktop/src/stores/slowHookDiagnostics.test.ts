import { describe, expect, it, vi } from 'vitest'
import type { RuntimeHookDiagnostic, RuntimeHookDiagnosticSink } from '@/agent/runtime/RuntimeHookRegistry'
import {
  SLOW_HOOK_THRESHOLD_MS,
  wrapSlowHookDiagnostics,
  type SlowHookAlert,
} from './slowHookDiagnostics'

const diagnostic = (overrides: Partial<RuntimeHookDiagnostic> = {}): RuntimeHookDiagnostic => ({
  stage: 'invocation',
  scopeId: 'scope',
  hookType: 'tool_call',
  id: 'test.hook',
  version: '1',
  source: 'test',
  status: 'completed',
  durationMs: 0,
  ...overrides,
})

const capturingSink = (): { sink: RuntimeHookDiagnosticSink; records: RuntimeHookDiagnostic[] } => {
  const records: RuntimeHookDiagnostic[] = []
  return {
    records,
    sink: {
      record: (d) => {
        records.push(d)
      },
    },
  }
}

describe('wrapSlowHookDiagnostics', () => {
  it('always delegates record to the inner sink regardless of slowness', () => {
    const inner = capturingSink()
    const wrapper = wrapSlowHookDiagnostics(inner.sink, 1_000)
    wrapper.record(diagnostic({ durationMs: 5_000 }))
    wrapper.record(diagnostic({ durationMs: 10 }))
    expect(inner.records).toHaveLength(2)
  })

  it('alerts when an invocation-stage completed record meets the threshold', () => {
    const inner = capturingSink()
    const alerts: SlowHookAlert[] = []
    const wrapper = wrapSlowHookDiagnostics(inner.sink, 1_000, (alert) => alerts.push(alert))
    wrapper.record(diagnostic({ durationMs: 1_000 }))
    expect(alerts).toEqual([{
      stage: 'invocation',
      hookType: 'tool_call',
      id: 'test.hook',
      durationMs: 1_000,
    }])
  })

  it('does not alert below the threshold', () => {
    const inner = capturingSink()
    const alerts: SlowHookAlert[] = []
    const wrapper = wrapSlowHookDiagnostics(inner.sink, 1_000, (alert) => alerts.push(alert))
    wrapper.record(diagnostic({ durationMs: 999 }))
    expect(alerts).toHaveLength(0)
  })

  it('does not alert for deferred or deferred_late stages', () => {
    const inner = capturingSink()
    const alerts: SlowHookAlert[] = []
    const wrapper = wrapSlowHookDiagnostics(inner.sink, 1_000, (alert) => alerts.push(alert))
    wrapper.record(diagnostic({ stage: 'deferred', durationMs: 5_000 }))
    wrapper.record(diagnostic({ stage: 'deferred_late', durationMs: 5_000 }))
    expect(alerts).toHaveLength(0)
  })

  it('does not alert for non-completed statuses', () => {
    const inner = capturingSink()
    const alerts: SlowHookAlert[] = []
    const wrapper = wrapSlowHookDiagnostics(inner.sink, 1_000, (alert) => alerts.push(alert))
    for (const status of ['failed', 'timed_out', 'aborted'] as const) {
      wrapper.record(diagnostic({ status, durationMs: 5_000 }))
    }
    expect(alerts).toHaveLength(0)
  })

  it('keeps the default observer side-effect-free: alert payload has no error or content fields', () => {
    const inner = capturingSink()
    const observed: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((msg: string) => {
      observed.push(msg)
    })
    try {
      const wrapper = wrapSlowHookDiagnostics(inner.sink, 1_000)
      wrapper.record({
        ...diagnostic({ durationMs: 2_000 }),
        error: 'super-secret-stack-trace',
      })
      expect(observed).toHaveLength(1)
      // 告警正文不得泄露 error 字段或任何 hook 内容
      expect(observed[0]).not.toContain('super-secret-stack-trace')
      expect(observed[0]).toContain('test.hook')
      expect(observed[0]).toContain('tool_call')
      expect(observed[0]).toContain('2000')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('records to the inner sink even when the inner sink throws', () => {
    // inner 抛错不应阻断 wrapper 自身的 record 路径（registry 对 sink 异常已有兜底，
    // 但 wrapper 不应在 inner 抛错时提前中断或进入告警分支——保持委托语义）
    const throwing: RuntimeHookDiagnosticSink = {
      record: () => {
        throw new Error('sink down')
      },
    }
    const wrapper = wrapSlowHookDiagnostics(throwing, 1_000)
    // 委托抛错向上冒泡：registry 的 recordDiagnostic 已 try/catch 吞掉，
    // 这里仅断言 wrapper 不吞错、不静默改语义。
    expect(() => wrapper.record(diagnostic({ durationMs: 2_000 }))).toThrow('sink down')
  })

  it('rejects an invalid threshold', () => {
    const inner = capturingSink()
    expect(() => wrapSlowHookDiagnostics(inner.sink, NaN)).toThrow('慢 hook 阈值无效')
    expect(() => wrapSlowHookDiagnostics(inner.sink, -1)).toThrow('慢 hook 阈值无效')
  })

  it('exports the default threshold constant', () => {
    expect(SLOW_HOOK_THRESHOLD_MS).toBe(1_000)
  })
})
