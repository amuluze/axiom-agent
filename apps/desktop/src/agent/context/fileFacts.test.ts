import { describe, expect, it } from 'vitest'
import { mergeFileFacts, READ_FILE_TOOL_NAMES } from './fileFacts'

describe('mergeFileFacts', () => {
  it('recognizes only the canonical read tools', () => {
    const facts = mergeFileFacts(undefined, [
      { role: 'tool', toolName: 'read', details: { path: 'src/a.ts' } },
      { role: 'tool', toolName: 'read_workspace_file', details: { path: 'src/b.ts' } },
      { role: 'tool', toolName: 'read_authorized_text', details: { path: 'notes/c.md' } },
      { role: 'tool', toolName: 'thread_read', details: { path: 'src/false-positive.ts' } },
      { role: 'tool', toolName: 'grep', details: { path: 'src/search.ts' } },
    ])
    expect(READ_FILE_TOOL_NAMES).toEqual(['read', 'read_workspace_file', 'read_authorized_text'])
    expect(facts).toEqual({
      readFiles: ['notes/c.md', 'src/a.ts', 'src/b.ts'],
      modifiedFiles: [],
    })
  })

  it('treats created/edited operations as modifications and removes them from reads', () => {
    const facts = mergeFileFacts({ readFiles: ['src/a.ts', 'src/b.ts'], modifiedFiles: [] }, [
      { role: 'tool', toolName: 'read', details: { path: 'src/a.ts' } },
      { role: 'tool', toolName: 'write', details: { path: 'src/a.ts', operation: 'created' } },
      { role: 'tool', toolName: 'edit', details: { path: 'src/b.ts', operation: 'edited' } },
    ])
    expect(facts).toEqual({ readFiles: [], modifiedFiles: ['src/a.ts', 'src/b.ts'] })
  })

  it('keeps previous facts, ignores errors and malformed details, and sorts output', () => {
    const facts = mergeFileFacts(
      { readFiles: ['src/z.ts'], modifiedFiles: ['src/y.ts'] },
      [
        { role: 'tool', toolName: 'read', isError: true, details: { path: 'src/ignored.ts' } },
        { role: 'tool', toolName: 'read', details: null },
        { role: 'tool', toolName: 'read', details: ['not', 'an', 'object'] },
        { role: 'tool', toolName: 'read', details: { path: 'src/a.ts' } },
        { role: 'tool', toolName: 'write', details: { path: 'src/b.ts', operation: 'edited' } },
      ],
    )
    expect(facts).toEqual({
      readFiles: ['src/a.ts', 'src/z.ts'],
      modifiedFiles: ['src/b.ts', 'src/y.ts'],
    })
  })
})
