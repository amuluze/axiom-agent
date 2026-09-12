import { describe, expect, it, vi } from 'vitest'
import type { AgentToolExecutionContext } from '@/agent/core/types'
import { createFakeAgentEnvironment } from './__fixtures__/fakeAgentEnvironment'
import { createWriteTool } from './writeTool'

const baseContext = (overrides: Partial<AgentToolExecutionContext> = {}): AgentToolExecutionContext => ({
  sessionId: 'session-1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  signal: new AbortController().signal,
  reportProgress: async () => undefined,
  ...overrides,
})

describe('writeTool validate', () => {
  it('accepts a valid path and content', () => {
    const tool = createWriteTool(createFakeAgentEnvironment())
    expect(tool.validate({ path: 'src/new.ts', content: 'export const x = 1' }))
      .toEqual({ ok: true, value: { path: 'src/new.ts', content: 'export const x = 1' } })
  })

  it('rejects unknown keys and malformed inputs', () => {
    const tool = createWriteTool(createFakeAgentEnvironment())
    expect(tool.validate({ path: 'a.ts', content: 'x', mode: 'w' }).ok).toBe(false)
    expect(tool.validate({ path: 'a.ts' }).ok).toBe(false)
    expect(tool.validate({ path: 1, content: 'x' }).ok).toBe(false)
  })

  it('rejects unsafe workspace paths', () => {
    const tool = createWriteTool(createFakeAgentEnvironment())
    for (const path of ['', '../escape.ts', 'a\\b.ts', '.git/config', '.axiom/secret']) {
      expect(tool.validate({ path, content: 'x' }).ok, `path=${path}`).toBe(false)
    }
  })

  it('rejects content exceeding 1 MiB', () => {
    const tool = createWriteTool(createFakeAgentEnvironment())
    const oversized = 'x'.repeat(1024 * 1024 + 1)
    expect(tool.validate({ path: 'big.ts', content: oversized }).ok).toBe(false)
  })
})

describe('writeTool execute', () => {
  it('requires an approval lease', async () => {
    const tool = createWriteTool(createFakeAgentEnvironment())
    await expect(tool.execute({ path: 'a.ts', content: 'x' }, baseContext()))
      .rejects.toThrow('Missing workspace approval lease')
  })

  it('rejects an aborted signal before creating the file', async () => {
    const controller = new AbortController()
    controller.abort()
    const tool = createWriteTool(createFakeAgentEnvironment())
    await expect(tool.execute({ path: 'a.ts', content: 'x' }, baseContext({
      approvalLease: 'lease-1',
      signal: controller.signal,
    }))).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('creates the file and threads the result back to the model', async () => {
    const environment = createFakeAgentEnvironment()
    vi.mocked(environment.workspace.createTextFile).mockResolvedValueOnce({
      workspace: { path: '/workspace/repo', name: 'repo', gitBranch: 'main' },
      path: 'src/new.ts',
      sizeBytes: 5,
      sha256: 'f'.repeat(64),
    })

    const result = await createWriteTool(environment).execute(
      { path: 'src/new.ts', content: 'hello' },
      baseContext({ approvalLease: 'lease-1' }),
    )

    expect(environment.workspace.createTextFile).toHaveBeenCalledWith('src/new.ts', 'hello', 'lease-1')
    expect(result.content).toContain('Created src/new.ts (5 bytes)')
    expect(result.content).toContain(`sha256: ${'f'.repeat(64)}`)
    expect(result.details).toMatchObject({ path: 'src/new.ts', sizeBytes: 5, operation: 'created' })
  })

  it('attaches diff stats and preview to details for the session UI', async () => {
    const environment = createFakeAgentEnvironment()
    vi.mocked(environment.workspace.createTextFile).mockResolvedValueOnce({
      workspace: { path: '/workspace/repo', name: 'repo' },
      path: 'src/new.ts',
      sizeBytes: 12,
      sha256: 'e'.repeat(64),
    })
    const result = await createWriteTool(environment).execute(
      { path: 'src/new.ts', content: 'hello\nworld' },
      baseContext({ approvalLease: 'lease-1' }),
    )
    const details = result.details as { diffAdded: number; diffRemoved: number; diffPreview: string }
    expect(details.diffAdded).toBe(2)
    expect(details.diffRemoved).toBe(0)
    expect(details.diffPreview).toContain('--- /dev/null')
    expect(details.diffPreview).toContain('+ world')
  })

  it('marks a write as completedAfterAbort when the signal aborts after the file is created', async () => {
    const environment = createFakeAgentEnvironment()
    let resolveCreate!: (value: {
      workspace: { path: string; name: string }
      path: string
      sizeBytes: number
      sha256: string
    }) => void
    vi.mocked(environment.workspace.createTextFile).mockImplementationOnce(() =>
      new Promise((resolve) => { resolveCreate = resolve }))
    const controller = new AbortController()
    const tool = createWriteTool(environment)

    const pending = tool.execute({ path: 'a.ts', content: 'x' }, baseContext({
      approvalLease: 'lease-1',
      signal: controller.signal,
    }))
    controller.abort()
    resolveCreate({
      workspace: { path: '/workspace/repo', name: 'repo' },
      path: 'a.ts',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
    })

    // 写入已成功落盘：不再把已生效的写入判为失败，只标注 completedAfterAbort。
    const result = await pending
    expect(result.details).toMatchObject({ completedAfterAbort: true, operation: 'created' })
    expect(result.content).toContain('Abort signal arrived after the file was created')
  })
})

describe('writeTool presentation, audit and idempotency', () => {
  it('builds a diff-style preview truncated to 16k chars', () => {
    const tool = createWriteTool(createFakeAgentEnvironment())
    const longContent = 'line\n'.repeat(10_000)
    const presentation = tool.approvalPresentation?.({ path: 'src/new.ts', content: longContent })
    expect(presentation?.category).toBe('workspace-write')
    expect(presentation?.preview).toContain('+++ src/new.ts')
    expect(presentation?.preview).toContain('[preview truncated]')
  })

  it('audits the path and content byte length', () => {
    const tool = createWriteTool(createFakeAgentEnvironment())
    expect(tool.auditArguments?.({ path: 'a.ts', content: 'hi' })).toEqual({ path: 'a.ts', contentBytes: 2 })
  })

  it('derives a stable idempotency key from path and content hash', async () => {
    const tool = createWriteTool(createFakeAgentEnvironment())
    const keyA = await tool.idempotencyKey?.({ path: 'a.ts', content: 'abc' })
    const keyB = await tool.idempotencyKey?.({ path: 'a.ts', content: 'abc' })
    const keyC = await tool.idempotencyKey?.({ path: 'a.ts', content: 'abcd' })
    expect(keyA).toBe(keyB)
    expect(keyA).not.toBe(keyC)
    expect(keyA).toMatch(/^write:a\.ts:[0-9a-f]{64}$/u)
  })
})
