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
  // v2：环境档的自定义大写变量（多服务端点）。两列保留名优先，JSON 里的同名键不应出现
  //（环境档导入已排除），仍按「列优先」合并以防手写记录把语义覆盖。
  let extraVars: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(environment.extraVarsJson || '{}')
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      extraVars = parsed as Record<string, unknown>
    }
  } catch {
    extraVars = {}
  }
  for (const [name, value] of Object.entries(extraVars).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof value === 'string' && values[name] === undefined) values[name] = value
  }
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
