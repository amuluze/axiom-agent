import { describe, expect, it } from 'vitest'
import type { AgentToolExecutionContext } from '@/agent/core/types'
import { createFakeAgentEnvironment } from './__fixtures__/fakeAgentEnvironment'
import {
  createWebFetchTool,
  WEB_FETCH_MAX_BYTES,
  WEB_FETCH_MAX_URL_CHARS,
} from './webFetchTool'

const baseContext = (overrides: Partial<AgentToolExecutionContext> = {}): AgentToolExecutionContext => ({
  sessionId: 'session-1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  signal: new AbortController().signal,
  reportProgress: async () => undefined,
  ...overrides,
})

describe('webFetchTool validate', () => {
  it('accepts absolute http(s) URLs with optional maxBytes', () => {
    const tool = createWebFetchTool(createFakeAgentEnvironment())
    expect(tool.validate({ url: 'https://example.com/docs' }).ok).toBe(true)
    expect(tool.validate({ url: 'http://example.com:8080/a', maxBytes: 4096 }).ok).toBe(true)
  })

  it('rejects non-http schemes, oversized URLs, unknown keys, bad maxBytes', () => {
    const tool = createWebFetchTool(createFakeAgentEnvironment())
    expect(tool.validate({ url: 'ftp://example.com/file' }).ok).toBe(false)
    expect(tool.validate({ url: 'file:///etc/passwd' }).ok).toBe(false)
    expect(tool.validate({ url: 'example.com/relative' }).ok).toBe(false)
    expect(tool.validate({ url: `https://example.com/${'a'.repeat(WEB_FETCH_MAX_URL_CHARS)}` }).ok).toBe(false)
    expect(tool.validate({ url: 'https://example.com', extra: true }).ok).toBe(false)
    expect(tool.validate({ url: 'https://example.com', maxBytes: 512 }).ok).toBe(false)
    expect(tool.validate({ url: 'https://example.com', maxBytes: WEB_FETCH_MAX_BYTES + 1 }).ok).toBe(false)
  })

  it('builds a stable idempotency key from the url', () => {
    const tool = createWebFetchTool(createFakeAgentEnvironment())
    expect(tool.idempotencyKey?.({ url: 'https://example.com' })).toBe('web_fetch:https://example.com')
    expect(tool.idempotencyKey?.({ maxBytes: 1 })).toBe('web_fetch:invalid')
  })
})

describe('webFetchTool execute', () => {
  it('threads content and response metadata without a truncation footer', async () => {
    const environment = createFakeAgentEnvironment({
      webFetch: async () => ({
        url: 'https://example.com/final',
        status: 200,
        contentType: 'text/html; charset=utf-8',
        content: 'Page body',
        truncated: false,
        fetchedBytes: 2048,
      }),
    })
    const tool = createWebFetchTool(environment)
    const result = await tool.execute({ url: 'https://example.com' }, baseContext())
    expect(result.content).toBe('Page body')
    expect(result.content).not.toContain('Truncated')
    expect(result.details).toMatchObject({
      url: 'https://example.com/final',
      status: 200,
      contentType: 'text/html; charset=utf-8',
      truncated: false,
      fetchedBytes: 2048,
      contentBytes: 'Page body'.length,
    })
  })

  it('appends a retry hint when the response is truncated', async () => {
    const environment = createFakeAgentEnvironment({
      webFetch: async () => ({
        url: 'https://example.com/big',
        status: 200,
        contentType: 'text/plain',
        content: 'x'.repeat(100),
        truncated: true,
        fetchedBytes: 262144,
      }),
    })
    const tool = createWebFetchTool(environment)
    const result = await tool.execute(
      { url: 'https://example.com/big', maxBytes: 262144 },
      baseContext(),
    )
    expect(environment.web.fetch).toHaveBeenCalledWith({
      url: 'https://example.com/big',
      maxBytes: 262144,
    })
    expect(result.content).toContain('Truncated')
    expect(result.content).toContain(`${WEB_FETCH_MAX_BYTES}`)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const environment = createFakeAgentEnvironment()
    const tool = createWebFetchTool(environment)
    const controller = new AbortController()
    controller.abort()
    await expect(
      tool.execute({ url: 'https://example.com' }, baseContext({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(environment.web.fetch).not.toHaveBeenCalled()
  })
})
