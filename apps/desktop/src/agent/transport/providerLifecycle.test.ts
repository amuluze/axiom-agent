import type { JsonValue, ModelRequest } from '@/agent/core/types'
import { describe, expect, it } from 'vitest'
import { prepareProviderRequest } from './providerLifecycle'

const request: ModelRequest = {
  sessionId: 'session-1',
  runId: 'run-1',
  systemPrompt: 'safe',
  model: { provider: 'openai-compatible', model: 'model-a' },
  messages: [{ id: 'user-1', role: 'user', content: 'hello', createdAt: 1 }],
  tools: [],
}

const baseOptions = {
  request,
  apiFormat: 'openai-compatible' as const,
  endpoint: 'https://api.example.com/v1/chat/completions',
  timeoutMs: 60_000,
  payload: { model: 'model-a', stream: true, messages: [] } satisfies JsonValue,
  signal: new AbortController().signal,
}

describe('provider lifecycle policy', () => {
  it('ignores in-place mutation and applies only explicit bounded replacements', async () => {
    const prepared = await prepareProviderRequest({
      ...baseOptions,
      lifecycle: {
        beforeRequest: () => ({ timeoutMs: 500_000 }),
        beforePayload: (context) => {
          ;(context.payload as Record<string, JsonValue>).ignored = true
          return {
            payload: {
              ...(context.payload as Record<string, JsonValue>),
              ignored: false,
              metadata: { source: 'hook' },
            },
          }
        },
      },
    })

    expect(prepared.timeoutMs).toBe(300_000)
    expect(JSON.parse(prepared.body)).toMatchObject({
      model: 'model-a',
      stream: true,
      ignored: false,
      metadata: { source: 'hook' },
    })
  })

  it.each([
    { label: 'model', payload: { model: 'other', stream: true } },
    { label: 'stream', payload: { model: 'model-a', stream: false } },
    { label: 'shape', payload: [] },
  ])('rejects payload replacements that change protocol $label identity', async ({ payload }) => {
    await expect(prepareProviderRequest({
      ...baseOptions,
      lifecycle: { beforePayload: () => ({ payload: payload as JsonValue }) },
    })).rejects.toThrow()
  })

  it('rejects payloads above the Rust request boundary before IPC', async () => {
    await expect(prepareProviderRequest({
      ...baseOptions,
      lifecycle: {
        beforePayload: () => ({
          payload: { model: 'model-a', stream: true, data: 'x'.repeat(2 * 1024 * 1024) },
        }),
      },
    })).rejects.toThrow('2 MiB')
  })
})
