import type { ParsedMention } from './mentionParser'

export interface HighlightSegment {
  text: string
  isMention: boolean
}

/** 把输入文本按提及 token 的完整范围切片，供 textarea 下方的高亮层渲染
 * （textarea 不支持富文本，只能叠一层只画背景、不画文字的高亮层）。
 * 越界或重叠的范围一律忽略，保证切片完整覆盖原文。 */
export const splitMentionSegments = (
  value: string,
  mentions: readonly ParsedMention[],
): HighlightSegment[] => {
  if (value.length === 0) return []
  const ranges = mentions
    .map((mention) => ({ start: mention.tokenStart, end: mention.tokenEnd }))
    .filter((range) => range.start >= 0 && range.start < range.end && range.end <= value.length)
    .sort((left, right) => left.start - right.start)
  const segments: HighlightSegment[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start < cursor) continue
    if (range.start > cursor) {
      segments.push({ text: value.slice(cursor, range.start), isMention: false })
    }
    segments.push({ text: value.slice(range.start, range.end), isMention: true })
    cursor = range.end
  }
  if (cursor < value.length) {
    segments.push({ text: value.slice(cursor), isMention: false })
  }
  return segments
}
