import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, AtSign, ChevronRight, FileText, FileUp, Folder, FolderUp, Hash, Sparkles } from 'lucide-react'
import type {
  ActiveMention,
  MentionCandidate,
  MentionGroup,
  MentionKind,
} from './mentionParser'
import { filterCandidates } from './mentionParser'
import { useT } from '@/i18n'

const ICON_BY_KIND: Record<MentionKind, typeof AtSign> = {
  file: AtSign,
  skill: Sparkles,
  thread: Hash,
}

const TITLE_KEY_BY_KIND: Record<MentionKind, string> = {
  file: 'app.mention.title.file',
  skill: 'app.mention.title.skill',
  thread: 'app.mention.title.thread',
}

const PLACEHOLDER_KEY_BY_KIND: Record<MentionKind, string> = {
  file: 'app.mention.empty.file',
  skill: 'app.mention.empty.skill',
  thread: 'app.mention.empty.thread',
}

/** 已有引用但检索未命中：与「尚未添加引用」空态区分。 */
const NO_MATCH_KEY_BY_KIND: Record<MentionKind, string> = {
  file: 'app.mention.empty.fileNoMatch',
  skill: 'app.mention.empty.skill',
  thread: 'app.mention.empty.thread',
}

const GROUP_KEY_BY_GROUP: Record<MentionGroup, string> = {
  referenced: 'app.mention.group.referenced',
  workspace: 'app.mention.group.workspace',
}

/** 分区顺序：已引用（显式用户意图）先于工作区检索结果。 */
export const GROUP_ORDER: readonly MentionGroup[] = ['referenced', 'workspace']

interface CandidateSection {
  group: MentionGroup | null
  items: Array<{ candidate: MentionCandidate; index: number }>
}

/** 按 group 稳定分桶：保留 filtered 的全局序号（键盘高亮按整体索引），
    桶间顺序固定 GROUP_ORDER，无 group 候选（skill/thread）垫底且不带标题。 */
export const sectionizeCandidates = (candidates: MentionCandidate[]): CandidateSection[] => {
  const buckets = new Map<MentionGroup | null, CandidateSection['items']>()
  candidates.forEach((candidate, index) => {
    const group = candidate.group ?? null
    const bucket = buckets.get(group)
    if (bucket) bucket.push({ candidate, index })
    else buckets.set(group, [{ candidate, index }])
  })
  const order: Array<MentionGroup | null> = [
    ...GROUP_ORDER.filter((group) => buckets.has(group)),
    ...(buckets.has(null) ? [null] : []),
  ]
  return order.map((group) => ({ group, items: buckets.get(group) ?? [] }))
}

export interface MentionPopoverProps {
  active: ActiveMention | null
  candidates: MentionCandidate[]
  onSelect: (candidate: MentionCandidate) => void
  onClose: () => void
  onAuthorizeFile?: () => void
  onAuthorizeDirectory?: () => void
  /** 当前浏览目录（工作区相对路径）；非空时展示面包屑与「返回上级」。 */
  browsePath?: string | null
  onEnterDirectory?: (candidate: MentionCandidate) => void
  onExitDirectory?: () => void
}

type MentionKeyAction =
  | { type: 'highlight'; index: number }
  | { type: 'select'; index: number }
  | { type: 'close' }

export const resolveMentionKeyAction = (
  key: string,
  candidateCount: number,
  highlightIndex: number,
): MentionKeyAction | null => {
  if (key === 'Escape') return { type: 'close' }
  if (candidateCount === 0) return null
  if (key === 'ArrowDown') return { type: 'highlight', index: (highlightIndex + 1) % candidateCount }
  if (key === 'ArrowUp') {
    return { type: 'highlight', index: (highlightIndex - 1 + candidateCount) % candidateCount }
  }
  if (key === 'Enter' || key === 'Tab') return { type: 'select', index: highlightIndex }
  return null
}

const CandidateIcon = ({ candidate }: { candidate: MentionCandidate }) => {
  if (candidate.isDirectory) {
    return <Folder size={13} className="composer__mention-item-icon" />
  }
  return <FileText size={13} className="composer__mention-item-icon" />
}

