import { useEffect, useRef, useState } from 'react'
import { Check, Copy, GitBranch, GitMerge, Pencil, RotateCcw } from 'lucide-react'
import { useT, type TFunction } from '@/i18n'

export type MessageActionRole = 'user' | 'assistant'

const roleLabelKey = (role: MessageActionRole): string => role === 'user'
  ? 'app.sessionView.role.user'
  : 'app.sessionView.role.assistant'

const roleLabel = (role: MessageActionRole, t: TFunction): string => t(roleLabelKey(role))

interface MessageActionsProps {
  /** 该消息所属的操作集合：用户消息只有复制/编辑，Agent 消息是复制/分支/总结后分支/重试。 */
  role: MessageActionRole
  /** 复制的内容；空内容不渲染复制按钮。 */
  text: string
  /** 会话忙（运行中或有结构操作）时禁用所有会改动会话的操作。 */
  busy: boolean
  branchable: boolean
  summarizable: boolean
  retryable: boolean
  /** 该用户消息之前存在安全分支边界时才可编辑。 */
  editable: boolean
  onBranch: () => void
  onSummarizedBranch: () => void
  onRetry: () => void
  onEdit: () => void
}

/**
 * 消息操作行（设计稿 xBpxw / sNxPn）：18×18 命中区、12px 图标、组内 2px 间距，
 * 用户消息右对齐、Agent 消息左对齐，hover 或键盘聚焦时才出现。
 * 复制成功/失败的反馈 2 秒后自动复位，避免 Check 图标误导为持久状态。
 */
export const MessageActions = ({
  role,
  text,
  busy,
  branchable,
  summarizable,
  retryable,
  editable,
  onBranch,
  onSummarizedBranch,
  onRetry,
  onEdit,
}: MessageActionsProps) => {
  const { t } = useT()
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const resetTimerRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
  }, [])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 2000)
  }

  const tRole = roleLabel(role, t)
  const copyLabel = copyState === 'copied'
    ? t('app.message.copied')
    : copyState === 'failed'
      ? t('app.message.copyFailed')
      : t('app.message.copyMessageAria')
  const canCopy = Boolean(text.trim())
  const editDisabled = busy || !editable
  // 编辑不可用时补一条可读原因：会话忙 vs 该消息之前没有安全分支边界。
  const editLabel = busy
    ? t('app.sessionView.editBusyAria', { role: tRole })
    : editable
      ? t('app.sessionView.editAria', { role: tRole })
      : t('app.sessionView.editUnavailableAria', { role: tRole })

  return (
    <div className={`session__message-actions session__message-actions--${role}`}>
      {canCopy && (
        <button
          aria-label={copyLabel}
          className={`message-action${copyState !== 'idle' ? ' message-action--feedback' : ''}`}
          onClick={() => { void copy() }}
          title={copyLabel}
          type="button"
        >
          {copyState === 'copied' ? <Check size={12} /> : <Copy size={12} />}
        </button>
      )}
      {role === 'user' && (
        <button
          aria-label={editLabel}
          className="message-action"
          disabled={editDisabled}
          onClick={onEdit}
          title={editLabel}
          type="button"
        >
          <Pencil size={12} />
        </button>
      )}
      {role === 'assistant' && branchable && (
        <button
          aria-label={t('app.sessionView.branchAria', { role: tRole })}
          className="message-action"
          disabled={busy}
          onClick={onBranch}
          title={t('app.sessionView.branch')}
          type="button"
        >
          <GitBranch size={12} />
        </button>
      )}
      {role === 'assistant' && summarizable && (
        <button
          aria-label={t('app.sessionView.summarizedBranchAria', { role: tRole })}
          className="message-action"
          disabled={busy}
          onClick={onSummarizedBranch}
          title={t('app.sessionView.summarizedBranch')}
          type="button"
        >
          <GitMerge size={12} />
        </button>
      )}
      {role === 'assistant' && retryable && (
        <button
          aria-label={t('app.sessionView.retryAria')}
          className="message-action"
          disabled={busy}
          onClick={onRetry}
          title={t('app.sessionView.retry')}
          type="button"
        >
          <RotateCcw size={12} />
        </button>
      )}
    </div>
  )
}
