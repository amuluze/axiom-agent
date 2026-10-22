import { useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import type { ContextBudgetUsage, ContextCheckpoint } from '@/agent/context/types'
import type { AgentMessage, ModelMessage } from '@/agent/core/types'
import { mergeSkillPhases, normalizeFacts } from '@/agent/context/ledger'
import type { SendManifest } from '@/agent/context/sendManifest'
import { useT } from '@/i18n'
import { SessionUsageControl, SessionUsageDetail } from './SessionUsageControl'
import { useHorizontalMenuClamp } from './useHorizontalMenuClamp'
import { formatTokens, lastAssistantUsage } from './usageSummary'

export const formatContextBytes = (bytes: number): string => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(2)} MiB`
  : `${Math.ceil(bytes / 1024)} KiB`

/** token 与字节两条水位取最大值作为对外展示的占用口径，与压缩判定一致。 */
export const contextBudgetPercent = (usage: ContextBudgetUsage): number =>
  Math.min(100, Math.max(usage.tokenPercent, usage.bytePercent))

export const sddProgressFromHistory = (
  checkpoint: ContextCheckpoint | null,
  messages: AgentMessage[],
): ReturnType<typeof mergeSkillPhases> => {
  const facts = normalizeFacts(checkpoint?.facts ?? { readFiles: [], modifiedFiles: [] })
  const boundaryIndex = checkpoint
    ? messages.findIndex((message) => message.id === checkpoint.throughMessageId)
    : -1
  const recentMessages = checkpoint
    ? boundaryIndex >= 0 ? messages.slice(boundaryIndex + 1) : []
    : messages
  const modelMessages = recentMessages.filter(
    (message): message is ModelMessage => message.role !== 'custom',
  )
  return mergeSkillPhases(facts.loadedSkills, facts.sddReviews, modelMessages)
}

export interface ContextBudgetPanelProps {
  usage: ContextBudgetUsage
  checkpoint: ContextCheckpoint | null
  busy: boolean
  messageCount: number
  compactionRunning: boolean
  sendManifest: SendManifest | null
  sddProgress?: ReturnType<typeof mergeSkillPhases>
  onCompact: () => void
  /** 弹层根元素引用：水平钳制 hook 的测量目标（可选，SSR 快照不传）。 */
  menuRef?: RefObject<HTMLDivElement | null>
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
  sendManifest,
  sddProgress,
  onCompact,
  menuRef,
}: ContextBudgetPanelProps) => {
  const { t } = useT()
  const percent = contextBudgetPercent(usage)
  return (
    <div className="composer__budget-menu" ref={menuRef} role="dialog" aria-label={t('app.budget.aria')}>
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
      {sendManifest && (
        <p className="composer__budget-send-manifest">
          {t('app.budget.sendManifest', {
            messages: sendManifest.messageCount,
            bytes: formatContextBytes(sendManifest.bytes),
            tools: sendManifest.toolCount,
            toolResults: sendManifest.toolResultCount,
            toolResultBytes: formatContextBytes(sendManifest.toolResultBytes),
            images: sendManifest.imageCount,
            retries: sendManifest.retryCount,
            scan: sendManifest.credentialScan === 'passed'
              ? t('app.budget.sendManifest.scanPassed')
              : sendManifest.credentialScan === 'blocked'
                ? t('app.budget.sendManifest.scanBlocked')
                : t('app.budget.sendManifest.scanPending'),
            summary: sendManifest.summaryIncluded
              ? t('app.budget.sendManifest.summaryYes')
              : t('app.budget.sendManifest.summaryNo'),
          })}
        </p>
      )}
      {sddProgress && (sddProgress.loadedSkills.length > 0 || sddProgress.sddReviews.length > 0) && (
        <section className="composer__budget-sdd" aria-label={t('app.budget.sdd.title')}>
          <div className="composer__budget-sdd-title">{t('app.budget.sdd.title')}</div>
          {sddProgress.loadedSkills.length > 0 && (
            <div>{t('app.budget.sdd.skills', {
              skills: sddProgress.loadedSkills.map((entry) => entry.name).join(' → '),
            })}</div>
          )}
          {sddProgress.sddReviews.map((entry) => (
            <div data-status={entry.verdict} key={entry.reviewer}>
              {t('app.budget.sdd.review', {
                reviewer: entry.reviewer.replace('_subagent', ''),
                verdict: t(`app.budget.sdd.verdict.${entry.verdict}`),
              })}
            </div>
          ))}
          {sddProgress.sddReviews.some((entry) => entry.verdict !== 'pass') && (
            <div className="composer__budget-sdd-warning">{t('app.budget.sdd.unresolved')}</div>
          )}
        </section>
      )}
      {checkpoint && (
        <details className="composer__budget-checkpoint">
          <summary>{t('app.budget.viewSummary')}</summary>
          <pre>{checkpoint.summary}</pre>
        </details>
      )}
    </div>
  )
}

/**
 * 悬浮层里的预算区块（纯 props）：水位与两条上限。与用量区块并列，
 * 分区标题是必需的——两者数值含义无交集，混排会让用户把水位读成命中率。
 */
export const ContextBudgetSummary = ({ usage }: { usage: ContextBudgetUsage }) => {
  const { t } = useT()
  const percent = contextBudgetPercent(usage)
  return (
    <span className="composer__budget-summary">
      <span className="composer__popover-title">{t('app.budget.title')}</span>
      <span className="composer__popover-emphasis">{percent.toFixed(0)}%</span>
      <span>{formatTokens(usage.estimatedTokens)} / {formatTokens(usage.contextWindow)} tokens</span>
      <span>{formatContextBytes(usage.requestBytes)} / 2.00 MiB</span>
    </span>
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
 * 输入框控制行里的预算入口：环即水位——底栏不再给出百分比文本，数值只出现在
 * aria 名称与悬浮层里；悬浮展开预算与用量明细，点击展开完整面板。
 *
 * 无水位（尚无活跃会话）时退化为「最近一次响应」的命中率环；两者都无则不渲染。
 * 悬浮层与面板互斥：面板已展开时不再叠一层提示。
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
  const messages = useAgentStore((state) => state.messages)
  const running = useAgentStore((state) => state.running)
  const sessionBusy = useAgentStore((state) => state.sessionBusy)
  const compactionRunning = useAgentStore((state) => state.compactionRunning)
  const sendManifest = useAgentStore((state) =>
    state.activeSessionId ? state.sendManifests[state.activeSessionId] ?? null : null)
  const setSummaryRequest = useUiStore((state) => state.setSummaryRequest)
  const [hovered, setHovered] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useHorizontalMenuClamp(menuRef, open)
  if (!contextUsage) return <SessionUsageControl />
  const usage = lastAssistantUsage(messages)
  const busy = running || sessionBusy
  const percent = contextBudgetPercent(contextUsage)
  const sddProgress = sddProgressFromHistory(contextCheckpoint, messages)

  return (
    <div className="composer__budget-picker" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-label={t('app.budget.ariaValue', { percent: percent.toFixed(0) })}
        className="composer__budget-trigger"
        data-status={contextUsage.needsCompaction ? 'warn' : 'ok'}
        onBlur={() => setHovered(false)}
        onClick={onToggle}
        onFocus={() => setHovered(true)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        type="button"
      >
        <span
          className="composer__budget-ring"
          style={{ '--hit': `${percent}%` } as CSSProperties}
        />
      </button>
      {hovered && !open && (
        <span className="composer__budget-popover" role="tooltip">
          <ContextBudgetSummary usage={contextUsage} />
          {usage && <SessionUsageDetail usage={usage} />}
        </span>
      )}
      {open && (
        <ContextBudgetPanel
          busy={busy}
          checkpoint={contextCheckpoint}
          compactionRunning={compactionRunning}
          menuRef={menuRef}
          messageCount={messages.length}
          sendManifest={sendManifest}
          sddProgress={sddProgress}
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
