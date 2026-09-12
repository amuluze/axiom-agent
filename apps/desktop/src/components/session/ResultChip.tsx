import { CircleCheck } from 'lucide-react'
import type { AgentMessage } from '@/agent/core/types'
import { useT } from '@/i18n'

interface ResultChipProps {
  message: AgentMessage
}

export const ResultChip = ({ message }: ResultChipProps) => {
  const { t } = useT()
  return (
    <div className="session__result-chip" role="status">
      <CircleCheck size={15} className="session__result-chip-icon" aria-hidden />
      <span>{message.content || t('app.session.result.done')}</span>
      <span className="session__result-chip-spacer" />
      <span className="session__result-chip-meta">
        {new Date(message.createdAt).toLocaleTimeString()}
      </span>
    </div>
  )
}
