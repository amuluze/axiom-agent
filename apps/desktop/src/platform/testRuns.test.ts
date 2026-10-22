import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { getTestRunRecord, transitionTestStepRecord } from './testRuns'

describe('test run record wrappers', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
  })

  it('sends the step transition with camelCase arguments and an explicit null for absent evidence', async () => {
    mocks.invoke.mockResolvedValue(undefined)
    await transitionTestStepRecord('step-1', 'passed', 42)
    expect(mocks.invoke).toHaveBeenCalledWith('transition_test_step_record', {
      stepRunId: 'step-1',
      status: 'passed',
      now: 42,
      detailsJson: null,
      evidenceContentHash: null,
    })
  })

  it('returns null for a run outside the authorized workspace or an unknown run', async () => {
    mocks.invoke.mockResolvedValue(null)
    await expect(getTestRunRecord('missing')).resolves.toBeNull()
    expect(mocks.invoke).toHaveBeenCalledWith('get_test_run_record', { runId: 'missing' })
  })
})
