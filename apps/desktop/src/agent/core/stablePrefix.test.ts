import { describe, expect, it } from 'vitest'
import type { AgentContext, AgentTool, JsonValue, ModelTransport } from './types'
import { ModelRequestStablePrefixCache, stablePrefixInputsEqual } from './stablePrefix'

const transport = {} as ModelTransport

const tool = (runtimeVersion = '1'): AgentTool => ({
  name: 'read',
  label: 'Read',
  description: 'Read a file',
  runtimeVersion,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
  },
  validate: (input: JsonValue) => ({ ok: true, value: input }),
  execute: async () => ({ content: 'ok' }),
})

const context = (overrides: Partial<AgentContext> = {}): AgentContext => ({
  sessionId: 'session',
  systemPrompt: 'stable prompt',
  model: { provider: 'provider', model: 'model' },
  messages: [],
  tools: [tool()],
  activeToolNames: ['read'],
  ...overrides,
})

describe('ModelRequestStablePrefixCache', () => {
  it('reuses one frozen tool schema and fingerprint across dynamic suffix changes', async () => {
    const cache = new ModelRequestStablePrefixCache()
    const first = await cache.resolve(context(), transport, 'stable prompt', 'stable prompt')
    const second = await cache.resolve(
      context(),
      transport,
      'stable prompt',
      'stable prompt\n\n# 临时预算提醒',
    )

    expect(second.tools).toBe(first.tools)
    expect(second.diagnostics.fingerprint).toBe(first.diagnostics.fingerprint)
    expect(second.diagnostics.revision).toBe(first.diagnostics.revision)
    expect(first.diagnostics.dynamicSuffixBytes).toBe(0)
    expect(second.diagnostics.dynamicSuffixBytes).toBeGreaterThan(0)
    expect(Object.isFrozen(second.tools)).toBe(true)
    expect(Object.isFrozen(second.tools[0])).toBe(true)
    expect(Object.isFrozen(second.tools[0]?.inputSchema)).toBe(true)
  })

  it('keeps the fingerprint stable when only the project-context tail changes', async () => {
    const cache = new ModelRequestStablePrefixCache()
    const firstPrompt = 'stable prompt\n\n# 项目上下文\nproject a'
    const secondPrompt = 'stable prompt\n\n# 项目上下文\nproject b changed'
    const first = await cache.resolve(
      context({ systemPrompt: firstPrompt }),
      transport,
      firstPrompt,
      firstPrompt,
    )
    const second = await cache.resolve(
      context({ systemPrompt: secondPrompt }),
      transport,
      secondPrompt,
      secondPrompt,
    )

    expect(second.tools).toBe(first.tools)
    expect(second.diagnostics.fingerprint).toBe(first.diagnostics.fingerprint)
    expect(second.diagnostics.revision).toBe(first.diagnostics.revision)
    expect(second.diagnostics.dynamicSuffixBytes)
      .toBeGreaterThan(first.diagnostics.dynamicSuffixBytes)
  })

  it('rebuilds after explicit invalidation and prefix-affecting changes', async () => {
    const cache = new ModelRequestStablePrefixCache()
    const first = await cache.resolve(context(), transport, 'stable prompt', 'stable prompt')

    cache.invalidate()
    const invalidated = await cache.resolve(context(), transport, 'stable prompt', 'stable prompt')
    const modelChanged = await cache.resolve(
      context({ model: { provider: 'provider', model: 'next-model' } }),
      transport,
      'stable prompt',
      'stable prompt',
    )
    const toolChanged = await cache.resolve(
      context({ tools: [tool('2')] }),
      transport,
      'stable prompt',
      'stable prompt',
    )

    expect(invalidated.tools).not.toBe(first.tools)
    expect(invalidated.diagnostics.fingerprint).toBe(first.diagnostics.fingerprint)
    expect(invalidated.diagnostics.revision).toBeGreaterThan(first.diagnostics.revision)
    expect(modelChanged.diagnostics.fingerprint).not.toBe(invalidated.diagnostics.fingerprint)
    expect(toolChanged.diagnostics.fingerprint).not.toBe(modelChanged.diagnostics.fingerprint)
  })

  it('compares only the request prefix inputs and transport identity', () => {
    const left = context()
    expect(stablePrefixInputsEqual(left, context({ messages: [{
      id: 'user', role: 'user', content: 'dynamic', createdAt: 1,
    }] }), transport, transport)).toBe(true)
    expect(stablePrefixInputsEqual(
      left,
      context({ activeToolNames: [] }),
      transport,
      transport,
    )).toBe(false)
    expect(stablePrefixInputsEqual(
      context({ systemPrompt: 'stable\n\n# 项目上下文\none' }),
      context({ systemPrompt: 'stable\n\n# 项目上下文\ntwo' }),
      transport,
      transport,
    )).toBe(true)
    expect(stablePrefixInputsEqual(left, context(), transport, {} as ModelTransport)).toBe(false)
  })
})
