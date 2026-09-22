import { describe, expect, it } from 'vitest'
import { splitMentionSegments } from './mentionHighlight'
import { parseMentions } from './mentionParser'

describe('splitMentionSegments', () => {
  it('splits plain text around a structured token', () => {
    const value = '看下 @[cloud.yml](/a/cloud.yml) 配置'
    expect(splitMentionSegments(value, parseMentions(value))).toEqual([
      { text: '看下 ', isMention: false },
      { text: '@[cloud.yml](/a/cloud.yml)', isMention: true },
      { text: ' 配置', isMention: false },
    ])
  })

  it('returns a single plain segment when there is no mention', () => {
    expect(splitMentionSegments('普通文本', [])).toEqual([{ text: '普通文本', isMention: false }])
  })

  it('handles an empty value', () => {
    expect(splitMentionSegments('', [])).toEqual([])
  })

  it('ignores out-of-range token ranges', () => {
    const value = '@[a](/a)'
    const bogus = [
      { kind: 'file' as const, label: 'a', id: '/a', start: 2, end: 3, tokenStart: 0, tokenEnd: 999 },
    ]
    expect(splitMentionSegments(value, bogus)).toEqual([{ text: value, isMention: false }])
  })
})
