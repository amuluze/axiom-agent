import { describe, expect, it } from 'vitest'
import { compactParentHint } from './mentionHints'

describe('compactParentHint', () => {
  it('keeps the last two parent segments and elides the rest', () => {
    expect(compactParentHint('/Users/amu/Desktop/github/licensor/authz')).toBe('…/github/licensor')
  })

  it('keeps short parents intact', () => {
    expect(compactParentHint('/srv/spec.md')).toBe('/srv')
    expect(compactParentHint('/a/b.md')).toBe('/a')
  })

  it('returns an empty hint when there is no parent directory', () => {
    expect(compactParentHint('notes.md')).toBe('')
    expect(compactParentHint('/')).toBe('')
  })

  it('ignores trailing slashes on directory references', () => {
    expect(compactParentHint('/repo/src/')).toBe('/repo')
  })
})
