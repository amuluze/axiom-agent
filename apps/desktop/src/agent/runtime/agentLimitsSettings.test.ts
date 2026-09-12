import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_LIMITS_SETTINGS,
  MAX_TOOL_CALLS_LIMIT,
  MAX_TURNS_LIMIT,
  normalizeAgentLimitsSettings,
  resolveAgentLimitsSettings,
} from './agentLimitsSettings'

describe('agent limits settings', () => {
  it('clamps out-of-range values to the configured bounds', () => {
    // 0 / negative are finite numbers → clamped to the minimum floor (1), not the default
    expect(normalizeAgentLimitsSettings({ maxTurns: 0, maxToolCalls: -5 }))
      .toEqual({ maxTurns: 1, maxToolCalls: 1 })
    expect(normalizeAgentLimitsSettings({
      maxTurns: 99_999,
      maxToolCalls: 99_999,
    })).toEqual({ maxTurns: MAX_TURNS_LIMIT, maxToolCalls: MAX_TOOL_CALLS_LIMIT })
  })

  it('rounds non-integer numeric input', () => {
    expect(normalizeAgentLimitsSettings({ maxTurns: 23.7, maxToolCalls: 60.4 }))
      .toEqual({ maxTurns: 24, maxToolCalls: 60 })
  })

  it('falls back to defaults for non-object or malformed input', () => {
    expect(normalizeAgentLimitsSettings(null)).toEqual(DEFAULT_AGENT_LIMITS_SETTINGS)
    expect(normalizeAgentLimitsSettings('not-an-object')).toEqual(DEFAULT_AGENT_LIMITS_SETTINGS)
    expect(normalizeAgentLimitsSettings([1, 2])).toEqual(DEFAULT_AGENT_LIMITS_SETTINGS)
  })

  it('parses a valid JSON payload and falls back on invalid JSON', () => {
    expect(resolveAgentLimitsSettings(JSON.stringify({ maxTurns: 64, maxToolCalls: 200 })))
      .toEqual({ maxTurns: 64, maxToolCalls: 200 })
    expect(resolveAgentLimitsSettings(null)).toEqual(DEFAULT_AGENT_LIMITS_SETTINGS)
    expect(resolveAgentLimitsSettings('{invalid')).toEqual(DEFAULT_AGENT_LIMITS_SETTINGS)
  })
})
