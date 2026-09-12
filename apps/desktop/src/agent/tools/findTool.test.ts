import { describe, expect, it } from 'vitest'
import type { AgentToolExecutionContext } from '@/agent/core/types'
import { createFakeAgentEnvironment } from './__fixtures__/fakeAgentEnvironment'
import { createFindTool } from './findTool'

const baseContext = (overrides: Partial<AgentToolExecutionContext> = {}): AgentToolExecutionContext => ({
  sessionId: 'session-1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  signal: new AbortController().signal,
  reportProgress: async () => undefined,
  ...overrides,
})

describe('findTool validate', () => {
  it('accepts a valid pattern with optional path and limit', () => {
    const tool = createFindTool(createFakeAgentEnvironment())
    expect(tool.validate({ pattern: '**/*.ts' }).ok).toBe(true)
    expect(tool.validate({ pattern: 'src/**', path: 'src', limit: 10 }).ok).toBe(true)
  })

  it('rejects unknown keys and malformed patterns', () => {
    const tool = createFindTool(createFakeAgentEnvironment())
    expect(tool.validate({ pattern: '*.ts', extra: true }).ok).toBe(false)
    expect(tool.validate({ pattern: '' }).ok).toBe(false)
    expect(tool.validate({ pattern: '   ' }).ok).toBe(false)
    expect(tool.validate({ pattern: 'x'.repeat(513) }).ok).toBe(false)
  })

  it('rejects unsafe paths and out-of-range limits', () => {
    const tool = createFindTool(createFakeAgentEnvironment())
    expect(tool.validate({ pattern: '*.ts', path: '../escape' }).ok).toBe(false)
    expect(tool.validate({ pattern: '*.ts', limit: 0 }).ok).toBe(false)
    expect(tool.validate({ pattern: '*.ts', limit: 1.5 }).ok).toBe(false)
  })
})

describe('findTool execute', () => {
  it('threads matches and appends a cap footer when truncated', async () => {
    const environment = createFakeAgentEnvironment({
      find: async () => ({
        workspace: { path: '/workspace/repo', name: 'repo' },
        pattern: '**/*.ts',
        rootPath: '.',
        matches: [
          { path: 'src/a.ts', name: 'a.ts', kind: 'file', sizeBytes: 10 },
          { path: 'src/lib', name: 'lib', kind: 'directory', sizeBytes: 0 },
        ],
        truncated: true,
      }),
    })

    const result = await createFindTool(environment).execute({ pattern: '**/*.ts' }, baseContext())

    expect(result.content).toContain('src/a.ts')
    expect(result.content).toContain('src/lib/')
    expect(result.content).toContain('[Result cap (')
    expect(result.details).toMatchObject({ pattern: '**/*.ts', truncated: true })
  })

  it('reports no matches when the workspace walk returns none', async () => {
    const result = await createFindTool(createFakeAgentEnvironment()).execute(
      { pattern: '*.rs' },
      baseContext(),
    )
    expect(result.content).toBe('No matches found.')
  })

  it('rejects an aborted signal before searching', async () => {
    const controller = new AbortController()
    controller.abort()
    const tool = createFindTool(createFakeAgentEnvironment())
    await expect(tool.execute({ pattern: '*.ts' }, baseContext({ signal: controller.signal })))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('findTool idempotency', () => {
  it('derives a stable key from path and pattern, defaulting to the workspace root', () => {
    const tool = createFindTool(createFakeAgentEnvironment())
    expect(tool.idempotencyKey?.({ pattern: '*.ts', path: 'src' })).toBe('find:src:*.ts')
    expect(tool.idempotencyKey?.({ pattern: '*.ts' })).toBe('find:.:*.ts')
    expect(tool.idempotencyKey?.(null)).toBe('find:invalid')
  })
})
