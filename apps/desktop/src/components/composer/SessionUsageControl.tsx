import { useState, type CSSProperties } from 'react'
import type { TokenUsage } from '@/agent/core/types'
import { useAgentStore } from '@/stores/agentStore'
import { useT } from '@/i18n'
import { cacheHitRate, formatHitRate, formatTokens, lastAssistantUsage } from './usageSummary'

export interface SessionUsageDetailProps {
  usage: TokenUsage
}

/**
 * 用量明细区块（纯 props，便于 SSR 快照断言）：输入 / 输出 / 命中率 + 口径算式。
 * 合并控件的悬浮层与降级路径的命中率环共用同一份正文，避免两处各写一遍。
 */
export const SessionUsageDetail = ({ usage }: SessionUsageDetailProps) => {
  const { t } = useT()
  const rate = cacheHitRate(usage)
  return (
    <span className="composer__usage-detail">
      <span className="composer__popover-title">{t('app.usage.sessionTitle')}</span>
      <span>{t('app.usage.sessionIn', { value: formatTokens(usage.inputTokens) })}</span>
      <span>{t('app.usage.sessionOut', { value: formatTokens(usage.outputTokens) })}</span>
      <span>{t('app.usage.cacheHitRate', { value: formatHitRate(rate, t('app.usage.rateUnavailable')) })}</span>
      {rate !== undefined && (
        <span className="composer__usage-formula">
          {t('app.usage.cacheHitDetail', {
            read: formatTokens(usage.cacheReadTokens ?? 0),
            input: formatTokens(usage.inputTokens),
          })}
        </span>
      )}
    </span>
  )
}

export interface SessionUsageViewProps {
  usage: TokenUsage | undefined
}

/**
 * 控制行内的用量环（纯 props，便于 SSR 快照断言）：弧长即缓存命中率，
 * 悬浮/聚焦展开明细。环填充截断到 100%，超过 100% 只在文案里如实标注。
 *
 * 用 button 而非 role="img"：明细需要键盘可达，而非交互元素不允许可聚焦；
 * 无点击行为，故用 cursor: default 告知光标它只负责展开数据。
 */
export const SessionUsageView = ({ usage }: SessionUsageViewProps) => {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  if (!usage) return null
  const rate = cacheHitRate(usage)
  const rateText = formatHitRate(rate, t('app.usage.rateUnavailable'))
  return (
    <button
      aria-label={t('app.usage.ringAria', {
        input: formatTokens(usage.inputTokens),
        output: formatTokens(usage.outputTokens),
        rate: rateText,
      })}
      className="composer__usage"
      onBlur={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      type="button"
    >
      <span
        className="composer__usage-ring"
        style={{ '--hit': `${rate === undefined ? 0 : Math.min(100, rate)}%` } as CSSProperties}
      />
      {open && (
        <span className="composer__usage-popover" role="tooltip">
          <SessionUsageDetail usage={usage} />
        </span>
      )}
    </button>
  )
}

/** 会话 variant 的 store 包装：跟随当前会话投影更新。 */
export const SessionUsageControl = () => {
  const messages = useAgentStore((state) => state.messages)
  return <SessionUsageView usage={lastAssistantUsage(messages)} />
}
