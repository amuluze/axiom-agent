import type {
  AgentTool,
  ModelRequest,
  ModelStreamEvent,
  ModelTransport,
  ModelTransportLifecycle,
} from '@/agent/core/types'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentHarness,
  AgentHarnessError,
  AgentHarnessOperationCoordinator,
  isAgentHarnessAbortError,
  type AgentHarnessDeferredTaskHandle,
} from './AgentHarness'
import { RuntimeHookDiagnostics } from './RuntimeHookRegistry'

class StaticTransport implements ModelTransport {
  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield { type: 'start', responseId: 'response-1' }
    yield { type: 'text_delta', contentIndex: 0, delta: 'done' }
    yield { type: 'done', stopReason: 'stop' }
  }
}

class ToolTransport implements ModelTransport {
  private requests = 0

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests += 1
    yield { type: 'start' }
    if (this.requests === 1) {
      yield { type: 'tool_call_start', index: 0, contentIndex: 0, id: 'call-1', name: 'inspect' }
      yield { type: 'tool_call_delta', index: 0, argumentsDelta: '{}' }
      yield { type: 'tool_call_end', index: 0 }
      yield { type: 'done', stopReason: 'tool_use' }
      return
    }
    yield { type: 'text_delta', contentIndex: 0, delta: 'finished' }
    yield { type: 'done', stopReason: 'stop' }
  }
}

class LifecycleTransport implements ModelTransport {
  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
    lifecycle?: ModelTransportLifecycle,
  ): AsyncIterable<ModelStreamEvent> {
    const identity = {
      sessionId: request.sessionId,
      runId: request.runId,
      model: request.model,
      apiFormat: 'openai-compatible' as const,
      endpoint: 'https://example.com/v1/chat/completions',
      signal,
    }
    const requestResult = await lifecycle?.beforeRequest?.({ ...identity, timeoutMs: 1_000 })
    await lifecycle?.beforePayload?.({
      ...identity,
      timeoutMs: requestResult?.timeoutMs ?? 1_000,
      payload: { model: request.model.model, stream: true },
    })
    await lifecycle?.afterResponse?.({ ...identity, status: 200 })
    yield { type: 'start' }
    yield { type: 'done', stopReason: 'stop' }
  }
}

class RecordingTransport implements ModelTransport {
  readonly requests: ModelRequest[] = []

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(structuredClone(request))
    yield { type: 'start' }
    yield { type: 'done', stopReason: 'stop' }
  }
}

class AbortableTransport implements ModelTransport {
  private notifyStarted!: () => void
  readonly started = new Promise<void>((resolve) => { this.notifyStarted = resolve })

