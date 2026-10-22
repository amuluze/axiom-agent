import { describe, expect, it } from 'vitest'
import type { TestSpecIndexEntry } from './testSpecIndex'
import { matchesTestSpecType, testSpecType } from './testSpecFilter'

const spec = (uiStepCount: number, apiStepCount: number, valid = true): TestSpecIndexEntry => ({
  path: 'tests/sample.testspec.json',
  valid,
  id: valid ? 'sample' : null,
  name: valid ? 'Sample' : null,
  caseCount: 1,
  stepCount: uiStepCount + apiStepCount,
  uiStepCount,
  apiStepCount,
  issues: [],
      testPointIds: [],
      caseIds: [],
      caseVerifies: [],
})

describe('testSpecType', () => {
  it('classifies UI, API and mixed specs', () => {
    expect(testSpecType(spec(2, 0))).toBe('ui')
    expect(testSpecType(spec(0, 2))).toBe('api')
    expect(testSpecType(spec(1, 1))).toBe('mixed')
  })

  it('keeps invalid specs visible only in the all filter', () => {
    const invalid = spec(0, 0, false)
    expect(matchesTestSpecType(invalid, 'all')).toBe(true)
    expect(matchesTestSpecType(invalid, 'ui')).toBe(false)
  })
})
