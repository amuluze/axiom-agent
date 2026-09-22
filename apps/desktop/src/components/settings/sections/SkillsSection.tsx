import { useMemo, useState } from 'react'
import { AlertTriangle, Check, PencilLine, RefreshCw, Sparkles, X } from 'lucide-react'
import { useAgentStore } from '@/stores/agentStore'
import { useUiStore } from '@/stores/uiStore'
import { BUILTIN_SKILL_BODIES, BUILTIN_SKILL_BODIES_VERSION, resolveBuiltinSkillVariant } from '@/agent/skills/builtinSkillBodies'
import { formatAvailableSkills } from '@/agent/skills/formatAvailableSkills'
import { hasProjectSkillChanges } from '@/agent/skills/diffProjectSkills'
import { getBuiltinPromptOverrides } from '@/config/builtinPromptOverrides'
import { BuiltinPromptEditorDialog, type BuiltinPromptEditorTarget } from '../BuiltinPromptEditorDialog'
import { useT } from '@/i18n'

/**
 * 设置-技能面板（docs/skills-extension.md §7.3 显式 reload）：
 * - 「内置技能」区：只读展示 Axiom 随产品分发的 6 个内置 Skill（含 domain）——
 *   恒可用于任何工作区（与工作区无关，无工作区也展示）；项目同名 Skill
 *   覆盖时标注遮蔽关系；
 * - 「项目级技能」区：`projectEnabled` 独立开关（默认开启，影响后续新建/
 *   激活会话）、当前激活工作区 `.axiom/skills` 扫描结果列表 + 独立诊断通道；
 * - 显式 reload 分两步：`重新扫描` 生成 diff 预览（不替换 live 运行时），
 *   有变更时展开确认区（新增/删除/内容变化详情 +「reload 会使上下文摘要检查点
 *   失效，长历史可能增加摘要模型调用成本」提示），确认后才原子应用。
 */
