import type { TestTargetSpec } from '@/agent/testing/spec/types'
import type {
  EnvironmentApprovalMode,
  EnvironmentTlsTrust,
} from '@/agent/testing/environment/environmentFile'
import { trustedScopeOrigins } from '@/agent/testing/environment/trustScope'
import type { TestEnvironmentRecord } from '@/platform/testEnvironments'

export interface TestEnvironmentRuntimeConfig {
  values: Readonly<Record<string, string>>
  targetOverrides: Partial<TestTargetSpec>
  api: {
    allowPrivateNetwork: boolean
    headers: Readonly<Record<string, string>>
    secretIds: readonly string[]
    /** v23：证书校验策略。 */
    tlsTrust: EnvironmentTlsTrust
    /**
     * v23：审批档。`trusted` 时驱动层跳过 WebView 审批卡——**Rust 侧才是权威**
     * （它按 SQLite 里的环境记录独立判定），这里只是让界面与实际放行行为一致。
     */
    approvalMode: EnvironmentApprovalMode
    /** v23：Secret 允许发往的额外 origin（受信作用域的一部分）。 */
    secretOrigins: readonly string[]
  }
  /**
   * v23：受信环境的放行作用域（origin 集合）。空数组 = 不受信，逐次审批照旧。
   * 权威判定在 Rust 侧；这里只驱动界面是否弹审批卡。
   */
  trustedOrigins: readonly string[]
}

export const testEnvironmentRuntimeConfig = (
  environment: TestEnvironmentRecord | undefined,
): TestEnvironmentRuntimeConfig => {
  if (!environment) return {
    values: {},
    targetOverrides: {},
    api: {
      allowPrivateNetwork: false,
      headers: {},
      secretIds: [],
      tlsTrust: 'system',
      approvalMode: 'per_step',
      secretOrigins: [],
    },
    trustedOrigins: [],
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
  let secretOrigins: string[] = []
  try {
    const parsed: unknown = JSON.parse(environment.secretOriginsJson || '[]')
    if (Array.isArray(parsed)) secretOrigins = parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    secretOrigins = []
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
      tlsTrust: environment.tlsTrust,
      approvalMode: environment.approvalMode,
      secretOrigins,
    },
    // 受信作用域只在受信档下非空：作用域为空即「没有可免审批的目标」。
    trustedOrigins: environment.approvalMode === 'trusted'
      ? trustedScopeOrigins({
        webBaseUrl: environment.webBaseUrl,
        apiBaseUrl: environment.apiBaseUrl,
        secretOrigins,
      })
      : [],
  }
}
