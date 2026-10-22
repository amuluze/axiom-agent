/**
 * 测试运行状态机。转移表是唯一事实源：Runner 与持久化层都经此校验，
 * 终态不可再转移，非法转移直接抛错而不是静默覆盖（重复 settle 即为非法）。
 */
export type TestRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'passed'
  | 'failed'
  | 'error'
  | 'rejected'
  | 'skipped'
  | 'canceled'
  | 'interrupted'

const TRANSITIONS: Readonly<Record<TestRunStatus, readonly TestRunStatus[]>> = {
  queued: ['running', 'skipped', 'canceled'],
  // running → rejected 覆盖“审批前即被策略拒绝”，与“等待审批后被用户拒绝”同属 rejected。
  running: ['waiting_approval', 'passed', 'failed', 'error', 'rejected', 'canceled', 'interrupted'],
  waiting_approval: ['running', 'rejected', 'canceled', 'interrupted'],
  passed: [],
  failed: [],
  error: [],
  rejected: [],
  skipped: [],
  canceled: [],
  interrupted: [],
}

export const canTransitionStatus = (from: TestRunStatus, to: TestRunStatus): boolean =>
  TRANSITIONS[from].includes(to)

export const transitionStatus = (from: TestRunStatus, to: TestRunStatus): TestRunStatus => {
  if (!canTransitionStatus(from, to)) {
    throw new Error(`非法测试状态转移：${from} → ${to}`)
  }
  return to
}

export const isTerminalStatus = (status: TestRunStatus): boolean => TRANSITIONS[status].length === 0

/**
 * 应用启动发现遗留的非终态记录时使用：正在执行或等待审批的动作无法确认是否已产生副作用，
 * 统一记为 interrupted 且不得自动重放；尚未开始的排队项只能视为跳过。
 */
export const interruptStatus = (status: TestRunStatus): TestRunStatus => {
  if (status === 'running' || status === 'waiting_approval') return 'interrupted'
  if (status === 'queued') return 'skipped'
  return status
}

/**
 * 从子节点聚合父节点状态。优先级反映排障价值：中断与拒绝优先于失败，
 * 失败优先于用户停止；全部被跳过则父节点也跳过。
 */
export const aggregateStatus = (children: readonly TestRunStatus[]): TestRunStatus => {
  const precedence: readonly TestRunStatus[] = ['interrupted', 'rejected', 'error', 'failed', 'canceled', 'passed']
  for (const status of precedence) {
    if (children.includes(status)) return status
  }
  return children.length > 0 && children.every((status) => status === 'skipped') ? 'skipped' : 'queued'
}

/**
 * 步骤判定与**失败的客观归因**（`failure_origin`）：把"这一步为什么没通过"拆成四类可由宿主
 * 判定的事实，交给报告与批次编排消费。
 *
 * | origin | 判据（客观事实，不猜语义） |
 * |---|---|
 * | `environment` | 传输层失败：超时、连接失败、宿主出网/私网策略拒绝；以及批次级前置失败（探针未就绪） |
 * | `approval` | 用户在审批卡上拒绝，或审批前的策略拒绝 |
 * | `driver` | 定位零匹配/歧义/stale ref、协议与驱动异常、租约失效等步骤级故障 |
 * | `assertion` | 断言不成立（含非 2xx 与期望不符） |
 *
 * **不在这里判定的东西**：`driver` 里"测试写错了"与"产品有缺陷"的区分是**语义**判断，Axiom 不猜
 * ——失败来源由用户在「发送到测试/开发会话」时选择方向（既有原则，见 usage §4.5）。归因只服务两件事：
 * 报告分诊（一眼看出是环境问题还是断言问题）与**后果处理**（`environment`/`approval` 中断整批，
 * 不给坏环境刷屏、也不替用户继续批准）。
 *
 * `error` 是唯一需要驱动提供事实的 verdict：驱动明确知道是传输层还是步骤层；其余三类由 verdict 直接决定。
 */
export type StepVerdict = 'passed' | 'failed' | 'error' | 'rejected' | 'canceled'

export type FailureOrigin = 'environment' | 'approval' | 'driver' | 'assertion'

/** 报告与摘要展示用的稳定顺序（也是 SQLite CHECK 的白名单）。 */
export const FAILURE_ORIGINS: readonly FailureOrigin[] = ['environment', 'approval', 'driver', 'assertion']

export const isFailureOrigin = (value: unknown): value is FailureOrigin =>
  typeof value === 'string' && (FAILURE_ORIGINS as readonly string[]).includes(value)

/**
 * 步骤结果的归因。`passed`/`canceled` 没有归因（取消不是"失败原因"，由 `failure_kind` 表达）；
 * `error` 优先用驱动给出的显式事实，缺省 `driver`（步骤级故障是默认解释）。
 */
export const failureOriginForOutcome = (
  outcome: { verdict: StepVerdict; origin?: FailureOrigin },
): FailureOrigin | null => {
  switch (outcome.verdict) {
    case 'rejected':
      return 'approval'
    case 'failed':
      return 'assertion'
    case 'error':
      return outcome.origin ?? 'driver'
    default:
      return null
  }
}

/** 用例归因 = **首个未通过步骤**的归因（它决定了这个用例为什么停在这里）。 */
export const failureOriginForCase = (
  steps: readonly { status: TestRunStatus; origin?: FailureOrigin }[],
): FailureOrigin | null => {
  for (const step of steps) {
    if (['queued', 'running', 'waiting_approval', 'passed'].includes(step.status)) continue
    if (step.origin !== undefined) return step.origin
    if (step.status === 'failed') return 'assertion'
    if (step.status === 'rejected') return 'approval'
    if (step.status === 'error') return 'driver'
    // canceled/interrupted/skipped 不是"这一步失败"：不给归因，理由由 failure_kind 表达。
    return null
  }
  return null
}

/** 该批次是否应因归因中断（`environment`：环境坏了；`approval`：用户已表态，别继续替他批准）。 */
export const stopsBatch = (origin: FailureOrigin | null): boolean =>
  origin === 'environment' || origin === 'approval'
