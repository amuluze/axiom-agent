let fallbackSequence = 0

export const createId = (prefix: string): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }

  fallbackSequence += 1
  return `${prefix}-${Date.now()}-${fallbackSequence}`
}
