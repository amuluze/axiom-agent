import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { deleteApiTestSecret, hasApiTestSecret, saveApiTestSecret } from './apiTestSecrets'

describe('API test secret wrappers', () => {
  beforeEach(() => mocks.invoke.mockReset())

  it('exposes save, existence and delete without a plaintext load command', async () => {
    mocks.invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(true).mockResolvedValueOnce(undefined)
    await saveApiTestSecret('apitest.token', 'secret')
    await expect(hasApiTestSecret('apitest.token')).resolves.toBe(true)
    await deleteApiTestSecret('apitest.token')
    expect(mocks.invoke.mock.calls).toEqual([
      ['save_api_test_secret', { key: 'apitest.token', value: 'secret' }],
      ['has_api_test_secret', { key: 'apitest.token' }],
      ['delete_api_test_secret', { key: 'apitest.token' }],
    ])
  })
})
