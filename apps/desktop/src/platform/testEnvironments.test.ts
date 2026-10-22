import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import {
  deleteTestEnvironmentRecord,
  listTestEnvironmentRecords,
  saveTestEnvironmentRecord,
} from './testEnvironments'

describe('test environment wrappers', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
  })

  it('normalizes optional values before saving', async () => {
    mocks.invoke.mockResolvedValue(true)
    await saveTestEnvironmentRecord({
      id: 'env-1',
      name: '本地',
      allowPrivateNetwork: false,
      headersJson: '{}',
      secretIdsJson: '[]',
      updatedAt: 42,
    })
    expect(mocks.invoke).toHaveBeenCalledWith('save_test_environment_record', {
      environment: expect.objectContaining({
        webBaseUrl: null,
        apiBaseUrl: null,
        viewportWidth: null,
        viewportHeight: null,
        allowPrivateNetwork: false,
      }),
    })
  })

  it('lists and deletes environments through workspace-scoped commands', async () => {
    mocks.invoke.mockResolvedValueOnce([]).mockResolvedValueOnce(true)
    await expect(listTestEnvironmentRecords()).resolves.toEqual([])
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'list_test_environment_records')
    await expect(deleteTestEnvironmentRecord('env-1')).resolves.toBe(true)
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'delete_test_environment_record', { environmentId: 'env-1' })
  })
})
