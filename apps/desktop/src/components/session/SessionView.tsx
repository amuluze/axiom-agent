import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Composer } from '@/components/composer/Composer'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import { RichMessageContent } from '@/components/MessageContent'
import { ArtifactPreview } from '@/components/ArtifactPreview'
import { ToolCallCard } from '@/components/session/ToolCallCard'
import { ResultChip } from '@/components/session/ResultChip'
import { ErrorCard } from '@/components/session/ErrorCard'
import { PausedBanner } from '@/components/session/PausedBanner'
import { MessageActions, type MessageActionRole } from '@/components/session/MessageActions'
import { SessionHeader } from '@/components/session/SessionHeader'
import { ApprovalCard } from '@/components/session/ApprovalCard'
import { BackgroundApprovals } from '@/components/session/BackgroundApprovals'
import { useStickyScroll } from '@/components/session/useStickyScroll'
import { buildSessionBlocks, type SessionBlock } from '@/components/session/messagePairs'
import { getBranchMessageActions, type BranchMessageAction } from '@/agent/session/branch'
import type { AssistantMessage } from '@/agent/core/types'
import { useT } from '@/i18n'

interface OutputScrollMetrics {
  clientHeight: number
  scrollHeight: number
  scrollTop: number
}

export const shouldStickToOutput = (
  metrics: OutputScrollMetrics,
  threshold = 96,
): boolean => metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold

/**
 * 消息操作行的角色维度：设计稿只定义用户消息（xBpxw）与 Agent 消息（sNxPn）
 * 两种操作集，工具调用卡与结果块不带操作行。
 */
const blockActionRole = (block: SessionBlock): MessageActionRole | null => {
  if (block.type === 'user') return 'user'
  if (block.type === 'assistant-text') return 'assistant'
  return null
}

/** 带操作行的块所对应的消息 id；工具调用卡与结果块返回 null。 */
const blockMessageId = (block: SessionBlock): string | null => {
  if (block.type === 'user' || block.type === 'assistant-text') return block.message.id
  return null
}

interface HistoryBlockProps {
  block: SessionBlock
  action: BranchMessageAction | undefined
  busy: boolean
  lastMessageId: string | undefined
  onBranch: (messageId: string) => void
  onSummarizedBranch: (messageId: string) => void
  onRetry: (messageId: string) => void
  onEdit: (messageId: string, content: string) => void
}

/**
 * 单个历史消息块：消息内容与对应操作行作为一个整体渲染，避免操作按钮与消息输出
 * 在视觉上分离。`React.memo` 让 messages 引用稳定时不重渲染，从而保住长会话的
 * paint 区域。
 */
const HistoryBlock = memo(({
  block,
  action,
  busy,
  lastMessageId,
  onBranch,
  onSummarizedBranch,
  onRetry,
  onEdit,
}: HistoryBlockProps) => {
  const content = (() => {
    if (block.type === 'user') {
      return (
        <div className="message-bubble__row">
          <div className="message-bubble">{block.message.content}</div>
        </div>
      )
    }
    if (block.type === 'assistant-text') {
      return (
        <div className="message-text">
          <RichMessageContent message={block.message} renderToolCalls={false} />
        </div>
      )
    }
    if (block.type === 'tool') {
      return (
        <>
          <ToolCallCard
            toolCallId={block.toolCallId}
            toolName={block.toolName}
            call={block.call}
            result={block.result}
          />
          {block.result?.artifact && <ArtifactPreview artifact={block.result.artifact} />}
          {block.result?.artifactError && (
            <p className="artifact-error" role="alert">{block.result.artifactError}</p>
          )}
        </>
      )
    }
    if (block.type === 'result-chip') {
      return <ResultChip key={block.key} message={block.message} />
    }
    if (block.type === 'error-card') {
      return <ErrorCard messageId={block.message.id} error={block.error} message={block.message} />
    }
    return null
  })()

  if (block.type === 'result-chip') {
    return content
  }

  const role = blockActionRole(block)
  const message = block.type === 'user' || block.type === 'assistant-text' ? block.message : null
  const summarizable = Boolean(action?.branchable && message?.id !== lastMessageId)
  // 带操作行的消息组要交出等量的下外边距，让操作行叠在消息间距带里而不是额外占高。
  const groupClass = role
    ? 'session__message-group session__message-group--with-actions'
    : 'session__message-group'

  return (
    <div className={groupClass}>
      {content}
      {role && message && (
        <MessageActions
          branchable={action?.branchable ?? false}
          busy={busy}
          editable={Boolean(action?.editBoundaryId)}
          onBranch={() => onBranch(message.id)}
          onEdit={() => onEdit(message.id, message.content)}
          onRetry={() => onRetry(message.id)}
          onSummarizedBranch={() => onSummarizedBranch(message.id)}
          retryable={Boolean(action?.retryBoundaryId)}
          role={role}
          summarizable={summarizable}
          text={message.content}
        />
      )}
    </div>
  )
})
HistoryBlock.displayName = 'HistoryBlock'

