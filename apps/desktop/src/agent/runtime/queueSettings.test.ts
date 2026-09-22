import { describe, expect, it } from 'vitest'
import {
  DEFAULT_QUEUE_MODE_SETTINGS,
  normalizeQueueModeSettings,
  resolveQueueModeSettings,
} from './queueSettings'

describe('queue mode settings', () => {
  it('accepts only supported persisted delivery modes', () => {
    expect(normalizeQueueModeSettings({ steering: 'all', followUp: 'one-at-a-time' })).toEqual({
      steering: 'all',
      followUp: 'one-at-a-time',
      autoDrain: true,
    })
    expect(normalizeQueueModeSettings({ steering: 'invalid', followUp: 'all' })).toEqual({
      steering: 'one-at-a-time',
      followUp: 'all',
      autoDrain: true,
    })
  })

  it('defaults autoDrain to true and only accepts booleans (旧会话 payload 无此字段)', () => {
    expect(normalizeQueueModeSettings({ steering: 'all', followUp: 'all', autoDrain: false })).toEqual({
      steering: 'all',
      followUp: 'all',
      autoDrain: false,
    })
    expect(normalizeQueueModeSettings({ steering: 'all', followUp: 'all', autoDrain: 'off' }).autoDrain)
      .toBe(true)
  })

  it('falls back safely for absent or malformed persisted JSON', () => {
    expect(resolveQueueModeSettings(null)).toEqual(DEFAULT_QUEUE_MODE_SETTINGS)
    expect(resolveQueueModeSettings('{')).toEqual(DEFAULT_QUEUE_MODE_SETTINGS)
  })
})
