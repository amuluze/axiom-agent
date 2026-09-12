import { describe, expect, it, type vi } from 'vitest'
import { AgentEnvironmentError } from '@/agent/environment/AgentEnvironment'
import type { AgentEnvironment } from '@/agent/environment/AgentEnvironment'
import type {
  WorkspaceChangeRequest,
  WorkspaceChangeResult,
} from '@/platform/workspace'
import type { AgentToolExecutionContext, JsonValue } from '@/agent/core/types'
import { applyChangesTool } from './applyChangesTool'
import { createApplyChangesTool } from './applyChangesTool'
import {
  buildSuccessResult,
  createFakeAgentEnvironment,
} from './__fixtures__/fakeAgentEnvironment'

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

const validPatchFile = (overrides: Partial<{
  path: string
  expectedSha256: string
  oldText: string
  newText: string
}> = {}) => ({
  type: 'patch-file' as const,
  path: overrides.path ?? 'src/one.ts',
  expectedSha256: overrides.expectedSha256 ?? 'a'.repeat(64),
  oldText: overrides.oldText ?? 'before',
  newText: overrides.newText ?? 'after',
})

const validCreateFile = (overrides: Partial<{ path: string; content: string }> = {}) => ({
  type: 'create-file' as const,
  path: overrides.path ?? 'src/two.ts',
  content: overrides.content ?? 'export {}\n',
})

describe('applyChangesTool approval presentation', () => {
  it('uses singular and plural workspace change titles', () => {
    const one = applyChangesTool.approvalPresentation?.({
      operations: [{ type: 'create-file', path: 'one.txt', content: 'one' }],
    })
    const two = applyChangesTool.approvalPresentation?.({
      operations: [
        { type: 'create-file', path: 'one.txt', content: 'one' },
        { type: 'create-file', path: 'two.txt', content: 'two' },
      ],
    })

    expect(one?.title).toBe('Apply 1 workspace change atomically?')
    expect(two?.title).toBe('Apply 2 workspace changes atomically?')
  })

  it('renders a preview for every supported operation type', () => {
    const input = {
      operations: [
        validCreateFile({ path: 'src/new.ts', content: 'export const v = 1\n' }),
        validPatchFile({ path: 'src/existing.ts' }),
        { type: 'create-directory', path: 'src/lib' },
        {
          type: 'move',
          from: 'src/old.ts',
          to: 'src/new-old.ts',
          expectedSha256: 'd'.repeat(64),
        },
        {
          type: 'trash',
          path: 'src/legacy.ts',
          expectedSha256: 'e'.repeat(64),
        },
      ],
    }
    const presentation = applyChangesTool.approvalPresentation?.(input as unknown as JsonValue)
    expect((presentation as { changes?: unknown[] } | undefined)?.changes).toHaveLength(5)
    expect((presentation as { changes?: unknown[] } | undefined)?.changes?.map((change) => (change as { path: string }).path)).toEqual([
      'src/new.ts',
      'src/existing.ts',
      'src/lib',
      'src/old.ts → src/new-old.ts',
      'src/legacy.ts',
    ])
    const previews = (presentation as { changes?: unknown[] } | undefined)?.changes?.map((change) => (change as { preview?: string }).preview) ?? []
    expect(previews[0]).toContain('+++ src/new.ts')
    expect(previews[0]).toContain('+ export const v = 1')
    expect(previews[1]).toContain(`expected sha256 ${'a'.repeat(64)}`)
    expect(previews[1]).toContain('- before')
    expect(previews[1]).toContain('+ after')
    expect(previews[2]).toBe('mkdir src/lib')
    expect(previews[3]).toContain('move src/old.ts -> src/new-old.ts')
    expect(previews[3]).toContain(`expected sha256 ${'d'.repeat(64)}`)
    expect(previews[4]).toContain('recoverable trash src/legacy.ts')
    expect(previews[4]).toContain(`expected sha256 ${'e'.repeat(64)}`)
  })

  it('truncates oversized previews without changing the approved content', () => {
    const bigContent = 'x'.repeat(20_000)
    const presentation = applyChangesTool.approvalPresentation?.({
      operations: [validCreateFile({ content: bigContent })],
    })
    const preview = ((presentation as { changes?: unknown[] } | undefined)?.changes?.[0] as { preview?: string } | undefined)?.preview ?? ''
    expect(preview.length).toBeLessThan(bigContent.length)
    expect(preview).toContain('[this file preview is truncated; approval still covers the full content]')
  })
})

