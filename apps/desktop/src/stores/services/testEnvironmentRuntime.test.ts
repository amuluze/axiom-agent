import { describe, expect, it } from 'vitest'
import { testEnvironmentRuntimeConfig } from './testEnvironmentRuntime'

describe('testEnvironmentRuntimeConfig', () => {
  it('maps persisted base URLs and viewport to runtime values and overrides', () => {
    expect(testEnvironmentRuntimeConfig({
      id: 'env-1',
      name: '本地',
      kind: 'remote',
      recipeJson: null,
      webBaseUrl: 'http://localhost:5173',
      apiBaseUrl: 'http://localhost:8080',
      viewportWidth: 1440,
      viewportHeight: 900,
      allowPrivateNetwork: true,
      headersJson: '{"X-Test":"yes"}',
      secretIdsJson: '["apitest.token"]',
      createdAt: 1,
      updatedAt: 2,
    })).toEqual({
      values: {
        WEB_BASE_URL: 'http://localhost:5173',
        API_BASE_URL: 'http://localhost:8080',
      },
      targetOverrides: {
        webBaseUrl: 'http://localhost:5173',
        apiBaseUrl: 'http://localhost:8080',
        viewport: { width: 1440, height: 900 },
      },
      api: {
        allowPrivateNetwork: true,
        headers: { 'X-Test': 'yes' },
        secretIds: ['apitest.token'],
      },
    })
  })

  it('returns empty runtime data without a selected environment', () => {
    expect(testEnvironmentRuntimeConfig(undefined)).toEqual({
      values: {},
      targetOverrides: {},
      api: { allowPrivateNetwork: false, headers: {}, secretIds: [] },
    })
  })
})
