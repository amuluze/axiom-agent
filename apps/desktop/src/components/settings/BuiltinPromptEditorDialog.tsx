import { useEffect, useId, useState, type FormEvent } from 'react'
import { RotateCcw, X } from 'lucide-react'
import { trapDialogFocus, useDialogFocus } from '../dialogFocus'
import { useDesignPreview } from '@/components/design/ax/previewContext'
import { useT } from '@/i18n'
import {
  findBuiltinSkillBody,
  resolveBuiltinSkillVariant,
} from '@/agent/skills/builtinSkillBodies'
import {
  getBuiltinSubAgentPromptPreview,
  getBuiltinSubAgentPromptTemplate,
} from '@/agent/subagent/promptCatalog'
import type { SubAgentKind } from '@/agent/core/types'
import {
  MAX_BUILTIN_OVERRIDE_TEXT,
  isValidOverrideText,
  applySkillOverrideEntry,
  applySubAgentOverrideEntry,
  clearSkillOverride,
  clearSubAgentOverride,
  getBuiltinPromptOverrides,
  saveBuiltinPromptOverrides,
  type PromptOverrideLanguage,
} from '@/config/builtinPromptOverrides'

/**
 * 内置提示词查看/编辑弹窗（设置-技能页与设置-子智能体页共用）。
 *
 * 按语言（zh-CN/en）独立查看与编辑：
 * - 技能：description + body 逐字段覆写（diff 保存——字段改回默认值即等价移除覆写）；
 * - 子智能体：完整 system prompt 模板覆写，支持 {{SCOPE}}/{{BUDGET}}/{{TOOLS}}/
 *   {{FORBIDDEN}} 占位符，附渲染预览。
 *
 * 持久化走 config/builtinPromptOverrides 叶子模块（agent 层经本地化宿主在执行期
 * 读取），保存后经 onSaved 通知所属 section 刷新「已自定义」badge。
 * 样式沿用 connect 弹窗模式（backdrop + 居中卡片，settings.css 追加同名类）。
 */
export type BuiltinPromptEditorTarget =
  | { kind: 'skill'; name: string }
  | { kind: 'subagent'; subKind: SubAgentKind }

interface BuiltinPromptEditorDialogProps {
  target: BuiltinPromptEditorTarget | null
  onClose: () => void
  onSaved: () => void
}

const LANGUAGES: readonly PromptOverrideLanguage[] = ['zh-CN', 'en']

const isModified = (
  target: BuiltinPromptEditorTarget,
  language: PromptOverrideLanguage,
  designPreview = false,
): boolean => {
  const overrides: ReturnType<typeof getBuiltinPromptOverrides> = designPreview ? { version: 1, skills: {}, subagents: {} } : getBuiltinPromptOverrides()
  const entry = target.kind === 'skill'
    ? overrides.skills[target.name]?.[language]
    : overrides.subagents[target.subKind]?.[language]
  return entry !== undefined && Object.keys(entry).length > 0
}

/** 草稿种子：覆写字段优先，未覆写字段回落内置默认（纯函数——SSR 首屏即有值）。 */
const seedDrafts = (
  target: BuiltinPromptEditorTarget | null,
  language: PromptOverrideLanguage,
  designPreview = false,
): { description: string; body: string } => {
  if (!target) return { description: '', body: '' }
  const overrides: ReturnType<typeof getBuiltinPromptOverrides> = designPreview ? { version: 1, skills: {}, subagents: {} } : getBuiltinPromptOverrides()
  if (target.kind === 'skill') {
    const skill = findBuiltinSkillBody(target.name)
    if (!skill) return { description: '', body: '' }
    const variant = resolveBuiltinSkillVariant(skill, language, overrides.skills[target.name]?.[language])
    return { description: variant.description, body: variant.body }
  }
  return {
    description: '',
    body: overrides.subagents[target.subKind]?.[language]?.prompt
      ?? getBuiltinSubAgentPromptTemplate(target.subKind, language),
  }
}

