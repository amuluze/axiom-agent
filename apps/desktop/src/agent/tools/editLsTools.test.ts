import { describe, expect, it, vi } from 'vitest'
import type { AgentToolExecutionContext } from '@/agent/core/types'
import { createFakeAgentEnvironment } from './__fixtures__/fakeAgentEnvironment'
import { createEditTool } from './editTool'
import { createLsTool } from './lsTool'

const baseContext = (overrides: Partial<AgentToolExecutionContext> = {}): AgentToolExecutionContext => ({
  sessionId: 'session-1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  signal: new AbortController().signal,
  reportProgress: async () => undefined,
  ...overrides,
})

describe('editTool validate', () => {
  const tool = createEditTool(createFakeAgentEnvironment())

  it('accepts one or more precise replacements', () => {
    expect(tool.validate({ path: 'src/a.ts', edits: [{ oldText: 'x', newText: 'y' }] }).ok).toBe(true)
    expect(tool.validate({
      path: 'src/a.ts',
      edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }],
    }).ok).toBe(true)
  })

  it('rejects unsafe paths and empty or oversized edits', () => {
    expect(tool.validate({ path: '../a.ts', edits: [{ oldText: 'x', newText: 'y' }] }).ok).toBe(false)
    expect(tool.validate({ path: 'a.ts', edits: [] }).ok).toBe(false)
    expect(tool.validate({ path: 'a.ts', edits: [{ oldText: 'x', newText: 'y', extra: true }] }).ok).toBe(false)
    expect(tool.validate({ path: 'a.ts', edits: [{ oldText: '', newText: 'y' }] }).ok).toBe(false)
    expect(tool.validate({ path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }], extra: true }).ok).toBe(false)
  })

  it('rejects more than 64 replacements or 1 MiB sides', () => {
    const many = Array.from({ length: 65 }, (_, index) => ({ oldText: `${index}`, newText: 'x' }))
    expect(tool.validate({ path: 'a.ts', edits: many }).ok).toBe(false)
    const huge = 'x'.repeat(1024 * 1024 + 1)
    expect(tool.validate({ path: 'a.ts', edits: [{ oldText: huge, newText: 'y' }] }).ok).toBe(false)
  })
})

describe('editTool prepareArguments', () => {
  it('upgrades a legacy single oldText/newText pair into an edits array', async () => {
    const environment = createFakeAgentEnvironment()
    vi.mocked(environment.workspace.editTextFile).mockResolvedValueOnce({
      workspace: { path: '/w', name: 'w' },
      path: 'a.ts',
      sizeBytes: 3,
      sha256: 'a'.repeat(64),
    })
    const tool = createEditTool(environment)
    const prepared = tool.prepareArguments?.({ path: 'a.ts', oldText: 'x', newText: 'y' })
    const result = await tool.execute(
      prepared as never,
      baseContext({ approvalLease: 'lease-1' }),
    )
    expect(environment.workspace.editTextFile).toHaveBeenCalledWith(
      'a.ts', [{ oldText: 'x', newText: 'y' }], 'lease-1',
    )
    expect(result.content).toContain('Edited a.ts')
  })

  it('parses edits when a model emits them as a JSON string', async () => {
    const environment = createFakeAgentEnvironment()
    vi.mocked(environment.workspace.editTextFile).mockResolvedValueOnce({
      workspace: { path: '/w', name: 'w' },
      path: 'a.ts',
      sizeBytes: 3,
      sha256: 'b'.repeat(64),
    })
    const tool = createEditTool(environment)
    const prepared = tool.prepareArguments?.({ path: 'a.ts', edits: '[{"oldText":"x","newText":"y"}]' })
    await tool.execute(
      prepared as never,
      baseContext({ approvalLease: 'lease-1' }),
    )
    expect(environment.workspace.editTextFile).toHaveBeenCalledWith(
      'a.ts', [{ oldText: 'x', newText: 'y' }], 'lease-1',
    )
  })

  it('leaves an unparsable edits string for validate to reject', () => {
    const tool = createEditTool(createFakeAgentEnvironment())
    expect(tool.prepareArguments?.({ path: 'a.ts', edits: 'not-json' })).toEqual({ path: 'a.ts', edits: 'not-json' })
  })
})

