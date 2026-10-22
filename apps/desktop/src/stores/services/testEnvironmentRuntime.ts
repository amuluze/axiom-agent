import type { TestTargetSpec } from '@/agent/testing/spec/types'
import type { TestEnvironmentRecord } from '@/platform/testEnvironments'

export interface TestEnvironmentRuntimeConfig {
  values: Readonly<Record<string, string>>
  targetOverrides: Partial<TestTargetSpec>
  api: {
    allowPrivateNetwork: boolean
    headers: Readonly<Record<string, string>>
    secretIds: readonly string[]
  }
}

export const testEnvironmentRuntimeConfig = (
  environment: TestEnvironmentRecord | undefined,
): TestEnvironmentRuntimeConfig => {
  if (!environment) return {
    values: {},
    targetOverrides: {},
    api: { allowPrivateNetwork: false, headers: {}, secretIds: [] },
  }
  const values: Record<string, string> = {}
  if (environment.webBaseUrl) values.WEB_BASE_URL = environment.webBaseUrl
  if (environment.apiBaseUrl) values.API_BASE_URL = environment.apiBaseUrl
  return {
    values,
    targetOverrides: {
      ...(environment.webBaseUrl ? { webBaseUrl: environment.webBaseUrl } : {}),
      ...(environment.apiBaseUrl ? { apiBaseUrl: environment.apiBaseUrl } : {}),
      ...(environment.viewportWidth !== null && environment.viewportHeight !== null
        ? { viewport: { width: environment.viewportWidth, height: environment.viewportHeight } }
        : {}),
    },
    api: {
      allowPrivateNetwork: environment.allowPrivateNetwork,
      headers: JSON.parse(environment.headersJson) as Record<string, string>,
      secretIds: JSON.parse(environment.secretIdsJson) as string[],
    },
  }
}
