export type MentionKind = 'file' | 'skill' | 'thread'

export interface MentionCandidate {
  /** Stable identifier used in submit payload (path for file/thread, skill name for skill). */
  id: string
  /** Human-friendly label shown in the popover. */
  label: string
  /** Optional secondary caption, e.g. parent path. */
  hint?: string
  /** Whether this candidate represents a directory (file kind only). */
  isDirectory?: boolean
}

export interface ActiveMention {
  kind: MentionKind
  /** Offset of the trigger character inside the textarea value. */
  triggerStart: number
  /** Offset right after the last typed character of the query (i.e. caret). */
  queryEnd: number
  /** Lower-cased query captured between the trigger and the caret. */
  query: string
}

const TRIGGERS: Record<MentionKind, string> = {
  file: '@',
  skill: '/',
  thread: '#',
}

const TRIGGER_SET = new Set<string>(Object.values(TRIGGERS))

const isTriggerBoundary = (text: string, index: number): boolean => {
  if (index === 0) return true
  const previous = text[index - 1]
  if (!previous) return false
  return /\s/u.test(previous)
}

export const detectActiveMention = (
  value: string,
  caret: number,
): ActiveMention | null => {
  const end = Math.min(caret, value.length)
  for (let index = end - 1; index >= 0; index -= 1) {
    const char = value[index] ?? ''
    if (char === '\n' || /\s/u.test(char)) return null
    if (TRIGGER_SET.has(char)) {
      if (!isTriggerBoundary(value, index)) return null
      const kind = (Object.entries(TRIGGERS) as Array<[MentionKind, string]>)
        .find(([, trigger]) => trigger === char)?.[0]
      if (!kind) return null
      return {
        kind,
        triggerStart: index,
        queryEnd: end,
        query: value.slice(index + 1, end),
      }
    }
  }
  return null
}

export const filterCandidates = (
  candidates: MentionCandidate[],
  query: string,
  limit: number = 8,
): MentionCandidate[] => {
  const normalized = query.trim().toLocaleLowerCase()
  if (normalized.length === 0) return candidates.slice(0, limit)
  const prefixMatches: MentionCandidate[] = []
  const substringMatches: MentionCandidate[] = []
  for (const candidate of candidates) {
    const label = candidate.label.toLocaleLowerCase()
    const hint = candidate.hint?.toLocaleLowerCase() ?? ''
    if (label.startsWith(normalized) || hint.startsWith(normalized)) {
      prefixMatches.push(candidate)
    } else if (label.includes(normalized) || hint.includes(normalized)) {
      substringMatches.push(candidate)
    }
  }
  return [...prefixMatches, ...substringMatches].slice(0, limit)
}

export const formatMentionToken = (kind: MentionKind, candidate: MentionCandidate): string => {
  if (kind === 'file' || kind === 'thread') {
    const label = candidate.label.replace(/\\/gu, '\\\\').replace(/\]/gu, '\\]')
    return `${TRIGGERS[kind]}[${label}](${encodeURIComponent(candidate.id)}) `
  }
  return `${TRIGGERS[kind]}${candidate.id} `
}

export interface ParsedMention {
  kind: MentionKind
  label: string
  id?: string
  start: number
  end: number
}

const MENTION_REGEX = /([@/#])([^\s@/#]+)/gu
const STRUCTURED_MENTION_REGEX = /([@#])\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/gu

const decodeMentionId = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const unescapeMentionLabel = (value: string): string => value.replace(/\\([\\\]])/gu, '$1')

export const parseMentions = (value: string): ParsedMention[] => {
  const mentions: ParsedMention[] = []
  const structuredRanges: Array<{ start: number; end: number }> = []
  for (const match of value.matchAll(STRUCTURED_MENTION_REGEX)) {
    const trigger = match[1]
    const rawLabel = match[2]
    const rawId = match[3]
    if (!trigger || rawLabel === undefined || !rawId) continue
    const matchStart = match.index ?? 0
    if (!isTriggerBoundary(value, matchStart)) continue
    const label = unescapeMentionLabel(rawLabel)
    const kind: MentionKind = trigger === '@' ? 'file' : 'thread'
    mentions.push({
      kind,
      label,
      id: decodeMentionId(rawId),
      start: matchStart + 2,
      end: matchStart + 2 + rawLabel.length,
    })
    structuredRanges.push({ start: matchStart, end: matchStart + match[0].length })
  }
  for (const match of value.matchAll(MENTION_REGEX)) {
    const matchStart = match.index ?? 0
    if (structuredRanges.some((range) => matchStart >= range.start && matchStart < range.end)) continue
    const trigger = match[1]
    const label = match[2]
    if (!trigger || !label) continue
    if (!isTriggerBoundary(value, matchStart)) continue
    const kind = (Object.entries(TRIGGERS) as Array<[MentionKind, string]>)
      .find(([, symbol]) => symbol === trigger)?.[0]
    if (!kind) continue
    const start = matchStart + 1
    mentions.push({
      kind,
      label,
      start,
      end: start + label.length,
    })
  }
  return mentions.sort((left, right) => left.start - right.start)
}
