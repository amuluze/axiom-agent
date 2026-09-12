import { useEffect, useMemo, useState } from 'react'
import { AtSign, FileText, FileUp, Folder, FolderUp, Hash, Sparkles } from 'lucide-react'
import type {
  ActiveMention,
  MentionCandidate,
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

export interface MentionPopoverProps {
  active: ActiveMention | null
  candidates: MentionCandidate[]
  onSelect: (candidate: MentionCandidate) => void
  onClose: () => void
  onAuthorizeFile?: () => void
  onAuthorizeDirectory?: () => void
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
}: MentionPopoverProps) => {
  const { t } = useT()
  const [highlightIndex, setHighlightIndex] = useState(0)
  const filtered = useMemo(
    () => (active ? filterCandidates(candidates, active.query) : []),
    [active, candidates],
  )
  useEffect(() => {
    setHighlightIndex(0)
  }, [active?.triggerStart, active?.query])

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
  return (
    <div
      aria-label={title}
      className="composer__mention-popover"
      role="listbox"
    >
      <div className="composer__mention-title">
        <Icon size={13} />
        <span>
          {title}
          {filtered.length > 0 && `（${filtered.length}）`}
        </span>
      </div>
      {showAuthorizeActions && (
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
      )}
      {filtered.length === 0 ? (
        <div className="composer__mention-empty">{t(PLACEHOLDER_KEY_BY_KIND[active.kind])}</div>
      ) : (
        filtered.map((candidate, index) => (
          <button
            aria-selected={index === highlightIndex}
            className={`composer__mention-item ${index === highlightIndex ? 'composer__mention-item--active' : ''}`}
            key={candidate.id}
            onClick={() => onSelect(candidate)}
            onMouseEnter={() => setHighlightIndex(index)}
            role="option"
            type="button"
          >
            {active.kind === 'file' && <CandidateIcon candidate={candidate} />}
            <span className="composer__mention-item-label">{candidate.label}</span>
            {candidate.hint && <span className="composer__mention-item-hint">{candidate.hint}</span>}
          </button>
        ))
      )}
    </div>
  )
}