export const BuiltinPromptEditorDialog = ({
  target,
  onClose,
  onSaved,
}: BuiltinPromptEditorDialogProps) => {
  const { t } = useT()
  const identifier = useId()
  const titleId = `builtin-prompt-editor-title-${identifier}`
  const descriptionId = `builtin-prompt-editor-description-${identifier}`
  const designPreview = useDesignPreview() !== null
  const [language, setLanguage] = useState<PromptOverrideLanguage>('zh-CN')
  const [drafts, setDrafts] = useState(() => seedDrafts(target, 'zh-CN', designPreview))
  const [revision, setRevision] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  const dialogRef = useDialogFocus<HTMLFormElement>(target !== null && !designPreview)

  // 目标或语言切换时重填草稿（「恢复默认」经 revision 触发同一重填路径）。
  useEffect(() => {
    setDrafts(seedDrafts(target, language, designPreview))
  }, [target, language, revision, designPreview])

  if (!target) return null

  const skill = target.kind === 'skill' ? findBuiltinSkillBody(target.name) : null
  if (target.kind === 'skill' && !skill) return null

  const title = target.kind === 'skill'
    ? t('settings.promptEditor.title.skill', { name: target.name })
    : t('settings.promptEditor.title.subagent', { name: target.subKind })
  const modified = isModified(target, language, designPreview)
  // 渲染预览按当前草稿实时计算：草稿等同默认模板时不传 overrideTemplate。
  const defaultTemplate = target.kind === 'subagent'
    ? getBuiltinSubAgentPromptTemplate(target.subKind, language)
    : ''
  const preview = target.kind === 'subagent'
    ? getBuiltinSubAgentPromptPreview(
      target.subKind,
      language,
      drafts.body === defaultTemplate ? undefined : drafts.body,
    )
    : ''

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (designPreview || !target) return
    // 超长正文在存储层已被拒绝；这里提前拦下并给出可读原因——静默丢弃一次
    // 用户的编辑比报错更糟。
    const tooLong = target.kind === 'skill'
      ? [drafts.description, drafts.body].find((text) => !isValidOverrideText(text))
      : (isValidOverrideText(drafts.body) ? undefined : drafts.body)
    if (tooLong !== undefined) {
      setSaveError(t('settings.promptEditor.tooLong', { limit: MAX_BUILTIN_OVERRIDE_TEXT }))
      return
    }
    const overrides = getBuiltinPromptOverrides()
    if (target.kind === 'skill' && skill) {
      const defaults = resolveBuiltinSkillVariant(skill, language)
      const entry = {
        ...(drafts.description !== defaults.description ? { description: drafts.description } : {}),
        ...(drafts.body !== defaults.body ? { body: drafts.body } : {}),
      }
      saveBuiltinPromptOverrides(applySkillOverrideEntry(overrides, target.name, language, entry))
    } else if (target.kind === 'subagent') {
      const entry = drafts.body !== defaultTemplate ? { prompt: drafts.body } : {}
      saveBuiltinPromptOverrides(applySubAgentOverrideEntry(overrides, target.subKind, language, entry))
    }
    onSaved()
    onClose()
  }

  const restore = () => {
    if (designPreview || !target) return
    const overrides = getBuiltinPromptOverrides()
    if (target.kind === 'skill') {
      saveBuiltinPromptOverrides(clearSkillOverride(overrides, target.name, language))
    } else {
      saveBuiltinPromptOverrides(clearSubAgentOverride(overrides, target.subKind, language))
    }
    // 重填草稿为恢复后的默认值（revision 变化触发 effect 重跑）。
    setRevision((value) => value + 1)
    onSaved()
  }

  return (
    <div className="builtin-prompt-editor__backdrop" role="presentation">
      <form
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal={designPreview ? undefined : true}
        className="builtin-prompt-editor"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            if (!designPreview) onClose()
            return
          }
          if (!designPreview) trapDialogFocus(event, dialogRef.current)
        }}
        onSubmit={save}
        ref={dialogRef}
        role="dialog"
      >
        <header className="builtin-prompt-editor__header">
          <div className="builtin-prompt-editor__heading">
            <div className="eyebrow">
              {target.kind === 'skill'
                ? t('settings.promptEditor.eyebrow.skill')
                : t('settings.promptEditor.eyebrow.subagent')}
            </div>
            <h2 className="builtin-prompt-editor__title" id={titleId}>{title}</h2>
          </div>
          {modified && (
            <span className="settings__badge settings__badge--shadowed">{t('settings.promptEditor.modified')}</span>
          )}
          <button
            aria-label={t('settings.promptEditor.cancel')}
            className="builtin-prompt-editor__close"
            onClick={() => { if (!designPreview) onClose() }}
            type="button"
          >
            <X size={14} />
          </button>
        </header>

        <p className="builtin-prompt-editor__description" id={descriptionId}>
          {t('settings.promptEditor.hint')}
        </p>

        <div className="builtin-prompt-editor__tabs" role="tablist" aria-label={t('settings.promptEditor.language')}>
          {LANGUAGES.map((code) => (
            <button
              key={code}
              type="button"
              role="tab"
              aria-selected={language === code}
              className={`builtin-prompt-editor__tab${language === code ? ' builtin-prompt-editor__tab--active' : ''}`}
              onClick={() => setLanguage(code)}
            >
              {code === 'zh-CN' ? '中文' : 'English'}
              {isModified(target, code, designPreview) && <span className="builtin-prompt-editor__dot" aria-hidden="true" />}
            </button>
          ))}
        </div>

        <div className="builtin-prompt-editor__body">
          {target.kind === 'skill' && (
            <label className="builtin-prompt-editor__field">
              <span>{t('settings.promptEditor.descriptionLabel')}</span>
              <input
                onChange={(event) => setDrafts((current) => ({ ...current, description: event.target.value }))}
                value={drafts.description}
              />
            </label>
          )}
          <label className="builtin-prompt-editor__field">
            <span>
              {target.kind === 'skill'
                ? t('settings.promptEditor.bodyLabel')
                : t('settings.promptEditor.templateLabel')}
            </span>
            <textarea
              className="builtin-prompt-editor__textarea"
              data-dialog-initial-focus
              onChange={(event) => setDrafts((current) => ({ ...current, body: event.target.value }))}
              rows={target.kind === 'skill' ? 14 : 18}
              spellCheck={false}
              value={drafts.body}
              wrap="off"
            />
          </label>
          {target.kind === 'subagent' && (
            <>
              <p className="settings__hint">{t('settings.promptEditor.templateHint')}</p>
              <details className="builtin-prompt-editor__preview">
                <summary>{t('settings.promptEditor.preview')}</summary>
                <pre>{preview}</pre>
              </details>
            </>
          )}
        </div>

        <footer className="builtin-prompt-editor__footer">
          <button
            className="settings__button builtin-prompt-editor__restore"
            disabled={!modified}
            onClick={restore}
            type="button"
          >
            <RotateCcw size={13} />
            {t('settings.promptEditor.restore')}
          </button>
          <div className="builtin-prompt-editor__footer-spacer" />
          {saveError && <span className="settings__error" role="alert">{saveError}</span>}
          <button className="settings__button" onClick={() => { if (!designPreview) onClose() }} type="button">
            {t('settings.promptEditor.cancel')}
          </button>
          <button className="settings__button settings__button--primary" type="submit">
            {t('settings.promptEditor.save')}
          </button>
        </footer>
      </form>
    </div>
  )
}
