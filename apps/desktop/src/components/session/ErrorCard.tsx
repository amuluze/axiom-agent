import { AlertTriangle } from 'lucide-react'
import type { AssistantMessage } from '@/agent/core/types'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import { useT } from '@/i18n'

interface ErrorCardProps {
  messageId: string
  error: string
  /** 关联的 assistant 消息，用于展示 provider 友好文案（userMessage）。 */
  message?: AssistantMessage
}

export const ErrorCard = ({ messageId, error, message }: ErrorCardProps) => {
  const { t } = useT()
  const retryFailedAssistant = useAgentStore((state) => state.retryFailedAssistant)
  const setRuntimeRailOpen = useUiStore((state) => state.setRuntimeRailOpen)
  const headline = message?.providerError?.userMessage ?? error
  const detail = headline === error ? undefined : error
  return (
    <section className="session__error-card" role="alert">
      <header className="session__error-card-head">
        <AlertTriangle size={15} aria-hidden />
        <span>{t('app.session.error.title')}</span>
      </header>
      <div className="session__error-card-body">
        <p className="session__error-card-message">{headline}</p>
        {detail ? <p className="session__error-card-detail">{detail}</p> : null}
      </div>
      <div className="session__error-card-actions">
        <button
          type="button"
          className="session__error-card-button"
          onClick={() => setRuntimeRailOpen(true)}
        >
          {t('app.session.error.viewLogs')}
        </button>
        <button
          type="button"
          className="session__error-card-button"
          onClick={() => { void retryFailedAssistant(messageId) }}
        >
          {t('app.session.error.retry')}
        </button>
      </div>
    </section>
  )
}
