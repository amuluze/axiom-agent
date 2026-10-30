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
      extraVarsJson: '{}',
      secretOriginsJson: '[]',
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

describe('testEnvironmentRuntimeConfig v2（自定义服务变量）', () => {
  const record = {
    id: 'env-v2',
    name: '多服务',
    kind: 'remote' as const,
    recipeJson: null,
    webBaseUrl: 'http://127.0.0.1:5173',
    apiBaseUrl: 'http://127.0.0.1:8090',
    viewportWidth: null,
    viewportHeight: null,
    allowPrivateNetwork: true,
    headersJson: '{}',
    secretIdsJson: '[]',
    extraVarsJson: '{}',
    secretOriginsJson: '[]',
    createdAt: 1,
    updatedAt: 2,
  }
  it('merges extra service vars into values and keeps reserved columns authoritative', () => {
    const config = testEnvironmentRuntimeConfig({
      ...record,
      extraVarsJson: JSON.stringify({
        DETECTOR_MGMT_URL: 'http://127.0.0.1:18081',
        DATA_PLANE_URL: 'http://127.0.0.1:8081',
        API_BASE_URL: 'http://ignored.example',
      }),
    })
    expect(config.values).toMatchObject({
      WEB_BASE_URL: 'http://127.0.0.1:5173',
      API_BASE_URL: 'http://127.0.0.1:8090',
      DATA_PLANE_URL: 'http://127.0.0.1:8081',
      DETECTOR_MGMT_URL: 'http://127.0.0.1:18081',
    })
    expect(config.values.API_BASE_URL).toBe('http://127.0.0.1:8090')
  })

  it('ignores a corrupted extraVarsJson instead of failing the whole run', () => {
    const config = testEnvironmentRuntimeConfig({ ...record, extraVarsJson: '{not json' })
    expect(config.values.DETECTOR_MGMT_URL).toBeUndefined()
    expect(config.values.API_BASE_URL).toBe('http://127.0.0.1:8090')
  })
})
