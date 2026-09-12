import { useAgentStore } from '@/stores/agentStore'
import { useT } from '@/i18n'

export const PausedBanner = () => {
  const { t } = useT()
  const continueConversation = useAgentStore((state) => state.continueConversation)
  return (
    <section className="session__paused-banner" role="status">
      <span className="session__paused-banner-title">{t('app.session.paused.title')}</span>
      <button
        type="button"
        className="session__paused-banner-button"
        onClick={() => { void continueConversation() }}
      >
        {t('app.session.paused.resume')}
      </button>
    </section>
  )
}