export const SkillsSection = () => {
  const { t, language } = useT()
  const projectSkillsEnabled = useUiStore((state) => state.projectSkillsEnabled)
  const setProjectSkillsEnabled = useUiStore((state) => state.setProjectSkillsEnabled)
  const authorizedWorkspace = useAgentStore((state) => state.authorizedWorkspace)
  const projectSkills = useAgentStore((state) => state.projectSkills)
  const skillDiagnostics = useAgentStore((state) => state.skillDiagnostics)
  const preview = useAgentStore((state) => state.skillReloadPreview)
  const previewSkillReload = useAgentStore((state) => state.previewSkillReload)
  const applySkillReload = useAgentStore((state) => state.applySkillReload)
  const [previewing, setPreviewing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // 内置提示词编辑弹窗目标 + 覆写版本号（保存后 bump 触发重渲染）；覆写本身存
  // config 叶子模块，渲染值经 useMemo 在版本号变化时重新读取。
  const [editingTarget, setEditingTarget] = useState<BuiltinPromptEditorTarget | null>(null)
  const [overridesRevision, setOverridesRevision] = useState(0)
  const overrides = useMemo(() => getBuiltinPromptOverrides(), [overridesRevision])

  const handlePreview = async (): Promise<void> => {
    setPreviewing(true)
    try {
      const result = await previewSkillReload()
      // 有变更才展开确认区；无变更时确认区收起（preview 保留供下次对比）。
      setConfirming(hasProjectSkillChanges(result))
    } finally {
      setPreviewing(false)
    }
  }

  const handleApply = async (): Promise<void> => {
    setApplying(true)
    try {
      await applySkillReload()
      setConfirming(false)
    } finally {
      setApplying(false)
    }
  }

  const omitted = formatAvailableSkills(projectSkills).omittedSkillNames
  const showConfirm = confirming && preview && hasProjectSkillChanges(preview)
  // 项目同名 Skill 会遮蔽（shadow）内置同名版本：load_skill 双通道项目优先。
  const projectNames = new Set(projectSkills.skills.map((skill) => skill.name))

  return (
    <section className="settings-section" id="settings-skills">
      <div className="section-title">
        <span>{t('settings.skills.title')}</span>
        <span className="section-state">
          {t('settings.skills.state', { builtin: BUILTIN_SKILL_BODIES.length, project: projectSkills.skills.length })}
        </span>
      </div>

      {/* 内置技能区：与工作区无关，始终展示 */}
      <div className="section-title" style={{ marginTop: 'var(--space-6)' }}>
        <span>{t('settings.skills.builtinTitle')}</span>
        <span className="section-state">{t('settings.skills.builtinState')}</span>
      </div>
      <p className="settings__hint">
        {t('settings.skills.builtinHint', { version: BUILTIN_SKILL_BODIES_VERSION })}
      </p>
      <ul className="settings__skill-list">
        {BUILTIN_SKILL_BODIES.map((skill) => {
          const overrideEntry = overrides.skills[skill.name]
          const customized = overrideEntry !== undefined && Object.keys(overrideEntry).length > 0
          const description = resolveBuiltinSkillVariant(
            skill,
            language,
            overrideEntry?.[language],
          ).description
          return (
            <li key={skill.name} className="settings__skill-item">
              <div className="settings__skill-name">
                {skill.name}
                <span className="settings__badge">{t('settings.skills.badge.builtin')}</span>
                {customized && (
                  <span className="settings__badge settings__badge--shadowed">
                    {t('settings.promptEditor.modified')}
                  </span>
                )}
                {projectNames.has(skill.name) && (
                  <span className="settings__badge settings__badge--shadowed">{t('settings.skills.badge.shadowed')}</span>
                )}
              </div>
              <div className="settings__skill-desc">{description}</div>
              <div className="settings__skill-meta">{t('settings.skills.builtinMeta')}</div>
              <div className="settings__skill-actions">
                <button
                  type="button"
                  className="settings__icon-button"
                  onClick={() => setEditingTarget({ kind: 'skill', name: skill.name })}
                >
                  <PencilLine size={13} />
                  {t('settings.skills.edit')}
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      <BuiltinPromptEditorDialog
        onClose={() => setEditingTarget(null)}
        onSaved={() => setOverridesRevision((value) => value + 1)}
        target={editingTarget}
      />

      {/* 项目级技能区 */}
      <div className="section-title" style={{ marginTop: 'var(--space-6)' }}>
        <span>{t('settings.skills.projectTitle')}</span>
        <span className="section-state">{t('settings.skills.projectState')}</span>
      </div>
      <div className="settings-grid">
        <label className="settings__toggle">
          <input
            type="checkbox"
            checked={projectSkillsEnabled}
            onChange={(event) => setProjectSkillsEnabled(event.target.checked)}
          />
          <span className="settings__toggle-body">
            <span className="settings__field-label-with-icon">
              <Sparkles size={13} />
              {t('settings.skills.projectEnableLabel')}
            </span>
            <small>
              {t('settings.skills.projectEnableHint')}
            </small>
          </span>
        </label>
      </div>

      <div className="section-title" style={{ marginTop: 'var(--space-6)' }}>
        <span>{t('settings.skills.workspaceTitle')}</span>
        <button
          type="button"
          className="settings__icon-button"
          onClick={() => { void handlePreview() }}
          disabled={previewing || applying || !authorizedWorkspace}
          aria-label={t('settings.skills.rescanAria')}
        >
          <RefreshCw size={13} className={previewing ? 'settings__spin' : undefined} />
          {previewing ? t('settings.skills.scanning') : t('settings.skills.rescan')}
        </button>
      </div>

      {!authorizedWorkspace ? (
        <p className="settings__empty">
          {t('settings.skills.noWorkspace')}
        </p>
      ) : (
        <>
          <p className="settings__hint">{t('settings.skills.workspacePath', { path: authorizedWorkspace.path })}</p>

          {showConfirm ? (
            <div className="settings__reload-confirm" role="group" aria-label={t('settings.skills.confirmGroupAria')}>
              <div className="settings__reload-summary">
                {t('settings.skills.changesSummary', { count: preview.added.length + preview.removed.length + preview.changed.length })}
              </div>
              <ul className="settings__reload-diff">
                {preview.added.length > 0 && (
                  <li className="settings__reload-diff--added">{t('settings.skills.diff.added', { names: preview.added.join('、') })}</li>
                )}
                {preview.removed.length > 0 && (
                  <li className="settings__reload-diff--removed">{t('settings.skills.diff.removed', { names: preview.removed.join('、') })}</li>
                )}
                {preview.changed.length > 0 && (
                  <li className="settings__reload-diff--changed">{t('settings.skills.diff.changed', { names: preview.changed.join('、') })}</li>
                )}
              </ul>
              <p className="settings__reload-warning">
                {t('settings.skills.reloadWarning')}
              </p>
              <div className="settings__reload-actions">
                <button
                  type="button"
                  className="settings__reload-apply"
                  onClick={() => { void handleApply() }}
                  disabled={applying}
                >
                  <Check size={13} />
                  {applying ? t('settings.skills.applying') : t('settings.skills.apply')}
                </button>
                <button
                  type="button"
                  className="settings__reload-cancel"
                  onClick={() => setConfirming(false)}
                  disabled={applying}
                >
                  <X size={13} />
                  {t('settings.skills.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <p className="settings__empty">
              {t('settings.skills.noChanges')}
            </p>
          )}

          {projectSkills.skills.length === 0 ? (
            <p className="settings__empty">
              {t('settings.skills.noProjectSkills')}
            </p>
          ) : (
            <ul className="settings__skill-list">
              {projectSkills.skills.map((skill) => (
                <li key={skill.name} className="settings__skill-item">
                  <div className="settings__skill-name">
                    {skill.name}
                    {skill.disableModelInvocation && <span className="settings__badge">{t('settings.skills.badge.manual')}</span>}
                  </div>
                  <div className="settings__skill-desc">{skill.description}</div>
                  <div className="settings__skill-meta">
                    {t('settings.skills.meta', { path: skill.relativePath, hash: skill.contentSha256.slice(0, 12) })}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {omitted.length > 0 && (
            <p className="settings__warn">
              {t('settings.skills.omittedWarn', { names: omitted.join('、') })}
            </p>
          )}

          {skillDiagnostics.length > 0 && (
            <div className="settings__diagnostics">
              <div className="settings__diagnostics-title">
                <AlertTriangle size={13} />
                {t('settings.skills.diagnosticsTitle', { count: skillDiagnostics.length })}
              </div>
              <ul>
                {skillDiagnostics.map((diagnostic, index) => (
                  <li key={index} className="settings__diagnostic">
                    <code>
                      {diagnostic.code}
                      {diagnostic.reason ? `:${diagnostic.reason}` : ''}
                    </code>
                    <span>{diagnostic.relativePath}{diagnostic.line !== undefined ? `:${diagnostic.line}` : ''}</span>
                    <span className="settings__diagnostic-message">{diagnostic.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}
