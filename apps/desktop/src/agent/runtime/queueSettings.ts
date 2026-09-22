export type QueueDeliveryMode = 'one-at-a-time' | 'all'

export interface QueueModeSettings {
  steering: QueueDeliveryMode
  followUp: QueueDeliveryMode
  /**
   * 队列自动出队开关（对齐 ZCode 的 setAutoDrain）：false 时 steering/follow-up
   * 停止在 turn 边界自动消费，改为用户经「立即发送」逐条放行；run 结束后残留
   * 保留在队列跨 run 存活，不回收为恢复草稿。
   */
  autoDrain: boolean
}

export const DEFAULT_QUEUE_MODE_SETTINGS: QueueModeSettings = {
  steering: 'one-at-a-time',
  followUp: 'one-at-a-time',
  autoDrain: true,
}

const isQueueDeliveryMode = (value: unknown): value is QueueDeliveryMode =>
  value === 'one-at-a-time' || value === 'all'

export const normalizeQueueModeSettings = (value: unknown): QueueModeSettings => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...DEFAULT_QUEUE_MODE_SETTINGS }
  }
  const candidate = value as Record<string, unknown>
  return {
    steering: isQueueDeliveryMode(candidate.steering)
      ? candidate.steering
      : DEFAULT_QUEUE_MODE_SETTINGS.steering,
    followUp: isQueueDeliveryMode(candidate.followUp)
      ? candidate.followUp
      : DEFAULT_QUEUE_MODE_SETTINGS.followUp,
    autoDrain: typeof candidate.autoDrain === 'boolean'
      ? candidate.autoDrain
      : DEFAULT_QUEUE_MODE_SETTINGS.autoDrain,
  }
}

export const resolveQueueModeSettings = (raw: string | null): QueueModeSettings => {
  if (!raw) return { ...DEFAULT_QUEUE_MODE_SETTINGS }
  try {
    return normalizeQueueModeSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_QUEUE_MODE_SETTINGS }
  }
}
