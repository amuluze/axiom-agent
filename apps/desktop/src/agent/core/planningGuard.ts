import { byteLength } from './bytes'

export const PLANNING_GUARD_DIAGNOSTIC = 'planning-guard-interrupt'

const MIN_OBSERVED_BYTES = 8 * 1024
const LONG_OBSERVED_BYTES = 32 * 1024
const MAX_WINDOW_CHARACTERS = 48 * 1024
const MIN_PLANNING_UNITS = 8
const MIN_LONG_PLANNING_UNITS = 16

const planningPattern = /(?:\b(?:i|we)\s+(?:need|should|must|will|have)\s+(?:to\s+)?|\blet\s+me\b|\bnext\s+(?:i|we|step)\b|(?:我|我们)?(?:需要|应该|必须|接下来|下一步|先|然后|再|让我|我要|得先))/iu

const normalizedUnit = (value: string): string => value
  .toLocaleLowerCase('en-US')
  .replace(/[\d\p{P}\p{S}\s]+/gu, ' ')
  .trim()
  .slice(0, 240)

const planningUnits = (value: string): string[] => value
  .split(/[。！？.!?\n]+/u)
  .map((unit) => unit.trim())
  .filter((unit) => unit.length >= 12 && planningPattern.test(unit))
  .map(normalizedUnit)
  .filter((unit) => unit.length >= 8)

export class PlanningStreamGuard {
  private observedBytes = 0
  private window = ''

  observe(delta: string): boolean {
    if (!delta) return false
    this.observedBytes += byteLength(delta)
    this.window = `${this.window}${delta}`.slice(-MAX_WINDOW_CHARACTERS)
    if (this.observedBytes < MIN_OBSERVED_BYTES) return false

    const units = planningUnits(this.window)
    if (units.length < MIN_PLANNING_UNITS) return false
    const counts = new Map<string, number>()
    for (const unit of units) counts.set(unit, (counts.get(unit) ?? 0) + 1)
    if ([...counts.values()].some((count) => count >= 3)) return true
    return this.observedBytes >= LONG_OBSERVED_BYTES && units.length >= MIN_LONG_PLANNING_UNITS
  }
}
