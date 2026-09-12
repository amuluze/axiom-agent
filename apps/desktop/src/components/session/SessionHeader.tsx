import { useMemo } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { lastUserMessage } from './messagePairs'
import { WindowActions } from './WindowActions'
import { useT, type TFunction } from '@/i18n'

const statusTag = (
  state:
    | { running: boolean; sessionBusy: boolean; endReason: ReturnType<typeof useAgentStore.getState>['endReason']; hasError: boolean },
  t: TFunction,
): { tone: 'running' | 'completed' | 'error' | 'paused' | 'idle'; label: string } => {
  if (state.running) return { tone: 'running', label: t('app.sessionHeader.status.running') }
  if (state.hasError) return { tone: 'error', label: t('app.sessionHeader.status.failed') }
  if (state.endReason === 'completed') return { tone: 'completed', label: t('app.sessionHeader.status.completed') }
  if (state.endReason === 'stopped' || state.endReason === 'aborted') return { tone: 'paused', label: t('app.sessionHeader.status.paused') }
  if (state.sessionBusy) return { tone: 'running', label: t('app.sessionHeader.status.preparing') }
  return { tone: 'idle', label: t('app.sessionHeader.status.idle') }
}

export const SessionHeader = () => {
  const { t } = useT()
  const messages = useAgentStore((state) => state.messages)
  const running = useAgentStore((state) => state.running)
  const sessionBusy = useAgentStore((state) => state.sessionBusy)
  const endReason = useAgentStore((state) => state.endReason)
  const hasError = useAgentStore((state) => state.error !== null)
  const title = useMemo(() => {
    const last = lastUserMessage(messages)
    if (last && last.role === 'user') {
      return last.content.length > 0 ? last.content.slice(0, 80) : t('app.sessionHeader.unnamed')
    }
    return 'Axiom'
  }, [messages, t])
  const status = statusTag({ running, sessionBusy, endReason, hasError }, t)
  return (
    <header className="session__header" data-tauri-drag-region>
      <span className={`session__status-dot session__status-dot--${status.tone}`} />
      <span className="session__title">{title}</span>
      <span className={`session__status-tag session__status-tag--${status.tone}`}>{status.label}</span>
      <span className="session__header-spacer" />
      {/* 窗口操作图标常驻右上角：面板展开时按钮原地切换为收起态 */}
      <WindowActions />
    </header>
  )
}
