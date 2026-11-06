/**
 * 会话视图：会话头部 + 消息流（SessionMessageStream）+ Composer。
 *
 * 消息流自本轮起抽出为独立组件，与设计助手侧栏（窄栏对话）共用同一实现，
 * 避免两处各写一份历史块/流式/审批渲染（docs/design-canvas.md §11 第六轮）。
 */
import { Composer } from '@/components/composer/Composer'
import { SessionHeader } from '@/components/session/SessionHeader'
import { SessionMessageStream, shouldStickToOutput } from '@/components/session/SessionMessageStream'
import { useT } from '@/i18n'

// 兼容既有导入路径（测试与潜在消费者从 SessionView 取该纯函数）。
export { shouldStickToOutput }

export const SessionView = () => {
  const { t } = useT()

  return (
    <section
      className="session"
      aria-label={t('app.sessionView.sessionAria')}
    >
      <div className="session__content">
        <SessionHeader />
        <div className="session__divider" />
        <SessionMessageStream />
        <div className="session__composer-wrap">
          <Composer variant="session" />
        </div>
      </div>
    </section>
  )
}