export const MentionPopover = ({
  active,
  candidates,
  onSelect,
  onClose,
  onAuthorizeFile,
  onAuthorizeDirectory,
  browsePath,
  onEnterDirectory,
  onExitDirectory,
}: MentionPopoverProps) => {
  const { t } = useT()
  const [highlightIndex, setHighlightIndex] = useState(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const filtered = useMemo(
    () => (active ? filterCandidates(candidates, active.query) : []),
    [active, candidates],
  )
  const sections = useMemo(() => sectionizeCandidates(filtered), [filtered])
  useEffect(() => {
    setHighlightIndex(0)
  }, [active?.triggerStart, active?.query])

  // 键盘导航越过可视区时把高亮项带回视野（jsdom 无 scrollIntoView，需守卫）。
  useEffect(() => {
    const target = scrollRef.current?.querySelector(`[data-mention-index="${highlightIndex}"]`)
    if (!(target instanceof HTMLElement)) return
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex, filtered.length])

  useEffect(() => {
    if (!active) return
    const handleKey = (event: globalThis.KeyboardEvent) => {
      const action = resolveMentionKeyAction(event.key, filtered.length, highlightIndex)
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      if (action.type === 'close') onClose()
      else if (action.type === 'highlight') setHighlightIndex(action.index)
      else {
        const target = filtered[action.index]
        if (target) onSelect(target)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [active, filtered, highlightIndex, onClose, onSelect])

  if (!active) return null
  const Icon = ICON_BY_KIND[active.kind]
  const title = t(TITLE_KEY_BY_KIND[active.kind])
  const showAuthorizeActions = active.kind === 'file' && (onAuthorizeFile || onAuthorizeDirectory)
  // 已有手动引用却检索无结果时提示「没有匹配」，而非「尚未添加引用」。
  const emptyKey = candidates.some((candidate) => candidate.group === 'referenced')
    ? NO_MATCH_KEY_BY_KIND[active.kind]
    : PLACEHOLDER_KEY_BY_KIND[active.kind]
  return (
    <div aria-label={title} className="composer__mention-popover">
      <div className="composer__mention-title">
        <Icon size={13} />
        <span>
          {title}
          {filtered.length > 0 && `（${filtered.length}）`}
        </span>
      </div>
      {browsePath && (
        <div className="composer__mention-crumbs">
          <button
            className="composer__mention-crumb-up"
            onClick={onExitDirectory}
            type="button"
          >
            <ArrowLeft size={12} />
            <span>{t('app.mention.browse.up')}</span>
          </button>
          <span className="composer__mention-crumb-path">{browsePath}</span>
        </div>
      )}
      <div className="composer__mention-scroll" ref={scrollRef} role="listbox">
      {filtered.length === 0 ? (
        <div className="composer__mention-empty">{t(emptyKey)}</div>
      ) : (
        sections.map((section) => (
          <div
            aria-label={section.group ? t(GROUP_KEY_BY_GROUP[section.group]) : undefined}
            className="composer__mention-section"
            key={section.group ?? 'plain'}
            role="group"
          >
            {section.group && (
              <div className="composer__mention-group">{t(GROUP_KEY_BY_GROUP[section.group])}</div>
            )}
            {section.items.map(({ candidate, index }) => (
              <button
                aria-selected={index === highlightIndex}
                className={`composer__mention-item ${index === highlightIndex ? 'composer__mention-item--active' : ''}`}
                data-mention-index={index}
                key={candidate.id}
                onClick={() => onSelect(candidate)}
                onMouseEnter={() => setHighlightIndex(index)}
                role="option"
                type="button"
              >
                {active.kind === 'file' && <CandidateIcon candidate={candidate} />}
                <span className="composer__mention-item-label">{candidate.label}</span>
                {candidate.hint && <span className="composer__mention-item-hint">{candidate.hint}</span>}
                {onEnterDirectory && candidate.isDirectory && (
                  <span
                    aria-label={t('app.mention.browse.enter')}
                    className="composer__mention-item-enter"
                    onClick={(event) => {
                      event.stopPropagation()
                      onEnterDirectory(candidate)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      event.stopPropagation()
                      onEnterDirectory(candidate)
                    }}
                    role="button"
                    tabIndex={-1}
                    title={t('app.mention.browse.enter')}
                  >
                    <ChevronRight size={13} />
                  </span>
                )}
              </button>
            ))}
          </div>
        ))
      )}
      </div>
      {showAuthorizeActions && (
        // 授权动作行固定在滚动区之外：候选再多也不会把「选择文件/目录」挤出视野。
        <div className="composer__mention-footer">
          <div className="composer__mention-divider" />
          <div className="composer__mention-actions">
            {onAuthorizeFile && (
              <button
                className="composer__mention-action"
                onClick={onAuthorizeFile}
                type="button"
              >
                <FileUp size={13} />
                <span>{t('app.mention.chooseFile')}</span>
              </button>
            )}
            {onAuthorizeDirectory && (
              <button
                className="composer__mention-action"
                onClick={onAuthorizeDirectory}
                type="button"
              >
                <FolderUp size={13} />
                <span>{t('app.mention.chooseDir')}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
