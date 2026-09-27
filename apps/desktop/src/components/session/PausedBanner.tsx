import { useAgentStore } from '@/stores/agentStore'
import { useT } from '@/i18n'
import { useDesignPreview } from '@/components/design/ax/previewContext'

export const PausedBanner = () => {
  const { t } = useT()
  // 预览 seam：画布内为 no-op（评审不得触发真实续跑），画布外行为不变。
  const storeContinueConversation = useAgentStore((state) => state.continueConversation)
  const continueConversation = useDesignPreview()?.continueConversation ?? storeContinueConversation
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
