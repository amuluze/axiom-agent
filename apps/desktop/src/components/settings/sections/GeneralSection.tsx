import { Coffee, GitBranch, Languages, MonitorCog, Terminal, Type } from 'lucide-react'
import {
  MONO_FONT_FAMILY_OPTIONS,
  UI_FONT_SIZE_OPTIONS,
  useUiStore,
  type MonoFontFamily,
  type UiLanguage,
  type UiTheme,
} from '@/stores/uiStore'
import { useT } from '@/i18n'

/** 等宽字体选项的中文展示名；顺序与 MONO_FONT_FAMILY_OPTIONS 一致。 */
const MONO_FONT_FAMILY_LABELS: Record<MonoFontFamily, string> = {
  jetbrains: 'JetBrains Mono',
  menlo: 'Menlo',
  'sf-mono': 'SF Mono',
  monaco: 'Monaco',
}

export const GeneralSection = () => {
  const { t } = useT()
  const language = useUiStore((state) => state.language)
  const theme = useUiStore((state) => state.theme)
  const fontSizePx = useUiStore((state) => state.fontSizePx)
  const monoFontFamily = useUiStore((state) => state.monoFontFamily)
  const setLanguage = useUiStore((state) => state.setLanguage)
  const setTheme = useUiStore((state) => state.setTheme)
  const setFontSizePx = useUiStore((state) => state.setFontSizePx)
  const setMonoFontFamily = useUiStore((state) => state.setMonoFontFamily)
  const gitBranchPrefix = useUiStore((state) => state.gitBranchPrefix)
  const setGitBranchPrefix = useUiStore((state) => state.setGitBranchPrefix)
  const preventIdleSleep = useUiStore((state) => state.preventIdleSleep)
  const setPreventIdleSleep = useUiStore((state) => state.setPreventIdleSleep)

  return (
    <section className="settings-section" id="settings-general">
      <div className="section-title">
        <span>{t('settings.general.section.interface')}</span>
        <span className="section-state">{t('settings.general.state.instant')}</span>
      </div>
      <div className="settings-grid settings-grid--equal">
        <label>
          <span className="settings__field-label-with-icon"><Languages size={13} />{t('settings.general.language.label')}</span>
          <select
            aria-label={t('settings.general.language.label')}
            value={language}
            onChange={(event) => setLanguage(event.target.value as UiLanguage)}
          >
            <option value="system">{t('settings.general.language.option.system')}</option>
            <option value="zh-CN">{t('settings.general.language.option.zhCN')}</option>
            <option value="en">{t('settings.general.language.option.en')}</option>
          </select>
          <small>{t('settings.general.language.hint')}</small>
        </label>
        <label>
          <span className="settings__field-label-with-icon"><MonitorCog size={13} />{t('settings.general.theme.label')}</span>
          <select
            aria-label={t('settings.general.theme.label')}
            value={theme}
            onChange={(event) => setTheme(event.target.value as UiTheme)}
          >
            <option value="system">{t('settings.general.theme.option.system')}</option>
            <option value="dark">{t('settings.general.theme.option.dark')}</option>
            <option value="light">{t('settings.general.theme.option.light')}</option>
          </select>
          <small>{t('settings.general.theme.hint')}</small>
        </label>
        <label>
          <span className="settings__field-label-with-icon"><Type size={13} />{t('settings.general.fontSize.label')}</span>
          <select
            aria-label={t('settings.general.fontSize.label')}
            value={fontSizePx}
            onChange={(event) => setFontSizePx(Number(event.target.value))}
          >
            {UI_FONT_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>{size}px</option>
            ))}
          </select>
          <small>{t('settings.general.fontSize.hint')}</small>
        </label>
        <label>
          <span className="settings__field-label-with-icon"><Terminal size={13} />{t('settings.general.mono.label')}</span>
          <select
            aria-label={t('settings.general.mono.label')}
            value={monoFontFamily}
            onChange={(event) => setMonoFontFamily(event.target.value as MonoFontFamily)}
          >
            {MONO_FONT_FAMILY_OPTIONS.map((family) => (
              <option key={family} value={family}>{MONO_FONT_FAMILY_LABELS[family]}</option>
            ))}
          </select>
          <small>{t('settings.general.mono.hint')}</small>
        </label>
      </div>

      <div className="settings__group-gap" aria-hidden="true" />
      <div className="section-title">
        <span>{t('settings.general.section.git')}</span>
        <span className="section-state">{t('settings.general.state.instant')}</span>
      </div>
      <div className="settings-grid settings-grid--third">
        <label>
          <span className="settings__field-label-with-icon"><GitBranch size={13} />{t('settings.general.git.prefix.label')}</span>
          <input
            type="text"
            aria-label={t('settings.general.git.prefix.aria')}
            value={gitBranchPrefix}
            onChange={(event) => setGitBranchPrefix(event.target.value)}
            placeholder={t('settings.general.git.prefix.placeholder')}
          />
          <small>{t('settings.general.git.prefix.hint')}</small>
        </label>
      </div>

      <div className="settings__group-gap" aria-hidden="true" />
      <div className="section-title">
        <span>{t('settings.general.section.power')}</span>
        <span className="section-state">{t('settings.general.state.global')}</span>
      </div>
      <div className="settings-grid">
        <label className="settings__toggle">
          <input
            type="checkbox"
            aria-label={t('settings.general.power.sleep.label')}
            checked={preventIdleSleep}
            onChange={(event) => setPreventIdleSleep(event.target.checked)}
          />
          <span className="settings__toggle-body">
            <span className="settings__field-label-with-icon"><Coffee size={13} />{t('settings.general.power.sleep.label')}</span>
            <small>
              {t('settings.general.power.sleep.hint')}
            </small>
          </span>
        </label>
      </div>
    </section>
  )
}
