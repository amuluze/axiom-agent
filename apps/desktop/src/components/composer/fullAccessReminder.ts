/** 完全访问持续开启的软提醒阈值：到点只提示，不自动降级。 */
export const FULL_ACCESS_REMINDER_MS = 30 * 60 * 1000

/**
 * 距离下一次提醒还有多久。`startedAt` 是进入 no-approval 的时刻，`now` 由调用方注入
 * 以便测试；已超过阈值返回 0（立即提醒），而不是负数。
 */
export const fullAccessReminderDelay = (
  startedAt: number,
  now: number,
  threshold = FULL_ACCESS_REMINDER_MS,
): number => Math.max(0, threshold - Math.max(0, now - startedAt))

/** 是否已到软提醒点。 */
export const isFullAccessReminderDue = (
  startedAt: number,
  now: number,
  threshold = FULL_ACCESS_REMINDER_MS,
): boolean => now - startedAt >= threshold
