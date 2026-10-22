/**
 * 会话 → 工作区路径的运行时绑定注册表。
 *
 * ## 为什么需要它（不能直接读 store 的 sessions[].workspace）
 *
 * store 的 `sessions[].workspace.path` 是**展示层**数据：它会被 `hydrateSessionMetadata`
 * 按 DB/localStorage 双源刷新，也会被列表投影整体替换。审批签发需要的却是**该会话
 * 此刻实际挂载的 harness 所用的工作区**——两者在若干中间态下会分叉：
 *
 * - **LRU 逐出后**：本表条目已清（harness 也已 dispose，无从重建），而 store 的
 *   `sessions[].workspace` 仍保留原值。此时若以 store 为准，会给一个不存在的
 *   harness 签发租约。
 *
 * 因此它是独立于 store 的**第三份运行时状态**，三处同步（bind / 删除 / 逐出）是硬约束。
 *
 * ## 撤销工作区后的语义
 *
 * 路径**不保留**：撤销同时清空本表条目与 DB/store 的 `session.workspace`（两者同源
 * 于快照的 `session.workspace`，一并失效），该会话在重新绑定工作区之前不可运行——
 * 由工作区门而非审批挡住：
 *
 * - 激活该会话时 `selectSession` / `activateCachedRuntimeSession` 以会话自己的工作区
 *   推导全局 `authorizedWorkspace`，它已为 null → Composer 的 `workspaceReady` 为假；
 * - 后台快捷发送 `sendToSession` 要求会话工作区非空且在授权集内。
 *
 * 重新绑定（新建会话 / 切换工作区）时经 `createRuntimeSession` /
 * `activateCachedRuntimeSession` 按新快照重建绑定。
 *
 * ## 三处同步（AGENTS.md 红线 ①）
 *
 * 1. **绑定**：会话 harness 创建（`createRuntimeSession`）或缓存激活时调
 *    {@link bindSessionWorkspace}；无工作区时调 {@link forgetSessionWorkspace}。
 * 2. **删除**：删会话时 {@link forgetSessionWorkspace}（幂等）。
 * 3. **逐出**：LRU 逐出与 {@link dropRuntimeCachesForSession} 经 `runtimeCaches` 的
 *    逐出回调统一调 {@link forgetSessionWorkspace}——`runtimeCaches` 不能直接 import
 *    本模块（`workspaceActions` 已依赖 `runtimeCaches`，反向 import 会成环），故由
 *    `agentStore` 装配时注册回调。
 *
 * 漏掉 ① 会得到 stale path（会话在旧工作区执行）或空绑定（Rust `authorized_root_for(None)`
 * 回落到当前活动工作区）；漏掉 ②③ 只是内存滞留（撤销工作区的检查对已消失的会话仍生效，
 * 无害）。
 *
 * ## 不变量自检
 *
 * 绑定记录必须与 store 的 `sessions[].workspace.path` 一致（两者同源于快照的
 * `session.workspace`）。分叉时 {@link bindSessionWorkspace} 记一条诊断——见该函数
 * 注释。诊断而非抛出：此处被调用于会话激活路径，抛出会中断激活且无法自愈。
 */

const bindings = new Map<string, string>()

/**
 * 列表投影的工作区来源（由 `agentStore` 在 store 创建后注入）。
 *
 * 未注入时自检静默跳过——`createRuntimeSession` 在模块求值期即被调用一次，
 * 此时 store 尚不存在（TDZ），注入点必须在 store 之后。这也让本模块保持
 * store 无关（可独立单测）。
 */
let projectedWorkspacePathOf: ((sessionId: string) => string | undefined) | undefined

export const setProjectedWorkspacePathSource = (
  source: (sessionId: string) => string | undefined,
): void => {
  projectedWorkspacePathOf = source
}

/** 绑定会话到工作区路径。空路径按解绑处理，避免写入无效条目。 */
export const bindSessionWorkspace = (sessionId: string, workspacePath?: string): void => {
  const projected = projectedWorkspacePathOf?.(sessionId)
  // 不变量自检：列表投影说该会话绑定了工作区，运行时绑定却是空或另一个路径。
  // 正常情况两者同源（都来自快照的 session.workspace），分叉意味着 harness 未按
  // 会话自己的工作区构造——此时工具调用会经 Rust `authorized_root_for(None)` 回落到
  // **当前活动工作区**，而不是该会话绑定的目录。这是不变量被破坏的信号，必须留下
  // 痕迹而不是静默降级（诊断而非抛出：抛出会中断会话激活，代价大于收益）。
  if (projected && projected !== workspacePath) {
    console.error(
      `[workspace-binding] 会话 ${sessionId} 的运行时工作区绑定（${workspacePath ?? '无'}）`
      + `与列表投影（${projected}）分叉；该会话的写操作可能落到当前活动工作区而非其绑定目录。`,
    )
  }
  if (workspacePath) bindings.set(sessionId, workspacePath)
  else bindings.delete(sessionId)
}

/** 解绑单个会话（幂等）。删会话与缓存逐出共用。 */
export const forgetSessionWorkspace = (sessionId: string): void => {
  bindings.delete(sessionId)
}

/** 读取会话当前挂载的工作区路径；未绑定返回 undefined。 */
export const sessionWorkspacePath = (sessionId: string): string | undefined =>
  bindings.get(sessionId)

/**
 * 解除某工作区下全部会话的绑定，返回受影响的会话 id。
 *
 * 调用方（`revokeWorkspace`）需要这些 id 来停止运行中的会话并连带降级访问模式；
 * 先取快照再逐个解绑，避免遍历中修改 Map。
 */
export const forgetSessionsForWorkspace = (workspacePath: string): string[] => {
  const affected: string[] = []
  for (const [sessionId, path] of bindings) {
    if (path !== workspacePath) continue
    affected.push(sessionId)
    bindings.delete(sessionId)
  }
  return affected
}

/** 绑定某工作区下的全部会话（测试与诊断用；生产路径按会话逐个绑定）。 */
export const sessionsForWorkspace = (workspacePath: string): string[] => [...bindings]
  .filter(([, path]) => path === workspacePath)
  .map(([sessionId]) => sessionId)

/** 当前全部绑定（测试断言用）。 */
export const sessionWorkspaceBindings = (): ReadonlyMap<string, string> => bindings
