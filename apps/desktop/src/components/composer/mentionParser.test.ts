import { describe, expect, it } from 'vitest'
import {
  detectActiveMention,
  filterCandidates,
  formatMentionToken,
  parseMentions,
} from './mentionParser'

const candidates = [
  { id: '/srv/spec.md', label: 'spec.md', hint: '/srv/spec.md' },
  { id: '/srv/notes.md', label: 'notes.md', hint: '/srv/notes.md' },
  { id: '/srv/Research.md', label: 'Research.md', hint: '/srv/Research.md' },
  { id: '/srv/repo/main.ts', label: 'main.ts', hint: '/srv/repo/main.ts' },
]

describe('mentionParser.detectActiveMention', () => {
  it('detects a trigger at the start of the value', () => {
    expect(detectActiveMention('@spec', 5)).toEqual({
      kind: 'file',
      triggerStart: 0,
      queryEnd: 5,
      query: 'spec',
    })
  })

  it('detects a trigger after a whitespace boundary', () => {
    expect(detectActiveMention('say @not', 8)).toEqual({
      kind: 'file',
      triggerStart: 4,
      queryEnd: 8,
      query: 'not',
    })
  })

  it('refuses to match a trigger that follows a non-whitespace character', () => {
    expect(detectActiveMention('hello@world', 12)).toBeNull()
  })

  it('returns null when the caret sits at a whitespace boundary', () => {
    expect(detectActiveMention('hi ', 3)).toBeNull()
  })

  it('matches the skill and thread triggers', () => {
    expect(detectActiveMention('/skill', 7)?.kind).toBe('skill')
    expect(detectActiveMention('#thread', 8)?.kind).toBe('thread')
  })

  it('no longer treats / as a command trigger', () => {
    expect(detectActiveMention('/run', 5)?.kind).toBe('skill')
  })
})

describe('mentionParser.filterCandidates', () => {
  it('returns every candidate when the query is empty', () => {
    expect(filterCandidates(candidates, '')).toHaveLength(4)
  })

  it('prefers prefix matches', () => {
    const result = filterCandidates(candidates, 'note')
    expect(result[0]?.id).toBe('/srv/notes.md')
  })

  it('falls back to substring matches after prefix matches', () => {
    const result = filterCandidates(candidates, 'main')
    expect(result[0]?.id).toBe('/srv/repo/main.ts')
  })

  it('trims whitespace and matches case-insensitively', () => {
    const result = filterCandidates(candidates, '  RESEARCH  ')
    expect(result[0]?.id).toBe('/srv/Research.md')
  })
})

describe('mentionParser.formatMentionToken', () => {
  it('preserves stable ids while keeping human-friendly labels', () => {
    expect(formatMentionToken('file', { id: '/srv/spec.md', label: 'spec.md' }))
      .toBe('@[spec.md](%2Fsrv%2Fspec.md) ')
    expect(formatMentionToken('file', { id: '/srv/src', label: 'src', isDirectory: true }))
      .toBe('@[src](%2Fsrv%2Fsrc) ')
    expect(formatMentionToken('thread', { id: 'session-2', label: '计划讨论' }))
      .toBe('#[计划讨论](session-2) ')
    expect(formatMentionToken('skill', { id: 'review', label: '审查' })).toBe('/review ')
  })
})

describe('mentionParser.parseMentions', () => {
  it('lists every well-formed mention in order', () => {
    const text = '@spec.md see /skill maybe #thread'
    expect(parseMentions(text)).toEqual([
      { kind: 'file', label: 'spec.md', start: 1, end: 8 },
      { kind: 'skill', label: 'skill', start: 14, end: 19 },
      { kind: 'thread', label: 'thread', start: 27, end: 33 },
    ])
  })

  it('records thread end as start + label length', () => {
    const result = parseMentions('#thread')
    expect(result).toHaveLength(1)
    expect(result[0]?.end).toBe(7)
    expect(result[0]?.end).toBeGreaterThan(result[0]?.start ?? 0)
  })

  it('ignores trigger characters that are not at a word boundary', () => {
    expect(parseMentions('a@b')).toEqual([])
  })

  it('parses structured file and thread mentions without losing their stable ids', () => {
    expect(parseMentions('@[spec.md](%2Fsrv%2Fspec.md) #[计划讨论](session-2)')).toEqual([
      { kind: 'file', label: 'spec.md', id: '/srv/spec.md', start: 2, end: 9 },
      { kind: 'thread', label: '计划讨论', id: 'session-2', start: 31, end: 35 },
    ])
  })
})
