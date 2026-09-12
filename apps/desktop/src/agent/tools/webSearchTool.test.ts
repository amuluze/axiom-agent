import { describe, expect, it } from 'vitest'
import type { AgentToolExecutionContext } from '@/agent/core/types'
import { createFakeAgentEnvironment } from './__fixtures__/fakeAgentEnvironment'
import { createWebSearchTool, WEB_SEARCH_MAX_QUERY_CHARS } from './webSearchTool'

const baseContext = (overrides: Partial<AgentToolExecutionContext> = {}): AgentToolExecutionContext => ({
  sessionId: 'session-1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  signal: new AbortController().signal,
  reportProgress: async () => undefined,
  ...overrides,
})

describe('webSearchTool validate', () => {
  it('accepts a valid query with optional limit', () => {
    const tool = createWebSearchTool(createFakeAgentEnvironment())
    expect(tool.validate({ query: 'rust async tokio' }).ok).toBe(true)
    expect(tool.validate({ query: 'rust async tokio', limit: 5 }).ok).toBe(true)
  })

  it('rejects unknown keys, empty and oversized queries, bad limits', () => {
    const tool = createWebSearchTool(createFakeAgentEnvironment())
    expect(tool.validate({ query: 'x', extra: 1 }).ok).toBe(false)
    expect(tool.validate({ query: '   ' }).ok).toBe(false)
    expect(tool.validate({ query: 'x'.repeat(WEB_SEARCH_MAX_QUERY_CHARS + 1) }).ok).toBe(false)
    expect(tool.validate({ query: 'x', limit: 0 }).ok).toBe(false)
    expect(tool.validate({ query: 'x', limit: 21 }).ok).toBe(false)
  })

  it('builds a stable idempotency key from the query', () => {
    const tool = createWebSearchTool(createFakeAgentEnvironment())
    expect(tool.idempotencyKey?.({ query: 'same' })).toBe('web_search:same')
    expect(tool.idempotencyKey?.({ limit: 3 })).toBe('web_search:invalid')
  })
})

describe('webSearchTool execute', () => {
  it('formats structured results for the model', async () => {
    const environment = createFakeAgentEnvironment({
      webSearch: async () => ({
        query: 'rust tokio',
        results: [
          { title: 'Tokio docs', url: 'https://tokio.rs/docs', snippet: 'Async runtime' },
          { title: 'GitHub', url: 'https://github.com/tokio-rs/tokio', snippet: 'Repo' },
        ],
      }),
    })
    const tool = createWebSearchTool(environment)
    const result = await tool.execute({ query: 'rust tokio', limit: 5 }, baseContext())
    expect(result.content).toContain('1. Tokio docs')
    expect(result.content).toContain('https://tokio.rs/docs')
    expect(result.content).toContain('Async runtime')
    expect(environment.web.search).toHaveBeenCalledWith({ query: 'rust tokio', limit: 5 })
    expect(result.details).toMatchObject({
      query: 'rust tokio',
      results: [
        { title: 'Tokio docs', url: 'https://tokio.rs/docs', snippet: 'Async runtime' },
        { title: 'GitHub', url: 'https://github.com/tokio-rs/tokio', snippet: 'Repo' },
      ],
    })
  })

  it('trims the query and omits limit when absent', async () => {
    const environment = createFakeAgentEnvironment({
      webSearch: async (request) => ({ query: request.query, results: [] }),
    })
    const tool = createWebSearchTool(environment)
    const result = await tool.execute({ query: '  padded  ' }, baseContext())
    expect(environment.web.search).toHaveBeenCalledWith({ query: 'padded', limit: undefined })
    expect(result.content).toContain('No results found')
  })
})
