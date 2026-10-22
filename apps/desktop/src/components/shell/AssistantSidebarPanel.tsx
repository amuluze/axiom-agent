/**
 * 通用「助手会话列」面板：设计（DesignAssistantPanel）/ 文档 / 测试三视图共用的
 * 侧栏形态（.pen 设计稿 Shared10 / DocsAssistant / Shared12 同构克隆）。
 * 组成（自上而下）：返回/新会话行 → 空态引导（无消息时）或消息流 → Composer。
 *
 * 会话就是普通 Axiom 会话：本列与右侧主区是同一份会话状态的两个投影，消息流
 * 复用 `SessionMessageStream`（与 SessionView 同一实现）。文案经 `copy` 注入，
 * 各视图只差口径（设计稿/文档/测试用例），行为完全一致。
 */
import { useState } from 'react'
import { Bot, Check, ChevronLeft, Eraser } from 'lucide-react'
import { Composer } from '@/components/composer/Composer'
import { SessionMessageStream } from '@/components/session/SessionMessageStream'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import type { TFunction } from '@/i18n'

export interface AssistantPanelCopy {
  back: string
  title: string
  subtitle: string
  hint1: string
  hint2: string
  hint3: string
  newSession: string
  start: string
  creating: string
}

export interface AssistantSidebarPanelProps {
  /** 由各视图用 t() 解析好的文案（面板自身不再关心 key 前缀）。 */
  copy: AssistantPanelCopy
  /** 返回目标：无会话时的回退视图（如 'new-task'）。 */
  fallbackView?: 'new-task'
}

export const AssistantSidebarPanel = ({ copy, fallbackView = 'new-task' }: AssistantSidebarPanelProps) => {
  const activeSessionId = useAgentStore((state) => state.activeSessionId)
  const messages = useAgentStore((state) => state.messages)
  const setView = useUiStore((state) => state.setView)
  const [creating, setCreating] = useState(false)

  const hasConversation = Boolean(activeSessionId) && messages.length > 0

  // 返回：有会话回会话页，否则回新任务页（与侧栏入口对称的出口）。
  const goBack = (): void => {
    setView(activeSessionId ? 'session' : fallbackView)
  }

  // 新建会话（橡皮擦图标）：开一份干净对话，不再续当前上下文。
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
          <span>{copy.back}</span>
        </button>
        <span className="design-assistant__spacer" />
        <button
          type="button"
          className="design-assistant__icon-button"
          aria-label={copy.newSession}
          title={copy.newSession}
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
          <h2 className="design-assistant__title">{copy.title}</h2>
          <p className="design-assistant__subtitle">{copy.subtitle}</p>
          <ul className="design-assistant__checklist">
            <li>
              <Check size={14} aria-hidden />
              <span>{copy.hint1}</span>
            </li>
            <li>
              <Check size={14} aria-hidden />
              <span>{copy.hint2}</span>
            </li>
            <li>
              <Check size={14} aria-hidden />
              <span>{copy.hint3}</span>
            </li>
          </ul>
        </div>
      )}
      <div className="design-assistant__composer">
        {activeSessionId ? (
          <Composer variant="session" />
        ) : (
          <button
            type="button"
            className="design-assistant__start"
            disabled={creating}
            onClick={() => void startSession()}
          >
            {creating ? copy.creating : copy.start}
          </button>
        )}
      </div>
    </div>
  )
}

/** 从 i18n key 前缀解析整套文案（三视图的 key 排布与设计助手完全同构）。 */
export const assistantCopyFrom = (
  t: TFunction,
  prefix: 'app.design.assistant' | 'app.docs.assistant' | 'app.testing.assistant',
): AssistantPanelCopy => ({
  back: t(`${prefix}.back`),
  title: t(`${prefix}.title`),
  subtitle: t(`${prefix}.subtitle`),
  hint1: t(`${prefix}.hint1`),
  hint2: t(`${prefix}.hint2`),
  hint3: t(`${prefix}.hint3`),
  newSession: t(`${prefix}.newSession`),
  start: t(`${prefix}.start`),
  creating: t(`${prefix}.creating`),
})
