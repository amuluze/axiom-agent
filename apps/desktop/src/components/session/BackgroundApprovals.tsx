import { ShieldAlert } from 'lucide-react'
import { useAgentStore } from '@/stores/agentStore'
import { useT } from '@/i18n'
import { displaySessionTitle } from '@/i18n/sessionTitle'
import { useDesignPreview } from '@/components/design/ax/previewContext'

/**
 * 后台会话审批收件箱：多会话（可跨工作目录）并行运行时，非激活会话的写操作
 * 审批在此列出，不必切换会话即可放行/拒绝（respond 按 toolCallId 全局定位）。
 * 此前后台审批只在侧栏显示「待审批」标记，用户必须切到该会话才能处理，后台
 * run 实际被静默阻塞到超时自动拒绝。高危（danger）审批仍要求切换到对应会话
 * 勾选确认——收件箱保持轻量，不承载高危确认交互。
 */
export const BackgroundApprovals = () => {
  const { t } = useT()
  // 预览 seam（与 ApprovalCard 同款）：store hooks 无条件调用，只在取值上分支——
  // 设计画布内用 fixture 数据 + no-op 动作，画布外逐字节不变。
  const storeBackgroundApprovals = useAgentStore((state) => state.backgroundApprovals)
  const storeSessions = useAgentStore((state) => state.sessions)
  const storeApproveToolCall = useAgentStore((state) => state.approveToolCall)
  const storeDenyToolCall = useAgentStore((state) => state.denyToolCall)
  const preview = useDesignPreview()
  const backgroundApprovals = preview ? preview.backgroundApprovals ?? [] : storeBackgroundApprovals
  const sessions = preview ? preview.sessions ?? [] : storeSessions
  const approveToolCall = preview?.approveToolCall ?? storeApproveToolCall
  const denyToolCall = preview?.denyToolCall ?? storeDenyToolCall
  if (backgroundApprovals.length === 0) return null
  return (
    <section aria-label={t('app.backgroundApprovals.aria')} className="approval-inbox">
      <header className="approval-inbox__header">
        <ShieldAlert size={13} className="approval-inbox__icon" aria-hidden />
        <span className="approval-inbox__eyebrow">
          {t('app.backgroundApprovals.eyebrow')}
        </span>
      </header>
      {backgroundApprovals.map((approval) => {
        const session = sessions.find((stored) => stored.id === approval.sessionId)
        const sessionTitle = session ? displaySessionTitle(t, session.title) : t('app.backgroundApprovals.unnamed')
        const danger = approval.presentation.danger === true
        return (
          <div className="approval-inbox__row" key={approval.toolCallId}>
            <div className="approval-inbox__meta">
              <span className="approval-inbox__session">{sessionTitle}</span>
              <span className="approval-inbox__tool">{approval.toolName}</span>
            </div>
            <p className="approval-inbox__title">{approval.presentation.title}</p>
            <div className="approval-inbox__actions">
              <button
                className="approval-inbox__button"
                onClick={() => { void denyToolCall(approval.toolCallId) }}
                type="button"
              >
                {t('app.backgroundApprovals.deny')}
              </button>
              <button
                className="approval-inbox__button approval-inbox__button--primary"
                disabled={danger}
                onClick={() => { void approveToolCall(approval.toolCallId) }}
                title={danger ? t('app.backgroundApprovals.dangerTitle') : undefined}
                type="button"
              >
                {danger ? t('app.backgroundApprovals.needsConfirm') : t('app.backgroundApprovals.allow')}
              </button>
            </div>
          </div>
        )
      })}
    </section>
  )
}
