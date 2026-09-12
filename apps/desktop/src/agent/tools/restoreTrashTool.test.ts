import { describe, expect, it, type vi } from 'vitest'
import { AgentEnvironmentError } from '@/agent/environment/AgentEnvironment'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import type { AgentToolExecutionContext } from '@/agent/core/types'
import { restoreTrashTool } from './restoreTrashTool'
import { createRestoreTrashTool } from './restoreTrashTool'
import { createFakeAgentEnvironment } from './__fixtures__/fakeAgentEnvironment'

const ZERO_ABORT = new AbortController().signal
const ZERO_LEASE = 'lease-test'

const buildContext = (
  overrides: Partial<AgentToolExecutionContext> = {},
): AgentToolExecutionContext => ({
  sessionId: 'session-test',
  runId: 'run-test',
  toolCallId: 'tool-call-test',
  approvalLease: ZERO_LEASE,
  signal: ZERO_ABORT,
  reportProgress: async () => {},
  ...overrides,
})

const callWithFake = async (
  environment: AgentEnvironment,
  input: unknown,
  contextOverrides: Partial<AgentToolExecutionContext> = {},
) => {
  const tool = createRestoreTrashTool(environment)
  return tool.execute(input as never, buildContext(contextOverrides))
}

describe('restoreTrashTool validation', () => {
  it('accepts an alphanumeric recoveryId', () => {
    expect(restoreTrashTool.validate({ recoveryId: 'workspace-change-abc.123' }).ok).toBe(true)
  })

  it('rejects empty, malformed, or path-traversal recoveryId values', () => {
    expect(restoreTrashTool.validate({ recoveryId: '' }).ok).toBe(false)
    expect(restoreTrashTool.validate({ recoveryId: '../escape' }).ok).toBe(false)
    expect(restoreTrashTool.validate({ recoveryId: 'has spaces' }).ok).toBe(false)
    expect(restoreTrashTool.validate({ recoveryId: 'a'.repeat(129) }).ok).toBe(false)
    expect(restoreTrashTool.validate({}).ok).toBe(false)
    expect(restoreTrashTool.validate({ recoveryId: 123 }).ok).toBe(false)
    expect(restoreTrashTool.validate({ recoveryId: 'valid', extra: 'no' }).ok).toBe(false)
  })
})

describe('restoreTrashTool approval presentation', () => {
  it('describes the recovery batch with the supplied id', () => {
    const presentation = restoreTrashTool.approvalPresentation?.({ recoveryId: 'rec-7' })
    expect(presentation?.title).toBe('Restore trash batch rec-7?')
    expect(presentation?.description).toMatch(/restore|冲突|abort/i)
    expect(presentation?.path).toBe('rec-7')
    expect(presentation?.preview).toBe('restore recoverable workspace trash rec-7')
    expect(presentation?.category).toBe('workspace-write')
  })

  it('auditArguments records only the recoveryId and never any restored content', () => {
    expect(restoreTrashTool.auditArguments?.({ recoveryId: 'rec-7' })).toEqual({
      recoveryId: 'rec-7',
    })
  })
})

describe('restoreTrashTool execute path', () => {
  it('threads the recoveryId and approvalLease to the environment', async () => {
    const environment = createFakeAgentEnvironment()
    const result = await callWithFake(environment, { recoveryId: 'rec-7' })
    const restoreTrashMock = environment.workspace.restoreTrash as ReturnType<typeof vi.fn>
    expect(restoreTrashMock).toHaveBeenCalledTimes(1)
    expect(restoreTrashMock.mock.calls[0]).toEqual(['rec-7', ZERO_LEASE])
    expect(result.content).toContain('Restored trash batch rec-7 (1 paths).')
    expect(result.details).toMatchObject({
      recoveryId: 'rec-7',
      completedAfterAbort: false,
    })
    expect((result.details as { changes?: unknown[] } | null)?.changes).toHaveLength(1)
  })

  it('reports multi-path restores verbatim from the environment summary', async () => {
    const environment = createFakeAgentEnvironment({
      restoreTrash: async (recoveryId) => ({
        workspace: { path: '/workspace/repo', name: 'repo', gitBranch: 'main' },
        requestId: `restore-${recoveryId}`,
        changes: [
          { operation: 'restore' as const, path: 'src/a.ts', sha256: 'a'.repeat(64) },
          { operation: 'restore' as const, path: 'src/b.ts', destination: 'src/b.ts', sha256: 'b'.repeat(64) },
          { operation: 'restore' as const, path: 'src/c.ts', sha256: 'c'.repeat(64) },
        ],
      }),
    })
    const result = await callWithFake(environment, { recoveryId: 'rec-multi' })
    expect(result.content).toContain('Restored trash batch rec-multi (3 paths).')
    expect((result.details as { changes?: unknown[] } | null)?.changes).toHaveLength(3)
    expect((result.details as { changes?: unknown[] } | null)?.changes?.[1]).toMatchObject({ destination: 'src/b.ts' })
  })

  it('flags completionAfterAbort when abort fires after the restore completes', async () => {
    const controller = new AbortController()
    const environment = createFakeAgentEnvironment({
      restoreTrash: async (recoveryId) => {
        controller.abort()
        return {
          workspace: { path: '/workspace/repo', name: 'repo', gitBranch: null },
          requestId: `restore-${recoveryId}`,
          changes: [{ operation: 'restore' as const, path: 'src/a.ts' }],
        }
      },
    })
    const result = await callWithFake(
      environment,
      { recoveryId: 'rec-abort' },
      { signal: controller.signal },
    )
    expect(result.details).toMatchObject({ completedAfterAbort: true })
    expect(result.content).toContain('Abort signal arrived mid-restore')
    expect(result.content).toContain('not auto-replayed')
  })

  it('throws AbortError immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const environment = createFakeAgentEnvironment()
    await expect(callWithFake(
      environment,
      { recoveryId: 'rec-abort' },
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('re-throws conflict errors from the environment verbatim', async () => {
    const environment = createFakeAgentEnvironment({
      restoreTrash: async () => {
        throw new AgentEnvironmentError('conflict', 'original location now occupied: src/a.ts')
      },
    })
    await expect(callWithFake(environment, { recoveryId: 'rec-conflict' }))
      .rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('occupied') })
  })

  it('propagates non-AgentEnvironmentError rejections verbatim', async () => {
    const boom = new Error('recoveryId not found')
    const environment = createFakeAgentEnvironment({
      restoreTrash: async () => { throw boom },
    })
    await expect(callWithFake(environment, { recoveryId: 'rec-missing' })).rejects.toBe(boom)
  })

  it('throws when no approval lease is supplied by the Runtime', async () => {
    const environment = createFakeAgentEnvironment()
    await expect(callWithFake(
      environment,
      { recoveryId: 'rec-no-lease' },
      { approvalLease: undefined },
    )).rejects.toThrow(/approval lease/)
  })
})