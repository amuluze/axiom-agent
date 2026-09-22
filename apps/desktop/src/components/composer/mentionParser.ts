export type MentionKind = 'file' | 'skill' | 'thread'

/** 候选来源分区：弹层内按「手动引用 / 工作区检索」分组展示。 */
export type MentionGroup = 'referenced' | 'workspace'

export interface MentionCandidate {
  /** Stable identifier used in submit payload (path for file/thread, skill name for skill). */
  id: string
  /** Human-friendly label shown in the popover. */
  label: string
  /** Optional secondary caption, e.g. parent path. */
  hint?: string
  /** Whether this candidate represents a directory (file kind only). */
  isDirectory?: boolean
  /** 分组归属；缺省表示平面列表（skill / thread 候选）。 */
  group?: MentionGroup
  /** 工作区内的相对路径（目录候选用于下钻），仅 file 类候选携带。 */
  relativePath?: string
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

/** 候选过滤：不设默认条数上限——弹层自己滚动，检索侧由 Rust limit 兜底。 */
export const filterCandidates = (
  candidates: MentionCandidate[],
  query: string,
  limit?: number,
): MentionCandidate[] => {
  const normalized = query.trim().toLocaleLowerCase()
  if (normalized.length === 0) {
    return limit === undefined ? candidates : candidates.slice(0, limit)
  }
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
  const merged = [...prefixMatches, ...substringMatches]
  return limit === undefined ? merged : merged.slice(0, limit)
}

/**
 * 提及 id 的最小转义：只编码会破坏 token 语法的字符（空白、括号）与百分号本身，
 * 路径分隔符等可读字符原样保留——输入框与提示词里看到的是真实路径而非 %2F 串。
 * 解码侧 decodeURIComponent 对这些转义是恒等还原。
 */
const encodeMentionId = (value: string): string => value
  .replaceAll('%', '%25')
  .replace(/\s/gu, (char) => encodeURIComponent(char))
  .replaceAll('(', '%28')
  .replaceAll(')', '%29')

const FOLDABLE_LABEL = /^[^\s@#]+$/u

/**
 * 生成提及 token。默认用折叠形态 `@ci/cloud.yml`（输入框里可读、可手改）；
 * 标签含空白或触发器字符时退回结构化形态 `@[label](id)`，
 * 否则 token 会在空白/触发器处被截断。
 * 末尾固定两个空格：胶囊两侧各外扩 3px（见 composer.css 的 .composer__mention-token），
 * 单个空格（约 4px）容不下，相邻引用会粘成一颗——双空格保证它们独立展示。
 */
export const formatMentionToken = (kind: MentionKind, candidate: MentionCandidate): string => {
  if (kind === 'skill') return `${TRIGGERS.skill}${candidate.id}  `
  // 目录标签以 / 结尾：折叠 token 不携带元数据，目录/文件的区分只能编码进文本
  // （chip 图标与类型、编辑回填后的重新解析都靠这个约定）。
  const label = candidate.isDirectory && !candidate.label.endsWith('/')
    ? `${candidate.label}/`
    : candidate.label
  if (FOLDABLE_LABEL.test(label)) return `${TRIGGERS[kind]}${label}  `
  const escaped = label.replace(/\\/gu, '\\\\').replace(/\]/gu, '\\]')
  return `${TRIGGERS[kind]}[${escaped}](${encodeMentionId(candidate.id)})  `
}

export interface ParsedMention {
  kind: MentionKind
  label: string
  id?: string
  start: number
  end: number
  /** token 起始偏移（含触发符 `@`/`#`），供 chip 删除整段引用。 */
  tokenStart: number
  /** token 结束偏移（结构化形式的 `](id)` 之后），不含尾随空格。 */
  tokenEnd: number
}

// 折叠 token 的标签是工作区相对路径（含 `/`），字符类必须允许它；
// 触发器判定仍由 isTriggerBoundary 把关（`/` 前无空白时不视为 skill 触发）。
const MENTION_REGEX = /([@/#])([^\s@#]+)/gu
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
      tokenStart: matchStart,
      tokenEnd: matchStart + match[0].length,
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
      tokenStart: matchStart,
      tokenEnd: start + label.length,
    })
  }
  return mentions.sort((left, right) => left.start - right.start)
}