describe('editTool execute', () => {
  it('requires an approval lease and rejects an aborted signal', async () => {
    const tool = createEditTool(createFakeAgentEnvironment())
    await expect(tool.execute({ path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] }, baseContext()))
      .rejects.toThrow('Missing workspace approval lease')
    const aborted = new AbortController()
    aborted.abort()
    await expect(tool.execute(
      { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] },
      baseContext({ approvalLease: 'l', signal: aborted.signal }),
    )).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('threads edit count and sha256 back to the model', async () => {
    const environment = createFakeAgentEnvironment()
    vi.mocked(environment.workspace.editTextFile).mockResolvedValueOnce({
      workspace: { path: '/w', name: 'w' },
      path: 'a.ts',
      sizeBytes: 4,
      sha256: 'c'.repeat(64),
    })
    const result = await createEditTool(environment).execute(
      { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }, { oldText: 'p', newText: 'q' }] },
      baseContext({ approvalLease: 'lease-1' }),
    )
    expect(result.content).toContain('2 replacements')
    expect(result.content).toContain(`sha256: ${'c'.repeat(64)}`)
    expect(result.details).toMatchObject({ editCount: 2, operation: 'edited' })
  })

  it('attaches diff stats and preview to details for the session UI', async () => {
    const environment = createFakeAgentEnvironment()
    vi.mocked(environment.workspace.editTextFile).mockResolvedValueOnce({
      workspace: { path: '/w', name: 'w' },
      path: 'a.ts',
      sizeBytes: 4,
      sha256: 'd'.repeat(64),
    })
    const result = await createEditTool(environment).execute(
      { path: 'a.ts', edits: [{ oldText: 'x\ny', newText: 'x\nz' }] },
      baseContext({ approvalLease: 'lease-1' }),
    )
    const details = result.details as { diffAdded: number; diffRemoved: number; diffPreview: string }
    expect(details.diffAdded).toBe(2)
    expect(details.diffRemoved).toBe(2)
    expect(details.diffPreview).toContain('- y')
    expect(details.diffPreview).toContain('+ z')
  })
})

describe('editTool presentation, audit and idempotency', () => {
  it('builds a per-edit diff preview with an index header for multi-edit calls', () => {
    const tool = createEditTool(createFakeAgentEnvironment())
    const presentation = tool.approvalPresentation?.({
      path: 'a.ts',
      edits: [{ oldText: 'x', newText: 'y' }, { oldText: 'p', newText: 'q' }],
    })
    expect(presentation?.title).toBe('Edit a.ts (2 replacements)?')
    expect(presentation?.preview).toContain('@@ edit 1 @@')
  })

  it('audits old/new byte lengths per edit', () => {
    const tool = createEditTool(createFakeAgentEnvironment())
    expect(tool.auditArguments?.({ path: 'a.ts', edits: [{ oldText: 'hi', newText: 'hello' }] }))
      .toEqual({ path: 'a.ts', editCount: 1, oldTextBytes: [2], newTextBytes: [5] })
  })

  it('derives an idempotency key from path and edit content hashes', async () => {
    const tool = createEditTool(createFakeAgentEnvironment())
    const key = async (value: unknown): Promise<string> => (await tool.idempotencyKey?.(value as never)) ?? ''
    expect(await key({ path: 'a.ts', edits: [{ oldText: 'x', newText: 'yy' }] })).toMatch(/^edit:a\.ts:[0-9a-f]{64}$/u)
    expect(await key({ path: 'a.ts', edits: [] })).toMatch(/^edit:a\.ts:[0-9a-f]{64}$/u)
    expect(await key(null)).toBe('edit:invalid')
  })
})

describe('lsTool', () => {
  it('validates path and limit', () => {
    const tool = createLsTool(createFakeAgentEnvironment())
    expect(tool.validate({}).ok).toBe(true)
    expect(tool.validate({ path: 'src', limit: 10 }).ok).toBe(true)
    expect(tool.validate({ path: '../x' }).ok).toBe(false)
    expect(tool.validate({ limit: 0 }).ok).toBe(false)
    expect(tool.validate({ limit: 1.5 }).ok).toBe(false)
    expect(tool.validate({ extra: true }).ok).toBe(false)
  })

  it('lists entries and appends a cap footer when truncated', async () => {
    const environment = createFakeAgentEnvironment({
      list: async () => ({
        workspace: { path: '/w', name: 'w' },
        directory: '.',
        entries: [
          { path: 'src', name: 'src', kind: 'directory', sizeBytes: 0 },
          { path: 'a.ts', name: 'a.ts', kind: 'file', sizeBytes: 10 },
        ],
        truncated: true,
      }),
    })
    const result = await createLsTool(environment).execute({ path: '.', limit: 2 }, baseContext())
    expect(result.content).toContain('src/')
    expect(result.content).toContain('a.ts')
    expect(result.content).toContain('[Entry cap (2) reached')
  })

  it('reports an empty directory', async () => {
    const result = await createLsTool(createFakeAgentEnvironment()).execute({}, baseContext())
    expect(result.content).toBe('(empty directory)')
  })

  it('rejects an aborted signal and derives a stable idempotency key', async () => {
    const tool = createLsTool(createFakeAgentEnvironment())
    const aborted = new AbortController()
    aborted.abort()
    await expect(tool.execute({}, baseContext({ signal: aborted.signal })))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(tool.idempotencyKey?.({ path: 'src', limit: 5 })).toBe('ls:src:5')
    expect(tool.idempotencyKey?.({})).toBe('ls:.:0')
  })
})
