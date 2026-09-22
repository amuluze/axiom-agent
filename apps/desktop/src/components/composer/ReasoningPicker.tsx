import { useCallback, useMemo, useRef, useState } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import { useAgentStore } from '@/stores/agentStore'
import { resolveModelDescriptor } from '@/agent/transport/provider'
import type { ReasoningSettings } from '@/agent/runtime/reasoningSettings'
import { useUpwardMenuClamp } from '@/components/composer/useUpwardMenuClamp'
import { useT } from '@/i18n'

const LEVELS: ReasoningSettings['level'][] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

const LEVEL_LABEL_KEYS: Record<ReasoningSettings['level'], string> = {
  off: 'settings.reasoning.level.off',
  minimal: 'settings.reasoning.level.minimal',
  low: 'settings.reasoning.level.low',
  medium: 'settings.reasoning.level.medium',
  high: 'settings.reasoning.level.high',
  xhigh: 'settings.reasoning.level.xhigh',
  max: 'settings.reasoning.level.max',
}

const MODES: ReasoningSettings['mode'][] = ['effort', 'adaptive', 'enabled']

const MODE_LABEL_KEYS: Record<ReasoningSettings['mode'], string> = {
  effort: 'settings.reasoning.mode.effort',
  adaptive: 'settings.reasoning.mode.adaptive',
  enabled: 'settings.reasoning.mode.enabled',
}

/**
 * 会话输入框的推理强度选择：替代原设置页 Reasoning Runtime 卡片。等级即时生效
 * （saveReasoningSettings 负责归一化、空闲 Runtime 更新与本地持久化）；
 * Anthropic-compatible 且强度非关闭时附推理模式组。当前模型未声明推理能力、
 * demo Provider 或设置未完成时整体隐藏。
 */
export const ReasoningPicker = ({ disabled = false }: { disabled?: boolean }) => {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pickerRef = useRef<HTMLDivElement | null>(null)
  useUpwardMenuClamp(pickerRef, open)

  const provider = useAgentStore((state) => state.provider)
  const reasoning = useAgentStore((state) => state.reasoningSettings)
  const saveReasoningSettings = useAgentStore((state) => state.saveReasoningSettings)
  const providerSetupRequired = useAgentStore((state) => state.providerSetupRequired)

  // 仅当目录内模型「明确声明不支持推理」时隐藏；目录外模型（中转站/自定义
  // modelId）能力未知，与设置页口径一致视为支持，不隐藏入口。
  const supportsReasoning = useMemo(() => {
    try {
      const descriptor = resolveModelDescriptor(provider)
      return descriptor.source === 'profile-compatibility' || descriptor.supportsReasoning !== false
    } catch {
      return true
    }
  }, [provider])

  const apply = useCallback(async (next: ReasoningSettings) => {
    setSaving(true)
    setError(null)
    const ok = await saveReasoningSettings(next)
    setSaving(false)
    if (ok) {
      setOpen(false)
      return
    }
    setError(useAgentStore.getState().settingsError ?? '保存失败')
  }, [saveReasoningSettings])

  const applyLevel = (level: ReasoningSettings['level']) => {
    if (level === reasoning.level) {
      setOpen(false)
      return
    }
    void apply({ ...reasoning, level })
  }

  const applyMode = (mode: ReasoningSettings['mode']) => {
    if (mode === reasoning.mode) return
    void apply({ ...reasoning, mode })
  }

  const toggle = () => {
    setError(null)
    setOpen((current) => !current)
  }

  if (providerSetupRequired || provider.apiFormat === 'demo' || !supportsReasoning) return null

  const modeSelectable = provider.apiFormat === 'anthropic-compatible' && reasoning.level !== 'off'

  return (
    <div className="composer__reasoning-picker" ref={pickerRef}>
      <button
        aria-expanded={open}
        aria-label={t('app.composer.reasoning.aria')}
        className={`composer__reasoning${reasoning.level === 'off' ? ' composer__reasoning--off' : ''}`}
        disabled={disabled || saving}
        onClick={toggle}
        title={t('app.composer.reasoning.aria')}
        type="button"
      >
        <Brain size={13} />
        <span>{t(LEVEL_LABEL_KEYS[reasoning.level])}</span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="composer__reasoning-menu" role="menu">
          <div className="composer__menu-title">{t('app.composer.reasoning.title')}</div>
          {LEVELS.map((level) => (
            <button
              aria-checked={level === reasoning.level}
              className={`composer__menu-item${level === reasoning.level ? ' composer__menu-item--active' : ''}`}
              disabled={saving}
              key={level}
              onClick={() => void applyLevel(level)}
              role="menuitemradio"
              type="button"
            >
              {t(LEVEL_LABEL_KEYS[level])}
            </button>
          ))}
          {modeSelectable && (
            <>
              <div className="composer__menu-title">{t('app.composer.reasoning.modeTitle')}</div>
              {MODES.map((mode) => (
                <button
                  aria-checked={mode === reasoning.mode}
                  className={`composer__menu-item${mode === reasoning.mode ? ' composer__menu-item--active' : ''}`}
                  disabled={saving}
                  key={mode}
                  onClick={() => applyMode(mode)}
                  role="menuitemradio"
                  type="button"
                >
                  {t(MODE_LABEL_KEYS[mode])}
                </button>
              ))}
            </>
          )}
          {error && (
            <p className="composer__reasoning-error" role="alert">{error}</p>
          )}
        </div>
      )}
    </div>
  )
}
