import type { TestSpecIndexEntry } from './testSpecIndex'

export type TestSpecTypeFilter = 'all' | 'ui' | 'api' | 'mixed'

export const testSpecType = (spec: TestSpecIndexEntry): Exclude<TestSpecTypeFilter, 'all'> | null => {
  if (!spec.valid) return null
  if (spec.uiStepCount > 0 && spec.apiStepCount > 0) return 'mixed'
  if (spec.apiStepCount > 0) return 'api'
  return 'ui'
}

export const matchesTestSpecType = (
  spec: TestSpecIndexEntry,
  filter: TestSpecTypeFilter,
): boolean => filter === 'all' || testSpecType(spec) === filter
