/**
 * 环境就绪判定（纯函数：无 I/O、无宿主依赖）。
 *
 * 「就绪」必须由**客观事实**判定，而不是由代码猜：环境档声明探针（方法 / 路径 / 期望状态码），
 * 宿主真打一次接口，本模块把结果分类。三类失败原因**不合并**——用户需要知道到底是
 * 「环境没起来」「服务起来了但没就绪」还是「宿主策略拒绝了这次请求」：
 *
 * | verdict | 含义 | 典型处置 |
 * |---|---|---|
 * | `ready` | 接口返回了期望状态码 | 可以开始运行 |
 * | `unreachable` | 超时 / 连接失败 | 环境没起来：先起环境 |
 * | `not_ready` | 可达但状态码不在期望集合里 | 服务起了但没就绪（依赖没起完 / 健康检查失败） |
 * | `blocked` | 宿主出网/私网策略拒绝 | 配置问题：勾「允许访问回环/私网」或改用 https |
 * | `rejected` | 用户在审批卡上拒绝 | 逐次审批的正常结果 |
 * | `canceled` | 运行被停止 | — |
 * | `unusable` | 环境本身没法探测（缺 API Base URL / 配方非法） | 修环境档 |
 *
 * 纯模块只吃**结构化输入**（不 import `platform/`）：环境记录到输入的映射由调用方完成。
 */
import { parseEnvironmentRecipeJson } from './environmentFile'
import type { ApiStepSpec } from '../spec/types'

export interface ReadinessEnvironmentInput {
  /** 环境记录里的 API Base URL；缺失即无法探测（自定义变量探针除外）。 */
  apiBaseUrl: string | null
  /**
   * v2：环境档的自定义变量（多服务端点的地址）。探针 `var` 指向这里；
   * `API_BASE_URL` 仍可由 `apiBaseUrl` 提供（运行期投影会合并两者）。
   */
  vars?: Readonly<Record<string, string>>
  /** 环境记录里的配方 JSON；`null` 表示没有配方（用缺省探针）。 */
  recipeJson: string | null
  /** 探针步骤 ID 前缀：审批 actor 与租约都按它绑定（调用方拼 `env-probe:<envId>`）。 */
  stepId: string
}

export interface EnvironmentProbePlan {
  /**
   * 探针步骤。**不带 `expect`**：就绪判定按 `expectStatus` 集合做，混进 Runner 的断言
   * 语义只会让「环境就绪」与「用例断言」两件事互相污染。
   */
  step: ApiStepSpec
  expectStatus: readonly number[]
  /** 目标服务变量名（多服务探针用于失败定位与报告事实；单探针为 API_BASE_URL）。 */
  var?: string
}

export type EnvironmentReadinessVerdict =
  | 'ready'
  | 'unreachable'
  | 'not_ready'
  | 'blocked'
  | 'rejected'
  | 'canceled'
  | 'unusable'

export interface EnvironmentReadiness {
  ready: boolean
  verdict: EnvironmentReadinessVerdict
  /** 中文原文原因：直接展示给用户，不收敛成「环境不可用」。 */
  reason: string
  status: number | null
  elapsedMs: number
}

/** 缺省探针：`GET ${API_BASE_URL}/` 期望 200。产品把健康检查放在别处就在配方里显式声明。 */
export const DEFAULT_PROBE_METHOD = 'GET' as const
export const DEFAULT_PROBE_PATH = '/' as const
export const DEFAULT_PROBE_EXPECT_STATUS: readonly number[] = [200]

export type ReadinessProbePlanResult =
  | { ok: true; plan: EnvironmentProbePlan }
  | { ok: false; reason: string }

export type ReadinessProbePlansResult =
  | { ok: true; plans: readonly EnvironmentProbePlan[] }
  | { ok: false; reason: string }

/**
 * 由环境构造探针计划。任何「没法探测」的情形都给出**可执行**的原因（用户知道去改哪里），
 * 而不是抛错或静默跳过探测——静默跳过等于把「没验证」伪装成「已验证」。
 */
/** 探针目标地址的解析基址：保留名 API_BASE_URL 允许用环境记录的列兜底。 */
const probeBaseFor = (
  environment: ReadinessEnvironmentInput,
  varName: string,
): string | null => {
  const fromVars = environment.vars?.[varName]?.trim()
  if (fromVars !== undefined && fromVars !== '') return fromVars
  const fallback = varName === 'API_BASE_URL' ? environment.apiBaseUrl?.trim() : undefined
  return fallback !== undefined && fallback !== '' ? fallback : null
}

/**
 * 由环境构造**就绪探针清单**。多服务拓扑下「就绪」是每个服务都就绪：
 * v2 档的 `probes[]` 逐个解析，v1 形态（或未声明）退化为单个 `API_BASE_URL` 探针。
 * 任何「没法探测」的情形都给出**可执行**的原因（用户知道去改哪里），而不是抛错或静默跳过。
 */
