export type QueueDeliveryMode = 'one-at-a-time' | 'all'

export interface QueueModeSettings {
  steering: QueueDeliveryMode
  followUp: QueueDeliveryMode
}

export const DEFAULT_QUEUE_MODE_SETTINGS: QueueModeSettings = {
  steering: 'one-at-a-time',
  followUp: 'one-at-a-time',
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
