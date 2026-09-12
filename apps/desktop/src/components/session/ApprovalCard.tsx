import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { useAgentStore } from '@/stores/agentStore'
import { useT } from '@/i18n'

export const ApprovalCard = () => {
  const { t } = useT()
  const pendingApproval = useAgentStore((state) => state.pendingApproval)
  // 高危命令（danger 标记）要求用户显式勾选确认后才放行；切换到下一个审批时重置。
  const [dangerAcknowledged, setDangerAcknowledged] = useState(false)
  useEffect(() => {
    setDangerAcknowledged(false)
  }, [pendingApproval?.toolCallId])
  const approveToolCall = useAgentStore((state) => state.approveToolCall)
  const denyToolCall = useAgentStore((state) => state.denyToolCall)
  if (!pendingApproval) return null
  const presentation = pendingApproval.presentation
  const isCommand = presentation.category === 'workspace-command'
  return (
    <aside
      aria-describedby="approval-card-description"
      aria-labelledby="approval-card-title"
      className="approval-card"
      role="alert"
    >
      <header className="approval-card__header">
        <ShieldAlert size={15} className="approval-card__icon" aria-hidden />
        <span className="approval-card__eyebrow">
          {t('app.approval.need', { target: isCommand ? t('app.approval.target.command') : t('app.approval.target.workspace') })} · {pendingApproval.toolName}
        </span>
        <span className="approval-card__tag">{pendingApproval.toolName}</span>
      </header>
      <h2 className="approval-card__title" id="approval-card-title">{presentation.title}</h2>
      <p className="approval-card__description" id="approval-card-description">{presentation.description}</p>
      {presentation.path && (
        <div className="approval-card__path">
          <span>{isCommand ? t('app.approval.workingDir') : t('app.approval.targetPath')}</span>
          <code>{presentation.path}</code>
        </div>
      )}
      {presentation.preview && (
        <pre aria-label={isCommand ? t('app.approval.commandAria') : t('app.approval.changeAria')} className="approval-card__command">
          {presentation.preview}
        </pre>
      )}
      {presentation.changes && presentation.changes.length > 0 && (
        <div aria-label={t('app.approval.filesAria')} className="approval-card__changes">
          {presentation.changes.map((change, index) => (
            <details key={`${change.path}-${index}`} open>
              <summary>{change.path}</summary>
              <pre className="approval-card__command">{change.preview}</pre>
            </details>
          ))}
        </div>
      )}
      <p className="approval-card__scope-note">
        {isCommand ? t('app.approval.scopeNote.command') : t('app.approval.scopeNote.tool')}
      </p>
      {presentation.danger && (
        <div className="approval-card__danger">
          <label className="approval-card__danger-confirm">
            <input
              checked={dangerAcknowledged}
              onChange={(event) => setDangerAcknowledged(event.target.checked)}
              type="checkbox"
            />
            <span>
              {t('app.approval.dangerConfirm')}
            </span>
          </label>
        </div>
      )}
      <div className="approval-card__actions">
        <button
          className="approval-card__button"
          onClick={() => void denyToolCall(pendingApproval.toolCallId)}
          type="button"
        >
          {t('app.approval.deny')}
        </button>
        <button
          className="approval-card__button approval-card__button--primary"
          disabled={presentation.danger === true && !dangerAcknowledged}
          onClick={() => void approveToolCall(pendingApproval.toolCallId)}
          type="button"
        >
          {t('app.approval.allow')}
        </button>
      </div>
    </aside>
  )
}
