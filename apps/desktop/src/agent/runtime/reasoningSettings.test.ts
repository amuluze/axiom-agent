import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REASONING_SETTINGS,
  normalizeReasoningSettings,
  resolveReasoningSettings,
  toModelReasoning,
} from './reasoningSettings'

describe('reasoning settings', () => {
  it('defaults the composer picker to high effort', () => {
    expect(DEFAULT_REASONING_SETTINGS.level).toBe('high')
    expect(resolveReasoningSettings(null, 'openai-compatible', 8_192)).toEqual({
      level: 'high',
      mode: 'effort',
      budgetTokens: DEFAULT_REASONING_SETTINGS.budgetTokens,
    })
  })

  it('restores only supported values and clamps token budgets', () => {
    expect(normalizeReasoningSettings({
      level: 'high',
      mode: 'enabled',
      budgetTokens: 99_999,
    }, 'anthropic-compatible', 8_192)).toEqual({
      level: 'high',
      mode: 'enabled',
      budgetTokens: 8_191,
    })
    expect(resolveReasoningSettings('{', 'anthropic-compatible', 4_096))
      .toEqual(DEFAULT_REASONING_SETTINGS)
  })

  it('forces provider-safe modes and disables reasoning for Demo', () => {
    expect(normalizeReasoningSettings({
      level: 'medium',
      mode: 'adaptive',
      budgetTokens: 4_096,
    }, 'openai-compatible', 8_192)).toEqual({
      level: 'medium',
      mode: 'effort',
      budgetTokens: 4_096,
    })
    expect(normalizeReasoningSettings({
      level: 'high',
      mode: 'enabled',
      budgetTokens: 4_096,
    }, 'demo', 8_192)).toEqual(DEFAULT_REASONING_SETTINGS)
  })

  it('creates a bounded runtime request without weakening model capability checks', () => {
    expect(toModelReasoning({
      level: 'high',
      mode: 'enabled',
      budgetTokens: 4_096,
    }, {
      provider: 'anthropic-compatible',
      model: 'model',
      maxOutputTokens: 8_192,
      supportsReasoning: true,
    })).toEqual({ level: 'high', mode: 'enabled', budgetTokens: 4_096 })
    expect(toModelReasoning({
      level: 'high',
      mode: 'effort',
      budgetTokens: 4_096,
    }, {
      provider: 'test',
      model: 'model',
      supportsReasoning: false,
    })).toBeUndefined()
  })
})
