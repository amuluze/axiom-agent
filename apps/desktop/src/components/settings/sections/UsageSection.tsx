import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LockKeyhole, RefreshCw } from 'lucide-react'
import { useAgentStore } from '@/stores/agentStore'
import { isTauriRuntime } from '@/platform/environment'
import type { ProviderProfile } from '@/agent/transport/provider'
import {
  formatUsageResetsAt,
  isUsageQueryableProvider,
  queryProviderUsage,
  type UsageMetric,
  type UsageQueryResult,
} from '@/platform/usageQuery'
import { useT } from '@/i18n'
import { localizedProviderLabel } from '@/i18n/providerLabels'
import { localizeUsageMetricText } from './usageMetricLabels'

/**
 * 模型用量统计页：按「设置 → 模型」中已配置的 Provider Profile，调用各官方
 * 账户接口展示余额/额度。查询经 Rust `query_provider_usage` 权威执行——
 * 端点由 Rust 内置表决定、API Key 不进入渲染进程（见 platform/usageQuery）。
 */

type UsageStateStatus = 'idle' | 'loading' | 'done' | 'error'

interface ProviderUsageState {
  status: UsageStateStatus
  result?: UsageQueryResult
  error?: string
}

interface ProviderUsageGroup {
  providerId: string
  label: string
  profiles: ProviderProfile[]
  queryable: boolean
}

const USAGE_UNAVAILABLE_NOTES: Record<string, string> = {
  demo: 'settings.usage.note.demo',
  ollama: 'settings.usage.note.ollama',
}

// 可选字段用 typeof 守卫而非 `!== undefined`：wire 数据的历史形态（serde
// None 序列化为 null）会让 undefined 检查漏过 null 并抛 `null.toFixed`，
// 把整个设置页打崩（黑屏）。归一化在 platform 层，这里是最后防线。
const formatMetricValue = (metric: UsageMetric, t: (key: string, params?: Record<string, string | number>) => string): string => {
  if (typeof metric.remaining === 'number') {
    // 金额保留两位小数；百分比（MiniMax 剩余额度）取整更易读。
    const digits = metric.unit === '%' ? 0 : 2
    return t('settings.usage.remaining', { value: metric.remaining.toFixed(digits), unit: metric.unit }).trim()
  }
  if (typeof metric.used === 'number') {
    const unit = metric.unit === '%' ? '%' : ` ${metric.unit}`
    return t('settings.usage.used', { value: metric.used.toFixed(1), unit })
  }
  return t('settings.usage.dash')
}

const metricPercent = (metric: UsageMetric): number | undefined => {
  if (typeof metric.used !== 'number' || typeof metric.total !== 'number' || metric.total <= 0) {
    return undefined
  }
  return Math.min(100, Math.max(0, (metric.used / metric.total) * 100))
}

const metricBarTone = (percent: number): string => {
  if (percent >= 90) return 'critical'
  if (percent >= 70) return 'warn'
  return 'normal'
}

const formatModels = (profiles: ProviderProfile[]): string => {
  const names = profiles.map((profile) => profile.modelName?.trim() || profile.modelId)
  return [...new Set(names)].join(' / ')
}

