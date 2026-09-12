import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@/agent/core/types'
import { applyChangesTool } from './applyChangesTool'
import { editTool } from './editTool'
import { grepTool } from './grepTool'
import { lsTool } from './lsTool'
import { readTool } from './readTool'
import { restoreTrashTool } from './restoreTrashTool'
import { bashTool } from './bashTool'
import { writeTool } from './writeTool'

describe('workspace tool validation', () => {
  it('accepts scoped list, search and paginated read arguments', () => {
    expect(lsTool.validate({ path: 'src', limit: 25 }).ok).toBe(true)
    expect(grepTool.validate({
      pattern: 'runAgentLoop',
      path: 'apps/desktop/src',
      glob: '**/*.ts',
      literal: true,
      limit: 50,
    }).ok).toBe(true)
    expect(grepTool.validate({
      pattern: 'runAgentLoop',
      context: 3,
    }).ok).toBe(true)
    expect(readTool.validate({ path: 'README.md', offset: 10, limit: 100 }).ok).toBe(true)
  })

  it('rejects absolute paths, parent traversal and unsupported fields', () => {
    expect(lsTool.validate({ path: '../outside' }).ok).toBe(false)
    expect(readTool.validate({ path: 'README.md', shell: true }).ok).toBe(false)
    expect(grepTool.validate({ pattern: 'x', path: 'src/../../outside' }).ok).toBe(false)
  })

  it('rejects out-of-range grep context', () => {
    expect(grepTool.validate({ pattern: 'x', context: 11 }).ok).toBe(false)
    expect(grepTool.validate({ pattern: 'x', context: -1 }).ok).toBe(false)
  })

  it('rejects invalid limits and empty patterns before invoking Rust', () => {
    expect(lsTool.validate({ limit: 0 }).ok).toBe(false)
    expect(readTool.validate({ path: 'README.md', offset: 1.5 }).ok).toBe(false)
    expect(grepTool.validate({ pattern: '', limit: 501 }).ok).toBe(false)
  })

  it('validates protected create and unique-replacement edit arguments', () => {
    expect(writeTool.validate({ path: 'notes/new.md', content: '# Axiom\n' }).ok).toBe(true)
    expect(editTool.validate({
      path: 'notes/new.md',
      edits: [{ oldText: '# Axiom', newText: '# Axiom Agent' }],
    }).ok).toBe(true)
    expect(writeTool.validate({ path: '../escape.md', content: 'x' }).ok).toBe(false)
    expect(editTool.validate({
      path: 'notes/new.md',
      edits: [{ oldText: '', newText: 'x' }],
    }).ok).toBe(false)
    expect(editTool.validate({ path: 'notes/new.md', edits: [] }).ok).toBe(false)
  })

  it('upgrades legacy single oldText/newText edit input via prepareArguments', () => {
    const upgraded = editTool.prepareArguments?.({
      path: 'notes/new.md',
      oldText: '# Axiom',
      newText: '# Axiom Agent',
    })
    expect(upgraded).toEqual({
      path: 'notes/new.md',
      edits: [{ oldText: '# Axiom', newText: '# Axiom Agent' }],
    })
    expect(editTool.validate(upgraded!).ok).toBe(true)
  })

  it('redacts full workspace write content from audit arguments', () => {
    expect(writeTool.auditArguments?.({
      path: 'notes.md',
      content: 'sensitive body',
    })).toEqual({ path: 'notes.md', contentBytes: 14 })
    expect(editTool.auditArguments?.({
      path: 'notes.md',
      edits: [{ oldText: 'private old', newText: 'private new' }],
    })).toEqual({
      path: 'notes.md',
      editCount: 1,
      oldTextBytes: [11],
      newTextBytes: [11],
    })
  })

  it('validates atomic multi-file changes with hashes and per-file approval previews', () => {
    const input = {
      operations: [
        {
          type: 'patch-file',
          path: 'src/one.ts',
          expectedSha256: 'a'.repeat(64),
          oldText: 'before',
          newText: 'after',
        },
        { type: 'create-file', path: 'src/two.ts', content: 'export {}\n' },
      ],
    }
    expect(applyChangesTool.validate(input as unknown as JsonValue).ok).toBe(true)
    const presentation = applyChangesTool.approvalPresentation?.(input as unknown as JsonValue)
    expect(presentation?.changes).toHaveLength(2)
    expect(presentation?.changes?.map((change) => change.path)).toEqual([
      'src/one.ts',
      'src/two.ts',
    ])
    expect(JSON.stringify(applyChangesTool.auditArguments?.(input as unknown as JsonValue))).not.toContain('before')
    expect(JSON.stringify(applyChangesTool.auditArguments?.(input as unknown as JsonValue))).not.toContain('export')
  })

  it('rejects unsafe overlapping batches and validates recovery IDs', () => {
    expect(applyChangesTool.validate({
      operations: [
        { type: 'trash', path: 'src' },
        {
          type: 'patch-file',
          path: 'src/main.ts',
          expectedSha256: 'b'.repeat(64),
          oldText: 'old',
          newText: 'new',
        },
      ],
    }).ok).toBe(false)
    expect(applyChangesTool.validate({
      operations: [{ type: 'patch-file', path: '.git/config', expectedSha256: 'a'.repeat(64), oldText: 'x', newText: 'y' }],
    }).ok).toBe(false)
    expect(restoreTrashTool.validate({ recoveryId: 'workspace-change-123' }).ok).toBe(true)
    expect(restoreTrashTool.validate({ recoveryId: '../escape' }).ok).toBe(false)
  })

  it('accepts free-form bash commands', () => {
    expect(bashTool.validate({
      command: 'npm run typecheck',
      cwd: 'apps/desktop',
      timeout: 120,
    }).ok).toBe(true)
    expect(bashTool.validate({
      command: 'git status --short',
    }).ok).toBe(true)
    expect(bashTool.validate({
      command: 'ls -la && echo done',
    }).ok).toBe(true)
    expect(bashTool.validate({
      command: 'sh -c "echo hello"',
    }).ok).toBe(true)
    expect(bashTool.validate({
      command: 'git commit -am "x"',
    }).ok).toBe(true)
  })

  it('rejects empty or missing bash commands', () => {
    expect(bashTool.validate({ command: '' }).ok).toBe(false)
    expect(bashTool.validate({ command: '   ' }).ok).toBe(false)
    expect(bashTool.validate({ cwd: 'src' }).ok).toBe(false)
  })

  it('redacts full command from persistent audit metadata', () => {
    const command = 'npm run secret-script -- --sensitive-value'
    expect(bashTool.auditArguments?.({
      command,
      cwd: '.',
      timeout: 5,
    })).toEqual({
      commandPreview: command,
      commandLength: command.length,
      cwd: '.',
      timeoutMs: 5_000,
    })
  })
})
