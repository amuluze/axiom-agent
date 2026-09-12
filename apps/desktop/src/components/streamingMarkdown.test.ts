import { describe, expect, it } from 'vitest'
import { splitStreamingMarkdown } from './streamingMarkdown'

describe('splitStreamingMarkdown', () => {
  it('treats a closed code fence as fully stable', () => {
    expect(splitStreamingMarkdown('```ts\nconst x = 1\n```')).toEqual({
      stable: '```ts\nconst x = 1\n```',
      tail: '',
    })
  })

  it('sends an unclosed code fence to the tail', () => {
    expect(splitStreamingMarkdown('```ts\nconst x = 1')).toEqual({
      stable: '',
      tail: '```ts\nconst x = 1',
    })
  })

  it('sends plain text without any fence to the tail', () => {
    expect(splitStreamingMarkdown('plain text')).toEqual({
      stable: '',
      tail: 'plain text',
    })
  })

  it('returns an empty split for an empty string', () => {
    expect(splitStreamingMarkdown('')).toEqual({ stable: '', tail: '' })
  })

  it('splits at the last closed fence, keeping trailing text as tail', () => {
    expect(splitStreamingMarkdown('```\nx\n```after')).toEqual({
      stable: '```\nx\n```',
      tail: 'after',
    })
  })

  it('keeps multiple closed fences stable, then an open fence becomes tail', () => {
    expect(splitStreamingMarkdown('```\na\n```\n```\nb')).toEqual({
      stable: '```\na\n```',
      tail: '\n```\nb',
    })
  })

  it('treats two closed fences as fully stable', () => {
    expect(splitStreamingMarkdown('```\na\n```\n```\nb\n```')).toEqual({
      stable: '```\na\n```\n```\nb\n```',
      tail: '',
    })
  })
})
