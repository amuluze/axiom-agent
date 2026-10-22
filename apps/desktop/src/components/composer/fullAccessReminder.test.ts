import { describe, expect, it } from 'vitest'
import {
  FULL_ACCESS_REMINDER_MS,
  fullAccessReminderDelay,
  isFullAccessReminderDue,
} from './fullAccessReminder'

describe('fullAccessReminder', () => {
  it('reports the remaining delay before the soft reminder', () => {
    expect(fullAccessReminderDelay(1_000, 1_000)).toBe(FULL_ACCESS_REMINDER_MS)
    expect(fullAccessReminderDelay(1_000, 1_000 + FULL_ACCESS_REMINDER_MS - 1)).toBe(1)
  })

  it('is due at and after the threshold, never returning a negative delay', () => {
    expect(isFullAccessReminderDue(1_000, 1_000 + FULL_ACCESS_REMINDER_MS - 1)).toBe(false)
    expect(isFullAccessReminderDue(1_000, 1_000 + FULL_ACCESS_REMINDER_MS)).toBe(true)
    expect(fullAccessReminderDelay(1_000, 1_000 + FULL_ACCESS_REMINDER_MS * 2)).toBe(0)
  })

  it('tolerates a clock that moves backwards', () => {
    expect(fullAccessReminderDelay(2_000, 1_000)).toBe(FULL_ACCESS_REMINDER_MS)
    expect(isFullAccessReminderDue(2_000, 1_000)).toBe(false)
  })
})
