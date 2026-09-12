import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from './environment'

/**
 * Provider 用量查询：调用 Rust 侧 `query_provider_usage` command，查询已配置
 * Provider 的账户余额/额度。端点由 Rust 内置表权威决定（前端不传 URL），
 * API Key 仅在 Rust 请求期使用，不进入渲染进程。
 */

export interface UsageMetric {
  label: string
  used?: number
  total?: number
  remaining?: number
  unit: string
  resetsAt?: string
  detail?: string
}

export type UsageQueryKind = 'balance' | 'quota'

export interface UsageQueryResult {
  providerId: string
  kind: UsageQueryKind
  metrics: UsageMetric[]
  checkedAtMs: number
}

export interface UsageQueryRequestPayload {
  providerId: string
  secretId?: string
  /**
   * 用户在「设置 → 模型」配置的 chat endpoint。Rust 侧仅用于智谱国内/
   * 国际站（open.bigmodel.cn / api.z.ai）分流，且必须在官方站点白名单内，
   * 其余 host fail-closed 拒绝；其它 Provider 忽略该字段。
   */
  endpointHint?: string
}

/**
 * 支持用量查询的内置 Provider（与 Rust `usage_query::usage_endpoint` 表保持
 * 一致；此处仅用于 UI 预判避免无效请求，Rust 侧对未收录 provider 一律拒绝）。
 */
export const USAGE_QUERY_PROVIDER_IDS: readonly string[] = [
  'deepseek',
  'zhipu-glm',
  'kimi',
  'kimi-coding',
  'minimax-chat',
]

export const isUsageQueryableProvider = (providerId: string): boolean =>
  USAGE_QUERY_PROVIDER_IDS.includes(providerId)

/**
 * 格式化重置时间：Rust 侧归一为毫秒时间戳字符串或原样 ISO 字符串，
 * 两种形态 `new Date(...)` 都能解析；解析失败原样返回。
 */
export const formatUsageResetsAt = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  const date = new Date(/^\d+$/.test(value) ? Number(value) : value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

/**
 * 把 wire 数据中的 `null` 可选字段归一为 undefined（双保险：Rust 侧已用
 * skip_serializing_if 让 None 不进 JSON，此处防御任何残留的 null 形态——
 * TS 按 `field?: number` 判空，`null.toFixed` 会直接抛异常打崩页面）。
 */
const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const normalizeUsageMetric = (metric: UsageMetric): UsageMetric => ({
  label: metric.label,
  used: optionalNumber(metric.used),
  total: optionalNumber(metric.total),
  remaining: optionalNumber(metric.remaining),
  unit: metric.unit,
  resetsAt: optionalString(metric.resetsAt),
  detail: optionalString(metric.detail),
})

const normalizeUsageResult = (result: UsageQueryResult): UsageQueryResult => ({
  ...result,
  metrics: result.metrics.map(normalizeUsageMetric),
})

export const queryProviderUsage = async (
  request: UsageQueryRequestPayload,
): Promise<UsageQueryResult> => {
  if (!isTauriRuntime()) throw new Error('用量查询仅在 Axiom 桌面应用中可用')
  return invoke<UsageQueryResult>('query_provider_usage', { request })
    .then(normalizeUsageResult)
}
