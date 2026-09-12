import type {
  ModelReasoning,
  ModelRef,
  ProviderApiFormat,
  ThinkingLevel,
} from '@/agent/core/types'

export interface ReasoningSettings {
  level: ThinkingLevel
  mode: NonNullable<ModelReasoning['mode']>
  budgetTokens: number
}

export const DEFAULT_REASONING_SETTINGS: ReasoningSettings = {
  level: 'off',
  mode: 'effort',
  budgetTokens: 4_096,
}

const LEVELS = new Set<ThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

const MODES = new Set<ReasoningSettings['mode']>(['effort', 'enabled', 'adaptive'])

/** Thinking token 预算的收敛上限：normalize 与设置页输入框共用，避免 UI 上限与保存收敛漂移。 */
export const reasoningBudgetCeiling = (maxOutputTokens: number): number =>
  Math.max(1_024, Math.min(64_000, Math.round(maxOutputTokens) - 1))

const boundedBudget = (value: unknown, maxOutputTokens: number): number => {
  const fallback = DEFAULT_REASONING_SETTINGS.budgetTokens
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(reasoningBudgetCeiling(maxOutputTokens), Math.max(1_024, parsed))
}

const boundedStoredBudget = (value: unknown): number => {
  const parsed = typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value)
    : DEFAULT_REASONING_SETTINGS.budgetTokens
  return Math.min(64_000, Math.max(1_024, parsed))
}

export const normalizeReasoningSettings = (
  value: unknown,
  provider: ProviderApiFormat,
  maxOutputTokens: number,
): ReasoningSettings => {
  if (provider === 'demo') return { ...DEFAULT_REASONING_SETTINGS }
  const candidate = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const level = LEVELS.has(candidate.level as ThinkingLevel)
    ? candidate.level as ThinkingLevel
    : DEFAULT_REASONING_SETTINGS.level
  const requestedMode = MODES.has(candidate.mode as ReasoningSettings['mode'])
    ? candidate.mode as ReasoningSettings['mode']
    : DEFAULT_REASONING_SETTINGS.mode
  const mode = provider === 'openai-compatible' || provider === 'openai-responses'
    || (requestedMode === 'enabled' && maxOutputTokens <= 1_024)
    ? 'effort'
    : requestedMode
  return {
    level,
    mode,
    budgetTokens: mode === 'enabled'
      ? boundedBudget(candidate.budgetTokens, maxOutputTokens)
      : boundedStoredBudget(candidate.budgetTokens),
  }
}

export const resolveReasoningSettings = (
  raw: string | null,
  provider: ProviderApiFormat,
  maxOutputTokens: number,
): ReasoningSettings => {
  if (!raw) return normalizeReasoningSettings(DEFAULT_REASONING_SETTINGS, provider, maxOutputTokens)
  try {
    return normalizeReasoningSettings(JSON.parse(raw), provider, maxOutputTokens)
  } catch {
    return normalizeReasoningSettings(DEFAULT_REASONING_SETTINGS, provider, maxOutputTokens)
  }
}

export const toModelReasoning = (
  settings: ReasoningSettings,
  model: ModelRef,
): ModelReasoning | undefined => {
  if (settings.level === 'off' || model.supportsReasoning === false) return undefined
  const mode = settings.mode === 'enabled' && (model.maxOutputTokens ?? 0) <= 1_024
    ? 'effort'
    : settings.mode
  return {
    level: settings.level,
    mode,
    ...(mode === 'enabled'
      ? { budgetTokens: boundedBudget(settings.budgetTokens, model.maxOutputTokens ?? 64_000) }
      : {}),
  }
}
