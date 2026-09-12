import { describe, expect, it } from 'vitest'
import {
  buildApplyChangesResultDiff,
  buildEditResultDiff,
  buildWriteResultDiff,
} from './toolDiff'

describe('buildEditResultDiff', () => {
  it('counts added/removed lines and renders a unified preview', () => {
    const diff = buildEditResultDiff('a.ts', [{ oldText: 'x\ny', newText: 'x\nz' }])
    expect(diff.diffRemoved).toBe(2)
    expect(diff.diffAdded).toBe(2)
    expect(diff.diffPreview).toContain('--- a.ts')
    expect(diff.diffPreview).toContain('- y')
    expect(diff.diffPreview).toContain('+ z')
  })

  it('labels each edit with an index header for multi-edit calls', () => {
    const diff = buildEditResultDiff('a.ts', [
      { oldText: 'x', newText: 'y' },
      { oldText: 'p', newText: 'q' },
    ])
    expect(diff.diffPreview).toContain('@@ edit 1 @@')
    expect(diff.diffPreview).toContain('@@ edit 2 @@')
    expect(diff.diffAdded).toBe(2)
    expect(diff.diffRemoved).toBe(2)
  })

  it('truncates oversized previews with a visible marker', () => {
    const diff = buildEditResultDiff('a.ts', [{ oldText: 'x', newText: '段落\n'.repeat(20_000) }])
    expect(diff.diffPreview.length).toBeLessThanOrEqual(12_000 + '\n… [preview truncated]'.length + 1)
    expect(diff.diffPreview.endsWith('… [preview truncated]')).toBe(true)
  })
})

describe('buildWriteResultDiff', () => {
  it('counts every line as an addition against /dev/null', () => {
    const diff = buildWriteResultDiff('new.md', '# Title\nbody')
    expect(diff.diffRemoved).toBe(0)
    expect(diff.diffAdded).toBe(2)
    expect(diff.diffPreview).toContain('--- /dev/null')
    expect(diff.diffPreview).toContain('+++ new.md')
    expect(diff.diffPreview).toContain('+ # Title')
  })
})

describe('buildApplyChangesResultDiff', () => {
  it('covers create-file and patch-file segments in one preview', () => {
    const diff = buildApplyChangesResultDiff([
      { type: 'create-file', path: 'b.txt', content: 'hello' },
      { type: 'patch-file', path: 'a.txt', expectedSha256: 'a'.repeat(64), oldText: 'old', newText: 'new' },
    ])
    expect(diff).toBeDefined()
    expect(diff!.diffAdded).toBe(2)
    expect(diff!.diffRemoved).toBe(1)
    expect(diff!.diffPreview).toContain('+++ b.txt')
    expect(diff!.diffPreview).toContain('- old')
    expect(diff!.diffPreview).toContain('+ new')
  })

  it('returns undefined when the batch has no text-bearing operations', () => {
    expect(buildApplyChangesResultDiff([
      { type: 'create-directory', path: 'dir' },
      { type: 'move', from: 'x', to: 'y' },
      { type: 'trash', path: 'z' },
    ])).toBeUndefined()
  })
})