export const readinessProbePlans = (environment: ReadinessEnvironmentInput): ReadinessProbePlansResult => {
  const recipe = environment.recipeJson === null
    ? undefined
    : parseEnvironmentRecipeJson(environment.recipeJson)
  if (recipe !== undefined && !recipe.ok) return { ok: false, reason: recipe.reason }
  const recipeBody = recipe?.ok === true ? recipe.recipe : undefined
  const declared = recipeBody?.probes?.map((probe) => ({
    var: probe.var,
    method: probe.method,
    path: probe.path,
    expectStatus: probe.expectStatus,
  })) ?? (recipeBody?.probe !== undefined
    ? [{ var: 'API_BASE_URL', ...recipeBody.probe }]
    : [{ var: 'API_BASE_URL', method: DEFAULT_PROBE_METHOD, path: DEFAULT_PROBE_PATH, expectStatus: DEFAULT_PROBE_EXPECT_STATUS }])

  const plans: EnvironmentProbePlan[] = []
  for (const probe of declared) {
    const baseUrl = probeBaseFor(environment, probe.var)
    if (baseUrl === null) {
      return {
        ok: false,
        reason: probe.var === 'API_BASE_URL'
          ? '运行环境没有 API Base URL：无法探测环境是否就绪（在环境档的 vars.API_BASE_URL 里填写真实接口地址）'
          : `运行环境缺少服务变量「${probe.var}」：无法探测该服务是否就绪（在环境档的 vars 里声明）`,
      }
    }
    let url: string
    try {
      url = new URL(probe.path, baseUrl).toString()
    } catch {
      return { ok: false, reason: `无法用「${probe.var}=${baseUrl}」拼接探针地址：请检查环境档里的地址` }
    }
    plans.push({
      step: {
        // 多探针各自独立的步骤 ID：审批 actor 与租约按步骤绑定，互不覆盖。
        id: probe.var === 'API_BASE_URL' ? environment.stepId : `${environment.stepId}:${probe.var}`,
        action: 'api.request',
        method: probe.method,
        url,
        redirect: 'manual',
        // 探针的预算取环境自己的启动预算：服务刚启动时给它足够时间回答第一次请求。
        ...(recipeBody !== undefined ? { timeoutMs: recipeBody.timeoutMs } : {}),
      },
      expectStatus: probe.expectStatus,
      var: probe.var,
    })
  }
  return { ok: true, plans }
}

/** 单探针兼容入口：返回第一项（旧调用方与测试语义不变）。 */
export const readinessProbePlan = (environment: ReadinessEnvironmentInput): ReadinessProbePlanResult => {
  const plans = readinessProbePlans(environment)
  if (!plans.ok) return plans
  const plan = plans.plans[0]
  return plan === undefined
    ? { ok: false, reason: '环境探针清单为空' }
    : { ok: true, plan }
}

/** 宿主探针结果的**结构**投影（`ApiTestStepResult` 的判定相关子集，避免纯模块依赖 platform）。 */
export interface ProbeObservation {
  transport: 'received' | 'timeout' | 'blocked' | 'network_error' | 'canceled'
  statusCode: number | null
  message: string
  elapsedMs: number
}

export const unusableReadiness = (reason: string): EnvironmentReadiness => ({
  ready: false,
  verdict: 'unusable',
  reason,
  status: null,
  elapsedMs: 0,
})

export const rejectedReadiness = (): EnvironmentReadiness => ({
  ready: false,
  verdict: 'rejected',
  reason: '用户拒绝了环境探测请求：没有确认就无法判断环境是否就绪',
  status: null,
  elapsedMs: 0,
})

/** 用户停止运行：与“拒绝审批”区分，报告/批次摘要应显示已取消而不是被拒绝。 */
export const canceledReadiness = (): EnvironmentReadiness => ({
  ready: false,
  verdict: 'canceled',
  reason: '环境探测已取消（运行已停止）',
  status: null,
  elapsedMs: 0,
})

/** 把探针结果分类成就绪结论。每个分支都给**具体**原因（含地址、实际状态码、期望集合）。 */
export const classifyReadiness = (
  plan: EnvironmentProbePlan,
  observation: ProbeObservation,
): EnvironmentReadiness => {
  const target = `${plan.step.method} ${plan.step.url}`
  const base = { status: observation.statusCode, elapsedMs: observation.elapsedMs }
  switch (observation.transport) {
    case 'received': {
      const status = observation.statusCode
      if (status !== null && plan.expectStatus.includes(status)) {
        return {
          ready: true,
          verdict: 'ready',
          reason: `环境就绪：${target} 返回 ${status}（${observation.elapsedMs} ms）`,
          ...base,
        }
      }
      return {
        ready: false,
        verdict: 'not_ready',
        reason: `服务可达但未就绪：${target} 返回 ${status ?? '无状态码'}，期望 ${plan.expectStatus.join('/')}`,
        ...base,
      }
    }
    case 'timeout':
      return {
        ready: false,
        verdict: 'unreachable',
        reason: `接口探测超时（${target}）：环境可能尚未启动完成，请先启动环境再运行`,
        ...base,
      }
    case 'network_error':
      return {
        ready: false,
        verdict: 'unreachable',
        reason: `接口不可达（${target}）：环境可能尚未启动${observation.message ? `（${observation.message}）` : ''}`,
        ...base,
      }
    case 'blocked':
      return {
        ready: false,
        verdict: 'blocked',
        reason: `宿主拒绝了这次探测请求：${observation.message || '出网/私网策略判定'}。` +
          '这是地址与网络策略的问题，不代表环境不存在。',
        ...base,
      }
    case 'canceled':
      return { ready: false, verdict: 'canceled', reason: '环境探测已取消', ...base }
  }
}
