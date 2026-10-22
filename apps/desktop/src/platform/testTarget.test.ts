import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { issueTestTargetGrant, revokeTestTargetGrant } from './testTarget'

describe('test target grant platform wrappers', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
  })

  it('sends the expected origin and returns the Rust-issued grant', async () => {
    mocks.invoke.mockResolvedValue({
      runId: 'run-1',
      tabId: 'tab-1',
      origin: 'https://shop.test',
      workspaceGeneration: 2,
      viewport: { width: 1280, height: 800 },
    })
    const grant = await issueTestTargetGrant({
      runId: 'run-1',
      tabId: 'tab-1',
      expectedOrigin: 'https://shop.test',
      viewport: { width: 1280, height: 800 },
    })
    expect(mocks.invoke).toHaveBeenCalledWith('issue_test_target_grant', {
      request: {
        runId: 'run-1',
        tabId: 'tab-1',
        expectedOrigin: 'https://shop.test',
        viewport: { width: 1280, height: 800 },
      },
    })
    expect(grant.workspaceGeneration).toBe(2)
  })

  it('revokes by run id', async () => {
    mocks.invoke.mockResolvedValue(true)
    await expect(revokeTestTargetGrant('run-1')).resolves.toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith('revoke_test_target_grant', { runId: 'run-1' })
  })
})
