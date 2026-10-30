import { describe, expect, it, vi } from 'vitest'
import type { AgentToolPreparationContext } from '@/agent/core/types'
import { createFakeAgentEnvironment } from './__fixtures__/fakeAgentEnvironment'
import { applyExactEdits, assessSyntax, prepareSyntaxRepair } from './editSyntaxRepair'
import { sha256Text } from './workspaceToolUtils'

const preparationContext = (
  repairSyntax: NonNullable<AgentToolPreparationContext['repairSyntax']>,
): AgentToolPreparationContext => ({
  sessionId: 'session-1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  signal: new AbortController().signal,
  repairSyntax,
})

const environmentWithFile = async (path: string, content: string, truncated = false) =>
  createFakeAgentEnvironment({
    readText: async () => ({
      workspace: { path: '/workspace/repo', name: 'repo' },
      path,
      content,
      sha256: await sha256Text(content),
      startLine: 1,
      endLine: content.split('\n').length,
      totalLines: content.split('\n').length,
      truncated,
    }),
  })

describe('assessSyntax', () => {
  it('uses strict JSON parsing and detects structural TypeScript damage', () => {
    expect(assessSyntax('config.json', '{"ok":true}')).toMatchObject({ supported: true, valid: true })
    expect(assessSyntax('config.json', '{"ok":}')).toMatchObject({ supported: true, valid: false })
    expect(assessSyntax('src/a.ts', 'export const value = { ok: true }')).toMatchObject({ supported: true, valid: true })
    expect(assessSyntax('src/a.ts', 'export const value = { ok: true')).toMatchObject({ supported: true, valid: false })
    expect(assessSyntax('README.md', '# title')).toEqual({ supported: false, valid: true })
  })

  it('ignores balanced delimiters inside strings, comments and regex literals', () => {
    const content = `const pattern = /[})]/u\nconst text = "}"\n/* ] */\nexport const ok = { value: true }`
    expect(assessSyntax('src/a.ts', content)).toMatchObject({ valid: true })
  })
})

describe('applyExactEdits', () => {
  it('applies non-overlapping unique edits and rejects ambiguous matches', () => {
    expect(applyExactEdits('alpha beta gamma', [
      { oldText: 'alpha', newText: 'one' },
      { oldText: 'gamma', newText: 'three' },
    ])).toBe('one beta three')
    expect(applyExactEdits('same same', [{ oldText: 'same', newText: 'x' }])).toBeUndefined()
  })
})

describe('prepareSyntaxRepair', () => {
  it('repairs a newly introduced syntax error and records the accepted attempt', async () => {
    const before = 'export const value = { ok: true }\n'
    const environment = await environmentWithFile('src/a.ts', before)
    const repairSyntax = vi.fn(async () => ['export const value = { ok: false }'])
    const result = await prepareSyntaxRepair({
      path: 'src/a.ts',
      edits: [{ oldText: 'export const value = { ok: true }', newText: 'export const value = { ok: false' }],
      environment,
      context: preparationContext(repairSyntax),
    })
    expect(result.edits[0].newText).toBe('export const value = { ok: false }')
    expect(result.details).toMatchObject({ syntaxAutoRepair: { applied: true, attempts: 1 } })
    expect(repairSyntax).toHaveBeenCalledTimes(1)
  })

  it('rejects a pure rollback and accepts a valid second attempt', async () => {
    const before = '{"enabled":true}'
    const environment = await environmentWithFile('config.json', before)
    const repairSyntax = vi.fn()
      .mockResolvedValueOnce(['true'])
      .mockResolvedValueOnce(['false'])
    const result = await prepareSyntaxRepair({
      path: 'config.json',
      edits: [{ oldText: 'true', newText: '' }],
      environment,
      context: preparationContext(repairSyntax),
    })
    expect(result.edits).toEqual([{ oldText: 'true', newText: 'false' }])
    expect(result.details).toMatchObject({ syntaxAutoRepair: { attempts: 2 } })
    expect(repairSyntax).toHaveBeenLastCalledWith(expect.objectContaining({ previousAttempt: ['true'] }))
  })

  it('skips repair when the original is invalid, the read is truncated, or matching is ambiguous', async () => {
    const repairSyntax = vi.fn(async () => ['fixed'])
    const invalidEnvironment = await environmentWithFile('config.json', '{bad')
    const truncatedEnvironment = await environmentWithFile('config.json', '{"ok":true}', true)
    const ambiguousEnvironment = await environmentWithFile('config.json', '{"a":true,"b":true}')
    const edit = [{ oldText: 'true', newText: '' }]

    await expect(prepareSyntaxRepair({
      path: 'config.json', edits: edit, environment: invalidEnvironment, context: preparationContext(repairSyntax),
    })).resolves.toEqual({ edits: edit })
    await expect(prepareSyntaxRepair({
      path: 'config.json', edits: edit, environment: truncatedEnvironment, context: preparationContext(repairSyntax),
    })).resolves.toEqual({ edits: edit })
    await expect(prepareSyntaxRepair({
      path: 'config.json', edits: edit, environment: ambiguousEnvironment, context: preparationContext(repairSyntax),
    })).resolves.toEqual({ edits: edit })
    expect(repairSyntax).not.toHaveBeenCalled()
  })
})