  async *stream(_request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent> {
    this.notifyStarted()
    yield { type: 'start' }
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  }
}

const createHarness = (transport: ModelTransport = new StaticTransport(), tools: AgentTool[] = []) =>
  new AgentHarness({
    sessionId: 'session-1',
    systemPrompt: 'safe',
    model: { provider: 'test', model: 'model-1' },
    transport,
    tools,
  })

const testHookRegistration = (id: string, overrides: { priority?: number; timeoutMs?: number } = {}) => ({
  id: `test.${id}`,
  version: '1',
  source: 'test',
  ...overrides,
})

describe('AgentHarness', () => {
  it('separates frozen Hook registration and host mutation capabilities', () => {
    const harness = createHarness()

    expect(Object.isFrozen(harness.hooks)).toBe(true)
    expect(Object.isFrozen(harness.host)).toBe(true)
    expect('updateRuntime' in harness.hooks).toBe(false)
    expect('on' in harness.host).toBe(false)
    expect(() => Reflect.apply(harness.hooks.on, harness.hooks, ['context', () => undefined]))
      .toThrow('必须提供 identity')
  })

  it('seals Hook dependencies for a Session while preserving dispose cleanup', async () => {
    const harness = createHarness()
    const unregister = harness.hooks.on(
      'context',
      () => undefined,
      testHookRegistration('sealed-session'),
    )
    harness.addCleanup(unregister)

    const dependencies = harness.hooks.seal()
    dependencies[0]!.fingerprint = 'mutated'

    expect(harness.hooks.dependencies()).toEqual([
      expect.objectContaining({
        id: 'test.sealed-session',
        fingerprint: expect.not.stringMatching('mutated'),
      }),
    ])
    expect(() => harness.hooks.on(
      'context',
      () => undefined,
      testHookRegistration('late-registration'),
    )).toThrow('已封存')
    expect(unregister).toThrow('已封存')
    await expect(harness.dispose()).resolves.toBeUndefined()
  })

  it('applies isolated before_agent_start and context Hook results without persisting a temporary prompt', async () => {
    const transport = new RecordingTransport()
    const harness = createHarness(transport)
    const hookMessage = {
      id: 'hook-message',
      role: 'user' as const,
      content: 'hook context',
      createdAt: 2,
    }
    harness.hooks.on('before_agent_start', (event) => {
      event.context.model.model = 'mutated-model'
      event.prompts.splice(0)
      return { appendMessages: [hookMessage], systemPrompt: 'temporary prompt' }
    }, testHookRegistration('isolated-before-start'))
    harness.hooks.on('context', (event) => ({
      messages: event.messages.filter((message) => message.id === 'hook-message'),
    }), testHookRegistration('isolated-context'))

    const result = await harness.prompt('original prompt')

    expect(transport.requests[0]).toMatchObject({
      systemPrompt: 'temporary prompt',
      model: { model: 'model-1' },
      messages: [hookMessage],
    })
    expect(result.messages).toContainEqual(hookMessage)
    expect(harness.runtimeContext.systemPrompt).toBe('safe')
    expect(harness.runtimeContext.model.model).toBe('model-1')
  })

  it('exposes one observer surface while keeping runtime persistence listeners awaited', async () => {
    const harness = createHarness()
    const observed: string[] = []
    const persisted: string[] = []
    harness.subscribe((event) => { observed.push(event.type) })
    harness.subscribeRuntime(async (event) => {
      await Promise.resolve()
      persisted.push(event.type)
    })

    await harness.nextTurn('queued context')
    await harness.host.updateRuntime({ reasoning: { level: 'high', mode: 'effort' } })
    const result = await harness.prompt('run')

    expect(result.reason).toBe('completed')
    expect(observed).toContain('queue_update')
    expect(observed).toContain('runtime_update')
    expect(observed).toContain('agent_settled')
    expect(persisted.at(-1)).toBe('agent_settled')
  })

  it('exposes isolated read-only agent_settled lifecycle events', async () => {
    const harness = createHarness()
    const settledEvents: Array<{ runId: string; messageCount: number }> = []
    expect(Object.isFrozen(harness.lifecycle)).toBe(true)
    expect(harness.lifecycle.delivery).toBe('best-effort-readonly')
    harness.lifecycle.on('agent_settled', (event) => {
      event.savePoint.messageCount = 0
      throw new Error('observer unavailable')
    })
    harness.lifecycle.on('agent_settled', async (event) => {
      await Promise.resolve()
      settledEvents.push({
        runId: event.savePoint.runId,
        messageCount: event.savePoint.messageCount,
      })
    })

    const result = await harness.prompt('run')
    await vi.waitFor(() => expect(settledEvents).toEqual([{
      runId: result.runId,
      messageCount: result.messages.length,
    }]))
  })

  it('isolates best-effort observers from runtime settlement', async () => {
    const harness = createHarness()
    const persisted: string[] = []
    harness.subscribe(async () => { throw new Error('observer unavailable') })
    harness.subscribeRuntime((event) => { persisted.push(event.type) })

    const result = await harness.prompt('run')

    expect(result.reason).toBe('completed')
    expect(persisted.at(-1)).toBe('agent_settled')
  })

  it('returns a structured abort settlement after the durable idle barrier', async () => {
    const transport = new AbortableTransport()
    const harness = createHarness(transport)
    const abortEvents: unknown[] = []
    harness.subscribe((event) => {
      if (event.type === 'abort') abortEvents.push(event.settlement)
    })
    const run = harness.prompt('run')
    await transport.started
    await harness.steer('recover steering')
    await harness.nextTurn('preserve next turn')

    const settlement = await harness.abort()
    const result = await run

    expect(result.reason).toBe('aborted')
    expect(settlement).toMatchObject({
      sessionId: 'session-1',
      hadActiveRun: true,
      settled: true,
      durable: true,
      runId: result.runId,
      reason: 'aborted',
      savePoint: { runId: result.runId },
      queues: {
        consumedMessageIds: [],
        recovered: [expect.objectContaining({ content: 'recover steering' })],
        preservedNextTurn: [expect.objectContaining({ content: 'preserve next turn' })],
        discardedMessageIds: [],
      },
      errors: [],
    })
    expect(harness.isRunning).toBe(false)
    expect(abortEvents).toEqual([settlement])
  })

  it('shares one synchronous phase lock across rebound harness instances', async () => {
    const coordinator = new AgentHarnessOperationCoordinator()
    const transport = new AbortableTransport()
    const first = new AgentHarness({
      sessionId: 'phase-first',
      systemPrompt: 'safe',
      model: { provider: 'test', model: 'model-1' },
      transport,
      operationCoordinator: coordinator,
    })
    const rebound = new AgentHarness({
      sessionId: 'phase-rebound',
      systemPrompt: 'safe',
      model: { provider: 'test', model: 'model-1' },
      transport: new StaticTransport(),
      operationCoordinator: coordinator,
    })

    const run = first.prompt('run')
    await transport.started

    expect(first.phase).toBe('turn')
    expect(rebound.phase).toBe('turn')
    await expect(rebound.prompt('overlap')).rejects.toMatchObject({ code: 'busy' })
    await expect(rebound.compact()).rejects.toMatchObject({ code: 'busy' })
    await expect(rebound.runStructuralOperation('branch_summary', async () => undefined))
      .rejects.toMatchObject({ code: 'busy' })
    await expect(rebound.host.updateRuntime({ systemPrompt: 'overlap' }))
      .rejects.toMatchObject({ code: 'busy' })
    expect(await rebound.nextTurn('allowed next turn')).toBe(true)

    expect(first.requestAbort()).toBe(true)
    expect(first.requestAbort()).toBe(false)
    expect((await run).reason).toBe('aborted')
    await first.waitForIdle()
    expect(first.phase).toBe('idle')
    expect(rebound.phase).toBe('idle')
  })

  it('cancels a structural operation through the shared requestAbort contract', async () => {
    const coordinator = new AgentHarnessOperationCoordinator()
    const harness = new AgentHarness({
      sessionId: 'phase-structural',
      systemPrompt: 'safe',
      model: { provider: 'test', model: 'model-1' },
      transport: new StaticTransport(),
      operationCoordinator: coordinator,
    })
    const operation = harness.runStructuralOperation('branch_summary', async (signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }))

    expect(harness.phase).toBe('branch_summary')
    expect(harness.requestAbort()).toBe(true)
    await expect(operation).rejects.toMatchObject({ code: 'aborted' })
    expect(harness.phase).toBe('idle')
  })

  it('uses the same aborted contract for Branch Summary hook cancellation', async () => {
    const harness = createHarness()
    harness.hooks.on(
      'before_branch_summary',
      () => ({ cancel: true }),
      testHookRegistration('branch-summary-cancel'),
    )

    const operation = harness.summarizeBranch({
      messages: [{
        id: 'branch-user-cancel',
        role: 'user',
        content: 'cancel summary',
        createdAt: 1,
      }],
      model: { provider: 'test', model: 'model-1' },
      transport: new StaticTransport(),
    })

    await expect(operation).rejects.toMatchObject({ code: 'aborted' })
    await operation.catch((error: unknown) => {
      expect(isAgentHarnessAbortError(error)).toBe(true)
    })
    expect(harness.phase).toBe('idle')
  })

  it('lets an awaited Hook request abort without waiting on its own run', async () => {
    const transport = new AbortableTransport()
    const harness = createHarness(transport)
    let callbackPhase: string | undefined
    harness.hooks.on('before_agent_start', (_event, context) => {
      callbackPhase = context.phase
      expect(context.allowedOperations).toContain('request_abort')
      expect(context.can('request_abort')).toBe(true)
      expect(context.can('defer_until_idle')).toBe(true)
      expect(context.requestAbort()).toBe(true)
      return undefined
    }, testHookRegistration('request-abort'))

    const result = await Promise.race([
      harness.prompt('abort from hook'),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('hook abort deadlocked')), 1_000)
      }),
    ])

    expect(result.reason).toBe('aborted')
    expect(callbackPhase).toBe('turn')
    expect(harness.phase).toBe('idle')
  })

  it('defers settled mutations until idle and rejects unsafe inline settlement writes', async () => {
    const harness = createHarness()
    const settledNote = {
      id: 'settled-note',
      role: 'custom' as const,
      customType: 'settled-note',
      content: 'persist after settlement',
      createdAt: 3,
    }
    let resolveDeferred!: () => void
    const deferred = new Promise<void>((resolve) => { resolveDeferred = resolve })
    harness.subscribeRuntime((event, _signal, context) => {
      if (event.type !== 'agent_settled') return
      expect(context.phase).toBe('turn')
      expect(context.allowedOperations).toEqual(['next_turn', 'defer_until_idle'])
      expect(context.can('next_turn')).toBe(true)
      expect(context.can('append_message')).toBe(false)
      expect(() => context.appendMessage(settledNote)).toThrow(AgentHarnessError)
      context.deferUntilIdle(async () => {
        await harness.appendMessage(settledNote)
        resolveDeferred()
      })
    })

    await harness.prompt('run')
    await deferred

    expect(harness.phase).toBe('idle')
    expect(harness.runtimeContext.messages).toContainEqual(settledNote)
  })

  it('aborts before disposing, runs cleanups once in reverse order, and rejects later mutations', async () => {
    const transport = new AbortableTransport()
    const harness = createHarness(transport)
    const cleanupOrder: string[] = []
    harness.addCleanup(() => { cleanupOrder.push('first') })
    harness.addCleanup(async () => { cleanupOrder.push('second') })
    const run = harness.prompt('dispose active run')
    await transport.started

    const disposing = harness.dispose()
    expect(() => harness.requestAbort()).toThrow(expect.objectContaining({ code: 'invalid_state' }))
    await disposing
    const result = await run

    expect(result.reason).toBe('aborted')
    expect(harness.isDisposed).toBe(true)
    expect(cleanupOrder).toEqual(['second', 'first'])
    await harness.dispose()
    expect(cleanupOrder).toEqual(['second', 'first'])
    await expect(harness.prompt('after dispose')).rejects.toMatchObject({ code: 'invalid_state' })
    await expect(harness.nextTurn('after dispose')).rejects.toMatchObject({ code: 'invalid_state' })
    expect(() => harness.reset()).toThrow(expect.objectContaining({ code: 'invalid_state' }))
    expect(() => harness.subscribe(() => undefined))
      .toThrow(expect.objectContaining({ code: 'invalid_state' }))
    expect(() => harness.hooks.on('context', () => undefined, testHookRegistration('disposed-context')))
      .toThrow(expect.objectContaining({ code: 'invalid_state' }))
    expect(() => harness.addCleanup(() => undefined))
      .toThrow(expect.objectContaining({ code: 'invalid_state' }))
  })

  it('keeps seeded reentrant operation sequences inside the phase-lock model', async () => {
    const random = (seed: number) => {
      let state = seed >>> 0
      return () => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
        return state / 0x1_0000_0000
      }
    }

    for (const seed of [7, 41, 503, 9_973]) {
      const next = random(seed)
      const transport = new AbortableTransport()
      const harness = createHarness(transport)
      const run = harness.prompt(`seed-${seed}`)
      await transport.started

      for (let step = 0; step < 24; step += 1) {
        expect(harness.phase).toBe('turn')
        switch (Math.floor(next() * 7)) {
          case 0:
            await expect(harness.prompt('overlap')).rejects.toMatchObject({ code: 'busy' })
            break
          case 1:
            await expect(harness.compact()).rejects.toMatchObject({ code: 'busy' })
            break
          case 2:
            await expect(harness.runStructuralOperation('retry', async () => undefined))
              .rejects.toMatchObject({ code: 'busy' })
            break
          case 3:
            await expect(harness.host.updateRuntime({ systemPrompt: 'overlap' }))
              .rejects.toMatchObject({ code: 'busy' })
            break
          case 4:
            expect(await harness.steer(`steer-${step}`)).toBe(true)
            break
          case 5:
            expect(await harness.followUp(`follow-up-${step}`)).toBe(true)
            break
          default:
            expect(await harness.nextTurn(`next-turn-${step}`)).toBe(true)
            break
        }
      }

      expect(harness.requestAbort()).toBe(true)
      expect(harness.requestAbort()).toBe(false)
      expect((await run).reason).toBe('aborted')
      await harness.waitForIdle()
      expect(harness.phase).toBe('idle')
      await harness.dispose()
    }
  })

  it('broadcasts each Provider lifecycle once while chaining hooks in order', async () => {
    const harness = createHarness(new LifecycleTransport())
    const observed: string[] = []
    const hookTimeouts: Array<number | undefined> = []
    harness.subscribe((event) => {
      observed.push(event.type)
      if (event.type === 'before_provider_request') event.timeoutMs = 99_000
    })
    harness.hooks.on('before_provider_request', (event) => {
      hookTimeouts.push(event.timeoutMs)
      return { timeoutMs: 2_000 }
    }, testHookRegistration('provider-lifecycle-first'))
    harness.hooks.on('before_provider_request', (event) => {
      hookTimeouts.push(event.timeoutMs)
      return { timeoutMs: 3_000 }
    }, testHookRegistration('provider-lifecycle-second'))

    await harness.prompt('run')

    expect(hookTimeouts).toEqual([1_000, 2_000])
    expect(observed.filter((type) => type === 'before_provider_request')).toHaveLength(1)
    expect(observed.filter((type) => type === 'before_provider_payload')).toHaveLength(1)
    expect(observed.filter((type) => type === 'after_provider_response')).toHaveLength(1)
  })

  it('orders identified Hooks by priority and exposes the active dependency set', async () => {
    const harness = createHarness(new LifecycleTransport())
    const order: string[] = []
    harness.hooks.on('before_provider_request', () => {
      order.push('low')
      return undefined
    }, {
      id: 'test.low-hook',
      version: '1',
      source: 'test',
      priority: 1,
    })
    harness.hooks.on('before_provider_request', () => {
      order.push('high')
      return undefined
    }, {
      id: 'test.high-hook',
      version: '2',
      source: 'test',
      priority: 10,
    })
    harness.hooks.seal()

    await harness.prompt('run')

    expect(order).toEqual(['high', 'low'])
    expect(harness.hooks.dependencies()).toEqual([
      expect.objectContaining({
        id: 'test.high-hook',
        version: '2',
        fingerprint: expect.any(String),
      }),
      expect.objectContaining({
        id: 'test.low-hook',
        version: '1',
        fingerprint: expect.any(String),
      }),
    ])
    expect(harness.hooks.diagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'test.high-hook', status: 'completed' }),
      expect.objectContaining({ id: 'test.low-hook', status: 'completed' }),
    ]))
  })

  it('fails a timed-out Hook closed and records its identity', async () => {
    const harness = createHarness()
    harness.hooks.on('before_agent_start', () => new Promise<undefined>(() => undefined), {
      id: 'test.timeout-hook',
      version: '1',
      source: 'test',
      timeoutMs: 5,
    })

    await expect(harness.prompt('run')).rejects.toMatchObject({
      code: 'hook',
      message: expect.stringContaining('test.timeout-hook'),
    })
    expect(harness.hooks.diagnostics()).toContainEqual(expect.objectContaining({
      id: 'test.timeout-hook',
      status: 'timed_out',
    }))
  })

  it('keeps parent cancellation as the first-writer outcome ahead of Hook timeout', async () => {
    const harness = createHarness()
    let hookStarted!: () => void
    const started = new Promise<void>((resolve) => { hookStarted = resolve })
    harness.hooks.on('before_agent_start', () => {
      hookStarted()
      return new Promise<undefined>(() => undefined)
    }, {
      id: 'test.parent-before-timeout-hook',
      version: '1',
      source: 'test',
      timeoutMs: 50,
    })

    const run = harness.prompt('run')
    await started
    expect(harness.requestAbort()).toBe(true)

    await expect(run).resolves.toMatchObject({ reason: 'aborted' })
    expect(harness.hooks.diagnostics()).toContainEqual(expect.objectContaining({
      id: 'test.parent-before-timeout-hook',
      status: 'aborted',
    }))
    expect(harness.hooks.diagnostics()).not.toContainEqual(expect.objectContaining({
      id: 'test.parent-before-timeout-hook',
      status: 'timed_out',
    }))
  })

  it('fails closed when a Hook throws its own AbortError', async () => {
    const harness = createHarness()
    harness.hooks.on('before_agent_start', () => {
      throw new DOMException('hook failed', 'AbortError')
    }, testHookRegistration('self-abort-error-hook'))

    await expect(harness.prompt('run')).rejects.toMatchObject({ code: 'hook' })
    expect(harness.hooks.diagnostics()).toContainEqual(expect.objectContaining({
      id: 'test.self-abort-error-hook',
      status: 'failed',
      error: 'AbortError',
    }))
  })

  it('injects the invocation signal into both Hook arguments', async () => {
    const harness = createHarness()
    let eventSignal: AbortSignal | undefined
    let contextSignal: AbortSignal | undefined
    harness.hooks.on('before_agent_start', async (event, context) => {
      eventSignal = event.signal
      contextSignal = context.signal
      expect(event.signal).toBe(context.signal)
      await new Promise((resolve) => setTimeout(resolve, 30))
      return undefined
    }, {
      id: 'test.invocation-signal-hook',
      version: '1',
      source: 'test',
      timeoutMs: 5,
    })

    await expect(harness.prompt('run')).rejects.toMatchObject({ code: 'hook' })
    expect(eventSignal?.aborted).toBe(true)
    expect(contextSignal?.aborted).toBe(true)
  })

  it('requires one policy identity for every handler in a Hook bundle', () => {
    const harness = createHarness()
    harness.hooks.on('before_agent_start', () => undefined, {
      id: 'test.bundle-hook',
      version: '1',
      source: 'test',
      priority: 10,
      timeoutMs: 100,
    })

    expect(() => harness.hooks.on('context', () => undefined, {
      id: 'test.bundle-hook',
      version: '1',
      source: 'other',
      priority: 10,
      timeoutMs: 100,
    })).toThrow('bundle identity 冲突')
    expect(() => harness.hooks.on('context', () => undefined, {
      id: 'test.bundle-hook',
      version: '1',
      source: 'test',
      priority: 11,
      timeoutMs: 100,
    })).toThrow('bundle identity 冲突')
  })

  it('retains Hook diagnostics across Harness replacement', async () => {
    const diagnostics = new RuntimeHookDiagnostics(4)
    const first = new AgentHarness({
      sessionId: 'session-1',
      systemPrompt: 'safe',
      model: { provider: 'test', model: 'model-1' },
      transport: new StaticTransport(),
      tools: [],
      hookDiagnostics: diagnostics,
    })
    first.hooks.on('before_agent_start', () => undefined, testHookRegistration('first-harness'))
    await first.prompt('first')
    await first.dispose()

    const second = new AgentHarness({
      sessionId: 'session-2',
      systemPrompt: 'safe',
      model: { provider: 'test', model: 'model-1' },
      transport: new StaticTransport(),
      tools: [],
      hookDiagnostics: diagnostics,
    })
    second.hooks.on('before_agent_start', () => undefined, testHookRegistration('second-harness'))
    await second.prompt('second')

    const snapshot = diagnostics.snapshot()
    expect(snapshot).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'test.first-harness', status: 'completed' }),
      expect.objectContaining({ id: 'test.second-harness', status: 'completed' }),
    ]))
    expect(new Set(snapshot.map((diagnostic) => diagnostic.scopeId)).size).toBe(2)
  })

  it('isolates synchronous, asynchronous, and mutating diagnostic sinks from Hook execution', async () => {
    let records = 0
    const harness = new AgentHarness({
      sessionId: 'session-diagnostic-failure',
      systemPrompt: 'safe',
      model: { provider: 'test', model: 'model-1' },
      transport: new StaticTransport(),
      tools: [],
      hookDiagnostics: {
        record: (diagnostic) => {
          records += 1
          diagnostic.id = 'mutated-by-sink'
          if (records === 1) throw new Error('sink failed')
          return Promise.reject(new Error('async sink failed'))
        },
      },
    })
    harness.hooks.on('before_agent_start', () => undefined, testHookRegistration('sink-failure'))
    harness.hooks.on('before_agent_start', () => undefined, testHookRegistration('async-sink-failure'))

    await expect(harness.prompt('run')).resolves.toMatchObject({ reason: 'completed' })
    expect(harness.hooks.diagnostics()).toContainEqual(expect.objectContaining({
      id: 'test.sink-failure',
      status: 'completed',
    }))
    expect(harness.hooks.diagnostics()).toContainEqual(expect.objectContaining({
      id: 'test.async-sink-failure',
      status: 'completed',
    }))
    expect(harness.hooks.diagnostics()).not.toContainEqual(expect.objectContaining({
      id: 'mutated-by-sink',
    }))
  })

  it('drops idle work registered by a Hook that later times out', async () => {
    const harness = createHarness()
    let deferredRan = false
    harness.hooks.on('before_agent_start', async (_event, context) => {
      context.deferUntilIdle(() => { deferredRan = true })
      await new Promise((resolve) => setTimeout(resolve, 30))
      return undefined
    }, {
      id: 'test.timeout-deferred-hook',
      version: '1',
      source: 'test',
      timeoutMs: 5,
    })

    await expect(harness.prompt('run')).rejects.toMatchObject({ code: 'hook' })
    await harness.waitForIdle()

    expect(deferredRan).toBe(false)
  })

  it('transfers idle work only after a Hook completes successfully', async () => {
    const harness = createHarness()
    let deferredRan = false
    harness.hooks.on('before_agent_start', (_event, context) => {
      context.deferUntilIdle(() => { deferredRan = true })
      expect(deferredRan).toBe(false)
      return undefined
    }, testHookRegistration('successful-deferred-hook'))

    await harness.prompt('run')
    await harness.waitForIdle()

    expect(deferredRan).toBe(true)
  })

  it('commits deferred work per successful handler when a later Hook fails', async () => {
    const harness = createHarness()
    let deferredRan = false
    harness.hooks.on('before_agent_start', (_event, context) => {
      context.deferUntilIdle(() => { deferredRan = true })
      return undefined
    }, testHookRegistration('committed-deferred-hook'))
    harness.hooks.on('before_agent_start', () => {
      throw new Error('later hook failed')
    }, testHookRegistration('later-failed-hook'))

    await expect(harness.prompt('run')).rejects.toMatchObject({ code: 'hook' })
    await harness.waitForIdle()

    expect(harness.hooks.deferredCommitPolicy).toBe('handler-success')
    expect(deferredRan).toBe(true)
  })

  it('cancels pending deferred Hook work during dispose', async () => {
    const transport = new AbortableTransport()
    const harness = createHarness(transport)
    let deferredRan = false
    harness.hooks.on('before_agent_start', (_event, context) => {
      context.deferUntilIdle(() => { deferredRan = true })
      return undefined
    }, testHookRegistration('dispose-pending-deferred-hook'))

    const run = harness.prompt('run')
    await transport.started
    await harness.dispose()
    await run

    expect(deferredRan).toBe(false)
    expect(harness.hooks.diagnostics()).toContainEqual(expect.objectContaining({
      id: 'test.dispose-pending-deferred-hook',
      stage: 'deferred',
      status: 'aborted',
    }))
  })

  it('aborts running deferred Hook work without blocking dispose indefinitely', async () => {
    const harness = createHarness()
    let taskStarted!: () => void
    const started = new Promise<void>((resolve) => { taskStarted = resolve })
    let taskSignal: AbortSignal | undefined
    harness.hooks.on('before_agent_start', (_event, context) => {
      context.deferUntilIdle((signal) => {
        taskSignal = signal
        taskStarted()
        return new Promise<void>(() => undefined)
      })
      return undefined
    }, testHookRegistration('dispose-running-stuck-deferred-hook'))

    const run = harness.prompt('run')
    await started
    await expect(harness.dispose()).resolves.toBeUndefined()
    await run

    expect(taskSignal?.aborted).toBe(true)
    expect(harness.hooks.diagnostics()).toContainEqual(expect.objectContaining({
      id: 'test.dispose-running-stuck-deferred-hook',
      stage: 'deferred',
      status: 'aborted',
    }))
  })

  it('times out non-settling deferred Hook work', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness()
      let taskStarted!: () => void
      const started = new Promise<void>((resolve) => { taskStarted = resolve })
      harness.hooks.on('before_agent_start', (_event, context) => {
        context.deferUntilIdle(() => {
          taskStarted()
          return new Promise<void>(() => undefined)
        })
        return undefined
      }, testHookRegistration('timeout-stuck-deferred-hook'))

      const run = harness.prompt('run')
      await started
      await vi.advanceTimersByTimeAsync(10_000)
      await run

      expect(harness.hooks.diagnostics()).toContainEqual(expect.objectContaining({
        id: 'test.timeout-stuck-deferred-hook',
        stage: 'deferred',
        status: 'timed_out',
        error: 'AgentHarnessDeferredTaskTimeoutError',
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('observes a deferred Hook operation that completes after its bounded timeout', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness()
      let taskStarted!: () => void
      const started = new Promise<void>((resolve) => { taskStarted = resolve })
      let finishTask!: () => void
      const finish = new Promise<void>((resolve) => { finishTask = resolve })
      let handle: AgentHarnessDeferredTaskHandle | undefined
      harness.hooks.on('before_agent_start', (_event, context) => {
        handle = context.deferUntilIdle(async () => {
          taskStarted()
          await finish
        })
        return undefined
      }, testHookRegistration('late-completing-deferred-hook'))

      const run = harness.prompt('run')
      await started
      await vi.advanceTimersByTimeAsync(10_000)
      await run
      await expect(handle?.settlement).resolves.toMatchObject({ status: 'timed_out' })

      finishTask()
      await expect(handle?.completion).resolves.toMatchObject({ status: 'completed' })
      await vi.advanceTimersByTimeAsync(0)
      expect(harness.hooks.diagnostics()).toContainEqual(expect.objectContaining({
        id: 'test.late-completing-deferred-hook',
        stage: 'deferred_late',
        status: 'completed',
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('observes a deferred Hook operation that fails after its bounded timeout', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness()
      let taskStarted!: () => void
      const started = new Promise<void>((resolve) => { taskStarted = resolve })
      let failTask!: (error: Error) => void
      const failure = new Promise<void>((_resolve, reject) => { failTask = reject })
      let handle: AgentHarnessDeferredTaskHandle | undefined
      harness.hooks.on('before_agent_start', (_event, context) => {
        handle = context.deferUntilIdle(async () => {
          taskStarted()
          await failure
        })
        return undefined
      }, testHookRegistration('late-failing-deferred-hook'))

      const run = harness.prompt('run')
      await started
      await vi.advanceTimersByTimeAsync(10_000)
      await run
      await expect(handle?.settlement).resolves.toMatchObject({ status: 'timed_out' })

      failTask(new Error('late deferred failure'))
      await expect(handle?.completion).resolves.toMatchObject({
        status: 'failed',
        error: expect.objectContaining({ message: 'late deferred failure' }),
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(harness.hooks.diagnostics()).toContainEqual(expect.objectContaining({
        id: 'test.late-failing-deferred-hook',
        stage: 'deferred_late',
        status: 'failed',
        error: 'Error',
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for running deferred Hook work before cleanup', async () => {
    const harness = createHarness()
    const order: string[] = []
    let taskStarted!: () => void
    let finishTask!: () => void
    const started = new Promise<void>((resolve) => { taskStarted = resolve })
    const finish = new Promise<void>((resolve) => { finishTask = resolve })
    harness.hooks.on('before_agent_start', (_event, context) => {
      context.deferUntilIdle(async () => {
        order.push('task-started')
        taskStarted()
        await finish
        order.push('task-finished')
      })
      return undefined
    }, testHookRegistration('dispose-running-deferred-hook'))
    harness.addCleanup(() => { order.push('cleanup') })

    const run = harness.prompt('run')
    await started
    const disposing = harness.dispose()
    finishTask()
    await disposing
    await run

    expect(order).toEqual(['task-started', 'task-finished', 'cleanup'])
  })

  it('records deferred Hook work failures separately from invocation success', async () => {
    const harness = createHarness()
    let deferredFinished!: () => void
    const finished = new Promise<void>((resolve) => { deferredFinished = resolve })
    harness.hooks.on('before_agent_start', (_event, context) => {
      context.deferUntilIdle(() => {
        deferredFinished()
        throw new Error('deferred failed')
      })
      return undefined
    }, testHookRegistration('deferred-diagnostic-hook'))

    await harness.prompt('run')
    await finished
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(harness.hooks.diagnostics()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'test.deferred-diagnostic-hook',
        stage: 'invocation',
        status: 'completed',
      }),
      expect.objectContaining({
        id: 'test.deferred-diagnostic-hook',
        stage: 'deferred',
        status: 'failed',
      }),
    ]))
  })

  it('aborts an active Hook immediately when the parent run is cancelled', async () => {
    const harness = createHarness()
    let started!: () => void
    const hookStarted = new Promise<void>((resolve) => { started = resolve })
    let invocationSignal: AbortSignal | undefined
    harness.hooks.on('before_agent_start', async (_event, context) => {
      invocationSignal = context.signal
      started()
      await new Promise<undefined>(() => undefined)
      return undefined
    }, {
      id: 'test.parent-abort-hook',
      version: '1',
      source: 'test',
      timeoutMs: 10_000,
    })

    const run = harness.prompt('run')
    await hookStarted
    expect(harness.requestAbort()).toBe(true)

    await expect(run).resolves.toMatchObject({ reason: 'aborted' })
    expect(invocationSignal?.aborted).toBe(true)
    expect(harness.hooks.diagnostics()).toContainEqual(expect.objectContaining({
      id: 'test.parent-abort-hook',
      status: 'aborted',
    }))
  })

  it('rejects durable queue mutations from Runtime Hooks', async () => {
    const tool: AgentTool = {
      name: 'inspect',
      runtimeVersion: '1',
      label: 'Inspect',
      description: 'Inspect data',
      inputSchema: { type: 'object' },
      validate: (input) => ({ ok: true, value: input }),
      execute: async () => ({ content: 'executed' }),
    }
    const harness = createHarness(new ToolTransport(), [tool])
    harness.hooks.on('tool_call', async (_event, context) => {
      expect(context.can('next_turn')).toBe(false)
      await context.nextTurn('must not be queued')
      return undefined
    }, testHookRegistration('durable-effect-hook'))

    await expect(harness.prompt('inspect')).resolves.toMatchObject({ reason: 'completed' })
    expect(harness.pendingNextTurnCount).toBe(0)
    expect(harness.hooks.diagnostics()).toContainEqual(expect.objectContaining({
      id: 'test.durable-effect-hook',
      status: 'failed',
    }))
  })

  it('aborts a timed-out Hook invocation and rejects its late queue side effects', async () => {
    const tool: AgentTool = {
      name: 'inspect',
      runtimeVersion: '1',
      label: 'Inspect',
      description: 'Inspect data',
      inputSchema: { type: 'object' },
      validate: (input) => ({ ok: true, value: input }),
      execute: async () => ({ content: 'executed' }),
    }
    const harness = createHarness(new ToolTransport(), [tool])
    let invocationSignal: AbortSignal | undefined
    let resolveLateEffect!: (result: 'rejected' | 'queued') => void
    const lateEffect = new Promise<'rejected' | 'queued'>((resolve) => {
      resolveLateEffect = resolve
    })
    harness.hooks.on('tool_call', async (_event, context) => {
      invocationSignal = context.signal
      setTimeout(() => {
        void Promise.resolve()
          .then(() => context.nextTurn('must not be queued'))
          .then(() => resolveLateEffect('queued'))
          .catch(() => resolveLateEffect('rejected'))
      }, 15)
      await new Promise((resolve) => setTimeout(resolve, 30))
      return undefined
    }, {
      id: 'test.late-side-effect-hook',
      version: '1',
      source: 'test',
      timeoutMs: 5,
    })

    await expect(harness.prompt('inspect')).resolves.toMatchObject({ reason: 'completed' })

    expect(await lateEffect).toBe('rejected')
    expect(invocationSignal?.aborted).toBe(true)
    expect(harness.pendingNextTurnCount).toBe(0)
  })

  it('uses stable public error codes', async () => {
    const harness = createHarness()
    await expect(harness.prompt('')).rejects.toEqual(expect.objectContaining({
      name: 'AgentHarnessError',
      code: 'invalid_argument',
    }))
    await expect(harness.prompt('')).rejects.toBeInstanceOf(AgentHarnessError)
  })

  it('lets a hook block tools without bypassing product approval policy', async () => {
    const execute = vi.fn<AgentTool['execute']>(async () => ({ content: 'executed' }))
    const tool: AgentTool = {
      name: 'inspect',
      runtimeVersion: '1',
      label: 'Inspect',
      description: 'Inspect data',
      inputSchema: { type: 'object' },
      validate: (input) => ({ ok: true, value: input }),
      execute,
    }
    const harness = createHarness(new ToolTransport(), [tool])
    const hookEvents: string[] = []
    harness.hooks.on('tool_call', (event) => {
      hookEvents.push(event.toolName)
      return { block: true, reason: 'blocked by harness' }
    }, testHookRegistration('block-tool'))
    harness.hooks.on('tool_call', () => {
      hookEvents.push('must-not-run')
      return undefined
    }, testHookRegistration('must-not-run'))

    const result = await harness.prompt('inspect')

    expect(result.reason).toBe('completed')
    expect(execute).not.toHaveBeenCalled()
    expect(hookEvents).toEqual(['inspect'])
    expect(result.messages).toContainEqual(expect.objectContaining({
      role: 'tool',
      isError: true,
      content: expect.stringContaining('blocked by harness'),
    }))
  })

  it('dispatches Branch Summary through the Harness Registry', async () => {
    const harness = createHarness()
    const observed: string[] = []
    const phases: string[] = []
    harness.subscribe((event) => { observed.push(event.type) })
    harness.hooks.on('before_branch_summary', (_event, context) => {
      phases.push(context.phase)
      return {
        customInstructions: 'preserve decisions',
        replacement: { content: 'registry summary' },
      }
    }, testHookRegistration('branch-summary-before'))
    harness.hooks.on('after_branch_summary', (event, context) => {
      phases.push(context.phase)
      expect(event.result.content).toBe('registry summary')
      return undefined
    }, testHookRegistration('branch-summary-after'))

    const result = await harness.summarizeBranch({
      messages: [{
        id: 'branch-user',
        role: 'user',
        content: 'abandoned work',
        createdAt: 1,
      }],
      model: { provider: 'test', model: 'model-1' },
      transport: new StaticTransport(),
    })

    expect(result.content).toBe('registry summary')
    expect(phases).toEqual(['branch_summary', 'branch_summary'])
    expect(observed).toContain('before_branch_summary')
    expect(observed).toContain('after_branch_summary')
  })

  it('stops at the first cancel and preserves accumulated branch-summary instructions from prior hooks', async () => {
    // 多个 before_branch_summary hook 链式调用：prior hook advance 了 customInstructions，
    // 后续 hook 返回 cancel 触发 stop——dispatch 在 cancel 处中断，之后的 hook 不执行，
    // summarizeBranch 因 summaryHookCancelled 抛 aborted。
    const harness = createHarness()
    const later = vi.fn()
    // priority 100 → 最先执行，返回 advance-able 结果（不 cancel）
    harness.hooks.on(
      'before_branch_summary',
      () => ({ customInstructions: 'prior guidance' }),
      testHookRegistration('branch-summary-advance', { priority: 100 }),
    )
    // priority 50 → 第二执行，返回 cancel 触发 stop
    harness.hooks.on(
      'before_branch_summary',
      () => ({ cancel: true }),
      testHookRegistration('branch-summary-cancel', { priority: 50 }),
    )
    // priority 1 → 不应被执行（stop 已中断）
    harness.hooks.on('before_branch_summary', later, testHookRegistration('branch-summary-skipped'))

    const operation = harness.summarizeBranch({
      messages: [{
        id: 'branch-user-chain',
        role: 'user',
        content: 'chain cancel',
        createdAt: 1,
      }],
      model: { provider: 'test', model: 'model-1' },
      transport: new StaticTransport(),
    })

    await expect(operation).rejects.toMatchObject({ code: 'aborted' })
    await operation.catch((error: unknown) => {
      expect(isAgentHarnessAbortError(error)).toBe(true)
    })
    expect(later).not.toHaveBeenCalled()
    expect(harness.phase).toBe('idle')
  })

  it('merges prepare_next_turn fields in registration order', async () => {
    const harness = createHarness()
    const order: string[] = []
    harness.hooks.on('prepare_next_turn', () => {
      order.push('first')
      return { systemPrompt: 'next prompt', activeToolNames: [] }
    }, testHookRegistration('prepare-next-turn-first'))
    harness.hooks.on('prepare_next_turn', () => {
      order.push('second')
      return { reasoning: { level: 'high', mode: 'effort' } }
    }, testHookRegistration('prepare-next-turn-second'))

    await harness.prompt('run')

    expect(order).toEqual(['first', 'second'])
    expect(harness.runtimeContext.systemPrompt).toBe('next prompt')
    expect(harness.runtimeContext.activeToolNames).toEqual([])
    expect(harness.runtimeContext.reasoning).toEqual({ level: 'high', mode: 'effort' })
  })

  it('rejects arbitrary Transport objects returned by public prepare_next_turn hooks', async () => {
    const harness = createHarness()
    const untrustedTransport = new StaticTransport()
    harness.hooks.on(
      'prepare_next_turn',
      () => ({ transport: untrustedTransport }),
      testHookRegistration('untrusted-transport'),
    )

    const result = await harness.prompt('run')
    expect(result.reason).toBe('error')
    expect(result.errorMessage).toBe('prepare_next_turn 只能切换宿主拥有的 Transport')
    expect(result.transport).not.toBe(untrustedTransport)
    expect(harness.hooks.diagnostics()).toContainEqual(expect.objectContaining({
      id: 'test.untrusted-transport',
      hookType: 'prepare_next_turn',
      status: 'failed',
      error: 'Error',
    }))
    expect(harness.hooks.diagnostics()).not.toContainEqual(expect.objectContaining({
      id: 'test.untrusted-transport',
      status: 'completed',
    }))
  })

  it('rejects arbitrary Transport objects nested in public prepare_next_turn updates', async () => {
    const harness = createHarness()
    const untrustedTransport = new StaticTransport()
    harness.hooks.on('prepare_next_turn', () => ({
      runtimeUpdates: [{ transport: untrustedTransport }],
    }), testHookRegistration('nested-untrusted-transport'))

    const result = await harness.prompt('run')
    expect(result.reason).toBe('error')
    expect(result.errorMessage).toBe('prepare_next_turn 只能切换宿主拥有的 Transport')
    expect(result.transport).not.toBe(untrustedTransport)
  })

  it('rejects runtime mutation scheduling from prepare_next_turn Hooks', async () => {
    const harness = createHarness()
    const untrustedTransport = new StaticTransport()
    harness.hooks.on('prepare_next_turn', async (_event, context) => {
      await context.scheduleRuntimeUpdate({ transport: untrustedTransport })
      return undefined
    }, testHookRegistration('runtime-mutation'))

    const result = await harness.prompt('run')
    expect(result.reason).toBe('error')
    expect(result.errorMessage).toBe('回调 prepare_next_turn 在 turn 阶段不能执行 schedule_runtime_update')
    expect(result.transport).not.toBe(untrustedTransport)
  })

  it('allows the host controller to install a Transport', async () => {
    const harness = createHarness()
    const nextTransport = new RecordingTransport()

    await harness.host.setModel(
      { provider: 'test', model: 'model-2' },
      nextTransport,
    )
    const result = await harness.prompt('run')

    expect(result.reason).toBe('completed')
    expect(result.transport).toBe(nextTransport)
    expect(nextTransport.requests).toHaveLength(1)
    expect(nextTransport.requests[0]?.model.model).toBe('model-2')
  })

  it('allows host-owned prepareNextTurn Transport updates', async () => {
    const nextTransport = new StaticTransport()
    let updated = false
    const harness = new AgentHarness({
      sessionId: 'host-transport',
      systemPrompt: 'safe',
      model: { provider: 'test', model: 'model-1' },
      transport: new StaticTransport(),
      prepareNextTurn: () => {
        if (updated) return undefined
        updated = true
        return { transport: nextTransport }
      },
    })

    await expect(harness.prompt('run')).resolves.toMatchObject({ reason: 'completed' })
  })
})
