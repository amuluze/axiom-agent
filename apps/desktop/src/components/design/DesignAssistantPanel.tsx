/**
 * 设计助手侧栏（docs/design-canvas.md §11 第六轮；对齐 .pen 设计稿 XjPQ 的
 * 侧栏覆写：设计页隐藏 Nav/工作区/任务列表/底栏，Spacer 位置换成「绘画窗口」；
 * 侧栏 Composer 隐藏审批模式下拉）。
 *
 * 组成（自上而下）：返回/新建设计会话行 → 空态引导（无消息时）或消息流 → Composer。
 * 会话就是普通 Axiom 会话（§4.2）：设计页的对话与画布是同一份会话状态的两个投影，
 * 消息流复用 `SessionMessageStream`（与 SessionView 同一实现）。
 */
import { useState } from 'react'
import { Bot, Check, ChevronLeft, Eraser } from 'lucide-react'
import { Composer } from '@/components/composer/Composer'
import { SessionMessageStream } from '@/components/session/SessionMessageStream'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import { useT } from '@/i18n'

const DesignAssistantPanel = () => {
  const { t } = useT()
  const activeSessionId = useAgentStore((state) => state.activeSessionId)
  const messages = useAgentStore((state) => state.messages)
  const setView = useUiStore((state) => state.setView)
  const [creating, setCreating] = useState(false)

  const hasConversation = Boolean(activeSessionId) && messages.length > 0

  // 返回：有会话回会话页，否则回新任务页（与「设计」入口对称的出口）。
  const goBack = (): void => {
    setView(activeSessionId ? 'session' : 'new-task')
  }

  // 新建设计会话（mockup 的橡皮擦）：开一份干净对话，不再续当前上下文。
  const startSession = async (): Promise<void> => {
    setCreating(true)
    try {
      await useAgentStore.getState().createNewSession()
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="design-assistant">
      <div className="design-assistant__bar">
        <button type="button" className="design-assistant__back" onClick={goBack}>
          <ChevronLeft size={14} aria-hidden />
          <span>{t('app.design.assistant.back')}</span>
        </button>
        <span className="design-assistant__spacer" />
        <button
          type="button"
          className="design-assistant__icon-button"
          aria-label={t('app.design.assistant.newSession')}
          title={t('app.design.assistant.newSession')}
          disabled={creating}
          onClick={() => void startSession()}
        >
          <Eraser size={15} aria-hidden />
        </button>
      </div>
      {hasConversation ? (
        <div className="design-assistant__stream">
          <SessionMessageStream />
        </div>
      ) : (
        <div className="design-assistant__intro">
          <span className="design-assistant__logo" aria-hidden>
            <Bot size={17} />
          </span>
          <h2 className="design-assistant__title">{t('app.design.assistant.title')}</h2>
          <p className="design-assistant__subtitle">{t('app.design.assistant.subtitle')}</p>
          <ul className="design-assistant__checklist">
            <li>
              <Check size={14} aria-hidden />
              <span>{t('app.design.assistant.hint1')}</span>
            </li>
            <li>
              <Check size={14} aria-hidden />
              <span>{t('app.design.assistant.hint2')}</span>
            </li>
            <li>
              <Check size={14} aria-hidden />
              <span>{t('app.design.assistant.hint3')}</span>
            </li>
          </ul>
        </div>
      )}
      <div className="design-assistant__composer">
        {activeSessionId ? (
          // 窄栏 Composer 隐藏审批模式下拉（设计稿 XjPQ 的 Controls Row 只留模型/预算/发送）。
          <Composer variant="session" showAccessPicker={false} />
        ) : (
          <button
            type="button"
            className="design-assistant__start"
            disabled={creating}
            onClick={() => void startSession()}
          >
            {creating ? t('app.design.assistant.creating') : t('app.design.assistant.start')}
          </button>
        )}
      </div>
    </div>
  )
}

export default DesignAssistantPanel
