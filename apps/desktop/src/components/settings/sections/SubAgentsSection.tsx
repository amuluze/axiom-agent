import { RUNTIME_POLICY } from '@/config/runtimePolicy'
import { BUILTIN_SUBAGENTS } from '@/agent/subagent/builtinSubAgents'
import { useT } from '@/i18n'

/**
 * 设置-子智能体：只读展示内置 SubAgent（当前仅 Explore）。
 * 数据来源为内置目录 builtinSubAgents.ts + RUNTIME_POLICY capability；
 * 激活状态镜像 createToolRegistry 的注册条件（workspace:read + 各自 capability：
 * explore 用 subagent:explore，审查三子代理用 subagent:review）。
 */
const formatDuration = (ms: number, label: string): string => {
  const seconds = Math.round(ms / 1000)
  return label.replace('{seconds}', String(seconds))
}
const formatBytes = (bytes: number): string =>
  bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes / 1024} KiB`
// 固定 en-US，保证 SSR 快照确定性。
const formatInt = (value: number): string => value.toLocaleString('en-US')

export const SubAgentsSection = () => {
  const { t } = useT()
  const durationSeconds = t('app.subagents.duration.seconds')
  const caps = new Set(RUNTIME_POLICY.toolCapabilities)
  const workspaceRead = caps.has('workspace:read')
  const items = BUILTIN_SUBAGENTS

  return (
    <section className="settings-section" id="settings-subagents">
      <div className="section-title">
        <span>{t('settings.subagents.title')}</span>
        <span className="section-state">{t('settings.subagents.count', { count: items.length })}</span>
      </div>
      <p className="settings__hint">
        {t('settings.subagents.hint')}
      </p>

      {items.length === 0 ? (
        <p className="settings__empty">{t('settings.subagents.empty')}</p>
      ) : (
        <ul className="settings__subagent-list">
          {items.map((sub) => {
            const registered = workspaceRead && caps.has(sub.capability)
            return (
              <li key={sub.toolName} className="settings__subagent-item">
                <div className="settings__subagent-name">
                  {sub.displayName}
                  <span className="settings__badge settings__subagent-kind">{sub.kind}</span>
                  <span
                    className={registered
                      ? 'settings__subagent-status--active'
                      : 'settings__subagent-status--inactive'}
                  >
                    {registered ? t('settings.subagents.status.active') : t('settings.subagents.status.inactive')}
                  </span>
                </div>
                <div className="settings__subagent-desc">{sub.promptSnippet}</div>
                <div className="settings__subagent-meta">
                  {t('settings.subagents.meta', { tool: sub.toolName, version: sub.runtimeVersion, mode: sub.executionMode, approval: sub.requiresApproval ? t('settings.subagents.approval.required') : t('settings.subagents.approval.notRequired') })}
                </div>
                <div className="settings__subagent-tools">
                  {t('settings.subagents.allowedTools', { tools: sub.allowedTools.join('、') })}
                </div>
                <div className="settings__subagent-budget">
                  <div>
                    {t('settings.subagents.childBudget', {
                      maxTurns: sub.childBudget.maxTurns,
                      maxToolCalls: sub.childBudget.maxToolCalls,
                      maxDuration: formatDuration(sub.childBudget.maxDurationMs, durationSeconds),
                      maxTokens: formatInt(sub.childBudget.maxOutputTokens),
                      maxMessageBytes: formatBytes(sub.childBudget.maxMessageBytes),
                      maxInlineBytes: formatBytes(sub.childBudget.maxInlineToolResultBytes),
                    })}
                  </div>
                  <div>
                    {t('settings.subagents.parentBudget', {
                      calls: sub.parentRunBudget.maxCallsPerParentRun,
                      requests: sub.parentRunBudget.maxModelRequestsPerParentRun,
                      duration: formatDuration(sub.parentRunBudget.maxDurationMsPerParentRun, durationSeconds),
                    })}
                  </div>
                </div>
                <div className="settings__subagent-note">
                  {registered && sub.discoverGated
                    ? t('settings.subagents.note.registered')
                    : t('settings.subagents.note.unregistered', { capability: sub.capability })}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