describe('applyChangesTool audit arguments', () => {
  it('redacts full content text but keeps bytes, paths and hashes', () => {
    const createContent = 'private body' // 12 ASCII bytes
    const patchOld = 'private old'      // 11 ASCII bytes
    const patchNew = 'private new'      // 11 ASCII bytes
    const audit = applyChangesTool.auditArguments?.({
      operations: [
        validCreateFile({ content: createContent }),
        validPatchFile({ oldText: patchOld, newText: patchNew }),
        { type: 'trash', path: 'src/secret.ts', expectedSha256: 'f'.repeat(64) },
      ],
    })
    const serialized = JSON.stringify(audit)
    // Bodies must never reach the audit log; bytes/path/hash may.
    expect(serialized).not.toContain('private body')
    expect(serialized).not.toContain('private old')
    expect(serialized).not.toContain('private new')
    expect(audit).toMatchObject({
      operationCount: 3,
      operations: [
        { type: 'create-file', paths: ['src/two.ts'], textBytes: 12 },
        { type: 'patch-file', paths: ['src/one.ts'], textBytes: 22 },
        { type: 'trash', paths: ['src/secret.ts'], expectedSha256: 'f'.repeat(64) },
      ],
    })
  })
})

describe('applyChangesTool execute path', () => {
  const callWithFake = async (
    environment: AgentEnvironment,
    input: unknown,
    contextOverrides: Partial<AgentToolExecutionContext> = {},
  ) => {
    const tool = createApplyChangesTool(environment)
    return tool.execute(input as never, buildContext(contextOverrides))
  }

  it('threads requestId, approvalLease and operations through to the environment', async () => {
    const environment = createFakeAgentEnvironment()
    const input = {
      operations: [validCreateFile(), validPatchFile()],
    }
    const result = await callWithFake(environment, input)
    const applyChangesMock = environment.workspace.applyChanges as ReturnType<typeof vi.fn>
    expect(applyChangesMock).toHaveBeenCalledTimes(1)
    const [request, lease] = applyChangesMock.mock.calls[0]
    expect(lease).toBe(ZERO_LEASE)
    expect(request.operations).toHaveLength(2)
    expect(request.requestId).toMatch(/^workspace-change-/)
    expect(result.content).toContain('Applied 2 workspace changes atomically.')
    expect(result.details).toMatchObject({
      requestId: request.requestId,
      recoveryId: null,
      completedAfterAbort: false,
    })
    expect((result.details as { changes?: unknown[] } | null)?.changes).toHaveLength(2)
  })

  it('attaches diff stats and preview to details for text-bearing operations', async () => {
    const environment = createFakeAgentEnvironment()
    const result = await callWithFake(environment, {
      operations: [
        validCreateFile({ content: 'hello\n' }),
        validPatchFile({ oldText: 'before', newText: 'after' }),
      ],
    })
    const details = result.details as { diffAdded: number; diffRemoved: number; diffPreview: string }
    // create-file 'hello\n' 两段（含尾部空段）+ patch-file 一行新增
    expect(details.diffAdded).toBe(3)
    expect(details.diffRemoved).toBe(1)
    expect(details.diffPreview).toContain('+++ src/two.ts')
    expect(details.diffPreview).toContain('- before')
    expect(details.diffPreview).toContain('+ after')
  })

  it('omits the diff section when the batch has no text-bearing operations', async () => {
    const environment = createFakeAgentEnvironment()
    const result = await callWithFake(environment, {
      operations: [{ type: 'create-directory', path: 'src/lib' }],
    })
    expect(result.details).not.toHaveProperty('diffPreview')
  })

  it('forwards the audit artifact reference returned by the environment', async () => {
    const environment = createFakeAgentEnvironment({
      applyChanges: async (request) => buildSuccessResult(request, { includeArtifact: true }),
    })
    const result = await callWithFake(environment, { operations: [validCreateFile()] })
    expect(result.artifact).toBeDefined()
    expect(result.artifact?.id).toBe('artifact-test')
  })

  it('omits the artifact reference when the environment does not return one', async () => {
    const environment = createFakeAgentEnvironment({
      applyChanges: async (request) => buildSuccessResult(request, { includeArtifact: false }),
    })
    const result = await callWithFake(environment, { operations: [validCreateFile()] })
    expect(result.artifact).toBeUndefined()
    expect(result.content).not.toContain('Recoverable trash id')
  })

  it('surfaces the recoveryId from trash operations in content and details', async () => {
    const environment = createFakeAgentEnvironment({
      applyChanges: async (request) =>
        buildSuccessResult(request, { includeRecoveryId: true, recoveryId: 'recovery-xyz' }),
    })
    const input = {
      operations: [{ type: 'trash', path: 'src/legacy.ts' }],
    }
    const result = await callWithFake(environment, input)
    expect(result.content).toContain('Recoverable trash id: recovery-xyz')
    expect(result.details).toMatchObject({ recoveryId: 'recovery-xyz' })
  })

  it('flags completionAfterAbort when the signal aborts after the environment resolves', async () => {
    const controller = new AbortController()
    const environment = createFakeAgentEnvironment({
      applyChanges: async (request) => {
        // Abort fires only after applyChanges has resolved.
        const result = buildSuccessResult(request)
        controller.abort()
        return result
      },
    })
    const result = await callWithFake(
      environment,
      { operations: [validCreateFile()] },
      { signal: controller.signal },
    )
    expect(result.details).toMatchObject({ completedAfterAbort: true })
    expect(result.content).toContain('Abort signal arrived mid-transaction')
    expect(result.content).toContain('not auto-replayed')
  })

  it('throws AbortError immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const environment = createFakeAgentEnvironment()
    await expect(callWithFake(
      environment,
      { operations: [validCreateFile()] },
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('re-throws environment errors so the Runtime can mark the result as isError', async () => {
    const environment = createFakeAgentEnvironment({
      applyChanges: async () => {
        throw new AgentEnvironmentError('conflict', 'sha256 mismatch on src/one.ts')
      },
    })
    await expect(callWithFake(environment, { operations: [validPatchFile()] }))
      .rejects.toBeInstanceOf(AgentEnvironmentError)
    await expect(callWithFake(environment, { operations: [validPatchFile()] }))
      .rejects.toMatchObject({ code: 'conflict' })
  })

  it('propagates non-AgentEnvironmentError rejections verbatim', async () => {
    const boom = new Error('rust panic: workspace not authorized')
    const environment = createFakeAgentEnvironment({
      applyChanges: async () => { throw boom },
    })
    await expect(callWithFake(environment, { operations: [validCreateFile()] }))
      .rejects.toBe(boom)
  })

  it('throws when no approval lease is supplied by the Runtime', async () => {
    const environment = createFakeAgentEnvironment()
    await expect(callWithFake(
      environment,
      { operations: [validCreateFile()] },
      { approvalLease: undefined },
    )).rejects.toThrow(/approval lease/)
  })

  it('validate returns the typed operations array for downstream approvalPresentation', () => {
    const result = applyChangesTool.validate({
      operations: [
        validCreateFile(),
        validPatchFile(),
        { type: 'move', from: 'src/a.ts', to: 'src/b.ts' },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      operations: [
        { type: 'create-file', path: 'src/two.ts' },
        { type: 'patch-file', path: 'src/one.ts' },
        { type: 'move', from: 'src/a.ts', to: 'src/b.ts' },
      ],
    })
  })

  it('rejects batches where the same path appears twice', () => {
    const result = applyChangesTool.validate({
      operations: [
        validCreateFile({ path: 'src/same.ts' }),
        validPatchFile({ path: 'src/same.ts' }),
      ],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/ancestor\/descendant/)
  })

  it('uses the fake environment returned by buildSuccessResult for integration smoke', async () => {
    const environment = createFakeAgentEnvironment()
    const request: WorkspaceChangeRequest = {
      requestId: 'workspace-change-fixed',
      operations: [validCreateFile()],
    }
    const result: WorkspaceChangeResult = await environment.workspace.applyChanges(request, ZERO_LEASE)
    expect(result.workspace.path).toBe('/workspace/repo')
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({ operation: 'create-file', path: 'src/two.ts' })
  })
})