export const UsageSection = () => {
  const { t } = useT()
  const providerProfiles = useAgentStore((state) => state.providerProfiles)
  const [usageStates, setUsageStates] = useState<Record<string, ProviderUsageState>>({})
  const refreshToken = useRef(0)

  const groups = useMemo<ProviderUsageGroup[]>(() => {
    const byProvider = new Map<string, ProviderProfile[]>()
    for (const profile of providerProfiles) {
      const existing = byProvider.get(profile.providerId) ?? []
      existing.push(profile)
      byProvider.set(profile.providerId, existing)
    }
    return [...byProvider.entries()].map(([providerId, profiles]) => ({
      providerId,
      label: localizedProviderLabel(t, profiles[0]!.providerId),
      profiles,
      queryable: isUsageQueryableProvider(providerId),
    }))
  }, [providerProfiles, t])

  // useMemo 稳定引用是关键：filter 每次返回新数组会让 refreshAll 的 useCallback
  // 引用逐次变化，effect 随之无限重跑（setUsageStates → re-render → 新数组 → …）。
  const queryableGroups = useMemo(
    () => groups.filter((group) => group.queryable),
    [groups],
  )
  const unsupportedGroups = useMemo(
    () => groups.filter((group) => !group.queryable),
    [groups],
  )
  // providerProfiles 在应用启动时异步加载：按可查询 Provider 集合的签名触发，
  // 集合从空变为非空（或变化）时自动查询一次，之后由用户手动刷新。
  const queryableSignature = queryableGroups.map((group) => group.providerId).join(',')

  const refreshProvider = useCallback(async (group: ProviderUsageGroup, token: number) => {
    setUsageStates((current) => ({
      ...current,
      [group.providerId]: { status: 'loading' },
    }))
    try {
      const result = await queryProviderUsage({
        providerId: group.providerId,
        // 同一 Provider 的全部 Profile 共享 provider 级 Secret namespace，
        // 取代表 Profile 的 secretId（通常为默认值）。
        secretId: group.profiles[0]!.secretId,
        // 智谱按用户配置的 chat endpoint 分流国内/国际站（其余 Provider 忽略）。
        endpointHint: group.profiles[0]!.endpoint,
      })
      if (refreshToken.current !== token) return
      setUsageStates((current) => ({
        ...current,
        [group.providerId]: { status: 'done', result },
      }))
    } catch (error) {
      if (refreshToken.current !== token) return
      setUsageStates((current) => ({
        ...current,
        [group.providerId]: {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        },
      }))
    }
  }, [])

  const refreshAll = useCallback(() => {
    if (!isTauriRuntime()) return
    refreshToken.current += 1
    const token = refreshToken.current
    for (const group of queryableGroups) void refreshProvider(group, token)
  }, [queryableGroups, refreshProvider])

  useEffect(() => {
    if (!isTauriRuntime() || queryableSignature === '') return
    refreshAll()
  }, [queryableSignature, refreshAll])

  const refreshing = queryableGroups.some(
    (group) => usageStates[group.providerId]?.status === 'loading',
  )

  return (
    <section className="settings-section" id="settings-usage">
      <div className="section-title">
        <span>{t('settings.usage.title')}</span>
        <span className="section-state">
          {queryableGroups.length > 0
            ? t('settings.usage.queryableCount', { count: queryableGroups.length })
            : t('settings.usage.noQueryable')}
        </span>
      </div>

      {!isTauriRuntime() && (
        <p className="security-note"><LockKeyhole size={13} aria-hidden />{t('settings.usage.desktopOnly')}</p>
      )}
      {isTauriRuntime() && groups.length === 0 && (
        <p className="security-note"><LockKeyhole size={13} aria-hidden />{t('settings.usage.noProfiles')}</p>
      )}

      <div className="usage-actions">
        <button
          type="button"
          className="settings__button"
          onClick={refreshAll}
          disabled={!isTauriRuntime() || refreshing || queryableGroups.length === 0}
        >
          <RefreshCw size={13} className={refreshing ? 'usage-spin' : undefined} />
          {refreshing ? t('settings.usage.refreshing') : t('settings.usage.refresh')}
        </button>
      </div>

      {queryableGroups.length > 0 && (
        <div className="usage-provider-list">
          {queryableGroups.map((group) => {
            const state = usageStates[group.providerId] ?? { status: 'idle' as UsageStateStatus }
            return (
              <div key={group.providerId} className="usage-provider-card">
                <div className="usage-provider-head">
                  <span className="usage-provider-name">{group.label}</span>
                  <span className="usage-provider-models">{formatModels(group.profiles)}</span>
                  <span className="usage-provider-state">
                    {state.status === 'loading' && t('settings.usage.querying')}
                    {state.status === 'idle' && t('settings.usage.pending')}
                    {state.status === 'done' && state.result
                      && t('settings.usage.updatedAt', { time: new Date(state.result.checkedAtMs).toLocaleTimeString() })}
                  </span>
                </div>
                {state.status === 'error' && (
                  <p className="usage-provider-error" role="alert">{state.error}</p>
                )}
                {state.status === 'done' && state.result && (
                  <div className="usage-metrics">
                    {state.result.metrics.map((metric, index) => {
                      const percent = metricPercent(metric)
                      const label = localizeUsageMetricText(t, metric.label)
                      const detail = metric.detail
                        ? localizeUsageMetricText(t, metric.detail)
                        : undefined
                      return (
                        <div key={`${metric.label}-${index}`} className="usage-metric">
                          <div className="usage-metric-head">
                            <span>{label}</span>
                            <span className="usage-metric-value">{formatMetricValue(metric, t)}</span>
                          </div>
                          {percent !== undefined && (
                            <div
                              className={`usage-metric-bar usage-metric-bar--${metricBarTone(percent)}`}
                              role="progressbar"
                              aria-label={label}
                              aria-valuenow={Math.round(percent)}
                              aria-valuemin={0}
                              aria-valuemax={100}
                            >
                              <span
                                className="usage-metric-fill"
                                style={{ width: `${Math.max(2, percent)}%` }}
                              />
                            </div>
                          )}
                          <div className="usage-metric-foot">
                            {detail && <span>{detail}</span>}
                            {metric.resetsAt && (
                              <span>{t('settings.usage.resetsAt', { time: formatUsageResetsAt(metric.resetsAt) ?? '' })}</span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {unsupportedGroups.length > 0 && (
        <div className="usage-unsupported">
          <span className="usage-unsupported-title">{t('settings.usage.unsupportedTitle')}</span>
          <ul>
            {unsupportedGroups.map((group) => (
              <li key={group.providerId}>
                <strong>{group.label}</strong>
                <span>
                  {t(USAGE_UNAVAILABLE_NOTES[group.providerId] ?? 'settings.usage.unsupportedFallback')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="security-note">
        <LockKeyhole size={13} aria-hidden />
        <span>{t('settings.usage.note')}</span>
      </p>
    </section>
  )
}
