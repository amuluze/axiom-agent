import type { AgentMessage, TokenUsage } from '@/agent/core/types'
import { useAgentStore } from '@/stores/agentStore'
import { useT } from '@/i18n'
import { formatTokens } from './ContextBudgetControl'

/**
 * 取最后一条携带 usage 的 assistant 消息用量。
 *
 * usage 属于 assistant 消息本身，随消息持久化（`persistence/messageCodec.ts` 校验该字段）
 * 并在会话恢复时回放，因此这里只读投影即可，不需要任何采集通道或额外状态。
 */
export const lastAssistantUsage = (messages: AgentMessage[]): TokenUsage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant' && message.usage) return message.usage
  }
  return undefined
}

export interface SessionUsageViewProps {
  usage: TokenUsage | undefined
}

/**
 * 控制行内的只读用量展示（纯 props，便于 SSR 快照断言）：
 * 主行恒为「输入/输出」，思考与缓存读写在 Provider 上报时才追加；无 usage 不渲染。
 */
export const SessionUsageView = ({ usage }: SessionUsageViewProps) => {
  const { t } = useT()
  if (!usage) return null
  const parts = [
    t('app.usage.sessionIn', { value: formatTokens(usage.inputTokens) }),
    t('app.usage.sessionOut', { value: formatTokens(usage.outputTokens) }),
  ]
  if (usage.reasoningTokens) {
    parts.push(t('app.usage.sessionReasoning', { value: formatTokens(usage.reasoningTokens) }))
  }
  if (usage.cacheReadTokens) {
    parts.push(t('app.usage.sessionCacheRead', { value: formatTokens(usage.cacheReadTokens) }))
  }
  if (usage.cacheWriteTokens) {
    parts.push(t('app.usage.sessionCacheWrite', { value: formatTokens(usage.cacheWriteTokens) }))
  }
  const detail = parts.join(' · ')
  return (
    <span className="composer__usage" title={`${t('app.usage.sessionTitle')} · ${detail}`}>
      {detail}
    </span>
  )
}

/** 会话 variant 的 store 包装：跟随当前会话投影更新。 */
export const SessionUsageControl = () => {
  const messages = useAgentStore((state) => state.messages)
  return <SessionUsageView usage={lastAssistantUsage(messages)} />
}
