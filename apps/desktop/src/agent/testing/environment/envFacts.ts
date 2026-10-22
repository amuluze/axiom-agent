/**
 * 运行环境事实（envFacts）：**这次运行到底打了哪个环境、这次结论是自己探的还是沿用缓存**。
 *
 * 为什么要有它：报告只记 `environment_id` 时，环境被改名/改动/删除之后就没法回答
 * 「当时打的是哪儿」。所以事实是**运行时快照**，与环境记录解耦（不靠 join），
 * 环境删除后报告依然可读。
 *
 * 纯模块：不 import `platform/`，序列化与展示都只吃结构。
 */
import type { EnvironmentMode } from './environmentFile'
import type { EnvironmentReadiness, EnvironmentReadinessVerdict } from './readiness'

export interface TestEnvironmentFacts {
  environmentId: string
  /** 运行当时的展示名（环境后来改名不影响历史报告）。 */
  name: string
  kind: EnvironmentMode
  /** 探针实际打的目标：报告里可直接核对。 */
  probe: { method: string; url: string }
  verdict: EnvironmentReadinessVerdict
  /** 探针实际拿到的状态码（无状态码时 null）。 */
  status: number | null
  elapsedMs: number
  /**
   * 就绪结论的来源：`probe` = 本次真打一次接口；`cache` = 命中会话内就绪缓存。
   * 两者都算「已就绪」，但报告必须能区分——否则「30 秒前探过」会被读成「刚才验过」。
   */
  preparedBy: 'probe' | 'cache'
}

export interface EnvironmentFactsInput {
  environment: { id: string; name: string; kind: EnvironmentMode }
  probe: { method: string; url: string } | null
  readiness: EnvironmentReadiness
  preparedBy: TestEnvironmentFacts['preparedBy']
}

/**
 * 由环境记录 + 探针结论组装事实。`probe` 为 null（例如缺 API Base URL，压根没探）时
 * 用空目标占位，并在展示里说明「没有探针目标」。
 */
export const environmentFactsFrom = (input: EnvironmentFactsInput): TestEnvironmentFacts => ({
  environmentId: input.environment.id,
  name: input.environment.name,
  kind: input.environment.kind,
  probe: input.probe ?? { method: '—', url: '（未探测：环境没有可用的 API Base URL）' },
  verdict: input.readiness.verdict,
  status: input.readiness.status,
  elapsedMs: input.readiness.elapsedMs,
  preparedBy: input.preparedBy,
})

export const serializeEnvironmentFacts = (facts: TestEnvironmentFacts): string => JSON.stringify(facts)

/**
 * 报告里的一行人话。输入是不可信的历史 JSON：字段缺失或类型不符时返回 `null`，
 * 报告退化为不显示这一行，而不是抛错或显示 `[object Object]`。
 */
export const describeEnvironmentFacts = (json: string | null | undefined): string | null => {
  if (!json || json.trim() === '') return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const facts = raw as Record<string, unknown>
  const name = typeof facts.name === 'string' ? facts.name : null
  const kind = facts.kind === 'local' || facts.kind === 'remote' ? facts.kind : null
  if (name === null || kind === null) return null
  const probe = typeof facts.probe === 'object' && facts.probe !== null && !Array.isArray(facts.probe)
    ? (facts.probe as Record<string, unknown>)
    : {}
  const method = typeof probe.method === 'string' ? probe.method : '—'
  const url = typeof probe.url === 'string' ? probe.url : '（未记录）'
  const status = typeof facts.status === 'number' ? String(facts.status) : null
  const elapsedMs = typeof facts.elapsedMs === 'number' ? facts.elapsedMs : null
  const source = facts.preparedBy === 'cache'
    ? '就绪结论来自会话内缓存（本次未重新探测）'
    : '本次探测'
  const outcome = status === null
    ? `结论 ${String(facts.verdict ?? '未知')}`
    : `返回 ${status}`
  const timing = elapsedMs === null ? '' : `（${elapsedMs} ms）`
  return [
    `本次环境：${name}（${kind}）`,
    `探针 ${method} ${url} → ${outcome}${timing}`,
    source,
  ].join(' · ')
}