/**
 * 流式 assistant 消息单独渲染：每次 text_delta / thinking_delta 仅本组件
 * 重渲染。thinking 块用稳定 key（contentBlocks 有序，index 稳定），避免折叠状态丢失。
 *
 * 内层做 rAF 节流：把一帧内的多个 delta 合并成一次渲染，降低 markdown re-parse 频率；
 * 渲染内容走增量渲染（`RichMessageContent` 的 `streaming` 路径），稳定前缀不重复
 * re-parse、未闭合尾部用纯文本轻量渲染。
 */
const StreamingMessage = memo(({ draft }: { draft: AssistantMessage }) => {
  const [renderDraft, setRenderDraft] = useState(draft)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setRenderDraft(draft))
    return () => cancelAnimationFrame(frame)
  }, [draft])
  return (
    <div className="session__message-group">
      <div className="message-text">
        <RichMessageContent message={renderDraft} renderToolCalls={false} streaming />
      </div>
    </div>
  )
})
StreamingMessage.displayName = 'StreamingMessage'

export const SessionView = () => {
  const { t } = useT()
  const activeSessionId = useAgentStore((state) => state.activeSessionId)
  const messages = useAgentStore((state) => state.messages)
  const endReason = useAgentStore((state) => state.endReason)
  const error = useAgentStore((state) => state.error)
  const running = useAgentStore((state) => state.running)
  const sessionBusy = useAgentStore((state) => state.sessionBusy)
  const branchFromMessage = useAgentStore((state) => state.branchFromMessage)
  const retryAssistant = useAgentStore((state) => state.retryAssistant)
  const setRuntimeRailOpen = useUiStore((state) => state.setRuntimeRailOpen)
  const setSummaryRequest = useUiStore((state) => state.setSummaryRequest)
  const setMessageEditRequest = useUiStore((state) => state.setMessageEditRequest)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const outputAnchorRef = useRef<HTMLDivElement | null>(null)
  const streamingDraft = useAgentStore((state) => state.streamingDraft)
  const blocks = useMemo(() => buildSessionBlocks(messages), [messages])
  const busy = running || sessionBusy
  const showPaused = !['completed', 'error'].includes(endReason ?? '') && messages.length > 0 && endReason === 'stopped'

  // IO 监听 anchor 决定贴底状态；内容变化时由 hook 在 rAF 内
  // 直接写 scrollTop = scrollHeight（不再走 scrollIntoView）。
  // streamingDraft 变化也触发贴底尝试（不依赖 messages 引用变化）。
  useStickyScroll({
    containerRef: messagesRef,
    anchorRef: outputAnchorRef,
    scrollTrigger: [messages, streamingDraft] as const,
    resetKey: activeSessionId,
  })

  // 分支/重试/编辑的可用性只在消息序列变化时重算一遍（单趟扫描）。
  const actionsByMessageId = useMemo(() => {
    const actions = getBranchMessageActions(messages)
    const mapped = new Map<string, BranchMessageAction>()
    messages.forEach((message, index) => {
      const action = actions[index]
      if (action) mapped.set(message.id, action)
    })
    return mapped
  }, [messages])
  const lastMessageId = messages[messages.length - 1]?.id

  const historyNodes = useMemo(() => blocks.map((block) => (
    <HistoryBlock
      key={block.key}
      action={actionsByMessageId.get(blockMessageId(block) ?? '')}
      block={block}
      busy={busy}
      lastMessageId={lastMessageId}
      onBranch={(messageId) => { void branchFromMessage(messageId) }}
      onEdit={(messageId, content) => {
        if (activeSessionId) setMessageEditRequest({ sessionId: activeSessionId, messageId, content })
      }}
      onRetry={(messageId) => { void retryAssistant(messageId) }}
      onSummarizedBranch={(messageId) => setSummaryRequest({ mode: 'branch', messageId })}
    />
  )), [
    actionsByMessageId,
    activeSessionId,
    blocks,
    branchFromMessage,
    busy,
    lastMessageId,
    retryAssistant,
    setMessageEditRequest,
    setSummaryRequest,
  ])

  return (
    <section
      className="session"
      aria-label={t('app.sessionView.sessionAria')}
    >
      <div className="session__content">
        <SessionHeader />
        <div className="session__divider" />
        <div
          aria-busy={busy}
          aria-live="polite"
          className="session__messages"
          ref={messagesRef}
        >
          <div className="session__column">
            {historyNodes}
            {streamingDraft && <StreamingMessage draft={streamingDraft} />}
            {showPaused && <PausedBanner />}
            <ApprovalCard />
            <BackgroundApprovals />
            <div aria-hidden="true" className="session__output-anchor" ref={outputAnchorRef} />
          </div>
        </div>
        {error && (
          <div className="session__runtime-error" role="alert">
            <span>{error}</span>
            <button onClick={() => setRuntimeRailOpen(true)} type="button">{t('app.sessionView.viewLogs')}</button>
          </div>
        )}
        <div className="session__composer-wrap">
          <Composer variant="session" />
        </div>
      </div>
    </section>
  )
}
