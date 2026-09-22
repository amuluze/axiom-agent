import { useMemo, useState } from 'react'
import { PencilLine } from 'lucide-react'
import { RUNTIME_POLICY } from '@/config/runtimePolicy'
import { BUILTIN_SUBAGENTS } from '@/agent/subagent/builtinSubAgents'
import { getBuiltinPromptOverrides } from '@/config/builtinPromptOverrides'
import { BuiltinPromptEditorDialog, type BuiltinPromptEditorTarget } from '../BuiltinPromptEditorDialog'
import { useT } from '@/i18n'

/**
 * 设置-子智能体：展示内置 SubAgent 目录（explore + 审查三件套）。
 * 数据来源为内置目录 builtinSubAgents.ts + RUNTIME_POLICY capability；
 * 激活状态镜像 createToolRegistry 的注册条件（workspace:read + 各自 capability：
 * explore 用 subagent:explore，审查三子代理用 subagent:review）。
 * 提示词按语言查看/编辑（BuiltinPromptEditorDialog，覆写存 config 叶子模块，
 * SubAgentRuntime 委派时经本地化宿主读取）。
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
  // 提示词编辑弹窗目标 + 覆写版本号（保存后 bump 触发「已自定义」badge 重渲染）。
  const [editingTarget, setEditingTarget] = useState<BuiltinPromptEditorTarget | null>(null)
  const [overridesRevision, setOverridesRevision] = useState(0)
  const overrides = useMemo(() => getBuiltinPromptOverrides(), [overridesRevision])

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
            const overrideEntry = overrides.subagents[sub.kind]
            const customized = overrideEntry !== undefined && Object.keys(overrideEntry).length > 0
            return (
              <li key={sub.toolName} className="settings__subagent-item">
                <div className="settings__subagent-name">
                  {sub.displayName}
                  <span className="settings__badge settings__subagent-kind">{sub.kind}</span>
                  {customized && (
                    <span className="settings__badge settings__badge--shadowed">
                      {t('settings.promptEditor.modified')}
                    </span>
                  )}
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
                <div className="settings__skill-actions">
                  <button
                    type="button"
                    className="settings__icon-button"
                    onClick={() => setEditingTarget({ kind: 'subagent', subKind: sub.kind })}
                  >
                    <PencilLine size={13} />
                    {t('settings.subagents.edit')}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <BuiltinPromptEditorDialog
        onClose={() => setEditingTarget(null)}
        onSaved={() => setOverridesRevision((value) => value + 1)}
        target={editingTarget}
      />
    </section>
  )
}
