import { describe, expect, it, vi } from 'vitest'
import type {
  AgentHarnessCallbackContext,
  AgentHarnessCallbackOperation,
  AgentHarnessDeferredTaskHandle,
  AgentHarnessDeferredTaskSettlement,
} from './AgentHarness'
import type { BeforeProviderRequestHookEvent } from './RuntimeHookRegistry'
import {
  RuntimeHookDiagnostics,
  RuntimeHookExecutionError,
  RuntimeHookRegistry,
  runtimeHookEvent,
} from './RuntimeHookRegistry'

/**
 * RuntimeHookRegistry 的独立单元测试。
 *
 * AgentHarness.test.ts 经 harness 间接覆盖了 registry 的部分行为，但这些测试
 * 依赖完整的 AgentHarness 装配。本文件直接 `new RuntimeHookRegistry()`，聚焦
 * registry 自身的边界：注册排序、dispatch 的 advance/stop/validate 组合、
 * seal 指纹、诊断不可变性与错误名白名单、生命周期状态机。
 */

const testRegistration = (id: string, overrides: { priority?: number; timeoutMs?: number } = {}) => ({
  id: `test.${id}`,
  version: '1',
  source: 'test',
  ...overrides,
})

const makeContext = (signal: AbortSignal = new AbortController().signal): AgentHarnessCallbackContext => {
  const allowed: readonly AgentHarnessCallbackOperation[] = ['request_abort', 'defer_until_idle']
  return {
    phase: 'turn',
    signal,
    allowedOperations: allowed,
    can: (operation) => allowed.includes(operation),
    requestAbort: () => false,
    steer: async () => false,
    followUp: async () => false,
    nextTurn: async () => false,
    appendMessage: async () => undefined,
    scheduleRuntimeUpdate: async () => undefined,
    deferUntilIdle: (): AgentHarnessDeferredTaskHandle => {
      const result: AgentHarnessDeferredTaskSettlement = {
        status: 'completed',
        durationMs: 0,
      }
      const promise = Promise.resolve(result)
      return { settlement: promise, completion: promise }
    },
  }
}

const requestEvent = (signal: AbortSignal): BeforeProviderRequestHookEvent => runtimeHookEvent(
  'before_provider_request',
  {
    sessionId: 'session-1',
    apiFormat: 'anthropic-compatible' as const,
    signal,
    runId: 'run-1',
    model: { provider: 'provider', model: 'model' },
    timeoutMs: 30_000,
    endpoint: 'https://example.test',
  },
)

describe('RuntimeHookRegistry — registration and ordering', () => {
  it('orders handlers by priority DESC then registration sequence ASC', async () => {
    const registry = new RuntimeHookRegistry()
    const calls: string[] = []
    // 故意按乱序 priority 注册：高 priority 必须先执行；同 priority 按注册顺序
    registry.register(
      'before_provider_request',
      async () => { calls.push('low'); return undefined },
      testRegistration('low', { priority: 1 }),
    )
    registry.register(
      'before_provider_request',
      async () => { calls.push('high'); return undefined },
      testRegistration('high', { priority: 100 }),
    )
    registry.register(
      'before_provider_request',
      async () => { calls.push('mid-1'); return undefined },
      testRegistration('mid-a', { priority: 50 }),
    )
    registry.register(
      'before_provider_request',
      async () => { calls.push('mid-2'); return undefined },
      testRegistration('mid-b', { priority: 50 }),
    )
    const controller = new AbortController()
    await registry.dispatch('before_provider_request', requestEvent(controller.signal), makeContext(controller.signal))
    expect(calls).toEqual(['high', 'mid-1', 'mid-2', 'low'])
  })

  it('requires consistent bundle identity across hook types', () => {
    const registry = new RuntimeHookRegistry()
    // 同一 id 在两个 hook 类型下注册：version/source/priority/timeoutMs 必须全一致
    registry.register('before_provider_request', async () => undefined, testRegistration('bundle'))
    expect(() => registry.register(
      'after_provider_response',
      async () => undefined,
      { ...testRegistration('bundle'), version: '2' },
    )).toThrow('Runtime Hook bundle identity 冲突')
    // 一致的可以跨 hook 类型注册
    expect(() => registry.register(
      'after_provider_response',
      async () => undefined,
      testRegistration('bundle'),
    )).not.toThrow()
  })

  it('enabled:false returns a no-op unregister and registers nothing', async () => {
    const registry = new RuntimeHookRegistry()
    const handler = vi.fn()
    const unregister = registry.register(
      'before_provider_request',
      handler,
      { ...testRegistration('disabled'), enabled: false },
    )
    expect(typeof unregister).toBe('function')
    const controller = new AbortController()
    await registry.dispatch('before_provider_request', requestEvent(controller.signal), makeContext(controller.signal))
    expect(handler).not.toHaveBeenCalled()
    // no-op unregister 可安全调用且不抛错
    expect(() => unregister()).not.toThrow()
  })

  it('throws when registering or unregistering after seal', () => {
    const registry = new RuntimeHookRegistry()
    const unregister = registry.register(
      'before_provider_request',
      async () => undefined,
      testRegistration('sealed'),
    )
    registry.seal()
    expect(() => registry.register(
      'after_provider_response',
      async () => undefined,
      testRegistration('other'),
    )).toThrow('已封存')
    expect(() => unregister()).toThrow('已封存')
  })
})

