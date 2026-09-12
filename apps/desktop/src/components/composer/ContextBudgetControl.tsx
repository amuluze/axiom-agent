import type { RefObject } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import type { ContextBudgetUsage, ContextCheckpoint } from '@/agent/context/types'
import { useT } from '@/i18n'

export const formatTokens = (tokens: number): string => tokens >= 1_000
  ? `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}K`
  : String(tokens)

export const formatContextBytes = (bytes: number): string => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(2)} MiB`
  : `${Math.ceil(bytes / 1024)} KiB`

/** token 与字节两条水位取最大值作为对外展示的占用口径，与压缩判定一致。 */
export const contextBudgetPercent = (usage: ContextBudgetUsage): number =>
  Math.min(100, Math.max(usage.tokenPercent, usage.bytePercent))

export interface ContextBudgetPanelProps {
  usage: ContextBudgetUsage
  checkpoint: ContextCheckpoint | null
  busy: boolean
  messageCount: number
  compactionRunning: boolean
  onCompact: () => void
}

/**
 * 预算弹层正文：从 RuntimeRail 迁移而来，挂在 Composer 控制行下方展示，
 * 纯 props 驱动以便 SSR 快照断言。
 */
export const ContextBudgetPanel = ({
  usage,
  checkpoint,
  busy,
  messageCount,
  compactionRunning,
  onCompact,
}: ContextBudgetPanelProps) => {
  const { t } = useT()
  const percent = contextBudgetPercent(usage)
  return (
    <div className="composer__budget-menu" role="dialog" aria-label={t('app.budget.aria')}>
      <div className="composer__budget-heading">
        <span>{t('app.budget.title')}</span>
        <span>{percent.toFixed(0)}%</span>
      </div>
      <div className="composer__budget-meter">
        <div className="composer__budget-meter-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="composer__budget-stats">
        <span>{formatTokens(usage.estimatedTokens)} / {formatTokens(usage.contextWindow)} tokens</span>
        <span>{formatContextBytes(usage.requestBytes)} / 2.00 MiB</span>
      </div>
      <div className="composer__budget-footer">
        <span>{checkpoint ? t('app.budget.hasCheckpoint') : t('app.budget.notCompacted')}</span>
        <button
          className="composer__budget-compact"
          disabled={busy || messageCount < 2}
          onClick={onCompact}
          type="button"
        >
          {compactionRunning ? t('app.budget.compacting') : t('app.budget.compact')}
        </button>
      </div>
      {checkpoint && (
        <details className="composer__budget-checkpoint">
          <summary>{t('app.budget.viewSummary')}</summary>
          <pre>{checkpoint.summary}</pre>
        </details>
      )}
    </div>
  )
}

export interface ContextBudgetControlProps {
  containerRef: RefObject<HTMLDivElement | null>
  open: boolean
  onToggle: () => void
  /** 触发手动压缩后回调，Composer 用于收起弹层。 */
  onCompacted: () => void
}

/**
 * 输入框控制行里的上下文预算入口：触发按钮常驻展示水位，
 * 弹层承载原 RuntimeRail 预算面板的完整信息（迁移后 rail 只保留浏览器/电脑控制）。
 * 仅会话 variant 渲染；无 contextUsage（尚无活跃会话）时不渲染。
 */
export const ContextBudgetControl = ({
  containerRef,
  open,
  onToggle,
  onCompacted,
}: ContextBudgetControlProps) => {
  const { t } = useT()
  const contextUsage = useAgentStore((state) => state.contextUsage)
  const contextCheckpoint = useAgentStore((state) => state.contextCheckpoint)
  const messageCount = useAgentStore((state) => state.messages.length)
  const running = useAgentStore((state) => state.running)
  const sessionBusy = useAgentStore((state) => state.sessionBusy)
  const compactionRunning = useAgentStore((state) => state.compactionRunning)
  const setSummaryRequest = useUiStore((state) => state.setSummaryRequest)
  if (!contextUsage) return null
  const busy = running || sessionBusy
  const percent = contextBudgetPercent(contextUsage)

  return (
    <div className="composer__budget-picker" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-label={t('app.budget.aria')}
        className="composer__budget-trigger"
        data-status={contextUsage.needsCompaction ? 'warn' : 'ok'}
        onClick={onToggle}
        title={t('app.budget.title')}
        type="button"
      >
        <span className="composer__budget-bar">
          <span className="composer__budget-bar-fill" style={{ width: `${percent}%` }} />
        </span>
        <span>{percent.toFixed(0)}%</span>
      </button>
      {open && (
        <ContextBudgetPanel
          busy={busy}
          checkpoint={contextCheckpoint}
          compactionRunning={compactionRunning}
          messageCount={messageCount}
          onCompact={() => {
            setSummaryRequest({ mode: 'compaction' })
            onCompacted()
          }}
          usage={contextUsage}
        />
      )}
    </div>
  )
}
