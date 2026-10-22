/**
 * 运行前置门：环境没就绪就**不创建运行**。
 *
 * 为什么必须挡在运行之前：环境没起来时跑用例只会得到一屏 `failed`/`error`，既污染报告与
 * 覆盖统计，又让人误以为产品坏了。safeline 的经验同向——「不要在环境未就绪时继续验证」。
 *
 * 缓存纪律（`ensureEnvironmentReady`）：
 * - **只缓存「已就绪」**：未就绪不缓存——环境可能正在启动，下一次尝试应当重新探测；
 * - 缓存键是环境 ID + **环境档指纹**：档位/地址/配方/私网开关/头任一变化都算另一套环境；
 * - TTL 60s 且只活在当前会话内，不跨重启（否则「起过一次就算就绪」会骗人）。
 */
import type { TestStepApprover } from '@/agent/testing/approval/testStepApprover'
import {
  environmentFactsFrom,
  type TestEnvironmentFacts,
} from '@/agent/testing/environment/envFacts'
import type { EnvironmentReadiness } from '@/agent/testing/environment/readiness'
import type { TestEnvironmentRecord } from '@/platform/testEnvironments'
import type { ProbeEnvironmentResult } from '@/platform/testEnvironmentProbe'
import { probeEnvironmentReadiness } from '@/platform/testEnvironmentProbe'

export const ENVIRONMENT_READINESS_TTL_MS = 60_000

export interface GatedEnvironmentReadiness {
  readiness: EnvironmentReadiness
  /** 落库用的事实快照；命中缓存时 `preparedBy` 会翻成 `cache`，报告据此区分「刚探过」与「沿用上次结论」。 */
  facts: TestEnvironmentFacts
}

interface ReadinessCacheEntry {
  fingerprint: string
  at: number
  gated: GatedEnvironmentReadiness
}

const readyCache = new Map<string, ReadinessCacheEntry>()

const fingerprintOf = (environment: TestEnvironmentRecord): string => JSON.stringify([
  environment.kind,
  environment.apiBaseUrl,
  environment.recipeJson,
  environment.allowPrivateNetwork,
  environment.headersJson,
  environment.secretIdsJson,
])

/** 测试接缝：清空会话内的就绪缓存。 */
export const resetEnvironmentReadinessCache = (): void => readyCache.clear()

export interface EnsureEnvironmentReadyInput {
  environment: TestEnvironmentRecord
  runId: string
  approver: TestStepApprover
  signal: AbortSignal
  now?: () => number
}

const toGated = (
  environment: TestEnvironmentRecord,
  result: ProbeEnvironmentResult,
  preparedBy: TestEnvironmentFacts['preparedBy'],
): GatedEnvironmentReadiness => ({
  readiness: result.readiness,
  facts: environmentFactsFrom({
    environment: { id: environment.id, name: environment.name, kind: environment.kind },
    probe: result.probe,
    readiness: result.readiness,
    preparedBy,
  }),
})

export const ensureEnvironmentReady = async (
  input: EnsureEnvironmentReadyInput,
): Promise<GatedEnvironmentReadiness> => {
  const now = input.now ?? Date.now
  const environmentId = input.environment.id
  const fingerprint = fingerprintOf(input.environment)
  const cached = readyCache.get(environmentId)
  if (cached && cached.fingerprint === fingerprint && now() - cached.at < ENVIRONMENT_READINESS_TTL_MS) {
    // 缓存命中：结论沿用上次，但事实里必须标成 cache。
    return { readiness: cached.gated.readiness, facts: { ...cached.gated.facts, preparedBy: 'cache' } }
  }

  const gated = toGated(
    input.environment,
    await probeEnvironmentReadiness({
      environment: input.environment,
      runId: input.runId,
      approver: input.approver,
      signal: input.signal,
    }),
    'probe',
  )
  if (gated.readiness.ready) {
    readyCache.set(environmentId, { fingerprint, at: now(), gated })
  } else {
    readyCache.delete(environmentId)
  }
  return gated
}