describe('RuntimeHookRegistry — dispatch advance / stop / validate', () => {
  it('advance threads each handler result into the next handler event', async () => {
    const registry = new RuntimeHookRegistry()
    const seen: Array<number | undefined> = []
    registry.register(
      'before_provider_request',
      () => ({ timeoutMs: 1_000 }),
      testRegistration('h1', { priority: 100 }),
    )
    registry.register(
      'before_provider_request',
      (event) => { seen.push(event.timeoutMs); return { timeoutMs: 2_000 } },
      testRegistration('h2', { priority: 50 }),
    )
    registry.register(
      'before_provider_request',
      (event) => { seen.push(event.timeoutMs); return undefined },
      testRegistration('h3', { priority: 1 }),
    )
    const controller = new AbortController()
    await registry.dispatch(
      'before_provider_request',
      requestEvent(controller.signal),
      makeContext(controller.signal),
      (event, result) => ({
        ...event,
        timeoutMs: result.timeoutMs ?? event.timeoutMs,
      }),
    )
    // h2 看到的是 h1 advance 后的 1_000；h3 看到的是 h2 advance 后的 2_000
    expect(seen).toEqual([1_000, 2_000])
  })

  it('stop breaks the chain and skips later handlers', async () => {
    const registry = new RuntimeHookRegistry()
    const later = vi.fn()
    registry.register(
      'before_provider_request',
      () => undefined,
      testRegistration('stopper', { priority: 100 }),
    )
    registry.register(
      'before_provider_request',
      later,
      testRegistration('later', { priority: 1 }),
    )
    const controller = new AbortController()
    await registry.dispatch(
      'before_provider_request',
      requestEvent(controller.signal),
      makeContext(controller.signal),
      undefined,
      // stop 在第一个非 undefined 结果即终止：但第一个返回 undefined 不会触发 stop。
      // 改用 tool_call 验证真实阻断更自然——这里验证 stop 回调对 undefined 的守卫。
      () => false,
    )
    // 第一个返回 undefined（stop 守卫），第二个仍执行
    expect(later).toHaveBeenCalled()
  })

  it('stop with a real result terminates before subsequent handlers', async () => {
    const registry = new RuntimeHookRegistry()
    const spy = vi.fn()
    registry.register(
      'before_provider_request',
      () => ({ timeoutMs: 500 }),
      testRegistration('first', { priority: 100 }),
    )
    registry.register(
      'before_provider_request',
      spy,
      testRegistration('second', { priority: 1 }),
    )
    const controller = new AbortController()
    await registry.dispatch(
      'before_provider_request',
      requestEvent(controller.signal),
      makeContext(controller.signal),
      undefined,
      () => true, // 第一个非 undefined 结果即停
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it('validate runs before advance/stop and its throw becomes failed status', async () => {
    const registry = new RuntimeHookRegistry()
    registry.register(
      'before_provider_request',
      () => ({ timeoutMs: 500 }),
      testRegistration('validated'),
    )
    const controller = new AbortController()
    const error = new Error('校验失败')
    await expect(registry.dispatch(
      'before_provider_request',
      requestEvent(controller.signal),
      makeContext(controller.signal),
      undefined,
      undefined,
      () => { throw error },
    )).rejects.toBeInstanceOf(RuntimeHookExecutionError)
    // 诊断记 failed
    expect(registry.diagnostics()).toEqual([
      expect.objectContaining({ status: 'failed', error: 'Error' }),
    ])
  })

  it('undefined result is transparent: no advance, no stop, no validate', async () => {
    const registry = new RuntimeHookRegistry()
    const advance = vi.fn()
    const stop = vi.fn()
    const validate = vi.fn()
    registry.register(
      'before_provider_request',
      () => undefined,
      testRegistration('transparent'),
    )
    const controller = new AbortController()
    const results = await registry.dispatch(
      'before_provider_request',
      requestEvent(controller.signal),
      makeContext(controller.signal),
      advance,
      stop,
      validate,
    )
    expect(results).toEqual([undefined])
    expect(advance).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
  })

  it('prior handler advance is preserved when a later handler triggers stop', async () => {
    // 对应改进项③的 registry 级语义：前一个 hook 返回 advance-able 结果（不触发 stop），
    // 后一个 hook 返回阻断性结果触发 stop——advance 的累积应保留，后续 handler 不执行。
    // dispatch 的 stop 回调对所有非 undefined 结果统一判定，因此用条件化的 stop：
    // 仅当结果的 timeoutMs 达到 sentinel 值时才停。
    const registry = new RuntimeHookRegistry()
    const seenByStopper: Array<number | undefined> = []
    const spy = vi.fn()
    const STOP_SENTINEL = 9_999
    registry.register(
      'before_provider_request',
      () => ({ timeoutMs: 7_777 }),
      testRegistration('advancer', { priority: 100 }),
    )
    registry.register(
      'before_provider_request',
      (event) => { seenByStopper.push(event.timeoutMs); return { timeoutMs: STOP_SENTINEL } },
      testRegistration('stopper', { priority: 50 }),
    )
    registry.register(
      'before_provider_request',
      spy,
      testRegistration('skipped', { priority: 1 }),
    )
    const controller = new AbortController()
    await registry.dispatch(
      'before_provider_request',
      requestEvent(controller.signal),
      makeContext(controller.signal),
      (event, result) => ({ ...event, timeoutMs: result.timeoutMs ?? event.timeoutMs }),
      (result) => result.timeoutMs === STOP_SENTINEL,
    )
    // stopper 看到的是 advancer advance 后的 7_777
    expect(seenByStopper).toEqual([7_777])
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('RuntimeHookRegistry — seal and dependency fingerprint', () => {
  it('seal is idempotent and returns the same dependency set', () => {
    const registry = new RuntimeHookRegistry()
    registry.register('before_provider_request', async () => undefined, testRegistration('bundle'))
    const first = registry.seal()
    const second = registry.seal()
    expect(second).toEqual(first)
  })

  it('collects one dependency per bundle with a stable, content-addressed fingerprint', () => {
    const registry = new RuntimeHookRegistry()
    registry.register(
      'before_provider_request',
      async () => undefined,
      testRegistration('bundle', { priority: 100, timeoutMs: 5_000 }),
    )
    // 同一 bundle 在另一个 hook 类型注册：fingerprint 的 hookCounts 应累加
    registry.register(
      'after_provider_response',
      async () => undefined,
      testRegistration('bundle', { priority: 100, timeoutMs: 5_000 }),
    )
    const [dependency] = registry.seal()
    expect(dependency.id).toBe('test.bundle')
    expect(dependency.version).toBe('1')
    // 指纹是确定性 JSON：含 schemaVersion/source/priority/timeoutMs + 两个 hook 计数
    const parsed = JSON.parse(dependency.fingerprint)
    expect(parsed).toEqual({
      schemaVersion: 1,
      source: 'test',
      priority: 100,
      timeoutMs: 5_000,
      hooks: [
        { type: 'after_provider_response', count: 1 },
        { type: 'before_provider_request', count: 1 },
      ],
    })
  })

  it('dependencies throws before seal', () => {
    const registry = new RuntimeHookRegistry()
    expect(() => registry.dependencies()).toThrow('尚未封存')
  })
})

describe('RuntimeHookRegistry — diagnostics', () => {
  it('returns structuredClone copies; mutating a result does not affect later snapshots', async () => {
    const registry = new RuntimeHookRegistry()
    registry.register('before_provider_request', async () => undefined, testRegistration('d'))
    const controller = new AbortController()
    await registry.dispatch('before_provider_request', requestEvent(controller.signal), makeContext(controller.signal))
    const first = registry.diagnostics()
    first[0].durationMs = 99_999
    const second = registry.diagnostics()
    expect(second[0].durationMs).not.toBe(99_999)
  })

  it('rotates the diagnostic ring buffer at capacity (RuntimeHookDiagnostics)', () => {
    const sink = new RuntimeHookDiagnostics(2)
    sink.record({
      stage: 'invocation', scopeId: 's', hookType: 'tool_call',
      id: 'a', version: '1', source: 't', status: 'completed', durationMs: 1,
    })
    sink.record({
      stage: 'invocation', scopeId: 's', hookType: 'tool_call',
      id: 'b', version: '1', source: 't', status: 'completed', durationMs: 2,
    })
    sink.record({
      stage: 'invocation', scopeId: 's', hookType: 'tool_call',
      id: 'c', version: '1', source: 't', status: 'completed', durationMs: 3,
    })
    const snapshot = sink.snapshot()
    expect(snapshot).toHaveLength(2)
    expect(snapshot.map((d) => d.id)).toEqual(['b', 'c'])
  })

  it('normalizes unknown error names to Error via the SAFE_HOOK_ERROR_NAMES whitelist', async () => {
    const registry = new RuntimeHookRegistry()
    class FooError extends Error {
      constructor() { super('foo'); this.name = 'FooError' }
    }
    registry.register(
      'before_provider_request',
      async () => { throw new FooError() },
      testRegistration('unknown-err', { timeoutMs: 30_000 }),
    )
    const controller = new AbortController()
    await expect(registry.dispatch(
      'before_provider_request',
      requestEvent(controller.signal),
      makeContext(controller.signal),
    )).rejects.toBeInstanceOf(RuntimeHookExecutionError)
    expect(registry.diagnostics()[0]).toMatchObject({ status: 'failed', error: 'Error' })
  })

  it('preserves whitelisted error names', async () => {
    const cases: Array<{ name: string; build: () => Error }> = [
      { name: 'AbortError', build: () => new DOMException('x', 'AbortError') },
      { name: 'RuntimeHookTimeoutError', build: () => {
        const e = new Error('t'); e.name = 'RuntimeHookTimeoutError'; return e
      } },
      { name: 'AgentHarnessError', build: () => {
        const e = new Error('h'); e.name = 'AgentHarnessError'; return e
      } },
      { name: 'RuntimeHookInvocationExpiredError', build: () => {
        const e = new Error('i'); e.name = 'RuntimeHookInvocationExpiredError'; return e
      } },
      { name: 'TypeError', build: () => new TypeError('t') },
    ]
    for (const { name, build } of cases) {
      const r = new RuntimeHookRegistry()
      r.register(
        'before_provider_request',
        async () => { throw build() },
        testRegistration(`wl-${name}`, { timeoutMs: 30_000 }),
      )
      const controller = new AbortController()
      await expect(r.dispatch(
        'before_provider_request',
        requestEvent(controller.signal),
        makeContext(controller.signal),
      )).rejects.toBeInstanceOf(RuntimeHookExecutionError)
      expect(r.diagnostics()[0]).toMatchObject({ error: name })
    }
  })

  it('records non-Error throws as UnknownError', async () => {
    const registry = new RuntimeHookRegistry()
    registry.register(
      'before_provider_request',
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      async () => { throw 'a bare string' },
      testRegistration('string-throw', { timeoutMs: 30_000 }),
    )
    const controller = new AbortController()
    await expect(registry.dispatch(
      'before_provider_request',
      requestEvent(controller.signal),
      makeContext(controller.signal),
    )).rejects.toBeInstanceOf(RuntimeHookExecutionError)
    expect(registry.diagnostics()[0]).toMatchObject({ error: 'UnknownError' })
  })

  it('swallows diagnosticSink.record failures without affecting dispatch', async () => {
    const throwingSink = { record: () => { throw new Error('sink down') } }
    const registry = new RuntimeHookRegistry(throwingSink)
    registry.register('before_provider_request', async () => undefined, testRegistration('sink'))
    const controller = new AbortController()
    // sink 抛错被 registry 静默吞掉，dispatch 正常完成
    await expect(registry.dispatch(
      'before_provider_request',
      requestEvent(controller.signal),
      makeContext(controller.signal),
    )).resolves.toEqual([undefined])
    // registry 自身的 recentDiagnostics 仍记录（不受 sink 影响）
    expect(registry.diagnostics()[0]).toMatchObject({ status: 'completed' })
  })
})

describe('RuntimeHookRegistry — lifecycle', () => {
  it('beginDispose blocks subsequent dispatch with 已失效', async () => {
    const registry = new RuntimeHookRegistry()
    registry.register('before_provider_request', async () => undefined, testRegistration('d'))
    registry.beginDispose()
    const controller = new AbortController()
    await expect(registry.dispatch(
      'before_provider_request',
      requestEvent(controller.signal),
      makeContext(controller.signal),
    )).rejects.toThrow('已失效')
  })

  it('dispose is idempotent', () => {
    const registry = new RuntimeHookRegistry()
    expect(() => registry.dispose()).not.toThrow()
    expect(() => registry.dispose()).not.toThrow()
  })
})
